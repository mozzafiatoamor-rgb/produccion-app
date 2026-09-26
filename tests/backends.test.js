// Prueba de los 3 backends de index.html: sheets (por defecto), demo (localStorage) y
// supabase (contra un mock local de PostgREST; no toca ningun servicio real).
// Uso:  npm i --no-save playwright && node tests/backends.test.js
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const ROOT = path.join(__dirname, '..');

// ---- Mock PostgREST minimo ----
const DBM = {}; const seqs = {}; const GRANTS = { catalogo: ['id', 'categoria', 'producto', 'stock_minimo', 'unidad', 'activo'], loyverse_map: ['loyverse_item_name', 'platillo', 'activo'] };
function tbl(t) { return DBM[t] = DBM[t] || []; }
const users = [{ id: 'U1', usuario: 'admin', nombre: 'Admin', rol: 'admin', pw: 'secreto' }];
const log = []; let sawAuth = false;
let slowMs = 0, noRange = false;
function json(res, code, body, extra) { res.writeHead(code, Object.assign({ 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': 'Content-Range' }, extra || {})); res.end(JSON.stringify(body)); }
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
      if (req.method === 'GET') {
        const off = +u.searchParams.get('offset') || 0, lim = Math.min(+u.searchParams.get('limit') || 1000, 1000), gt = u.searchParams.get('seq');
        let src = rows; if (gt && gt.startsWith('gt.')) src = rows.filter(r => r.seq > +gt.slice(3));
        const sl = src.slice(off, off + lim), hdr = {};
        if (!noRange && /count=exact/.test(req.headers.prefer || '')) hdr['content-range'] = (sl.length ? off + '-' + (off + sl.length - 1) : '*') + '/' + src.length;
        return setTimeout(() => json(res, hdr['content-range'] ? 206 : 200, sl, hdr), slowMs);
      }
      if (req.method === 'PATCH') { const id = +u.searchParams.get('seq').replace('eq.', ''); const r = rows.find(x => x.seq === id); if (!r) return json(res, 200, []); const b = JSON.parse(body); var allow = GRANTS[t]; if (allow && Object.keys(b).some(k => !allow.includes(k))) return json(res, 403, { message: 'columna no permitida' }); Object.assign(r, b); return json(res, 200, [r]); }
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
  // ---- dock de navegacion (rediseño) ----
  ok(await pg.evaluate(() => document.querySelectorAll('.dock-item').length === 7 && !document.querySelector('.bottom-nav') && document.querySelector('.dock-item.active .di-lb').textContent.trim() === 'Inicio'), 'dock: 7 secciones, sin barra inferior antigua, Inicio activo');
  ok(await pg.evaluate(() => document.querySelector('.dock-item.wide .di-lb').textContent.trim() === 'Bitácora'), 'dock: con 7 secciones la ultima ocupa las 2 columnas');
  ok(await pg.evaluate(() => getComputedStyle(document.querySelector('.dock-grid')).gridTemplateColumns.split(' ').length === 2), 'dock: rejilla de 2 columnas');
  ok(await pg.evaluate(() => getComputedStyle(document.querySelector('.dock-panel')).visibility === 'hidden' && S.dockOpen !== true), 'dock: plegado al inicio (solo se ve el boton)');
  await pg.click('.dock-btn'); await pg.waitForTimeout(800);
  ok(await pg.evaluate(() => S.dockOpen === true && document.querySelector('.dock-btn').getAttribute('aria-expanded') === 'true' && getComputedStyle(document.querySelector('.dock-panel')).opacity === '1' && document.querySelector('.dock').classList.contains('open')), 'dock: al tocar el boton se despliega');
  await pg.keyboard.press('Escape'); await pg.waitForTimeout(700);
  ok(await pg.evaluate(() => S.dockOpen === false && getComputedStyle(document.querySelector('.dock-panel')).visibility === 'hidden'), 'dock: Escape lo pliega');
  await pg.click('.dock-btn'); await pg.waitForTimeout(700); await pg.mouse.click(195, 60); await pg.waitForTimeout(600);
  ok(await pg.evaluate(() => S.dockOpen === false), 'dock: tocar fuera (fondo) lo pliega');
  await pg.click('.dock-btn'); await pg.waitForTimeout(700);
  await pg.click('.dock-item:nth-child(2)'); await pg.waitForTimeout(600);
  ok(await pg.evaluate(() => S.tab === 'produccion' && S.dockOpen === false && document.querySelector('.dock-item.active .di-lb').textContent.trim() === 'Producción'), 'dock: elegir una seccion navega, se pliega y marca la activa');
  await pg.click('.dock-btn'); await pg.waitForTimeout(600); await pg.click('.dock-item:nth-child(1)'); await pg.waitForTimeout(600);
  ok(await pg.evaluate(() => S.tab === 'home' && document.querySelectorAll('.quick-btn').length === 6), 'dock: vuelve a Inicio');
  ok(await pg.evaluate(() => { const c = [...document.querySelectorAll('.quick-btn')].map(b => getComputedStyle(b).getPropertyValue('--c').trim()); return new Set(c).size === 6 && c.every(Boolean) }), 'neon: cada acceso rapido tiene su propio color');
  ok(await pg.evaluate(() => [...document.querySelectorAll('.quick-btn')].every(b => getComputedStyle(b).boxShadow !== 'none')), 'neon: los accesos rapidos tienen resplandor');
  ok(await pg.evaluate(() => { const m = document.getElementById('mc').getBoundingClientRect(); const d = document.querySelector('.dock-btn').getBoundingClientRect(); return m.bottom > d.top && parseFloat(getComputedStyle(document.getElementById('mc')).paddingBottom) >= 100 }), 'dock: el contenido deja espacio para que el boton no tape lo ultimo');
  const st = await pg.evaluate(() => ({ c: S.catalogo.length, p: S.produccion.length, v: S.ventas.length, inv: S.inventario.map(i => i.producto + '=' + i.stockActual).join(',') }));
  console.log('   demo estado', JSON.stringify(st));
  ok(st.c === 4 && st.p === 2 && st.v === 1, 'demo: loadAll carga catalogo/produccion/ventas');
  ok(st.inv.includes('Pastel de chocolate=4'), 'demo: inventario calculado (6 prod - 2 vend = 4)');
  await pg.evaluate(async () => { await Sheets.append('\u{1F37D}️ Recetas', ['Pastel', 'Pasteles', 'Harina', 2, '']); await Sheets.append('\u{1F37D}️ Recetas', ['Pastel', 'Pasteles', 'Huevo', 3, '']); await Sheets.loadAll(); });
  ok(await pg.evaluate(() => S.recetas.length === 2 && S.recetas[1]._sheetRow === 3), 'demo: append recetas + _sheetRow');
  await pg.evaluate(async () => { await Sheets.deleteRow('\u{1F37D}️ Recetas', 2); await Sheets.loadAll(); });
  ok(await pg.evaluate(() => S.recetas.length === 1 && S.recetas[0].ingrediente === 'Huevo'), 'demo: deleteRow recetas');
  ok(await pg.evaluate(async () => (await Sheets.verifyAdmin('admin123'))?.nombre === 'Administrador' && (await Sheets.verifyAdmin('')) === null && (await Sheets.verifyAdmin('demo123')) === null && (await Sheets.verifyAdmin('x')) === null), 'demo: verifyAdmin acepta admin, rechaza vacia / usuario normal / incorrecta');
  // administrador de catalogo (demo)
  const dc = await pg.evaluate(async () => { await Sheets.loadAll(); return { todos: S.catalogoTodos.length, act: S.catalogo.length } });
  ok(dc.todos === 4 && dc.act === 4, 'demo: catalogoTodos incluye todos los productos (' + JSON.stringify(dc) + ')');
  ok(await pg.evaluate(async () => { const r = S.catalogoTodos[0]; await Sheets.updateRow(CAT_SHEET, r._row, [r.id, r.categoria, r.producto, r.stockMinimo, r.unidad, 'NO']); await Sheets.loadAll(); return S.catalogo.length === 3 && S.catalogoTodos.length === 4 && S.catalogoTodos[0].activo === 'NO' }), 'demo: updateRow desactiva un producto (sale de catalogo, sigue en catalogoTodos)');
  ok(await pg.evaluate(async () => { try { await Sheets.updateRow(CAT_SHEET, 999, ['x', 'y', 'z', 0, '', 'SI']); return false } catch (e) { return true } }), 'demo: updateRow de fila inexistente lanza error');
  await pg.evaluate(() => openModal('loyverse')); await pg.waitForTimeout(200);
  ok(await pg.evaluate(() => document.querySelector('.modal').innerText.includes('solo est\u00e1 disponible usando Supabase')), 'demo: el panel de Loyverse avisa que solo funciona con Supabase');
  await pg.evaluate(() => closeModal());
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
  // ---- administrador de catalogo (solo admin) ----
  pg.on('dialog', d => d.accept());
  const nPatch = () => log.filter(l => l.startsWith('PATCH')).length;
  await pg.evaluate(async () => { await Sheets.append('\u{1F4E6} Catálogo', ['C3', 'Postres', 'Cheesecake', '1', 'pza', 'SI']); await Sheets.loadAll(); });
  ok(await pg.evaluate(() => S.catalogoTodos.length === 3 && S.catalogo.length === 2 && S.catalogoTodos[1].activo === 'NO' && S.catalogoTodos[1]._row === 3), 'cat/sb: catalogoTodos trae activos e inactivos con su fila');
  await pg.evaluate(() => openModal('catalogo'));
  const mh = await pg.evaluate(() => document.querySelector('.modal').innerText);
  ok(mh.includes('Catálogo de productos') && mh.includes('Viejo') && mh.includes('Inactivo') && mh.includes('Todos (3)') && mh.includes('Activos (2)') && mh.includes('Inactivos (1)'), 'cat/sb: el modal lista productos con estado y contadores');
  await pg.evaluate(() => { S.cmF = 'inactivos'; cmRefresh() });
  ok(await pg.evaluate(() => { const t = document.getElementById('cmList').innerText; return t.includes('Viejo') && !t.includes('Cheesecake') }), 'cat/sb: filtro Inactivos');
  await pg.evaluate(() => { S.cmF = 'todos'; S.cmQ = 'viej'; cmRefresh() });
  ok(await pg.evaluate(() => { const t = document.getElementById('cmList').innerText; return t.includes('Viejo') && !t.includes('Cheesecake') }), 'cat/sb: busqueda');
  await pg.evaluate(() => { S.cmQ = ''; cmRefresh() });
  await pg.evaluate(async () => { await cmToggle(3) });
  ok(DBM.catalogo[1].activo === true && await pg.evaluate(() => S.catalogo.length === 3 && S.catalogo.some(p => p.producto === 'Viejo')), 'cat/sb: activar -> PATCH activo=true y reaparece en el catalogo activo');
  ok(DBM.bitacora.some(b => /Producto activado/.test(JSON.stringify(b))), 'cat/sb: la accion queda en la bitacora');
  await pg.evaluate(async () => { await cmToggle(3) });
  ok(DBM.catalogo[1].activo === false && await pg.evaluate(() => S.catalogo.length === 2 && !S.inventario.some(p => p.producto === 'Viejo')), 'cat/sb: desactivar (con confirmacion) -> sale del catalogo e inventario');
  ok(DBM.catalogo[1].producto === 'Viejo' && DBM.catalogo.length === 3 && DBM.produccion.length === 1, 'cat/sb: no se borra ni duplica nada, historial intacto');
  await pg.evaluate(() => { cmEdit(2) });
  ok(await pg.evaluate(() => !!document.getElementById('cmEM') && document.getElementById('cmEC').value === 'Pasteles'), 'cat/sb: se abre el editor con los valores actuales');
  await pg.evaluate(async () => { document.getElementById('cmEM').value = '7'; document.getElementById('cmEU').value = 'Kilos'; await cmSave(2) });
  ok(DBM.catalogo[0].stock_minimo === 7 && DBM.catalogo[0].unidad === 'Kilos' && DBM.catalogo[0].categoria === 'Pasteles' && DBM.catalogo[0].producto === 'Cheesecake', 'cat/sb: editar guarda stock minimo/unidad y no toca el nombre');
  ok(await pg.evaluate(() => S.catalogo.find(p => p.producto === 'Cheesecake' && p.categoria === 'Pasteles').stockMinimo === 7 && S.cmEdit === null), 'cat/sb: la app refleja lo guardado y cierra el editor');
  const p0 = nPatch();
  await pg.evaluate(() => { cmEdit(4) });
  await pg.evaluate(async () => { document.getElementById('cmEC').value = 'Pasteles'; await cmSave(4) });
  ok(DBM.catalogo[2].categoria === 'Postres' && nPatch() === p0, 'cat/sb: no permite duplicar producto+categoria');
  await pg.evaluate(async () => { document.getElementById('cmEC').value = 'Postres'; document.getElementById('cmEM').value = '-3'; await cmSave(4) });
  ok(DBM.catalogo[2].stock_minimo === 1 && nPatch() === p0, 'cat/sb: rechaza stock minimo negativo');
  await pg.evaluate(async () => { document.getElementById('cmEM').value = '1'; await cmSave(4) });
  ok(nPatch() === p0, 'cat/sb: sin cambios no manda nada al servidor');
  ok(await pg.evaluate(() => nextId('PROD', S.catalogoTodos.concat([{ id: 'PROD0099' }])) === 'PROD0100' && isDup('viejo', 'pasteles')), 'cat/sb: isDup considera tambien los inactivos');
  ok(log.some(l => /^PATCH catalogo\?seq=eq\.1 /.test(l)), 'cat/sb: PATCH por seq a la tabla catalogo');
  await pg.evaluate(() => { window._u = S.currentUser; S.currentUser = Object.assign({}, S.currentUser, { rol: 'cocina' }); closeModal() });
  const p1 = nPatch();
  await pg.evaluate(async () => { openModal('catalogo'); await cmToggle(3) });
  ok(await pg.evaluate(() => modalType !== 'catalogo') && nPatch() === p1, 'cat/sb: rol cocina no abre el catalogo ni puede cambiarlo');
  await pg.evaluate(() => { S.currentUser = window._u; closeModal() });
  await pg.evaluate(() => { window._o = SBK.req; SBK.req = async () => { throw new Error('offline') } });
  await pg.evaluate(async () => { await cmToggle(2) });
  await pg.evaluate(() => { SBK.req = window._o });
  ok(DBM.catalogo[0].activo === true && await pg.evaluate(() => S.catalogo.some(p => p.producto === 'Cheesecake' && p.categoria === 'Pasteles')), 'cat/sb: si falla la red no cambia nada (ni en la DB ni en pantalla)');

  // ---- integracion con Loyverse (solo admin, solo Supabase) ----
  tbl('loyverse_seen_items').push({ item_name: 'Flan de la casa', item_id: 'LV1', veces: 3, ultima_vez: '2026-09-24T10:00:00Z' });
  tbl('loyverse_sync_state').push({ id: 1, last_created_at: '2026-09-24T10:00:00Z', last_run_at: '2026-09-24T10:05:00Z', last_run_ok: true, last_run_detalle: '1 recibos, 2 filas de venta, 0 productos sin mapear, 0 omitidos' });
  await pg.evaluate(() => openModal('loyverse')); await pg.waitForTimeout(300);
  let lvh = await pg.evaluate(() => document.querySelector('.modal').innerText);
  ok(lvh.includes('Loyverse') && lvh.includes('Flan de la casa') && lvh.includes('Vendido 3 veces') && /1 recibos/.test(lvh), 'loy: el panel muestra el estado de la ultima sincronizacion y los productos pendientes de emparejar');
  ok(await pg.evaluate(() => { const s = document.getElementById('lvSel_Flan_de_la_casa'); return !!s && [...s.options].some(o => o.value === 'Flan') }), 'loy: el selector de platillo se llena con los platillos de Recetas');
  await pg.evaluate(() => { document.getElementById('lvSel_Flan_de_la_casa').value = 'Flan'; });
  await pg.evaluate(async () => { await lvSaveMap('Flan de la casa') }); await pg.waitForTimeout(200);
  ok(DBM.loyverse_map.length === 1 && DBM.loyverse_map[0].loyverse_item_name === 'Flan de la casa' && DBM.loyverse_map[0].platillo === 'Flan' && DBM.loyverse_map[0].activo === true, 'loy: emparejar crea la fila en loyverse_map');
  ok(DBM.bitacora.some(b => /Mapeo Loyverse/.test(JSON.stringify(b)) && /Flan de la casa/.test(JSON.stringify(b))), 'loy: el emparejamiento queda en la bitacora');
  lvh = await pg.evaluate(() => document.getElementById('lvBody').innerText);
  ok(lvh.includes('No hay productos de Loyverse pendientes') && /emparejados \(1\)/i.test(lvh), 'loy: tras emparejar ya no aparece como pendiente y pasa a "Emparejados"');
  const seqMap = DBM.loyverse_map[0].seq;
  await pg.evaluate(async (seq) => { await lvToggle(seq) }, seqMap); await pg.waitForTimeout(200);
  ok(DBM.loyverse_map[0].activo === false, 'loy: pausar hace PATCH activo=false');
  lvh = await pg.evaluate(() => document.getElementById('lvBody').innerText);
  ok(/pausados \(1\)/i.test(lvh) && lvh.includes('Flan de la casa') && /por emparejar \(1\)/i.test(lvh), 'loy: un mapeo pausado vuelve a aparecer como pendiente hasta que se reactive o reemparje');
  await pg.evaluate(async (seq) => { await lvToggle(seq) }, seqMap); await pg.waitForTimeout(200);
  ok(DBM.loyverse_map[0].activo === true, 'loy: reactivar hace PATCH activo=true');
  await pg.evaluate(() => closeModal());
  // rol no-admin: sin acceso
  await pg.evaluate(() => { window._u2 = S.currentUser; S.currentUser = Object.assign({}, S.currentUser, { rol: 'cocina' }) });
  await pg.evaluate(() => openModal('loyverse')); await pg.waitForTimeout(200);
  ok(await pg.evaluate(() => modalType !== 'loyverse'), 'loy: rol cocina no puede abrir el panel de Loyverse');
  await pg.evaluate(() => { S.currentUser = window._u2 });
  // paginacion: 2500 filas
  for (let i = 0; i < 2500; i++) tbl('mermas').push({ seq: (seqs.mermas = (seqs.mermas || 0) + 1), id: 'M' + i, fecha: '2026-09-01', hora: '', categoria: 'c', producto: 'Cheesecake', cantidad: 1, motivo: '', responsable: '' });
  const nm = await pg.evaluate(async () => (await Sheets.read('⚠️ Mermas', 'A2:H50000')).length);
  ok(nm === 2500, 'sb: paginacion lee 2500 filas (' + nm + ')');
  // ---- carga rapida: paginas en paralelo + recarga incremental ----
  for (let i = 0; i < 5200; i++) tbl('ventas').push({ seq: (seqs.ventas = (seqs.ventas || 0) + 1), id: 'X' + i, fecha: '2026-09-02', categoria: 'TPV', producto: 'Cheesecake', cantidad: 1, vendedor: 'A', notas: '' });
  const snap = () => pg.evaluate(() => JSON.stringify([S.produccion, S.ventas, S.mermas, S.inventario, S.stockBajo, S.recetas, S.catalogo]));
  const gets = (from, re) => log.slice(from).filter(l => l.startsWith('GET') && re.test(l));
  slowMs = 120; let mark = log.length; const t0 = Date.now();
  await pg.evaluate(async () => { await Sheets.loadAll(true) }); const tFull = Date.now() - t0; slowMs = 0;
  const ventasReq = gets(mark, /^GET ventas/);
  ok(ventasReq.length === 6 && ventasReq.slice(0, 5).every(l => /limit=1000/.test(l)), 'perf: carga completa lee ventas (5200+ filas) en 6 paginas (' + ventasReq.length + ')');
  const serial = log.slice(mark).filter(l => l.startsWith('GET')).length * 120;
  ok(tFull < serial * 0.6, 'perf: las paginas y las 8 tablas se piden a la vez (' + tFull + ' ms con 120 ms por peticion; en serie serian ~' + serial + ' ms; el navegador de prueba limita a 6 conexiones, Supabase usa HTTP/2)');
  const full1 = await snap();
  ok(await pg.evaluate(() => S.ventas.length) >= 5200, 'perf: la app tiene todas las filas de ventas');
  // recarga tras guardar = solo filas nuevas
  await pg.evaluate(async () => { await Sheets.append('\u{1F4B0} Ventas', ['VN1', '23/09/2026', 'TPV', 'Cheesecake', 2, 'Admin', '']); await Sheets.append('\u{1F3ED} Producción', ['PN1', '23/09/2026', 'x', 'Mañana', 'Pasteles', 'Cheesecake', 4, 'Admin', '']); });
  mark = log.length; slowMs = 120; const t1 = Date.now();
  await pg.evaluate(async () => { await Sheets.loadAll() }); const tInc = Date.now() - t1; slowMs = 0;
  const g1 = gets(mark, /./);
  const heavy = g1.filter(l => /^GET (ventas|produccion|mermas)/.test(l));
  ok(heavy.length === 3 && heavy.every(l => /seq=gt\./.test(l) && !/offset=/.test(l)), 'perf: tras guardar solo pide las filas nuevas de produccion/ventas/mermas (' + heavy.map(l => l.split('?')[0]).join(',') + ')');
  ok(tInc < tFull * 0.85, 'perf: recarga incremental mas rapida (' + tInc + ' ms vs ' + tFull + ' ms la completa)');
  ok(await pg.evaluate(() => S.ventas[0].id === 'VN1' && S.ventas.length >= 5201 && S.produccion[0].id === 'PN1'), 'perf: las filas nuevas aparecen (ventas y produccion)');
  const inc1 = await snap();
  await pg.evaluate(async () => { await Sheets.loadAll(true) });
  ok(inc1 === await snap(), 'perf: recarga incremental == recarga completa (mismo inventario, stock bajo, listas)');
  // today() ya no crea un formateador por llamada (con 33 mil filas la pantalla de inicio tardaba ~2 s)
  ok(await pg.evaluate(() => today() === new Date().toLocaleDateString('es-MX', { year: 'numeric', month: '2-digit', day: '2-digit' }) && /^\d\d\/\d\d\/\d{4}$/.test(today())), 'perf: today() da el mismo texto dd/mm/yyyy de siempre');
  const tHome = await pg.evaluate(() => { const a = performance.now(); render(); return performance.now() - a });
  ok(tHome < 300, 'perf: dibujar la pantalla con ' + (await pg.evaluate(() => S.produccion.length + S.ventas.length + S.mermas.length)) + ' filas tarda ' + Math.round(tHome) + ' ms');
  // otro dispositivo agrega filas: tambien llegan
  tbl('ventas').push({ seq: (seqs.ventas = seqs.ventas + 1), id: 'OTRO1', fecha: '2026-09-23', categoria: 'TPV', producto: 'Cheesecake', cantidad: 1, vendedor: 'B', notas: '' });
  await pg.evaluate(async () => { await Sheets.loadAll() });
  ok(await pg.evaluate(() => S.ventas[0].id === 'OTRO1'), 'perf: filas agregadas desde otro dispositivo llegan en la recarga incremental');
  // boton Actualizar = completa
  mark = log.length; await pg.evaluate(async () => { await Sheets.loadAll(true) });
  ok(gets(mark, /^GET ventas/).length === 6, 'perf: loadAll(true) (boton Actualizar) vuelve a leer todo');
  // sin Content-Range (proxy raro): cae a paginas en serie y da lo mismo
  noRange = true; await pg.evaluate(async () => { await Sheets.loadAll(true) }); noRange = false;
  ok(await pg.evaluate(() => S.ventas.length) >= 5202, 'perf: sin Content-Range sigue funcionando (paginas en serie)');
  // tras un error de carga la siguiente es completa
  await pg.evaluate(() => { S.connected = false });
  mark = log.length; await pg.evaluate(async () => { await Sheets.loadAll() });
  ok(gets(mark, /^GET ventas/).length === 6 && await pg.evaluate(() => S.connected === true), 'perf: si la carga anterior fallo, la siguiente es completa');
  // borrar receta despues de recargas incrementales sigue apuntando a la fila correcta
  await pg.evaluate(async () => { await Sheets.append('\u{1F37D}\ufe0f Recetas', ['Otra', 'Postres', 'Azucar', 2, 'kg']); await Sheets.loadAll(); const r = S.recetas.find(x => x.ingrediente === 'Azucar'); await Sheets.deleteRow('\u{1F37D}\ufe0f Recetas', r._sheetRow); await Sheets.loadAll(); });
  ok(await pg.evaluate(() => !S.recetas.some(x => x.ingrediente === 'Azucar') && S.recetas.some(x => x.ingrediente === 'Huevo')), 'perf: deleteRow de receta sigue correcto tras recargas incrementales');
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
  ok(await pg.evaluate(async () => { try { await Sheets.updateRow(CAT_SHEET, 2, ['a', 'b', 'c', 0, '', 'NO']); return false } catch (e) { return /Supabase/.test(e.message) } }) && posts.length === 2, 'gs: editar catalogo no esta disponible en modo Sheets (mensaje claro, no manda nada)');
  ok(await pg.evaluate(async () => { await Sheets.loadAll(); return S.catalogoTodos.length === 2 && S.catalogo.length === 1 && S.catalogoTodos[0].activo === 'SÍ' }), 'gs: catalogoTodos tambien en modo Sheets; "Sí" cuenta como activo');
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
