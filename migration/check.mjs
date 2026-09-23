#!/usr/bin/env node
// Verificacion SOLO LECTURA de la conexion a Supabase con la llave PUBLICA (la misma que usara la app).
//   node migration/check.mjs
// Necesita en migration/.env:  SUPABASE_URL  y  SUPABASE_ANON_KEY (sb_publishable_... o anon eyJ...)
// No escribe nada y no usa la llave secreta.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const envFile = path.join(here, '.env');
if (fs.existsSync(envFile)) for (const ln of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(ln);
  if (m && !ln.trim().startsWith('#') && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const url = (process.env.SUPABASE_URL || '').replace(/\/rest\/v1\/?$/, '').replace(/\/+$/, '');
const key = process.env.SUPABASE_ANON_KEY || '';
const schema = process.env.SUPABASE_SCHEMA || 'produccion_app';
if (!url || !key) { console.error('✖ Faltan SUPABASE_URL y/o SUPABASE_ANON_KEY en migration/.env'); process.exit(1); }
if (/service_role|sb_secret_/.test(key)) { console.error('✖ Esa es una llave SECRETA. Aqui usa solo la publica (sb_publishable_... / anon).'); process.exit(1); }

const headers = (extra = {}) => {
  const h = { apikey: key, 'Content-Type': 'application/json', 'Accept-Profile': schema, 'Content-Profile': schema, ...extra };
  if (/^eyJ/.test(key)) h.Authorization = 'Bearer ' + key;
  return h;
};
let bad = 0;
async function call(label, p, opt, judge) {
  let status = 0, body = '';
  try { const r = await fetch(url + '/rest/v1/' + p, { ...opt, headers: headers(opt?.headers) }); status = r.status; body = await r.text(); }
  catch (e) { console.log(`✖ ${label}\n    no se pudo conectar: ${e.cause?.code || e.message}`); bad++; return; }
  const res = judge(status, body);
  console.log(`${res.ok ? '✓' : '✖'} ${label}${res.ok ? '' : `\n    HTTP ${status}: ${body.slice(0, 200)}\n    -> ${res.hint}`}`);
  if (!res.ok) bad++;
}
const isArr = b => { try { return Array.isArray(JSON.parse(b)); } catch { return false; } };
const notExposed = 'El esquema no esta expuesto: agrega produccion_app en Project Settings > Data API > Exposed schemas.';

await call(`lee tabla catalogo del esquema ${schema}`, 'catalogo?select=seq&limit=1', {}, (s, b) =>
  s === 200 && isArr(b) ? { ok: true } : { ok: false, hint: /PGRST106|schema/i.test(b) ? notExposed : 'Revisa que schema.sql se ejecuto completo y que la llave es la correcta.' });
await call('usuarios NO se puede leer directo (contraseñas protegidas)', 'usuarios?select=*&limit=1', {}, (s, b) =>
  s === 401 || s === 403 ? { ok: true } : (s === 200 && JSON.parse(b).length === 0 ? { ok: false, hint: 'Respondio vacio en vez de denegar: revisa los permisos de la tabla usuarios.' } : { ok: false, hint: 'Deberia estar denegado.' }));
await call('funcion app_list_users responde', 'rpc/app_list_users', { method: 'POST', body: '{}' }, (s, b) =>
  s === 200 && isArr(b) ? { ok: true } : { ok: false, hint: 'La funcion no existe o no tiene permiso para anon.' });
await call('login con usuario inexistente devuelve vacio', 'rpc/app_login', { method: 'POST', body: JSON.stringify({ p_usuario: '__nadie__', p_password: 'x' }) }, (s, b) =>
  s === 200 && b.trim() === '[]' ? { ok: true } : { ok: false, hint: 'app_login deberia responder [].' });
await call('esquema inexistente es rechazado', 'catalogo?select=seq&limit=1', { headers: { 'Accept-Profile': '__no_existe__' } }, (s) =>
  s >= 400 ? { ok: true } : { ok: false, hint: 'Se esperaba un rechazo.' });

console.log(bad ? `\n✖ ${bad} problema(s). Copia esta salida y pasasela a Claude.` : '\n✓ Todo bien: la API ve produccion_app y los permisos son los esperados.');
process.exit(bad ? 1 : 0);
