// Prueba de los 3 backends de index.html: sheets (por defecto), demo (localStorage) y
// supabase (contra un mock local de PostgREST; no toca ningun servicio real).
// Uso:  npm i --no-save playwright && node tests/backends.test.js
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const ROOT = path.join(__dirname, '..');

// ---- Mock PostgREST minimo ----
const DBM = {}; const seqs = {};
function tbl(t) { return DBM[t] = DBM[t] || []; }
const users = [{ id: 'U1', usuario: 'admin', nombre: 'Admin', rol: 'admin', pw: 'secreto' }];
const log = [];
function json(res, code, body) { res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' }); res.end(JSON.stringify(body)); }
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') return json(res, 200, {});
  if (u.pathname.startsWith('/rest/v1/')) {
    let body = ''; req.on('data', d => body += d); req.on('end', () => {
      const p = u.pathname.slice(9); log.push(req.method + ' ' + p + u.search + (body ? ' ' + body.slice(0, 120) : ''));
      if (!req.headers.apikey || req.headers.authorization !== 'Bearer ANONKEY') return json(res, 401, { message: 'no key' });
      if (p === 'rpc/app_list_users') return json(res, 200, users.map(({ pw, ...r }) => r));
      if (p === 'rpc/app_login') { const b = JSON.parse(body); const f = users.find(x => x.usuario === b.p_usuario.toLowerCase() && x.pw === b.p_password); return json(res, 200, f ? [{ id: f.id, usuario: f.usuario, nombre: f.nombre, rol: f.rol }] : []); }
      const t = p; const rows = tbl(t);
      if (req.method === 'POST') { const r = JSON.parse(body); r.seq = (seqs[t] = (seqs[t] || 0) + 1); rows.push(r); return json(res, 201, {}); }
      if (req.method === 'GET') { const off = +u.searchParams.get('offset') || 0, lim = Math.min(+u.searchParams.get('limit') || 1000, 1000); return json(res, 200, rows.slice(off, off + lim)); }
      if (req.method === 'DELETE') { const id = +u.searchParams.get('seq').replace('eq.', ''); const i = rows.findIndex(r => r.seq === id); if (i < 0) return json(res, 200, []); const [d] = rows.splice(i, 1); return json(res, 200, [d]); }
      json(res, 404, {});
    }); return;
  }
  let f = u.pathname === '/' ? '/index.html' : u.pathname; f = path.join(ROOT, f);
  if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  const ext = path.extname(f); res.writeHead(200, { 'content-type': { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.json': 'application/json', '.js': 'text/javascript' }[ext] || 'text/plain' });
  fs.createReadStream(f).pipe(res);
});

let fails = 0; function ok(c, m) { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; }

(async () => {
  await new Promise(r => server.listen(8765, r));
  const b = await chromium.launch();
  const errs = [];
  // ===== 1) DEMO =====
  let ctx = await b.newContext(); let pg = await ctx.newPage(); pg.on('pageerror', e => errs.push('demo: ' + e.message));
  await pg.goto('http://localhost:8765/?backend=demo'); await pg.waitForSelector('#lu');
  ok(await pg.evaluate(() => BACKEND === 'demo'), 'demo: BACKEND=demo');
  ok(await pg.evaluate(() => document.body.innerText.includes('MODO DEMO')), 'demo: banner visible');
  await pg.fill('#lu', 'admin'); await pg.fill('#lp', 'mala'); await pg.click('text=Entrar'); await pg.waitForTimeout(300);
  ok(await pg.evaluate(() => S.screen === 'login'), 'demo: login con clave mala rechazado');
  await pg.fill('#lp', 'admin123'); await pg.click('text=Entrar'); await pg.waitForTimeout(800);
  ok(await pg.evaluate(() => S.screen === 'main' && S.currentUser.rol === 'admin'), 'demo: login admin OK');
  const st = await pg.evaluate(() => ({ c: S.catalogo.length, p: S.produccion.length, v: S.ventas.length, inv: S.inventario.map(i => i.producto + '=' + i.stockActual).join(',') }));
  console.log('   demo estado', JSON.stringify(st));
  ok(st.c === 4 && st.p === 2 && st.v === 1, 'demo: loadAll carga catalogo/produccion/ventas');
  ok(st.inv.includes('Pastel de chocolate=4'), 'demo: inventario calculado (6 prod - 2 vend = 4)');
  await pg.evaluate(async () => { await Sheets.append('\u{1F37D}️ Recetas', ['Pastel', 'Pasteles', 'Harina', 2, '']); await Sheets.append('\u{1F37D}️ Recetas', ['Pastel', 'Pasteles', 'Huevo', 3, '']); await Sheets.loadAll(); });
  ok(await pg.evaluate(() => S.recetas.length === 2 && S.recetas[1]._sheetRow === 3), 'demo: append recetas + _sheetRow');
  await pg.evaluate(async () => { await Sheets.deleteRow('\u{1F37D}️ Recetas', 2); await Sheets.loadAll(); });
  ok(await pg.evaluate(() => S.recetas.length === 1 && S.recetas[0].ingrediente === 'Huevo'), 'demo: deleteRow recetas');
  // cola offline con backend demo: fallo forzado
  await pg.evaluate(() => { DEMO.append = async () => { throw new Error('x') }; });
  await pg.evaluate(async () => { try { await Sheets.append('\u{1F4B0} Ventas', ['V9', today(), 'x', 'y', 1, 'z', '']) } catch (e) { } });
  ok(await pg.evaluate(() => _qCount() === 1), 'demo: cola offline guarda cuando falla el backend');
  await pg.reload(); await pg.waitForTimeout(800);
  ok(await pg.evaluate(() => S.screen === 'main'), 'demo: sesion persistente tras recargar');
  // resetApp conserva backend
  await pg.evaluate(() => resetApp()); ok(await pg.evaluate(() => localStorage.getItem('backend') === 'demo'), 'demo: resetApp conserva la config del backend');
  await ctx.close();

  // ===== 2) SUPABASE (mock) =====
  ctx = await b.newContext(); pg = await ctx.newPage(); pg.on('pageerror', e => errs.push('sb: ' + e.message));
  await pg.goto('http://localhost:8765/?backend=supabase&sburl=' + encodeURIComponent('http://localhost:8765') + '&sbkey=ANONKEY'); await pg.waitForSelector('#lu');
  ok(await pg.evaluate(() => BACKEND === 'supabase' && SB_URL === 'http://localhost:8765'), 'sb: config por URL');
  ok(await pg.evaluate(() => S.usuarios.length === 1 && S.usuarios[0].password === ''), 'sb: usuarios sin contraseña en el cliente');
  await pg.fill('#lu', 'admin'); await pg.fill('#lp', 'mala'); await pg.click('text=Entrar'); await pg.waitForTimeout(400);
  ok(await pg.evaluate(() => S.screen === 'login'), 'sb: clave mala rechazada (server-side)');
  await pg.fill('#lp', 'secreto'); await pg.click('text=Entrar'); await pg.waitForTimeout(800);
  ok(await pg.evaluate(() => S.screen === 'main' && S.currentUser.usuario === 'admin'), 'sb: login OK via app_login');
  // escrituras que hace la app: formatos de fecha/num/bool
  await pg.evaluate(async () => {
    await Sheets.append('\u{1F4E6} Catálogo', ['C1', 'Pasteles', 'Cheesecake', '2', 'pza', 'SI']);
    await Sheets.append('\u{1F4E6} Catálogo', ['C2', 'Pasteles', 'Viejo', '0', 'pza', 'NO']);
    await Sheets.append('\u{1F3ED} Producción', ['P1', '23/09/2026', 'miércoles', 'Mañana', 'Pasteles', 'Cheesecake', 5, 'Admin', '']);
    await Sheets.append('\u{1F4B0} Ventas', ['V1', '23/09/2026', 'TPV', 'Cheesecake', 1, 'Admin', '[TPV]']);
    await Sheets.append('\u{1F37D}️ Recetas', ['Flan', 'Postres', 'Leche', 1.5, 'L']);
    await Sheets.append('\u{1F37D}️ Recetas', ['Flan', 'Postres', 'Huevo', 4, 'pza']);
    await Sheets.append('\u{1F4CA} Saldo Inicial', ['Cheesecake', 'Pasteles', 4, 5, 1, 0, '23/09/2026']);
    await Sheets.append('\u{1F512} Turnos', ['T1', '23/09/2026', 'Mañana', 'apertura', 'Admin', '08:01:02 a. m.', '{"a":1}']);
    await Sheets.loadAll();
  });
  const prodRow = JSON.stringify(DBM.produccion[0]); console.log('   fila produccion en DB:', prodRow);
  ok(DBM.produccion[0].fecha === '2026-09-23' && DBM.produccion[0].cantidad === 5, 'sb: fecha dd/mm/yyyy -> ISO y cantidad numerica');
  ok(DBM.catalogo[1].activo === false && DBM.catalogo[0].activo === true && DBM.catalogo[0].stock_minimo === 2, 'sb: activo SI/NO -> boolean, stock_minimo int');
  ok(DBM.turnos[0].datos === '{"a":1}' && DBM.turnos[0].hora === '08:01:02 a. m.', 'sb: turnos datos JSON y hora como texto');
  const s2 = await pg.evaluate(() => ({ c: S.catalogo.map(c => c.producto).join(','), p: S.produccion[0], inv: S.inventario.map(i => i.producto + '=' + i.stockActual).join(','), rec: S.recetas.map(r => r.ingrediente + ':' + r.cantidad + ':' + r._sheetRow).join('|'), t: S.turnos.length }));
  console.log('   sb estado', JSON.stringify(s2));
  ok(s2.c === 'Cheesecake', 'sb: catalogo filtra activo=NO');
  ok(s2.p.fecha === '23/09/2026' && s2.p.cantidad === 5, 'sb: lectura devuelve dd/mm/yyyy como Sheets');
  ok(s2.inv.includes('Cheesecake=4'), 'sb: inventario parte del Saldo Inicial (4)');
  ok(s2.rec === 'Leche:1.5:2|Huevo:4:3', 'sb: recetas con _sheetRow 2,3');
  await pg.evaluate(async () => { await Sheets.deleteRow('\u{1F37D}️ Recetas', 2); await Sheets.loadAll(); });
  ok(await pg.evaluate(() => S.recetas.length === 1 && S.recetas[0].ingrediente === 'Huevo'), 'sb: deleteRow por seq');
  ok(await pg.evaluate(async () => { try { await Sheets.deleteRow('\u{1F37D}️ Recetas', 99); return false } catch (e) { return true } }), 'sb: deleteRow de fila inexistente lanza error');
  // cola offline: apagar server
  const cnt0 = DBM.ventas.length;
  await pg.evaluate(() => { window._orig = SBK.req; SBK.req = async () => { throw new Error('offline') }; });
  await pg.evaluate(async () => { try { await Sheets.append('\u{1F4B0} Ventas', ['V2', '23/09/2026', 'x', 'Cheesecake', 1, 'A', '']) } catch (e) { } });
  ok(await pg.evaluate(() => _qCount() === 1) && DBM.ventas.length === cnt0, 'sb: offline => cola local, nada escrito');
  await pg.evaluate(() => { SBK.req = window._orig; });
  await pg.evaluate(async () => { await retryQueue() }); await pg.waitForTimeout(500);
  ok(await pg.evaluate(() => _qCount() === 0) && DBM.ventas.length === cnt0 + 1, 'sb: retryQueue sincroniza por Supabase');
  // paginacion: 2500 filas
  for (let i = 0; i < 2500; i++) tbl('mermas').push({ seq: (seqs.mermas = (seqs.mermas || 0) + 1), id: 'M' + i, fecha: '2026-09-01', hora: '', categoria: 'c', producto: 'Cheesecake', cantidad: 1, motivo: '', responsable: '' });
  const nm = await pg.evaluate(async () => (await Sheets.read('⚠️ Mermas', 'A2:H50000')).length);
  ok(nm === 2500, 'sb: paginacion lee 2500 filas (' + nm + ')');
  await ctx.close();

  // ===== 3) SHEETS (default) no cambia =====
  ctx = await b.newContext(); pg = await ctx.newPage(); pg.on('pageerror', e => errs.push('gs: ' + e.message));
  await pg.goto('http://localhost:8765/'); await pg.waitForSelector('.setup-title');
  ok(await pg.evaluate(() => BACKEND === 'sheets' && DB === GS && document.querySelector('.setup-title').innerText.includes('Google Sheet')), 'sheets: por defecto sigue pidiendo Sheet ID (comportamiento actual)');
  ok(await pg.evaluate(() => !document.body.innerText.includes('MODO DEMO')), 'sheets: sin banner');
  // todas las hojas usadas por la app existen en TABLES
  const html = fs.readFileSync(ROOT + '/index.html', 'utf8');
  const names = [...html.matchAll(/Sheets\.(?:read|append|deleteRow)\(('[^']+')/g)].map(m => m[1]);
  const missing = await pg.evaluate(ns => ns.map(n => eval(n)).filter(n => !TABLES[n]), [...new Set(names)]);
  ok(missing.length === 0, 'sheets: todas las hojas referenciadas (' + new Set(names).size + ') estan en TABLES ' + JSON.stringify(missing));
  ok(errs.length === 0, 'sin errores JS de pagina ' + JSON.stringify(errs));
  await b.close(); server.close();
  console.log(fails ? '\n' + fails + ' FALLAS' : '\nTODO OK');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
