// supabase/functions/loyverse-sync/logic.mjs
// Logica pura (sin red, sin base de datos) de la sincronizacion Loyverse -> inventario.
// Se prueba con Node (tests/loyverse-sync.test.js) y la usa tal cual la Edge Function en Deno
// (Deno entiende ES modules igual que Node; este archivo no usa nada especifico de ninguno).
//
// Importante: esto NO escribe directo en el inventario. Por cada recibo con al menos un
// producto mapeado (y no ignorado) arma una fila "pendiente" con las ventas que se
// aplicarian (platillo vendido + descuento de ingredientes) para que un usuario logueado
// la revise y la acepte desde la app (Ajustes > Loyverse > pendientes). Solo al aceptarla
// esas filas se insertan de verdad en `ventas`.

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
function lineModifiersOf(li) {
  return li.line_modifiers || li.lineModifiers || [];
}
function itemNameOf(li) {
  return li.item_name || li.name || li.itemName || '';
}
function qtyOf(li) {
  const q = li.quantity ?? li.qty ?? 0;
  return typeof q === 'number' ? q : parseFloat(q) || 0;
}

// Resumen legible de un recibo, ej: "2x Cheesecake, 1x Café Americano" (solo platillos, no ingredientes).
function resumenDe(ventasReceipt) {
  const porProducto = new Map();
  ventasReceipt.forEach(function (v) {
    if (v.notas !== '[Loyverse]') return;
    porProducto.set(v.producto, (porProducto.get(v.producto) || 0) + v.cantidad);
  });
  return Array.from(porProducto.entries()).map(function ([p, c]) { return c + 'x ' + p; }).join(', ');
}

/**
 * @param {object} args
 * @param {Array}  args.receipts       recibos ya ordenados por created_at ascendente
 * @param {Array}  args.mapRows        [{loyverse_item_name, platillo, activo, ignorado}]
 * @param {Array}  args.recetasRows    [{platillo, categoria, ingrediente, cantidad, unidad}]
 * @param {Array}  args.catalogoRows   [{producto, categoria}]
 * @param {Set}    args.processedSet   receipt_number ya aplicados (de loyverse_processed_receipts)
 * @param {Date|string|null} args.cursorAfter  no procesar recibos con created_at <= a esto (defensivo; el caller ya filtra en la consulta)
 */
