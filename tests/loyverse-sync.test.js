// Pruebas de la logica pura de sincronizacion con Loyverse (sin red, sin Deno).
// Uso: node tests/loyverse-sync.test.js
const { planSync, norm, receiptIsVoidOrRefund } = require('../supabase/functions/loyverse-sync/logic.mjs');

let fails = 0; function ok(c, m) { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; }

const mapRows = [
  { loyverse_item_name: 'Cheesecake', platillo: 'Cheesecake', activo: true },
  { loyverse_item_name: 'Café Americano', platillo: 'Café Americano', activo: true },
  { loyverse_item_name: 'Combo viejo', platillo: 'Croissant', activo: false }, // desactivado: se trata como no mapeado
];
const recetasRows = [
  { platillo: 'Cheesecake', categoria: 'Pasteles', ingrediente: 'Queso crema', cantidad: 0.2 },
  { platillo: 'Cheesecake', categoria: 'Pasteles', ingrediente: 'Harina', cantidad: 0.05 },
  { platillo: 'Café Americano', categoria: 'Bebidas', ingrediente: 'Café molido', cantidad: 0.02 },
  { platillo: 'Café Americano', categoria: 'Bebidas', ingrediente: 'Harina', cantidad: 0 }, // cantidad 0: se ignora
];
const catalogoRows = [
  { producto: 'Queso crema', categoria: 'Insumos' },
  { producto: 'Harina', categoria: 'Insumos' },
  { producto: 'Café molido', categoria: 'Bebidas' },
];

function receipt(over) {
  return Object.assign({ receipt_number: 'R1', created_at: '2026-09-25T10:00:00.000Z', line_items: [] }, over);
}

// ---- 1) item mapeado: crea la venta del platillo + descuentos de ingredientes, redondeados hacia arriba ----
{
  const r = receipt({ receipt_number: 'R100', line_items: [{ item_name: 'Cheesecake', quantity: 3 }] });
  const plan = planSync({ receipts: [r], mapRows, recetasRows, catalogoRows, processedSet: new Set(), cursorAfter: null });
  ok(plan.ventasInserts.length === 3, 'mapeado: 1 fila de platillo + 2 de ingrediente (Queso crema y Harina, cada uno por separado)');
  const dish = plan.ventasInserts.find(v => v.notas === '[Loyverse]');
  ok(dish && dish.producto === 'Cheesecake' && dish.cantidad === 3 && dish.categoria === 'Pasteles' && dish.vendedor === 'Loyverse', 'mapeado: la fila del platillo trae categoria, cantidad y vendedor=Loyverse');
  const queso = plan.ventasInserts.find(v => v.producto === 'Queso crema');
  ok(queso && queso.cantidad === Math.ceil(0.2 * 3) && queso.notas === 'Descuento Loyverse' && queso.categoria === 'Insumos', 'mapeado: descuento de Queso crema = 0.2*3 redondeado hacia arriba, con categoria del catalogo');
  ok(plan.receiptsProcessed[0] === 'R100', 'mapeado: el recibo queda marcado como procesado');
  ok(plan.seenItemsUpserts.length === 0, 'mapeado: no aparece como "sin mapear"');
}

// ---- 2) dos platillos que comparten un ingrediente en el mismo recibo: se suman antes de redondear ----
{
  const r = receipt({ receipt_number: 'R101', line_items: [{ item_name: 'Cheesecake', quantity: 1 }, { item_name: 'Cheesecake', quantity: 2 }] });
  const plan = planSync({ receipts: [r], mapRows, recetasRows, catalogoRows, processedSet: new Set() });
  const harina = plan.ventasInserts.find(v => v.producto === 'Harina');
  ok(harina && harina.cantidad === Math.ceil(0.05 * 3), 'suma antes de redondear: 0.05*1 + 0.05*2 = 0.15 -> redondeado 1 vez, no dos veces 0.05 redondeado');
  ok(plan.ventasInserts.filter(v => v.producto === 'Harina').length === 1, 'un solo renglon de descuento por ingrediente por recibo, no uno por linea');
}

// ---- 3) producto sin mapear: no se descuenta nada, se registra para que el admin lo empareje ----
{
  const r = receipt({ receipt_number: 'R102', line_items: [{ item_name: 'Malteada de fresa', quantity: 2, item_id: 'abc' }] });
  const plan = planSync({ receipts: [r], mapRows, recetasRows, catalogoRows, processedSet: new Set() });
  ok(plan.ventasInserts.length === 0, 'sin mapear: no toca el inventario');
  ok(plan.seenItemsUpserts.length === 1 && plan.seenItemsUpserts[0].item_name === 'Malteada de fresa' && plan.seenItemsUpserts[0].item_id === 'abc', 'sin mapear: queda en la lista para emparejar, con su item_id');
  ok(plan.receiptsProcessed[0] === 'R102', 'sin mapear: el recibo igual queda marcado (no se reintenta cada vez)');
}

// ---- 4) mapeo desactivado se trata igual que "sin mapear" ----
{
  const r = receipt({ receipt_number: 'R103', line_items: [{ item_name: 'Combo viejo', quantity: 1 }] });
  const plan = planSync({ receipts: [r], mapRows, recetasRows, catalogoRows, processedSet: new Set() });
  ok(plan.ventasInserts.length === 0 && plan.seenItemsUpserts.length === 1, 'mapeo con activo=false no descuenta y aparece como pendiente');
}

