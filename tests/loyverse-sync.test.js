// Pruebas de la logica pura de sincronizacion con Loyverse (sin red, sin Deno).
// Uso: node tests/loyverse-sync.test.js
const { planSync, norm, receiptIsVoidOrRefund } = require('../supabase/functions/loyverse-sync/logic.mjs');

let fails = 0; function ok(c, m) { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; }

const mapRows = [
  { loyverse_item_name: 'Cheesecake', platillo: 'Cheesecake', activo: true },
  { loyverse_item_name: 'Café Americano', platillo: 'Café Americano', activo: true },
  { loyverse_item_name: 'Combo viejo', platillo: 'Croissant', activo: false }, // desactivado: se trata como no mapeado
  { loyverse_item_name: 'Shaker Americano', platillo: null, ignorado: true }, // bebida: ignorado a proposito (no aplica en esta app)
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
function idsUnicos(ventas) {
  const ids = ventas.map(function (v) { return v.id; });
  return new Set(ids).size === ids.length;
}

// ---- 1) item mapeado: 1 pendiente por recibo, con la venta del platillo + descuentos de ingredientes redondeados hacia arriba ----
{
  const r = receipt({ receipt_number: 'R100', line_items: [{ item_name: 'Cheesecake', quantity: 3 }] });
  const plan = planSync({ receipts: [r], mapRows, recetasRows, catalogoRows, processedSet: new Set(), cursorAfter: null });
  ok(plan.pendientes.length === 1 && plan.pendientes[0].receipt_number === 'R100', 'mapeado: se arma 1 pendiente para el recibo (no se escribe nada todavia)');
  const ventas = plan.pendientes[0].ventas;
  ok(ventas.length === 3, 'mapeado: 1 fila de platillo + 2 de ingrediente (Queso crema y Harina, cada uno por separado)');
  ok(idsUnicos(ventas), 'mapeado: todos los ids de las filas del recibo son unicos');
  const dish = ventas.find(v => v.notas === '[Loyverse]');
  ok(dish && dish.producto === 'Cheesecake' && dish.cantidad === 3 && dish.categoria === 'Pasteles' && dish.vendedor === 'Loyverse', 'mapeado: la fila del platillo trae categoria, cantidad y vendedor=Loyverse');
  const queso = ventas.find(v => v.producto === 'Queso crema');
  ok(queso && queso.cantidad === Math.ceil(0.2 * 3) && queso.notas === 'Descuento Loyverse' && queso.categoria === 'Insumos', 'mapeado: descuento de Queso crema = 0.2*3 redondeado hacia arriba, con categoria del catalogo');
  ok(plan.pendientes[0].resumen === '3x Cheesecake', 'mapeado: el resumen del recibo es legible ("3x Cheesecake")');
  ok(plan.receiptsProcessed[0] === 'R100', 'mapeado: el recibo queda marcado como procesado');
  ok(plan.seenItemsUpserts.length === 0, 'mapeado: no aparece como "sin mapear"');
}

// ---- 2) dos platillos que comparten un ingrediente en el mismo recibo: se suman antes de redondear ----
{
  const r = receipt({ receipt_number: 'R101', line_items: [{ item_name: 'Cheesecake', quantity: 1 }, { item_name: 'Cheesecake', quantity: 2 }] });
  const plan = planSync({ receipts: [r], mapRows, recetasRows, catalogoRows, processedSet: new Set() });
  const ventas = plan.pendientes[0].ventas;
  const harina = ventas.find(v => v.producto === 'Harina');
  ok(harina && harina.cantidad === Math.ceil(0.05 * 3), 'suma antes de redondear: 0.05*1 + 0.05*2 = 0.15 -> redondeado 1 vez, no dos veces 0.05 redondeado');
  ok(ventas.filter(v => v.producto === 'Harina').length === 1, 'un solo renglon de descuento por ingrediente por recibo, no uno por linea');
}

// ---- 3) dos PLATILLOS DISTINTOS mapeados en el mismo recibo: antes se perdia uno por ids repetidos ----
{
  const r = receipt({ receipt_number: 'R106', line_items: [{ item_name: 'Cheesecake', quantity: 1 }, { item_name: 'Café Americano', quantity: 2 }] });
  const plan = planSync({ receipts: [r], mapRows, recetasRows, catalogoRows, processedSet: new Set() });
  ok(plan.pendientes.length === 1, 'dos platillos distintos en un recibo: sigue siendo 1 pendiente (por recibo)');
  const ventas = plan.pendientes[0].ventas;
  const platillosVendidos = ventas.filter(v => v.notas === '[Loyverse]');
  ok(platillosVendidos.length === 2, 'ambos platillos quedan como fila de venta (antes uno se perdia por id duplicado)');
  ok(idsUnicos(ventas), 'ids unicos aunque haya 2 platillos + sus ingredientes en el mismo recibo');
  ok(plan.pendientes[0].resumen === '1x Cheesecake, 2x Café Americano', 'resumen lista ambos platillos del recibo');
}

// ---- 4) producto sin mapear: no genera pendiente, se registra para que el admin lo empareje ----
{
  const r = receipt({ receipt_number: 'R102', line_items: [{ item_name: 'Malteada de fresa', quantity: 2, item_id: 'abc' }] });
  const plan = planSync({ receipts: [r], mapRows, recetasRows, catalogoRows, processedSet: new Set() });
  ok(plan.pendientes.length === 0, 'sin mapear: no genera pendiente (no hay nada que aceptar)');
  ok(plan.seenItemsUpserts.length === 1 && plan.seenItemsUpserts[0].item_name === 'Malteada de fresa' && plan.seenItemsUpserts[0].item_id === 'abc', 'sin mapear: queda en la lista para emparejar, con su item_id');
  ok(plan.receiptsProcessed[0] === 'R102', 'sin mapear: el recibo igual queda marcado (no se reintenta cada vez)');
}

// ---- 5) mapeo desactivado (pausado) se trata igual que "sin mapear" ----
{
  const r = receipt({ receipt_number: 'R103', line_items: [{ item_name: 'Combo viejo', quantity: 1 }] });
  const plan = planSync({ receipts: [r], mapRows, recetasRows, catalogoRows, processedSet: new Set() });
  ok(plan.pendientes.length === 0 && plan.seenItemsUpserts.length === 1, 'mapeo con activo=false no genera pendiente y aparece como pendiente de emparejar');
}

// ---- 6) ignorado (ej. una bebida): no genera pendiente NI vuelve a pedir que lo emparejen ----
{
  const r = receipt({ receipt_number: 'R107', line_items: [{ item_name: 'Shaker Americano', quantity: 2 }] });
  const plan = planSync({ receipts: [r], mapRows, recetasRows, catalogoRows, processedSet: new Set() });
  ok(plan.pendientes.length === 0, 'ignorado: no genera pendiente de aceptar (no descuenta)');
  ok(plan.seenItemsUpserts.length === 0, 'ignorado: tampoco aparece en "por emparejar" (a diferencia de uno pausado o sin decidir)');
  ok(plan.receiptsProcessed[0] === 'R107', 'ignorado: el recibo igual queda marcado como procesado');
}

// ---- 7) reembolsos / cancelados: se omiten por completo ----
{
  ok(receiptIsVoidOrRefund({ cancelled_at: '2026-09-25T10:05:00Z' }), 'detecta cancelled_at');
  ok(receiptIsVoidOrRefund({ refund_for: 'R100' }), 'detecta refund_for');
  ok(receiptIsVoidOrRefund({ receipt_type: 'REFUND' }), 'detecta receipt_type REFUND');
  ok(!receiptIsVoidOrRefund({ receipt_type: 'SALE' }), 'una venta normal no se marca como reembolso');
  const r = receipt({ receipt_number: 'R104', cancelled_at: '2026-09-25T10:05:00Z', line_items: [{ item_name: 'Cheesecake', quantity: 5 }] });
  const plan = planSync({ receipts: [r], mapRows, recetasRows, catalogoRows, processedSet: new Set() });
  ok(plan.pendientes.length === 0, 'cancelado: no genera pendiente aunque tenga line_items mapeados');
  ok(plan.omitted.length === 1 && plan.omitted[0].receipt_number === 'R104' && /reembolso|cancelado/.test(plan.omitted[0].motivo), 'cancelado: queda listado como omitido con motivo');
  ok(plan.receiptsProcessed[0] === 'R104', 'cancelado: tambien se marca procesado (no se re-evalua cada corrida)');
}

// ---- 8) ya procesado (reintento) no se vuelve a aplicar ----
{
  const r = receipt({ receipt_number: 'R100', line_items: [{ item_name: 'Cheesecake', quantity: 3 }] });
  const plan = planSync({ receipts: [r], mapRows, recetasRows, catalogoRows, processedSet: new Set(['R100']) });
  ok(plan.pendientes.length === 0 && plan.receiptsProcessed.length === 0, 'un recibo ya en loyverse_processed_receipts no se procesa otra vez');
}

// ---- 9) cursorAfter: ignora recibos anteriores o iguales al ultimo sincronizado ----
{
  const viejo = receipt({ receipt_number: 'R90', created_at: '2026-09-20T09:00:00Z', line_items: [{ item_name: 'Cheesecake', quantity: 1 }] });
  const nuevo = receipt({ receipt_number: 'R91', created_at: '2026-09-26T09:00:00Z', line_items: [{ item_name: 'Cheesecake', quantity: 1 }] });
  const plan = planSync({ receipts: [viejo, nuevo], mapRows, recetasRows, catalogoRows, processedSet: new Set(), cursorAfter: '2026-09-25T00:00:00Z' });
  ok(plan.receiptsProcessed.length === 1 && plan.receiptsProcessed[0] === 'R91', 'cursorAfter: filtra recibos con created_at anterior o igual al cursor');
  ok(plan.maxCreatedAt === '2026-09-26T09:00:00Z', 'el cursor siguiente avanza hasta el ultimo recibo aplicado');
}

// ---- 10) varios recibos en una corrida: el orden de llegada no importa para el resultado final ----
{
  const rA = receipt({ receipt_number: 'RA', created_at: '2026-09-25T08:00:00Z', line_items: [{ item_name: 'Café Americano', quantity: 1 }] });
  const rB = receipt({ receipt_number: 'RB', created_at: '2026-09-25T09:00:00Z', line_items: [{ item_name: 'Producto que no existe', quantity: 4 }] });
  const plan = planSync({ receipts: [rA, rB], mapRows, recetasRows, catalogoRows, processedSet: new Set() });
  ok(plan.receiptsProcessed.length === 2, 'procesa ambos recibos de la corrida');
  ok(plan.pendientes.some(p => p.receipt_number === 'RA'), 'el recibo mapeado genera su pendiente');
  ok(!plan.pendientes.some(p => p.receipt_number === 'RB'), 'el recibo no mapeado no genera pendiente');
  ok(plan.seenItemsUpserts.some(s => s.item_name === 'Producto que no existe'), 'el recibo no mapeado queda pendiente de emparejar');
  ok(plan.maxCreatedAt === '2026-09-25T09:00:00Z', 'el cursor toma el created_at mas reciente de la corrida');
}

// ---- 11) cantidades no numericas o en 0 no rompen nada ----
{
  const r = receipt({ receipt_number: 'R105', line_items: [{ item_name: 'Cheesecake', quantity: 0 }, { item_name: '', quantity: 2 }, { item_name: 'Cheesecake', quantity: '2' }] });
  const plan = planSync({ receipts: [r], mapRows, recetasRows, catalogoRows, processedSet: new Set() });
  const ventas = plan.pendientes[0].ventas;
  ok(ventas.some(v => v.cantidad === 2), 'quantity como texto ("2") se interpreta igual que numero');
  ok(ventas.filter(v => v.notas === '[Loyverse]').length === 1, 'las lineas con cantidad 0 o sin nombre se ignoran');
}

// ---- 12) modificadores (ej. proteina/tipo de pasta): "PST Amatriciana" siempre se llama igual en
// Loyverse sin importar la opcion elegida -- esa opcion se mapea aparte, una sola vez, a un
// ingrediente+cantidad que se suma al descuento normal de la receta.
const modifierMapRows = [
  { modifier_option: 'Arrachera', ingrediente: 'Arrachera', cantidad: 0.15, activo: true },
  { modifier_option: 'Fusilli', ingrediente: 'Pasta fusilli', cantidad: 0.1, activo: true },
  { modifier_option: 'Sin queso', ingrediente: null, ignorado: true },
];
{
  const r = receipt({ receipt_number: 'R200', line_items: [{ item_name: 'Cheesecake', quantity: 2, line_modifiers: [{ name: 'Proteina', option: 'Arrachera' }] }] });
  const plan = planSync({ receipts: [r], mapRows, recetasRows, catalogoRows, processedSet: new Set(), modifierMapRows });
  const ventas = plan.pendientes[0].ventas;
  const arrachera = ventas.find(v => v.producto === 'Arrachera');
  ok(!!arrachera && arrachera.cantidad === Math.ceil(0.15 * 2), 'modificador mapeado: suma su ingrediente (cantidad x qty vendida, redondeado hacia arriba)');
  ok(ventas.some(v => v.producto === 'Queso crema'), 'modificador mapeado: no reemplaza los ingredientes normales de la receta, se suman aparte');
}
{
  const r = receipt({ receipt_number: 'R201', line_items: [{ item_name: 'Cheesecake', quantity: 1, line_modifiers: [{ name: 'Tipo de pasta', option: 'Espagueti' }] }] });
  const plan = planSync({ receipts: [r], mapRows, recetasRows, catalogoRows, processedSet: new Set(), modifierMapRows });
  ok(plan.pendientes.length === 1, 'modificador sin mapear: el platillo igual genera su pendiente (solo falta el ingrediente del modificador)');
  ok(plan.seenModifiersUpserts.some(s => s.modifier_option === 'Espagueti'), 'modificador sin mapear: queda pendiente de emparejar (aparte de los productos)');
}
{
  const r = receipt({ receipt_number: 'R202', line_items: [{ item_name: 'Cheesecake', quantity: 1, line_modifiers: [{ name: 'Extra', option: 'Sin queso' }] }] });
  const plan = planSync({ receipts: [r], mapRows, recetasRows, catalogoRows, processedSet: new Set(), modifierMapRows });
  ok(!plan.seenModifiersUpserts.some(s => s.modifier_option === 'Sin queso'), 'modificador ignorado: no se vuelve a pedir que se empareje');
  ok(plan.pendientes[0].ventas.length === 3, 'modificador ignorado: no agrega ninguna fila de ingrediente (1 platillo + 2 ingredientes de la receta nada mas)');
}
{
  const r = receipt({ receipt_number: 'R203', line_items: [{ item_name: 'Producto que no existe', quantity: 1, line_modifiers: [{ name: 'Proteina', option: 'Arrachera' }] }] });
  const plan = planSync({ receipts: [r], mapRows, recetasRows, catalogoRows, processedSet: new Set(), modifierMapRows });
  ok(!plan.seenModifiersUpserts.length, 'si el platillo mismo no esta mapeado, sus modificadores ni se revisan (se resuelve el platillo primero)');
}
{
  const r = receipt({ receipt_number: 'R204', line_items: [
    { item_name: 'Cheesecake', quantity: 2, line_modifiers: [{ name: 'Proteina', option: 'Arrachera' }] },
    { item_name: 'Café Americano', quantity: 1, line_modifiers: [{ name: 'Tipo de pasta', option: 'Fusilli' }] },
  ] });
  const plan = planSync({ receipts: [r], mapRows, recetasRows, catalogoRows, processedSet: new Set(), modifierMapRows });
  const ventas = plan.pendientes[0].ventas;
  ok(ventas.some(v => v.producto === 'Arrachera') && ventas.some(v => v.producto === 'Pasta fusilli'), 'varias lineas del mismo recibo con distintos modificadores mapeados suman cada ingrediente por separado');
}
{
  const pausedModMap = [{ modifier_option: 'Arrachera', ingrediente: 'Arrachera', cantidad: 0.15, activo: false }];
  const r = receipt({ receipt_number: 'R205', line_items: [{ item_name: 'Cheesecake', quantity: 1, line_modifiers: [{ name: 'Proteina', option: 'Arrachera' }] }] });
  const plan = planSync({ receipts: [r], mapRows, recetasRows, catalogoRows, processedSet: new Set(), modifierMapRows: pausedModMap });
  ok(!plan.pendientes[0].ventas.some(v => v.producto === 'Arrachera'), 'modificador pausado (activo:false) se trata como sin mapear: no descuenta');
  ok(plan.seenModifiersUpserts.some(s => s.modifier_option === 'Arrachera'), 'modificador pausado vuelve a aparecer como pendiente de emparejar');
}

ok(norm('Café Americano') === norm('CAFE   americano'), 'norm() ignora acentos, mayusculas y espacios repetidos, igual que en el resto de la app');

console.log(fails ? '\n' + fails + ' FALLAS' : '\nTODO OK');
process.exit(fails ? 1 : 0);
