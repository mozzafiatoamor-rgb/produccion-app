// supabase/functions/loyverse-sync/logic.mjs
// Logica pura (sin red, sin base de datos) de la sincronizacion Loyverse -> inventario.
// Se prueba con Node (tests/loyverse-sync.test.js) y la usa tal cual la Edge Function en Deno
// (Deno entiende ES modules igual que Node; este archivo no usa nada especifico de ninguno).

export function norm(s) {
  return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim().replace(/\s+/g, ' ');
}

// Un recibo se descarta (no se descuenta nada) si es un reembolso o fue cancelado.
// Los nombres exactos de estos campos en la respuesta real de Loyverse deben confirmarse
// contra recibos reales (ver docs/LOYVERSE.md, paso "modo prueba"); por eso se revisan
// varias formas posibles del mismo dato en vez de asumir una sola.
export function receiptIsVoidOrRefund(r) {
  if (r.cancelled_at) return true;
  if (r.refund_for || r.refund_for_id) return true;
  if (typeof r.receipt_type === 'string' && /refund|void|cancel/i.test(r.receipt_type)) return true;
  if (r.total_money && typeof r.total_money === 'number' && r.total_money < 0) return true;
  return false;
}

function lineItemsOf(r) {
  return r.line_items || r.lineItems || [];
}
function itemNameOf(li) {
  return li.item_name || li.name || li.itemName || '';
}
function qtyOf(li) {
  const q = li.quantity ?? li.qty ?? 0;
  return typeof q === 'number' ? q : parseFloat(q) || 0;
}

/**
 * @param {object} args
 * @param {Array}  args.receipts       recibos ya ordenados por created_at ascendente
 * @param {Array}  args.mapRows        [{loyverse_item_name, platillo, activo}]
 * @param {Array}  args.recetasRows    [{platillo, categoria, ingrediente, cantidad, unidad}]
 * @param {Array}  args.catalogoRows   [{producto, categoria}]
 * @param {Set}    args.processedSet   receipt_number ya aplicados (de loyverse_processed_receipts)
 * @param {Date|string|null} args.cursorAfter  no procesar recibos con created_at <= a esto (defensivo; el caller ya filtra en la consulta)
 */
export function planSync({ receipts, mapRows, recetasRows, catalogoRows, processedSet, cursorAfter }) {
  processedSet = processedSet || new Set();
  const cursorMs = cursorAfter ? new Date(cursorAfter).getTime() : 0;

  const mapByName = new Map();
  (mapRows || []).forEach(function (m) { if (m.activo !== false) mapByName.set(norm(m.loyverse_item_name), m.platillo); });

  const recetasByPlatillo = new Map();
  (recetasRows || []).forEach(function (r) {
    const k = norm(r.platillo);
    if (!recetasByPlatillo.has(k)) recetasByPlatillo.set(k, { categoria: r.categoria || '', ingredientes: [] });
    recetasByPlatillo.get(k).ingredientes.push({ producto: r.ingrediente, cantidad: parseFloat(r.cantidad) || 0 });
  });

  const catalogoByNorm = new Map();
  (catalogoRows || []).forEach(function (c) { catalogoByNorm.set(norm(c.producto), c); });

  const ventasInserts = [];
  const seenItemsUpserts = new Map(); // item_name -> {item_name,item_id,inc,ultima_vez,ultimo_recibo}
  const receiptsProcessed = [];
  const omitted = [];
  let maxCreatedAt = null;

  for (const r of receipts) {
    const rn = r.receipt_number || r.receiptNumber || r.id;
    if (!rn) { omitted.push({ receipt_number: null, motivo: 'sin receipt_number' }); continue; }
    if (processedSet.has(rn)) continue;
    const createdAt = r.created_at || r.receipt_date || r.createdAt;
    if (createdAt && new Date(createdAt).getTime() <= cursorMs) continue;

    if (receiptIsVoidOrRefund(r)) {
      omitted.push({ receipt_number: rn, motivo: 'reembolso o cancelado' });
      receiptsProcessed.push(rn); // se marca procesado para no re-evaluarlo cada vez
      if (createdAt && (!maxCreatedAt || createdAt > maxCreatedAt)) maxCreatedAt = createdAt;
      continue;
    }

    const items = lineItemsOf(r);
    const descuentos = new Map(); // producto normalizado -> {producto,cantidad}
    const detalles = [];
    let huboMapeado = false;

    for (const li of items) {
      const nombreLoy = itemNameOf(li);
      const qty = qtyOf(li);
      if (!nombreLoy || qty <= 0) continue;
      const key = norm(nombreLoy);
      const platillo = mapByName.get(key);
      if (!platillo) {
        const s = seenItemsUpserts.get(nombreLoy) || { item_name: nombreLoy, item_id: li.item_id || li.variant_id || null, inc: 0, ultima_vez: createdAt || new Date().toISOString(), ultimo_recibo: rn };
        s.inc += 1; s.ultima_vez = createdAt || s.ultima_vez; s.ultimo_recibo = rn;
        seenItemsUpserts.set(nombreLoy, s);
        continue;
      }
      const receta = recetasByPlatillo.get(norm(platillo));
      huboMapeado = true;
      detalles.push(qty + 'x ' + platillo);
      const idBase = 'LOY-' + rn;
      ventasInserts.push({ id: idBase, fecha: createdAt, categoria: receta ? receta.categoria : '', producto: platillo, cantidad: qty, vendedor: 'Loyverse', notas: '[Loyverse]' });
      if (receta) {
        receta.ingredientes.forEach(function (ing) {
          if (!ing.cantidad || ing.cantidad <= 0) return;
          const k2 = norm(ing.producto);
          const cur = descuentos.get(k2) || { producto: ing.producto, cantidad: 0 };
          cur.cantidad += ing.cantidad * qty;
          descuentos.set(k2, cur);
        });
      }
    }

    if (huboMapeado) {
      let i = 0;
      for (const d of descuentos.values()) {
        const cat = catalogoByNorm.get(norm(d.producto));
        ventasInserts.push({ id: 'LOY-' + rn + '-' + (i++), fecha: createdAt, categoria: cat ? cat.categoria : '', producto: cat ? cat.producto : d.producto, cantidad: Math.ceil(d.cantidad), vendedor: 'Loyverse', notas: 'Descuento Loyverse' });
      }
    }

    receiptsProcessed.push(rn);
    if (createdAt && (!maxCreatedAt || createdAt > maxCreatedAt)) maxCreatedAt = createdAt;
  }

  return {
    ventasInserts,
    seenItemsUpserts: Array.from(seenItemsUpserts.values()),
    receiptsProcessed,
    omitted,
    maxCreatedAt,
  };
}