// ---- 5) reembolsos / cancelados: se omiten por completo ----
{
  ok(receiptIsVoidOrRefund({ cancelled_at: '2026-09-25T10:05:00Z' }), 'detecta cancelled_at');
  ok(receiptIsVoidOrRefund({ refund_for: 'R100' }), 'detecta refund_for');
  ok(receiptIsVoidOrRefund({ receipt_type: 'REFUND' }), 'detecta receipt_type REFUND');
  ok(!receiptIsVoidOrRefund({ receipt_type: 'SALE' }), 'una venta normal no se marca como reembolso');
  const r = receipt({ receipt_number: 'R104', cancelled_at: '2026-09-25T10:05:00Z', line_items: [{ item_name: 'Cheesecake', quantity: 5 }] });
  const plan = planSync({ receipts: [r], mapRows, recetasRows, catalogoRows, processedSet: new Set() });
  ok(plan.ventasInserts.length === 0, 'cancelado: no descuenta nada aunque tenga line_items mapeados');
  ok(plan.omitted.length === 1 && plan.omitted[0].receipt_number === 'R104' && /reembolso|cancelado/.test(plan.omitted[0].motivo), 'cancelado: queda listado como omitido con motivo');
  ok(plan.receiptsProcessed[0] === 'R104', 'cancelado: tambien se marca procesado (no se re-evalua cada corrida)');
}

// ---- 6) ya procesado (reintento) no se vuelve a aplicar ----
{
  const r = receipt({ receipt_number: 'R100', line_items: [{ item_name: 'Cheesecake', quantity: 3 }] });
  const plan = planSync({ receipts: [r], mapRows, recetasRows, catalogoRows, processedSet: new Set(['R100']) });
  ok(plan.ventasInserts.length === 0 && plan.receiptsProcessed.length === 0, 'un recibo ya en loyverse_processed_receipts no se procesa otra vez');
}

// ---- 7) cursorAfter: ignora recibos anteriores o iguales al ultimo sincronizado ----
{
  const viejo = receipt({ receipt_number: 'R90', created_at: '2026-09-20T09:00:00Z', line_items: [{ item_name: 'Cheesecake', quantity: 1 }] });
  const nuevo = receipt({ receipt_number: 'R91', created_at: '2026-09-26T09:00:00Z', line_items: [{ item_name: 'Cheesecake', quantity: 1 }] });
  const plan = planSync({ receipts: [viejo, nuevo], mapRows, recetasRows, catalogoRows, processedSet: new Set(), cursorAfter: '2026-09-25T00:00:00Z' });
  ok(plan.receiptsProcessed.length === 1 && plan.receiptsProcessed[0] === 'R91', 'cursorAfter: filtra recibos con created_at anterior o igual al cursor');
  ok(plan.maxCreatedAt === '2026-09-26T09:00:00Z', 'el cursor siguiente avanza hasta el ultimo recibo aplicado');
}

// ---- 8) varios recibos en una corrida: el orden de llegada no importa para el resultado final ----
{
  const rA = receipt({ receipt_number: 'RA', created_at: '2026-09-25T08:00:00Z', line_items: [{ item_name: 'Café Americano', quantity: 1 }] });
  const rB = receipt({ receipt_number: 'RB', created_at: '2026-09-25T09:00:00Z', line_items: [{ item_name: 'Producto que no existe', quantity: 4 }] });
  const plan = planSync({ receipts: [rA, rB], mapRows, recetasRows, catalogoRows, processedSet: new Set() });
  ok(plan.receiptsProcessed.length === 2, 'procesa ambos recibos de la corrida');
  ok(plan.ventasInserts.some(v => v.producto === 'Café Americano'), 'el recibo mapeado genera su venta');
  ok(plan.seenItemsUpserts.some(s => s.item_name === 'Producto que no existe'), 'el recibo no mapeado queda pendiente de emparejar');
  ok(plan.maxCreatedAt === '2026-09-25T09:00:00Z', 'el cursor toma el created_at mas reciente de la corrida');
}

// ---- 9) cantidades no numericas o en 0 no rompen nada ----
{
  const r = receipt({ receipt_number: 'R105', line_items: [{ item_name: 'Cheesecake', quantity: 0 }, { item_name: '', quantity: 2 }, { item_name: 'Cheesecake', quantity: '2' }] });
  const plan = planSync({ receipts: [r], mapRows, recetasRows, catalogoRows, processedSet: new Set() });
  ok(plan.ventasInserts.some(v => v.cantidad === 2), 'quantity como texto ("2") se interpreta igual que numero');
  ok(plan.ventasInserts.filter(v => v.notas === '[Loyverse]').length === 1, 'las lineas con cantidad 0 o sin nombre se ignoran');
}

ok(norm('Café Americano') === norm('CAFE   americano'), 'norm() ignora acentos, mayusculas y espacios repetidos, igual que en el resto de la app');

console.log(fails ? '\n' + fails + ' FALLAS' : '\nTODO OK');
process.exit(fails ? 1 : 0);
