#!/usr/bin/env node
// Migracion Google Sheets -> Supabase  (Node 18+, sin dependencias)
//
//   node migration/migrate.mjs export            # Sheets -> migration/out/*.json  (solo lectura)
//   node migration/migrate.mjs import --dry-run  # valida y muestra conteos, NO escribe
//   node migration/migrate.mjs import            # escribe en Supabase (aborta si hay datos)
//   node migration/migrate.mjs verify            # compara conteos y sumas Sheets vs Supabase
//
// Configuracion en migration/.env (ver .env.example). Nunca toca la hoja: solo la LEE.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TABLES, convert } from './tables.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, 'out');

// ---- .env minimo ----
const envFile = path.join(here, '.env');
if (fs.existsSync(envFile)) {
  for (const ln of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(ln);
    if (m && !ln.trim().startsWith('#') && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const need = (...k) => { const miss = k.filter(x => !process.env[x]); if (miss.length) die('Faltan variables en migration/.env: ' + miss.join(', ')); };
const die = m => { console.error('✖ ' + m); process.exit(1); };
const [cmd, ...flags] = process.argv.slice(2);
const DRY = flags.includes('--dry-run');
const colLetter = n => String.fromCharCode(64 + n);

// ---------------- export ----------------
async function exportSheets() {
  need('GOOGLE_SHEET_ID', 'GOOGLE_API_KEY');
  fs.mkdirSync(OUT, { recursive: true });
  for (const t of TABLES) {
    const range = `${t.sheet}!A2:${colLetter(t.cols.length)}100000`;
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${process.env.GOOGLE_SHEET_ID}/values/${encodeURIComponent(range)}?key=${process.env.GOOGLE_API_KEY}`;
    const r = await fetch(url);
    if (!r.ok) { console.warn(`  ! ${t.sheet}: HTTP ${r.status} (¿la hoja existe? se omite)`); continue; }
    const rows = (await r.json()).values || [];
    fs.writeFileSync(path.join(OUT, t.table + '.json'), JSON.stringify(rows));
    console.log(`  ✓ ${t.sheet.padEnd(20)} ${String(rows.length).padStart(6)} filas -> out/${t.table}.json`);
  }
  console.log('\nListo. Revisa migration/out/ (contiene datos reales: NO se sube a git).');
}

// ---------------- utilidades Supabase ----------------
const SCHEMA = process.env.SUPABASE_SCHEMA || 'produccion_app';   // esquema propio (no public)
const sbHeaders = () => {
  const k = process.env.SUPABASE_SERVICE_KEY;
  const h = { apikey: k, 'Content-Type': 'application/json', 'Accept-Profile': SCHEMA, 'Content-Profile': SCHEMA };
  if (/^eyJ/.test(k)) h.Authorization = 'Bearer ' + k;   // llaves nuevas (sb_secret_...) no son JWT
  return h;
};
const sbUrl = p => process.env.SUPABASE_URL.replace(/\/rest\/v1\/?$/, '').replace(/\/+$/, '') + '/rest/v1/' + p;   // acepta la URL con o sin /rest/v1/
async function sb(p, opt = {}) {
  const r = await fetch(sbUrl(p), { ...opt, headers: { ...sbHeaders(), ...(opt.headers || {}) } });
  if (!r.ok) throw new Error(`${opt.method || 'GET'} ${p} -> ${r.status} ${(await r.text()).slice(0, 300)}`);
  return r;
}
const load = t => { const f = path.join(OUT, t.table + '.json'); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null; };
const count = async table => {
  const r = await sb(table + '?select=seq', { method: 'HEAD', headers: { Prefer: 'count=exact', Range: '0-0' } });
  return +(r.headers.get('content-range') || '*/0').split('/')[1];
};

// ---------------- import ----------------
async function importData() {
  if (!DRY) need('SUPABASE_URL', 'SUPABASE_SERVICE_KEY');
  const report = [];
  const plan = [];
  for (const t of TABLES) {
    const rows = load(t);
    if (!rows) { console.log(`  - ${t.table}: sin archivo, se omite`); continue; }
    const rejects = [];
    const objs = [];
    const seenUsers = new Set();
    rows.forEach((r, i) => {
      const row = i + 2; // numero de fila en la hoja
      if (t.table === 'usuarios') {
        const u = String(r[1] ?? '').trim();
        if (!u) return;                                   // la app ignora filas sin usuario
        if (seenUsers.has(u.toLowerCase())) { rejects.push({ hoja: t.sheet, fila: row, motivo: 'usuario duplicado (se conserva el primero)' }); return; }
        seenUsers.add(u.toLowerCase());
        objs.push({ p_id: r[0] ?? '', p_usuario: u, p_password: String(r[2] ?? ''), p_nombre: r[3] ?? '', p_rol: (r[4] || 'usuario') });
        return;
      }
      const o = {};
      t.cols.forEach((c, j) => {
        const raw = r[j];
        const v = convert(c.k, raw);
        if (c.k === 'd' && v === null && String(raw ?? '').trim() !== '') rejects.push({ hoja: t.sheet, fila: row, columna: c.n, motivo: 'fecha no reconocida', valor: raw });
        if (c.k === 'n' && typeof raw === 'string' && raw.includes(',')) rejects.push({ hoja: t.sheet, fila: row, columna: c.n, motivo: 'numero con coma (la app lo lee como ' + v + ')', valor: raw });
        o[c.n] = v;
      });
      objs.push(o);
    });
    plan.push({ t, objs });
    report.push(...rejects);
    console.log(`  ${t.table.padEnd(14)} ${String(objs.length).padStart(6)} filas a importar` + (rejects.length ? `  (⚠ ${rejects.length} avisos)` : ''));
  }
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'avisos.json'), JSON.stringify(report, null, 2));
  if (report.length) console.log(`\n⚠ ${report.length} avisos en migration/out/avisos.json (revisalos antes de aprobar la migracion)`);
  if (DRY) return console.log('\n(dry-run) No se escribio nada.');

  // seguridad: no mezclar con datos existentes
  for (const { t } of plan) {
    if (t.table === 'usuarios') continue;
    const n = await count(t.table);
    if (n > 0) die(`La tabla ${t.table} ya tiene ${n} filas. Aborto para no duplicar. (Vacia el proyecto de pruebas y reintenta.)`);
  }
  for (const { t, objs } of plan) {
    if (t.table === 'usuarios') {
      for (const o of objs) await sb('rpc/admin_upsert_user', { method: 'POST', body: JSON.stringify(o) });
    } else {
      for (let i = 0; i < objs.length; i += 500) {
        await sb(t.table, { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(objs.slice(i, i + 500)) });
      }
    }
    console.log(`  ✓ ${t.table}: ${objs.length} filas`);
  }
  console.log('\nImportacion completa. Ejecuta: node migration/migrate.mjs verify');
}

// ---------------- verify ----------------
async function verify() {
  need('SUPABASE_URL', 'SUPABASE_SERVICE_KEY');
  let bad = 0;
  for (const t of TABLES) {
    const rows = load(t); if (!rows) continue;
    const expected = t.table === 'usuarios' ? new Set(rows.map(r => String(r[1] ?? '').trim().toLowerCase()).filter(Boolean)).size : rows.length;
    const got = await count(t.table);
    const numCols = t.cols.map((c, j) => ({ c, j })).filter(x => x.c.k === 'n' || x.c.k === 'i');
    let line = `${t.table.padEnd(14)} filas: hoja=${expected} supabase=${got} ${expected === got ? '✓' : '✖'}`;
    if (expected !== got) bad++;
    for (const { c, j } of numCols) {
      const sheetSum = rows.reduce((a, r) => a + (c.k === 'i' ? parseInt(r[j]) || 0 : parseFloat(r[j]) || 0), 0);
      let dbSum = 0;
      for (let off = 0; ; off += 1000) {           // Supabase limita a 1000 filas por peticion
        const r = await sb(`${t.table}?select=${c.n}&order=seq.asc&limit=1000&offset=${off}`);
        const page = await r.json();
        dbSum += page.reduce((a, x) => a + Number(x[c.n] || 0), 0);
        if (page.length < 1000) break;
      }
      const same = Math.abs(sheetSum - dbSum) < 1e-6;
      if (!same) bad++;
      line += `\n    suma ${c.n}: hoja=${sheetSum} supabase=${dbSum} ${same ? '✓' : '✖'}`;
    }
    console.log(line);
  }
  console.log(bad ? `\n✖ ${bad} diferencias. NO apruebes la migracion.` : '\n✓ Todo coincide.');
  process.exit(bad ? 1 : 0);
}

const cmds = { export: exportSheets, import: importData, verify };
if (!cmds[cmd]) die('Uso: node migration/migrate.mjs <export | import [--dry-run] | verify>');
cmds[cmd]().catch(e => die(e.message));
