// supabase/functions/loyverse-sync/index.ts
// Edge Function (Deno) que se llama sola cada pocos minutos (cron, ver docs/LOYVERSE.md).
// Lee ventas nuevas de Loyverse, las cruza contra Recetas y descuenta el inventario,
// exactamente como hace "Venta TPV" a mano en la app -- ver planSync() en logic.mjs.
//
// Secretos que necesita (Project Settings > Edge Functions > Secrets):
//   LOYVERSE_TOKEN      token de acceso de Loyverse (Back Office > Access Tokens)
//   LOYVERSE_DRY_RUN    "true" para probar sin escribir nada (recomendado en el primer despliegue)
// SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY los da Supabase automaticamente a toda Edge Function.

import { planSync } from './logic.mjs';

const SCHEMA = 'produccion_app';
const SB_URL = Deno.env.get('SUPABASE_URL')!;
const SB_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const LOY_TOKEN = Deno.env.get('LOYVERSE_TOKEN') || '';
const DRY_RUN = (Deno.env.get('LOYVERSE_DRY_RUN') || '').toLowerCase() === 'true';
const LOY_BASE = 'https://api.loyverse.com/v1.0';

function sbHeaders(extra?: Record<string, string>) {
  return Object.assign({
    apikey: SB_KEY,
    Authorization: 'Bearer ' + SB_KEY,
    'Content-Type': 'application/json',
    'Accept-Profile': SCHEMA,
    'Content-Profile': SCHEMA,
  }, extra || {});
}
async function sbGet(path: string) {
  const r = await fetch(SB_URL + '/rest/v1/' + path, { headers: sbHeaders() });
  const txt = await r.text();
  if (!r.ok) throw new Error('Supabase GET ' + path + ' -> ' + r.status + ' ' + txt.slice(0, 300));
  if (!txt) throw new Error('Supabase GET ' + path + ' -> ' + r.status + ' respuesta vacia (sin cuerpo)');
  try { return JSON.parse(txt); } catch (_e) { throw new Error('Supabase GET ' + path + ' -> ' + r.status + ' respuesta no-JSON: ' + txt.slice(0, 300)); }
}
async function sbWrite(path: string, method: string, body: unknown, prefer: string) {
  const r = await fetch(SB_URL + '/rest/v1/' + path, {
    method, headers: sbHeaders({ Prefer: prefer }), body: JSON.stringify(body),
  });
  const txt = await r.text();
  if (!r.ok) throw new Error('Supabase ' + method + ' ' + path + ' -> ' + r.status + ' ' + txt.slice(0, 300));
  if (!txt) return null;
  try { return JSON.parse(txt); } catch (_e) { throw new Error('Supabase ' + method + ' ' + path + ' -> ' + r.status + ' respuesta no-JSON: ' + txt.slice(0, 300)); }
}

async function fetchNewReceipts(sinceISO: string | null) {
  const out: any[] = [];
  let cursor: string | null = null;
  for (;;) {
    const p = new URLSearchParams({ limit: '250' });
    if (sinceISO) p.set('created_at_min', new Date(sinceISO).toISOString());
    if (cursor) p.set('cursor', cursor);
    const r = await fetch(LOY_BASE + '/receipts?' + p.toString(), { headers: { Authorization: 'Bearer ' + LOY_TOKEN } });
    const txt = await r.text();
    if (!r.ok) throw new Error('Loyverse GET /receipts -> ' + r.status + ' ' + txt.slice(0, 300));
    if (!txt) throw new Error('Loyverse GET /receipts -> ' + r.status + ' respuesta vacia (sin cuerpo) -- posible corte de red o limite de la API');
    let j: any;
    try { j = JSON.parse(txt); } catch (_e) { throw new Error('Loyverse GET /receipts -> ' + r.status + ' respuesta no-JSON: ' + txt.slice(0, 300)); }
    const receipts = j.receipts || j.data || (Array.isArray(j) ? j : []);
    out.push(...receipts);
    cursor = j.cursor || null;
    if (!cursor || !receipts.length) break;
  }
  out.sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
  return out;
}