export function planSync({ receipts, mapRows, recetasRows, catalogoRows, processedSet, cursorAfter, modifierMapRows }) {
  processedSet = processedSet || new Set();
  const cursorMs = cursorAfter ? new Date(cursorAfter).getTime() : 0;

  // ignorado=true: el admin ya decidio que este producto de Loyverse no aplica aqui (ej. una
  // bebida; esta app solo descuenta inventario de comida) -> no se descuenta y tampoco se
  // vuelve a pedir que lo emparejen. activo=false (pausado) sigue tratandose como "sin mapear".
  const mapByName = new Map();
  const ignoradoSet = new Set();
  (mapRows || []).forEach(function (m) {
    if (m.ignorado) { ignoradoSet.add(norm(m.loyverse_item_name)); return; }
    if (m.activo !== false) mapByName.set(norm(m.loyverse_item_name), m.platillo);
  });

  const recetasByPlatillo = new Map();
  (recetasRows || []).forEach(function (r) {
    const k = norm(r.platillo);
    if (!recetasByPlatillo.has(k)) recetasByPlatillo.set(k, { categoria: r.categoria || '', ingredientes: [] });
    recetasByPlatillo.get(k).ingredientes.push({ producto: r.ingrediente, cantidad: parseFloat(r.cantidad) || 0 });
  });

  const catalogoByNorm = new Map();
  (catalogoRows || []).forEach(function (c) { catalogoByNorm.set(norm(c.producto), c); });

  // Modificadores (ej. proteina, tipo de pasta): "PST Amatriciana" siempre se llama igual en
  // Loyverse sin importar que proteina/pasta eligio el cliente -- esa eleccion viaja aparte, en
  // line_modifiers de cada linea del recibo. Cada OPCION de modificador se mapea una sola vez
  // (no por platillo) a un ingrediente+cantidad que se suma al descuento de ingredientes normal.
  const modifierByOption = new Map();
  const modIgnoradoSet = new Set();
  (modifierMapRows || []).forEach(function (m) {
    if (m.ignorado) { modIgnoradoSet.add(norm(m.modifier_option)); return; }
    if (m.activo !== false) modifierByOption.set(norm(m.modifier_option), { ingrediente: m.ingrediente, cantidad: parseFloat(m.cantidad) || 0 });
  });

  const pendientes = []; // [{receipt_number, fecha, resumen, ventas:[...]}]
  const seenItemsUpserts = new Map(); // item_name -> {item_name,item_id,inc,ultima_vez,ultimo_recibo}
  const seenModifiersUpserts = new Map(); // modifier_option -> {modifier_option,modifier_name,inc,ultima_vez,ultimo_recibo}
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
    const ventasReceipt = []; // filas que se propondrian para este recibo (platillo + ingredientes)
    let dishIdx = 0;

    for (const li of items) {
      const nombreLoy = itemNameOf(li);
      const qty = qtyOf(li);
      if (!nombreLoy || qty <= 0) continue;
      const key = norm(nombreLoy);
      const platillo = mapByName.get(key);
      if (!platillo) {
        if (ignoradoSet.has(key)) continue; // ej. una bebida: no descuenta, no vuelve a aparecer pendiente
        const s = seenItemsUpserts.get(nombreLoy) || { item_name: nombreLoy, item_id: li.item_id || li.variant_id || null, inc: 0, ultima_vez: createdAt || new Date().toISOString(), ultimo_recibo: rn };
        s.inc += 1; s.ultima_vez = createdAt || s.ultima_vez; s.ultimo_recibo = rn;
        seenItemsUpserts.set(nombreLoy, s);
        continue;
      }
      const receta = recetasByPlatillo.get(norm(platillo));
      // id unico por linea (D=platillo vendido, I=descuento de ingrediente); antes usaba el mismo
      // id para todas las filas de platillo de un recibo y una segunda venta mapeada en el mismo
      // recibo se perdia silenciosamente (on_conflict=id la trataba como duplicado).
      ventasReceipt.push({ id: 'LOY-' + rn + '-D' + (dishIdx++), fecha: createdAt, categoria: receta ? receta.categoria : '', producto: platillo, cantidad: qty, vendedor: 'Loyverse', notas: '[Loyverse]' });
      if (receta) {
        receta.ingredientes.forEach(function (ing) {
          if (!ing.cantidad || ing.cantidad <= 0) return;
          const k2 = norm(ing.producto);
          const cur = descuentos.get(k2) || { producto: ing.producto, cantidad: 0 };
          cur.cantidad += ing.cantidad * qty;
          descuentos.set(k2, cur);
        });
      }
      lineModifiersOf(li).forEach(function (mod) {
        const opt = mod.option || mod.name;
        if (!opt) return;
        const mk = norm(opt);
        if (modIgnoradoSet.has(mk)) return; // ej. "Sin queso": no aplica en esta app, no se vuelve a pedir
        const modMap = modifierByOption.get(mk);
        if (!modMap) {
          const sm = seenModifiersUpserts.get(opt) || { modifier_option: opt, modifier_name: mod.name || null, inc: 0, ultima_vez: createdAt || new Date().toISOString(), ultimo_recibo: rn };
          sm.inc += 1; sm.ultima_vez = createdAt || sm.ultima_vez; sm.ultimo_recibo = rn;
          seenModifiersUpserts.set(opt, sm);
          return;
        }
        if (!modMap.ingrediente || !modMap.cantidad) return;
        const k3 = norm(modMap.ingrediente);
        const cur3 = descuentos.get(k3) || { producto: modMap.ingrediente, cantidad: 0 };
        cur3.cantidad += modMap.cantidad * qty;
        descuentos.set(k3, cur3);
      });
    }

    if (ventasReceipt.length) {
      let i = 0;
      for (const d of descuentos.values()) {
        const cat = catalogoByNorm.get(norm(d.producto));
        ventasReceipt.push({ id: 'LOY-' + rn + '-I' + (i++), fecha: createdAt, categoria: cat ? cat.categoria : '', producto: cat ? cat.producto : d.producto, cantidad: Math.ceil(d.cantidad), vendedor: 'Loyverse', notas: 'Descuento Loyverse' });
      }
      pendientes.push({ receipt_number: rn, fecha: createdAt, resumen: resumenDe(ventasReceipt), ventas: ventasReceipt });
    }

    receiptsProcessed.push(rn);
    if (createdAt && (!maxCreatedAt || createdAt > maxCreatedAt)) maxCreatedAt = createdAt;
  }

  return {
    pendientes,
    seenItemsUpserts: Array.from(seenItemsUpserts.values()),
    seenModifiersUpserts: Array.from(seenModifiersUpserts.values()),
    receiptsProcessed,
    omitted,
    maxCreatedAt,
  };
}
