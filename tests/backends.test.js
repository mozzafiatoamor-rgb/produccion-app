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
const log = []; let sawAuth = false;
function json(res, code, body) { res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' }); res.end(JSON.stringify(body)); }
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') return json(res, 200, {});
  if (u.pathname.startsWith('/rest/v1/')) {
    let body = ''; req.on('data', d => body += d); req.on('end', () => {
      const p = u.pathname.slice(9); log.push(req.method + ' ' + p + u.search + (body ? ' ' + body.slice(0, 120) : ''));
      if (req.headers.apikey !== 'ANONKEY') return json(res, 401, { message: 'no key' });
      if (req.headers.authorization) sawAuth = true;                      // una llave no-JWT no debe mandar Authorization
      const prof = req.headers['accept-profile'] || req.headers['content-profile'];
      if (prof !== 'produccion_app') return json(res, 406, { message: 'schema no expuesto: ' + prof }); // como PostgREST
      if (p === 'rpc/app_list_users') return json(res, 200, users.map(({ pw, ...r }) => r));
      if (p === 'rpc/app_verify_admin') { const b = JSON.parse(body); const f = users.find(x => x.rol === 'admin' && b.p_password && x.pw === b.p_password); return json(res, 200, f ? [{ id: f.id, usuario: f.usuario, nombre: f.nombre, rol: f.rol }] : []); }
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
  ok(await pg.evaluate(async () => (await Sheets.verifyAdmin('admin123'))?.nombre === 'Administrador' && (await Sheets.verifyAdmin('')) === null && (await Sheets.verifyAdmin('demo123')) === null && (await Sheets.verifyAdmin('x')) === null), 'demo: verifyAdmin acepta admin, rechaza vacia / usuario normal / incorrecta');
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
  ok(await pg.evaluate(async () => (await Sheets.verifyAdmin('secreto'))?.nombre === 'Admin' && (await Sheets.verifyAdmin('')) === null && (await Sheets.verifyAdmin('mala')) === null), 'sb: verifyAdmin va al servidor (app_verify_admin); vacia y mala rechazadas');
  ok(await pg.evaluate(() => S.usuarios.every(u => u.password === '')), 'sb: ninguna contraseña en el navegador (S.usuarios)');
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
  ok(!sawAuth, 'sb: llave no-JWT (sb_publishable_) se manda solo en apikey, sin Authorization');
  ok(log.length > 0, 'sb: ' + log.length + ' peticiones, todas con Accept/Content-Profile: produccion_app (el mock responde 406 si falta)');
  await ctx.close();

  // ===== 3) SHEETS (default) no cambia =====
  ctx = await b.newContext(); pg = await ctx.newPage(); pg.on('pageerror', e => errs.push('gs: ' + e.message));
  await pg.goto('http://localhost:8765/?backend=sheets'); await pg.waitForSelector('.setup-title');
  ok(await pg.evaluate(() => BACKEND === 'sheets' && DB === GS && document.querySelector('.setup-title').innerText.includes('Google Sheet')), 'sheets (?backend=sheets): sigue pidiendo Sheet ID como antes');
  ok(await pg.evaluate(() => document.body.innerText.includes('GOOGLE SHEETS (respaldo)')), 'sheets (respaldo): muestra etiqueta naranja para no confundirse');
  // todas las hojas usadas por la app existen en TABLES
  const html = fs.readFileSync(ROOT + '/index.html', 'utf8');
  const names = [...html.matchAll(/Sheets\.(?:read|append|deleteRow)\(('[^']+')/g)].map(m => m[1]);
  const missing = await pg.evaluate(ns => ns.map(n => eval(n)).filter(n => !TABLES[n]), [...new Set(names)]);
  ok(missing.length === 0, 'sheets: todas las hojas referenciadas (' + new Set(names).size + ') estan en TABLES ' + JSON.stringify(missing));

  // ===== 3b) SHEETS con Google interceptado (comportamiento actual de produccion) =====
  ctx = await b.newContext(); pg = await ctx.newPage(); pg.on('pageerror', e => errs.push('gs2: ' + e.message));
  const gsData = {
    '\u{1F464} Usuarios': [['U1', 'admin', 'pw-admin', 'Gustavo', 'admin'], ['U2', 'coc', 'pw-coc', 'Fatima', 'cocina']],
    '\u{1F4E6} Catálogo': [['C1', 'Pasteles', 'Flan', '3', 'pza', 'Sí'], ['C2', 'Pasteles', 'Viejo', '0', 'pza', 'NO']],
    '\u{1F3ED} Producción': [['P1', '23/09/2026', 'miércoles', 'Mañana', 'Pasteles', 'Flan', '5', 'Fatima', '']],
    '\u{1F4B0} Ventas': [],
  };
  const posts = [];
  await pg.route('https://sheets.googleapis.com/**', route => {
    const m = /values\/([^!]+)!([A-Z]+\d+:[A-Z]+\d+)/.exec(decodeURIComponent(route.request().url()));
    const vals = gsData[m && m[1]];
    if (!vals) return route.fulfill({ status: 400, body: '{}' });
    route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ values: vals }) });
  });
  await pg.route('https://script.google.com/**', route => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } });
    posts.push(JSON.parse(route.request().postData()));
    route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ success: !globalThis.__gsFail }) });
  });
  await pg.addInitScript(() => { localStorage.setItem('sheetId', 'SID'); localStorage.setItem('apiKey', 'KEY'); });
  await pg.goto('http://localhost:8765/?backend=sheets'); await pg.waitForSelector('#lu');
  ok(await pg.evaluate(() => BACKEND === 'sheets' && DB === GS), 'gs: ?backend=sheets usa Google Sheets');
  ok(await pg.evaluate(() => S.usuarios.length === 2 && S.usuarios[1].rol === 'cocina' && S.usuarios[0].password === 'pw-admin'), 'gs: lee usuarios de la hoja (sin recursion)');
  ok(await pg.evaluate(async () => { await Sheets.loadAll(); return S.catalogo.length === 1 && S.catalogo[0].producto === 'Flan' && S.produccion[0].cantidad === 5 && S.inventario[0].stockActual === 5 }), 'gs: loadAll calcula catalogo e inventario');
  ok(await pg.evaluate(async () => { await Sheets.append('\u{1F4B0} Ventas', ['V1', '23/09/2026', 'x', 'Flan', 1, 'u', '']); await Sheets.deleteRow('\u{1F37D}️ Recetas', 7); return true }) && posts.length === 2 && posts[0].sheet === '\u{1F4B0} Ventas' && posts[0].values[3] === 'Flan' && posts[1].action === 'delete' && posts[1].row === 7, 'gs: append y deleteRow salen al Apps Script con el mismo formato de siempre');
  ok(await pg.evaluate(async () => (await Sheets.verifyAdmin('pw-admin'))?.nombre === 'Gustavo' && (await Sheets.verifyAdmin('pw-coc')) === null && (await Sheets.verifyAdmin('')) === null), 'gs: verifyAdmin compara con la hoja; rol cocina no sirve; vacia rechazada');
  ok(await pg.evaluate(async () => (await Sheets.checkLogin('coc', 'pw-coc'))?.rol === 'cocina' && (await Sheets.checkLogin('coc', 'mala')) === undefined), 'gs: login conserva el rol cocina');
  await pg.evaluate(() => { GS.append = async () => { throw new Error('sin red') }; });
  await pg.evaluate(async () => { try { await Sheets.append('\u{1F4B0} Ventas', ['V2', '23/09/2026', 'x', 'Flan', 1, 'u', '']) } catch (e) { } });
  ok(await pg.evaluate(() => _qCount() === 1), 'gs: sin red => cola local (comportamiento actual)');
  await ctx.close();

  // ===== 4) PRODUCCION: sin parametros ni configuracion previa => Supabase con la config incluida =====
  ctx = await b.newContext(); pg = await ctx.newPage(); pg.on('pageerror', e => errs.push('prod: ' + e.message));
  const seen = [];
  await pg.route('https://ujmecfdsbqtwxusqqiqi.supabase.co/**', route => {
    const r = route.request(); seen.push({ url: r.url(), h: r.headers() });
    if (r.method() === 'OPTIONS') return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
    route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '[]' });
  });
  await pg.goto('http://localhost:8765/'); await pg.waitForSelector('#lu');
  ok(await pg.evaluate(() => BACKEND === 'supabase' && DB === SBK && S.screen === 'login'), 'prod: sin configuracion previa arranca en Supabase y va directo al login (sin pedir Sheet ID)');
  ok(await pg.evaluate(() => !document.body.innerText.includes('MODO DEMO') && !document.body.innerText.includes('respaldo') && !document.body.innerText.includes('pruebas')), 'prod: sin etiquetas de prueba');
  const first = seen.find(x => x.url.includes('/rest/v1/rpc/app_list_users'));
  ok(!!first && first.h['apikey'] === 'sb_publishable_XY_anhqYY9rhgZau67wkcw_WkMx_PRA' && first.h['accept-profile'] === 'produccion_app' && !first.h['authorization'], 'prod: usa el proyecto/llave publica/esquema produccion_app incluidos en la app (sin Authorization)');
  ok(await pg.evaluate(() => ['sbUrl', 'sbKey', 'backend'].every(k => localStorage.getItem(k) === null)), 'prod: no necesita guardar nada en el dispositivo para funcionar');
  // un telefono que venia usando Google Sheets (sheetId/apiKey/sesion guardados) pasa a Supabase sin pedir nada
  await ctx.close(); ctx = await b.newContext(); pg = await ctx.newPage(); pg.on('pageerror', e => errs.push('prod2: ' + e.message));
  await pg.route('https://ujmecfdsbqtwxusqqiqi.supabase.co/**', route => {
    const r = route.request(); if (r.method() === 'OPTIONS') return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
    const rows = r.url().includes('app_list_users') ? [{ id: 'U2', usuario: 'ENCARGADO1', nombre: 'EUCEBIO', rol: 'cocina' }] : [];
    route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(rows) });
  });
  await pg.addInitScript(() => { if (!localStorage.getItem('_init')) { localStorage.setItem('_init', '1'); localStorage.setItem('sheetId', 'VIEJO'); localStorage.setItem('apiKey', 'VIEJA'); localStorage.setItem('currentUser', JSON.stringify({ id: 'U2', usuario: 'ENCARGADO1', nombre: 'EUCEBIO', rol: 'cocina' })); localStorage.setItem('_pendingQ', JSON.stringify([{ sh: '\u{1F4B0} Ventas', v: ['V1', '23/09/2026', 'x', 'Flan', 1, 'u', ''], ts: 1 }])); } });
  await pg.goto('http://localhost:8765/'); await pg.waitForTimeout(1200);
  ok(await pg.evaluate(() => BACKEND === 'supabase' && S.screen === 'main' && S.currentUser.usuario === 'ENCARGADO1' && S.currentUser.rol === 'cocina'), 'prod: telefono que usaba Sheets conserva su sesion (rol cocina) y entra directo a la app en Supabase');
  ok(await pg.evaluate(() => _qCount() === 1), 'prod: la cola offline pendiente de Sheets se conserva (se reintentara contra Supabase)');
  await ctx.close();
  ok(errs.length === 0, 'sin errores JS de pagina ' + JSON.stringify(errs));
  await b.close(); server.close();
  console.log(fails ? '\n' + fails + ' FALLAS' : '\nTODO OK');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