async function run() {
  if (!LOY_TOKEN) throw new Error('Falta el secreto LOYVERSE_TOKEN (Project Settings > Edge Functions > Secrets)');

  const [state] = await sbGet('loyverse_sync_state?id=eq.1&select=last_created_at');
  let cursor = state ? state.last_created_at : null;

  if (!cursor) {
    // Primera corrida: todavia no hay cursor guardado. En vez de traer TODO el historico
    // de Loyverse (que ademas esta limitado a 31 dias sin el addon "Unlimited Sales
    // History" -> 402 Payment Required), arrancamos el cursor en "ahora": de aqui en
    // adelante se sincroniza normal, sin importar ventas pasadas ni tocar el inventario
    // por algo que ya ocurrio antes de activar esto.
    cursor = new Date().toISOString();
    await sbWrite('loyverse_sync_state?id=eq.1', 'PATCH', {
      last_created_at: cursor, last_run_at: new Date().toISOString(), last_run_ok: true,
      last_run_detalle: 'primera corrida: cursor inicializado en ' + cursor + ' (no se importo historico)',
    }, 'return=minimal');
    return { recibos: 0, nota: 'cursor inicializado en ' + cursor + ', no se importo historico' };
  }

  const receipts = await fetchNewReceipts(cursor);
  if (!receipts.length) {
    await sbWrite('loyverse_sync_state?id=eq.1', 'PATCH', { last_run_at: new Date().toISOString(), last_run_ok: true, last_run_detalle: 'sin recibos nuevos' }, 'return=minimal');
    return { recibos: 0 };
  }

  const receiptNumbers = receipts.map((r: any) => r.receipt_number).filter(Boolean);
  const [mapRows, modifierMapRows, recetasRows, catalogoRows, processedRows] = await Promise.all([
    sbGet('loyverse_map?select=loyverse_item_name,platillo,activo,ignorado'),
    sbGet('loyverse_modifier_map?select=modifier_option,ingrediente,cantidad,activo,ignorado'),
    sbGet('recetas?select=platillo,categoria,ingrediente,cantidad&limit=5000'),
    sbGet('catalogo?select=producto,categoria&limit=1000'),
    receiptNumbers.length
      ? sbGet('loyverse_processed_receipts?receipt_number=in.(' + receiptNumbers.map((n: string) => '"' + n.replace(/"/g, '') + '"').join(',') + ')&select=receipt_number')
      : Promise.resolve([]),
  ]);
  const processedSet = new Set(processedRows.map((r: any) => r.receipt_number));

  const plan = planSync({ receipts, mapRows, modifierMapRows, recetasRows, catalogoRows, processedSet, cursorAfter: cursor });

  if (DRY_RUN) {
    return {
      modo: 'PRUEBA (no se escribio nada)', recibos: receipts.length,
      pendientesQueSeCrearian: plan.pendientes, productosNoMapeados: plan.seenItemsUpserts,
      modificadoresNoMapeados: plan.seenModifiersUpserts,
      recibosOmitidos: plan.omitted, cursorSiguiente: plan.maxCreatedAt,
    };
  }

  // No se escribe en `ventas` todavia: se deja como pendiente para que un usuario logueado lo
  // revise y lo acepte desde la app (Ajustes > Loyverse > pendientes), igual que se hacia a mano
  // al cerrar turno. on_conflict=receipt_number es defensivo (receiptsProcessed ya evita esto).
  if (plan.pendientes.length) {
    await sbWrite('loyverse_pending?on_conflict=receipt_number', 'POST', plan.pendientes.map((p: any) => ({
      receipt_number: p.receipt_number, fecha: p.fecha, resumen: p.resumen, ventas_payload: p.ventas,
    })), 'return=minimal,resolution=ignore-duplicates');
  }
  if (plan.seenItemsUpserts.length) {
    const names = plan.seenItemsUpserts.map((s: any) => '"' + s.item_name.replace(/"/g, '') + '"').join(',');
    const existentes = await sbGet('loyverse_seen_items?item_name=in.(' + names + ')&select=item_name,veces');
    const vecesPrevias = new Map(existentes.map((e: any) => [e.item_name, e.veces]));
    const filas = plan.seenItemsUpserts.map((s: any) => ({
      item_name: s.item_name, item_id: s.item_id, ultima_vez: s.ultima_vez, ultimo_recibo: s.ultimo_recibo,
      veces: (vecesPrevias.get(s.item_name) || 0) + s.inc,
    }));
    await sbWrite('loyverse_seen_items?on_conflict=item_name', 'POST', filas, 'return=minimal,resolution=merge-duplicates');
  }
  if (plan.seenModifiersUpserts.length) {
    const opts = plan.seenModifiersUpserts.map((s: any) => '"' + s.modifier_option.replace(/"/g, '') + '"').join(',');
    const existentes = await sbGet('loyverse_modifiers_seen?modifier_option=in.(' + opts + ')&select=modifier_option,veces');
    const vecesPrevias = new Map(existentes.map((e: any) => [e.modifier_option, e.veces]));
    const filas = plan.seenModifiersUpserts.map((s: any) => ({
      modifier_option: s.modifier_option, modifier_name: s.modifier_name, ultima_vez: s.ultima_vez, ultimo_recibo: s.ultimo_recibo,
      veces: (vecesPrevias.get(s.modifier_option) || 0) + s.inc,
    }));
    await sbWrite('loyverse_modifiers_seen?on_conflict=modifier_option', 'POST', filas, 'return=minimal,resolution=merge-duplicates');
  }
  if (plan.receiptsProcessed.length) {
    await sbWrite('loyverse_processed_receipts?on_conflict=receipt_number', 'POST',
      plan.receiptsProcessed.map((n: string) => ({ receipt_number: n })), 'return=minimal,resolution=ignore-duplicates');
  }
  await sbWrite('loyverse_sync_state?id=eq.1', 'PATCH', {
    last_created_at: plan.maxCreatedAt || cursor,
    last_run_at: new Date().toISOString(), last_run_ok: true,
    last_run_detalle: receipts.length + ' recibos, ' + plan.pendientes.length + ' pendientes de aceptar, ' + plan.seenItemsUpserts.length + ' productos sin mapear, ' + plan.seenModifiersUpserts.length + ' modificadores sin mapear, ' + plan.omitted.length + ' omitidos',
  }, 'return=minimal');

  return { recibos: receipts.length, pendientesCreados: plan.pendientes.length, sinMapear: plan.seenItemsUpserts.length, modificadoresSinMapear: plan.seenModifiersUpserts.length, omitidos: plan.omitted.length };
}

Deno.serve(async (_req: Request) => {
  try {
    const resultado = await run();
    return new Response(JSON.stringify(resultado), { headers: { 'content-type': 'application/json' } });
  } catch (e) {
    try {
      await sbWrite('loyverse_sync_state?id=eq.1', 'PATCH', { last_run_at: new Date().toISOString(), last_run_ok: false, last_run_detalle: String(e.message || e).slice(0, 500) }, 'return=minimal');
    } catch (_e2) { /* si ni esto se puede escribir, el error igual queda en los logs de la funcion */ }
    return new Response(JSON.stringify({ error: String(e.message || e) }), { status: 500, headers: { 'content-type': 'application/json' } });
  }
});
