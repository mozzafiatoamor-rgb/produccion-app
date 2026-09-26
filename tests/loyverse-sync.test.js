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

// ---- 12) variantes (ej. proteina/tipo de pasta): "PST ALFREDO" siempre se llama igual en
// Loyverse sin importar que eligio el cliente -- esa eleccion viaja en variant_name (confirmado
// con recibos reales, ver docs/LOYVERSE.md), NO en line_modifiers. Cada combinacion item+variante
// se mapea como un producto mas, igual que cualquier otro (item_name + " - " + variant_name).
const variantMapRows = [
  { loyverse_item_name: 'PST ALFREDO - Fetuccini / Pollo', platillo: 'Alfredo Fettuccini Pollo', activo: true },
];
const variantRecetasRows = [
  { platillo: 'Alfredo Fettuccini Pollo', categoria: 'Pastas', ingrediente: 'Salsa alfredo', cantidad: 0.2 },
  { platillo: 'Alfredo Fettuccini Pollo', categoria: 'Pastas', ingrediente: 'Pechuga de pollo', cantidad: 0.15 },
];
{
  const r = receipt({ receipt_number: 'R200', line_items: [{ item_name: 'PST ALFREDO', variant_name: 'Fetuccini / Pollo', quantity: 2 }] });
  const plan = planSync({ receipts: [r], mapRows: variantMapRows, recetasRows: variantRecetasRows, catalogoRows, processedSet: new Set() });
  ok(plan.pendientes.length === 1 && plan.pendientes[0].ventas.some(v => v.producto === 'Alfredo Fettuccini Pollo'), 'variante mapeada (item_name + variant_name juntos): genera su pendiente con el platillo exacto');
  ok(plan.pendientes[0].ventas.some(v => v.producto === 'Salsa alfredo') && plan.pendientes[0].ventas.some(v => v.producto === 'Pechuga de pollo'), 'variante mapeada: descuenta los ingredientes de la receta exacta de esa combinacion');
}
{
  // misma comida (item_name), OTRA variante no mapeada -> no se confunde con la de arriba
  const r = receipt({ receipt_number: 'R201', line_items: [{ item_name: 'PST ALFREDO', variant_name: 'Fusilli / Arrachera', quantity: 1 }] });
  const plan = planSync({ receipts: [r], mapRows: variantMapRows, recetasRows: variantRecetasRows, catalogoRows, processedSet: new Set() });
  ok(!plan.pendientes.length, 'una variante distinta del mismo item_name no mapeada no genera pendiente (se trata como producto nuevo, no como el ya mapeado)');
  ok(plan.seenItemsUpserts.some(s => s.item_name === 'PST ALFREDO - Fusilli / Arrachera'), 'la variante sin mapear se registra con su nombre completo (item + variante) para que se empareje aparte');
}
{
  // producto sin variante (variant_name null): se usa solo el item_name, como antes
  const r = receipt({ receipt_number: 'R202', line_items: [{ item_name: 'Cheesecake', variant_name: null, quantity: 1 }] });
  const plan = planSync({ receipts: [r], mapRows, recetasRows, catalogoRows, processedSet: new Set() });
  ok(plan.pendientes.length === 1 && plan.pendientes[0].ventas.some(v => v.producto === 'Cheesecake'), 'producto sin variante (variant_name null) sigue usando solo el item_name, igual que siempre');
}
{
  // dos lineas del mismo recibo, mismo item_name, variantes distintas, ninguna mapeada -> las dos se registran por separado
  const r = receipt({ receipt_number: 'R203', line_items: [
    { item_name: 'CHAPATA', variant_name: 'Mar y tierra', quantity: 1 },
    { item_name: 'CHAPATA', variant_name: 'Pechuga de pollo', quantity: 1 },
  ] });
  const plan = planSync({ receipts: [r], mapRows: [], recetasRows: [], catalogoRows, processedSet: new Set() });
  ok(plan.seenItemsUpserts.some(s => s.item_name === 'CHAPATA - Mar y tierra') && plan.seenItemsUpserts.some(s => s.item_name === 'CHAPATA - Pechuga de pollo'), 'dos variantes distintas del mismo item_name en un recibo se registran como dos productos separados, no se pisan');
}

ok(norm('Café Americano') === norm('CAFE   americano'), 'norm() ignora acentos, mayusculas y espacios repetidos, igual que en el resto de la app');

console.log(fails ? '\n' + fails + ' FALLAS' : '\nTODO OK');
process.exit(fails ? 1 : 0);
