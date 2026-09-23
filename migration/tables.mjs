// Mapa hoja de Google Sheets -> tabla Supabase.
// DEBE mantenerse igual que TABLES en index.html y supabase/schema.sql
// (tipos: s=texto i=entero n=numero d=fecha b=SI/NO). `npm`-free: solo Node 18+.
const T = (sheet, table, cols) => ({
  sheet, table,
  cols: cols.map(x => { const [n, k] = x.split(':'); return { n, k: k || 's' }; }),
});

export const TABLES = [
  T('\u{1F464} Usuarios',      'usuarios',      ['id', 'usuario', 'password_hash', 'nombre', 'rol']),
  T('\u{1F4E6} Catálogo', 'catalogo',      ['id', 'categoria', 'producto', 'stock_minimo:i', 'unidad', 'activo:b']),
  T('\u{1F3ED} Producción','produccion',   ['id', 'fecha:d', 'dia', 'turno', 'categoria', 'producto', 'cantidad:n', 'responsable', 'notas']),
  T('\u{1F4B0} Ventas',        'ventas',        ['id', 'fecha:d', 'categoria', 'producto', 'cantidad:n', 'vendedor', 'notas']),
  T('\u{1F37D}️ Recetas', 'recetas',       ['platillo', 'categoria', 'ingrediente', 'cantidad:n', 'unidad']),
  T('⚠️ Mermas',     'mermas',        ['id', 'fecha:d', 'hora', 'categoria', 'producto', 'cantidad:n', 'motivo', 'responsable']),
  T('\u{1F4CA} Saldo Inicial', 'saldo_inicial', ['producto', 'categoria', 'stock_actual:n', 'total_producido:n', 'total_vendido:n', 'total_merma:n', 'fecha_corte:d']),
  T('\u{1F4DC} Bitácora', 'bitacora',      ['fecha:d', 'hora', 'usuario', 'accion', 'detalle', 'tipo']),
  T('\u{1F512} Turnos',        'turnos',        ['id', 'fecha:d', 'turno', 'fase', 'responsable', 'hora', 'datos']),
];

// Misma conversion que hace la app al escribir (index.html: _toDB), para que
// los datos migrados calculen EXACTAMENTE el mismo inventario que hoy.
export function dateToISO(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  let iso = s;
  if (!s.includes('-')) {
    const p = s.split('/');
    if (p.length !== 3) return null;
    iso = p[2] + '-' + p[1].padStart(2, '0') + '-' + p[0].padStart(2, '0');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const d = new Date(iso + 'T00:00:00Z');
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso ? null : iso;
}

export function convert(kind, v) {
  switch (kind) {
    case 'i': return parseInt(v) || 0;
    case 'n': return parseFloat(v) || 0;
    case 'b': return String(v ?? '').trim().toUpperCase() !== 'NO';
    case 'd': return dateToISO(v);
    default: return v == null ? '' : String(v);
  }
}
