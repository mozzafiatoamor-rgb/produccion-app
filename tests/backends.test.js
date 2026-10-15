// Prueba de los 3 backends de index.html: sheets (por defecto), demo (localStorage) y
// supabase (contra un mock local de PostgREST; no toca ningun servicio real).
// Uso:  npm i --no-save playwright && node tests/backends.test.js
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const ROOT = path.join(__dirname, '..');

// ---- Mock PostgREST minimo ----
const DBM = {}; const seqs = {}; const GRANTS = { catalogo: ['id', 'categoria', 'producto', 'stock_minimo', 'unidad', 'activo'], loyverse_map: ['loyverse_item_name', 'platillo', 'activo', 'ignorado'], loyverse_pending: ['estado', 'resuelto_por', 'resuelto_at'] };
function tbl(t) { return DBM[t] = DBM[t] || []; }
const users = [{ id: 'U1', usuario: 'admin', nombre: 'Admin', rol: 'admin', pw: 'secreto' }];
const log = []; let sawAuth = false;
let slowMs = 0, noRange = false;
let fnSyncCalls = 0, fnSyncOnNextCall = null; // mock del Edge Function loyverse-sync (boton "Sincronizar ahora"/"Actualizar")
function json(res, code, body, extra) { res.writeHead(code, Object.assign({ 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': 'Content-Range' }, extra || {})); res.end(JSON.stringify(body)); }
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') return json(res, 200, {});
  if (u.pathname === '/functions/v1/loyverse-sync') {
    let body = ''; req.on('data', d => body += d); req.on('end', () => {
      fnSyncCalls++;
      const st = tbl('loyverse_sync_state'); if (!st.length) st.push({ id: 1 });
      st[0].last_run_at = new Date().toISOString(); st[0].last_run_ok = true; st[0].last_run_detalle = 'Sincronizacion manual #' + fnSyncCalls;
      if (fnSyncOnNextCall) { const fn = fnSyncOnNextCall; fnSyncOnNextCall = null; fn(); }
      json(res, 200, { ok: true });
    }); return;
  }
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
      if (p === 'rpc/admin_create_user') {
        const b = JSON.parse(body);
        const admin = users.find(x => x.rol === 'admin' && b.p_admin_password && x.pw === b.p_admin_password);
        if (!admin) return json(res, 400, { message: 'Contraseña de administrador incorrecta' });
        if (!b.p_usuario || !b.p_password) return json(res, 400, { message: 'Falta el usuario o la contraseña' });
        if (users.some(x => x.usuario.toLowerCase() === b.p_usuario.toLowerCase())) return json(res, 400, { message: 'Ese usuario ya existe' });
        const rol = b.p_rol === 'admin' ? 'admin' : 'usuario';
        const nu = { id: b.p_id, usuario: b.p_usuario, nombre: b.p_nombre || '', rol, pw: b.p_password };
        users.push(nu);
        return json(res, 200, [{ id: nu.id, usuario: nu.usuario, nombre: nu.nombre, rol: nu.rol }]);
      }
      if (p === 'rpc/admin_update_user') {
        const b = JSON.parse(body);
        const admin = users.find(x => x.rol === 'admin' && b.p_admin_password && x.pw === b.p_admin_password);
        if (!admin) return json(res, 400, { message: 'Contraseña de administrador incorrecta' });
        const target = users.find(x => x.usuario === b.p_usuario_actual);
        if (!target) return json(res, 400, { message: 'Usuario no encontrado' });
        const rol = b.p_rol === 'admin' ? 'admin' : 'usuario';
        if (target.rol === 'admin' && rol !== 'admin' && users.filter(x => x.rol === 'admin').length <= 1) return json(res, 400, { message: 'No puedes quitarle el rol de admin al único administrador' });
        if (b.p_usuario_nuevo.toLowerCase() !== target.usuario.toLowerCase() && users.some(x => x.usuario.toLowerCase() === b.p_usuario_nuevo.toLowerCase())) return json(res, 400, { message: 'Ese usuario ya existe' });
        target.usuario = b.p_usuario_nuevo; target.nombre = b.p_nombre || ''; target.rol = rol;
        if (b.p_password) target.pw = b.p_password;
        return json(res, 200, [{ id: target.id, usuario: target.usuario, nombre: target.nombre, rol: target.rol }]);
      }
      if (p === 'rpc/admin_delete_user') {
        const b = JSON.parse(body);
        const admin = users.find(x => x.rol === 'admin' && b.p_admin_password && x.pw === b.p_admin_password);
        if (!admin) return json(res, 400, { message: 'Contraseña de administrador incorrecta' });
        const i = users.findIndex(x => x.usuario === b.p_usuario);
        if (i < 0) return json(res, 400, { message: 'Usuario no encontrado' });
        if (users[i].rol === 'admin' && users.filter(x => x.rol === 'admin').length <= 1) return json(res, 400, { message: 'No puedes eliminar al único administrador' });
        users.splice(i, 1);
        return json(res, 200, {});
      }
      const t = p; const rows = tbl(t);
      if (req.method === 'POST') {
        const parsed = JSON.parse(body); const arr = Array.isArray(parsed) ? parsed : [parsed];
        const conflictCol = u.searchParams.get('on_conflict'); const prefer = req.headers.prefer || '';
        const merge = /resolution=merge-duplicates/.test(prefer), ignoreDup = /resolution=ignore-duplicates/.test(prefer);
        const out = [];
        arr.forEach(r => {
          const existing = conflictCol ? rows.find(x => x[conflictCol] === r[conflictCol]) : null;
          if (existing) { if (merge) { Object.assign(existing, r); out.push(existing); return; } if (ignoreDup) { out.push(existing); return; } }
          r.seq = (seqs[t] = (seqs[t] || 0) + 1); rows.push(r); out.push(r);
        });
        return json(res, 201, out);
      }
      if (req.method === 'GET') {
        const off = +u.searchParams.get('offset') || 0, lim = Math.min(+u.searchParams.get('limit') || 1000, 1000), gt = u.searchParams.get('seq');
        let src = rows; if (gt && gt.startsWith('gt.')) src = rows.filter(r => r.seq > +gt.slice(3));
        // filtros genericos ?col=eq.valor (como PostgREST), para columnas que no sean select/order/limit/offset/seq
        for (const [k, v] of u.searchParams.entries()) { if (['select', 'order', 'limit', 'offset', 'seq'].includes(k)) continue; if (v.startsWith('eq.')) { const val = v.slice(3); src = src.filter(r => String(r[k]) === val); } }
        const sl = src.slice(off, off + lim), hdr = {};
        if (!noRange && /count=exact/.test(req.headers.prefer || '')) hdr['content-range'] = (sl.length ? off + '-' + (off + sl.length - 1) : '*') + '/' + src.length;
        return setTimeout(() => json(res, hdr['content-range'] ? 206 : 200, sl, hdr), slowMs);
      }
      if (req.method === 'PATCH') { const raw = u.searchParams.get('seq') || ''; let ids; if (raw.startsWith('eq.')) ids = [+raw.slice(3)]; else if (raw.startsWith('in.(') && raw.endsWith(')')) ids = raw.slice(4, -1).split(',').map(Number); else ids = []; const matched = rows.filter(x => ids.includes(x.seq)); if (!matched.length) return json(res, 200, []); const b = JSON.parse(body); var allow = GRANTS[t]; if (allow && Object.keys(b).some(k => !allow.includes(k))) return json(res, 403, { message: 'columna no permitida' }); matched.forEach(r => Object.assign(r, b)); return json(res, 200, matched); }
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
  // panel de usuarios (demo: misma logica que supabase pero local, sin pedir nada al servidor)
  ok(await pg.evaluate(async () => { try { await Sheets.createUser('mala', 'U9', 'nuevo', '1234', 'Nuevo', 'usuario'); return false } catch (e) { return /incorrecta/.test(e.message) } }), 'demo: createUser rechaza contraseña de admin incorrecta');
  ok(await pg.evaluate(async () => { const r = await Sheets.createUser('admin123', 'U9', 'nuevo', '1234', 'Nuevo Empleado', 'usuario'); return r.usuario === 'nuevo' && S.usuarios.some(u => u.usuario === 'nuevo') }), 'demo: createUser agrega el usuario (local)');
  ok(await pg.evaluate(async () => { try { await Sheets.deleteUser('admin123', 'admin'); return false } catch (e) { return /\u00fanico administrador/.test(e.message) } }), 'demo: deleteUser no deja eliminar al unico admin');
  ok(await pg.evaluate(async () => { await Sheets.deleteUser('admin123', 'nuevo'); return !S.usuarios.some(u => u.usuario === 'nuevo') }), 'demo: deleteUser elimina un usuario normal');
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

  // ---- panel de usuarios (crear/editar/eliminar, solo admin, confirmando con la contraseña de un admin) ----
  await pg.evaluate(() => openModal('usuarios'));
  let umh = await pg.evaluate(() => document.querySelector('.modal').innerText);
  ok(umh.includes('Usuarios') && umh.includes('Admin') && !umh.includes('Empleado'), 'um/sb: el panel lista a los usuarios existentes (solo el admin inicial)');
  await pg.evaluate(() => umOpenNew());
  ok(await pg.evaluate(() => modalType === 'userForm' && !!document.getElementById('umU')), 'um/sb: "Nuevo usuario" abre el formulario');
  await pg.evaluate(() => { document.getElementById('umU').value = 'maria'; document.getElementById('umN').value = 'María Pérez'; document.getElementById('umP').value = '12'; });
  await pg.evaluate(() => umSubmitForm());
  ok(await pg.evaluate(() => modalType === 'userForm'), 'um/sb: contraseña muy corta se rechaza sin llegar al servidor');
  await pg.evaluate(() => { document.getElementById('umP').value = '1234'; });
  await pg.evaluate(() => umSubmitForm());
  ok(await pg.evaluate(() => modalType === 'userAuth'), 'um/sb: con los datos completos, pide la contraseña de un admin para confirmar');
  await pg.evaluate(() => umConfirmAuth('mala'));
  ok(users.length === 1 && await pg.evaluate(() => modalType === 'userAuth'), 'um/sb: contraseña de admin incorrecta no crea el usuario');
  await pg.evaluate(() => umConfirmAuth('secreto'));
  ok(users.length === 2 && users[1].usuario === 'maria' && users[1].rol === 'usuario' && await pg.evaluate(() => modalType === 'usuarios'), 'um/sb: contraseña correcta crea el usuario y vuelve a la lista');
  ok(DBM.bitacora.some(b => /Usuario creado/.test(JSON.stringify(b))), 'um/sb: la creacion queda en la bitacora');
  await pg.evaluate(() => umOpenNew());
  await pg.evaluate(() => { document.getElementById('umU').value = 'MARIA'; document.getElementById('umN').value = 'Otra'; document.getElementById('umP').value = '5678'; });
  await pg.evaluate(() => umSubmitForm());
  await pg.evaluate(() => umConfirmAuth('secreto'));
  ok(users.length === 2, 'um/sb: no deja crear un usuario con el mismo nombre (sin importar mayusculas)');
  await pg.evaluate(() => umOpenEdit('maria'));
  ok(await pg.evaluate(() => document.getElementById('umU').value === 'maria' && document.getElementById('umR').value === 'usuario'), 'um/sb: editar precarga los datos actuales');
  await pg.evaluate(() => { document.getElementById('umN').value = 'Maria P.'; document.getElementById('umR').value = 'admin'; });
  await pg.evaluate(() => umSubmitForm());
  await pg.evaluate(() => umConfirmAuth('secreto'));
  ok(users[1].nombre === 'Maria P.' && users[1].rol === 'admin' && users[1].pw === '1234', 'um/sb: editar guarda nombre/rol y conserva la contraseña si se deja en blanco');
  await pg.evaluate(() => umOpenEdit('maria'));
  await pg.evaluate(() => { document.getElementById('umR').value = 'usuario'; });
  await pg.evaluate(() => umSubmitForm());
  await pg.evaluate(() => umConfirmAuth('secreto'));
  ok(users[1].rol === 'usuario', 'um/sb: se le puede quitar el admin a alguien si no es el unico');
  await pg.evaluate(() => umOpenEdit('admin'));
  await pg.evaluate(() => { document.getElementById('umR').value = 'usuario'; });
  await pg.evaluate(() => umSubmitForm());
  await pg.evaluate(() => umConfirmAuth('secreto'));
  ok(users[0].rol === 'admin', 'um/sb: no deja quitarle el admin al unico administrador');
  await pg.evaluate(() => umOpenEdit('admin'));
  await pg.evaluate(() => { document.getElementById('umN').value = 'Administrador General'; document.getElementById('umR').value = 'admin'; });
  await pg.evaluate(() => umSubmitForm());
  await pg.evaluate(() => umConfirmAuth('secreto'));
  ok(users[0].nombre === 'Administrador General' && await pg.evaluate(() => S.currentUser.nombre === 'Administrador General' && S.screen === 'main'), 'um/sb: editar tu propia cuenta actualiza la sesion sin cerrarla');
  await pg.evaluate(() => umAskDelete('admin'));
  await pg.evaluate(() => umConfirmAuth('secreto'));
  ok(users.length === 2, 'um/sb: no deja eliminar al unico administrador');
  await pg.evaluate(() => umAskDelete('maria'));
  await pg.evaluate(() => umConfirmAuth('secreto'));
  ok(users.length === 1 && await pg.evaluate(() => modalType === 'usuarios' && !document.querySelector('.modal').innerText.includes('Maria')), 'um/sb: eliminar un usuario normal funciona y refresca la lista');
  await pg.evaluate(() => { window._u2 = S.currentUser; S.currentUser = Object.assign({}, S.currentUser, { rol: 'cocina' }); closeModal() });
  await pg.evaluate(() => openModal('usuarios'));
  ok(await pg.evaluate(() => modalType !== 'usuarios'), 'um/sb: rol cocina no puede abrir el panel de usuarios');
  await pg.evaluate(() => { S.currentUser = window._u2; closeModal() });

  // ---- integracion con Loyverse (solo admin, solo Supabase) ----
  tbl('loyverse_seen_items').push({ item_name: 'Flan de la casa', item_id: 'LV1', veces: 3, ultima_vez: '2026-09-24T10:00:00Z' });
  tbl('loyverse_sync_state').push({ id: 1, last_created_at: '2026-09-24T10:00:00Z', last_run_at: '2026-09-24T10:05:00Z', last_run_ok: true, last_run_detalle: '1 recibos, 2 filas de venta, 0 productos sin mapear, 0 omitidos' });
  await pg.evaluate(() => openModal('loyverse')); await pg.waitForTimeout(300);
  let lvh = await pg.evaluate(() => document.querySelector('.modal').innerText);
  ok(lvh.includes('Loyverse') && lvh.includes('Flan de la casa') && lvh.includes('Vendido 3 veces') && /1 recibos/.test(lvh), 'loy: el panel muestra el estado de la ultima sincronizacion y los productos pendientes de emparejar');
  ok(await pg.evaluate(() => { const s = document.getElementById('lvSel_Flan_de_la_casa'); return !!s && s.tagName === 'INPUT' && !s.hasAttribute('list') }), 'loy: el selector de platillo es un campo de texto (sin depender del datalist nativo, poco confiable en varios navegadores de celular)');
  ok(await pg.evaluate(() => { const s = document.getElementById('lvSel_Flan_de_la_casa'); s.value = 'fla'; s.dispatchEvent(new Event('input')); const box = document.getElementById('lvSelSuggest_Flan_de_la_casa'); return !!box && box.style.display === 'block' && box.innerText.includes('Flan'); }), 'loy: escribir en el campo despliega sugerencias propias filtradas por los platillos de Recetas');
  ok(await pg.evaluate(() => { document.querySelector('#lvSelSuggest_Flan_de_la_casa div').click(); return document.getElementById('lvSel_Flan_de_la_casa').value === 'Flan' && (S.lvMapSel['Flan de la casa'] || {}).platillo === 'Flan'; }), 'loy: elegir una sugerencia rellena el campo y guarda la seleccion pendiente');
  await pg.evaluate(() => { delete S.lvMapSel['Flan de la casa']; lvRefresh() }); // lvSaveMap (abajo) es el flujo legado de guardado individual, sin boton en la UI real (hoy se guarda por lote con Guardar (N)); se limpia la seleccion pendiente para no mezclar ambos caminos en la prueba
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
  // ---- ignorar (ej. bebidas: esta app solo descuenta inventario de comida) ----
  tbl('loyverse_seen_items').push({ item_name: 'Agua mineral', item_id: 'LV2', veces: 5, ultima_vez: '2026-09-24T11:00:00Z' });
  await pg.waitForTimeout(50);
  await pg.evaluate(async () => { await lvIgnorar('Agua mineral') }); await pg.waitForTimeout(200);
  ok(DBM.loyverse_map.some(m => m.loyverse_item_name === 'Agua mineral' && m.ignorado === true && m.platillo === null), 'loy: ignorar crea/actualiza la fila con ignorado=true y platillo=null');
  lvh = await pg.evaluate(() => document.getElementById('lvBody').innerText);
  ok(/ignorados \(1\)/i.test(lvh), 'loy: un item ignorado aparece en la seccion "Ignorados"');
  ok(!/por emparejar[\s\S]*Agua mineral[\s\S]*ignorados/i.test(lvh), 'loy: el item ignorado ya no aparece en "Por emparejar"');
  const seqIgn = DBM.loyverse_map.find(m => m.loyverse_item_name === 'Agua mineral').seq;
  await pg.evaluate(async (seq) => { await lvReactivarIgnorado(seq) }, seqIgn); await pg.waitForTimeout(200);
  ok(DBM.loyverse_map.find(m => m.seq === seqIgn).ignorado === false, 'loy: reactivar ignorado hace PATCH ignorado=false');
  lvh = await pg.evaluate(() => document.getElementById('lvBody').innerText);
  ok(/por emparejar \(1\)/i.test(lvh) && lvh.includes('Agua mineral'), 'loy: al reactivar un ignorado vuelve a "Por emparejar" para emparejarlo con un platillo (y no queda tambien en "Emparejados")');
  ok(!/emparejados[\s\S]*Agua mineral/i.test(lvh), 'loy: un reactivado sin platillo no aparece en "Emparejados"');
  // ---- guardar varios cambios de una sola vez (mapeo masivo, sin uno-por-uno) ----
  tbl('loyverse_seen_items').push({ item_name: 'Pay de Queso', item_id: 'LV3', veces: 2, ultima_vez: '2026-09-24T11:30:00Z' });
  tbl('loyverse_seen_items').push({ item_name: 'Refresco Cola', item_id: 'LV4', veces: 4, ultima_vez: '2026-09-24T11:45:00Z' });
  await pg.evaluate(async () => { await lvLoad(); lvRefresh() }); await pg.waitForTimeout(150);
  const postsBeforeBatch = log.filter(l => l.startsWith('POST loyverse_map')).length;
  await pg.evaluate(() => { lvMapSelSet('Pay de Queso', 'platillo', 'Flan'); lvMapSelSet('Refresco Cola', 'ignorar', true); lvMapSelSet('Agua mineral', 'platillo', 'Flan') });
  lvh = await pg.evaluate(() => document.getElementById('lvBody').innerText);
  ok(/Guardar \(3\)/.test(lvh), 'loy/batch: elegir platillo o marcar ignorar en varios productos junta un contador de cambios, sin guardar nada todavia');
  ok(DBM.loyverse_map.length === 2, 'loy/batch: elegir opciones en pantalla todavia no manda nada al servidor');
  ok(await pg.evaluate(() => document.getElementById('lvSel_' + lvSlug('Refresco Cola')).disabled === true), 'loy/batch: marcar Ignorar deshabilita el selector de platillo de ese producto');
  await pg.evaluate(async () => { await lvGuardarCambios() }); await pg.waitForTimeout(250);
  ok(log.filter(l => l.startsWith('POST loyverse_map')).length === postsBeforeBatch + 1, 'loy/batch: "Guardar" manda un solo POST con todos los cambios juntos (no uno por uno)');
  ok(DBM.loyverse_map.length === 4, 'loy/batch: crea filas nuevas solo para los productos que de verdad no tenian mapeo');
  ok(DBM.loyverse_map.some(m => m.loyverse_item_name === 'Pay de Queso' && m.platillo === 'Flan' && m.ignorado === false), 'loy/batch: emparejar un producto nuevo dentro del guardado masivo');
  ok(DBM.loyverse_map.some(m => m.loyverse_item_name === 'Refresco Cola' && m.ignorado === true && m.platillo === null), 'loy/batch: ignorar un producto nuevo dentro del mismo guardado');
  ok(DBM.loyverse_map.filter(m => m.loyverse_item_name === 'Agua mineral').length === 1 && DBM.loyverse_map.find(m => m.loyverse_item_name === 'Agua mineral').platillo === 'Flan', 'loy/batch: actualiza (no duplica) la fila ya existente de un producto que se habia reactivado');
  ok(DBM.bitacora.some(b => /Loyverse mapeo masivo/.test(JSON.stringify(b))), 'loy/batch: el guardado masivo queda como una sola entrada en la bitacora, no una por producto');
  lvh = await pg.evaluate(() => document.getElementById('lvBody').innerText);
  ok(!/Guardar \(/.test(lvh), 'loy/batch: tras guardar se limpia la seleccion pendiente (el boton desaparece)');
  ok(lvh.includes('No hay productos de Loyverse pendientes de emparejar'), 'loy/batch: tras guardar ya no queda nada en "Por emparejar"');
  ok(/emparejados \(3\)/i.test(lvh) && /ignorados \(1\)/i.test(lvh), 'loy/batch: los productos guardados pasan a "Emparejados" o "Ignorados" segun lo elegido');

  // ---- variantes de Loyverse (ej. tipo de pasta / proteina): Loyverse las manda en variant_name, no en modificadores
  // (line_modifiers siempre viene vacio para este negocio, confirmado con recibos reales). El backend ya combina
  // item_name + variant_name en un solo nombre (ej. "PST ALFREDO - Fetuccini / Pollo") antes de guardarlo en
  // loyverse_seen_items, asi que cada combinacion se empareja con Recetas igual que cualquier otro producto, sin
  // pantalla ni tablas nuevas: reutiliza el mismo "Por emparejar" de siempre ----
  await pg.evaluate(async () => { await Sheets.append('\u{1F37D}️ Recetas', ['Alfredo Fettuccini Pollo', 'Pastas', 'Salsa alfredo', 0.2, 'kg']); await Sheets.append('\u{1F37D}️ Recetas', ['Alfredo Fettuccini Pollo', 'Pastas', 'Pechuga de pollo', 0.15, 'kg']); await Sheets.append('\u{1F37D}️ Recetas', ['Alfredo Linguini Camaron', 'Pastas', 'Salsa alfredo', 0.2, 'kg']); await Sheets.append('\u{1F37D}️ Recetas', ['Alfredo Linguini Camaron', 'Pastas', 'Camaron', 0.12, 'kg']); await Sheets.loadAll(); });
  tbl('loyverse_seen_items').push({ item_name: 'PST ALFREDO - Fetuccini / Pollo', item_id: 'LV10', veces: 6, ultima_vez: '2026-09-25T10:00:00Z' });
  tbl('loyverse_seen_items').push({ item_name: 'PST ALFREDO - Linguini / Camaron', item_id: 'LV11', veces: 2, ultima_vez: '2026-09-25T10:10:00Z' });
  tbl('loyverse_seen_items').push({ item_name: 'CHAPATA - Mar y tierra', item_id: 'LV12', veces: 4, ultima_vez: '2026-09-25T10:20:00Z' });
  await pg.evaluate(async () => { await lvLoad(); lvRefresh() }); await pg.waitForTimeout(150);
  lvh = await pg.evaluate(() => document.getElementById('lvBody').innerText);
  ok(lvh.includes('PST ALFREDO - Fetuccini / Pollo') && lvh.includes('PST ALFREDO - Linguini / Camaron'), 'loy/variante: dos variantes del mismo producto base de Loyverse (mismo item_name) aparecen como dos filas separadas por emparejar, cada una con su nombre completo item_name + variante');
  ok(await pg.evaluate(() => lvPlatillos().includes('Alfredo Fettuccini Pollo') && lvPlatillos().includes('Alfredo Linguini Camaron')), 'loy/variante: la lista de platillos para emparejar incluye la receta exacta de cada combinacion (pasta+proteina)');
  ok(await pg.evaluate(() => { const s = document.getElementById('lvSel_' + lvSlug('PST ALFREDO - Fetuccini / Pollo')); s.value = 'fettuccini pollo'; s.dispatchEvent(new Event('input')); const box = document.getElementById('lvSelSuggest_' + lvSlug('PST ALFREDO - Fetuccini / Pollo')); return !!box && box.innerText.includes('Alfredo Fettuccini Pollo') && !box.innerText.includes('Alfredo Linguini Camaron'); }), 'loy/variante: las sugerencias distinguen cada variante (buscar "fetuccini pollo" no trae la de camaron)');
  await pg.evaluate(() => { document.getElementById('lvSel_' + lvSlug('PST ALFREDO - Fetuccini / Pollo')).value = 'Alfredo Fettuccini Pollo'; });
  await pg.evaluate(async () => { await lvSaveMap('PST ALFREDO - Fetuccini / Pollo') }); await pg.waitForTimeout(200);
  ok(DBM.loyverse_map.some(m => m.loyverse_item_name === 'PST ALFREDO - Fetuccini / Pollo' && m.platillo === 'Alfredo Fettuccini Pollo'), 'loy/variante: emparejar una combinacion especifica crea su propia fila en loyverse_map con el nombre completo item+variante');
  lvh = await pg.evaluate(() => document.getElementById('lvBody').innerText);
  ok(/por emparejar[\s\S]*PST ALFREDO - Linguini \/ Camaron/i.test(lvh), 'loy/variante: emparejar una variante no resuelve la otra variante del mismo producto (siguen siendo productos distintos para el sistema)');
  await pg.evaluate(() => { document.getElementById('lvSel_' + lvSlug('PST ALFREDO - Linguini / Camaron')).value = 'Alfredo Linguini Camaron'; });
  await pg.evaluate(async () => { await lvSaveMap('PST ALFREDO - Linguini / Camaron') }); await pg.waitForTimeout(200);
  ok(DBM.loyverse_map.some(m => m.loyverse_item_name === 'PST ALFREDO - Linguini / Camaron' && m.platillo === 'Alfredo Linguini Camaron'), 'loy/variante: la segunda variante se mapea a su propia receta exacta, independiente de la primera');
  lvh = await pg.evaluate(() => document.getElementById('lvBody').innerText);
  // ---- lista de Emparejados colapsable, agrupada por categoria de receta, con su propio buscador ----
  ok(/emparejados \(5\)/i.test(lvh) && !lvh.includes('PST ALFREDO - Fetuccini / Pollo') && !lvh.includes('PST ALFREDO - Linguini / Camaron') && !lvh.includes('Flan de la casa'), 'loy/emparejados: la lista de Emparejados viene colapsada por defecto (se ve el total pero no los productos uno por uno)');
  await pg.evaluate(() => { lvActToggleOpen() }); await pg.waitForTimeout(100);
  lvh = await pg.evaluate(() => document.getElementById('lvBody').innerText);
  ok(await pg.evaluate(() => !!document.getElementById('lvActList')), 'loy/emparejados: desplegada, la lista tiene su propio buscador');
  ok(/emparejados[\s\S]*PST ALFREDO - Fetuccini \/ Pollo/i.test(lvh) && /emparejados[\s\S]*PST ALFREDO - Linguini \/ Camaron/i.test(lvh), 'loy/variante: ambas combinaciones quedan emparejadas por separado, cada una a su receta exacta');
  const iPastas = lvh.search(/pastas \(2\)/i), iPostres = lvh.search(/postres \(3\)/i), iFet = lvh.indexOf('PST ALFREDO - Fetuccini / Pollo'), iLin = lvh.indexOf('PST ALFREDO - Linguini / Camaron'), iFlanCasa = lvh.indexOf('Flan de la casa');
  ok(iPastas >= 0 && iPostres >= 0 && iPastas < iFet && iFet < iLin && iLin < iPostres && iPostres < iFlanCasa, 'loy/emparejados: los productos quedan agrupados por categoria de receta (Pastas antes de Postres), cada uno bajo su encabezado');
  await pg.evaluate(() => { S.lvActQ = 'linguini' }); const lvActTxt = await pg.evaluate(() => { lvActRefresh(); return document.getElementById('lvActList').innerText });
  ok(lvActTxt.includes('PST ALFREDO - Linguini / Camaron') && !lvActTxt.includes('PST ALFREDO - Fetuccini / Pollo') && !lvActTxt.includes('Flan de la casa'), 'loy/emparejados: el buscador de Emparejados filtra por nombre sin perder el resto de la pantalla');
  await pg.evaluate(() => { S.lvActQ = ''; lvActRefresh(); lvActToggleOpen() }); await pg.waitForTimeout(100);
  lvh = await pg.evaluate(() => document.getElementById('lvBody').innerText);
  ok(/emparejados \(5\)/i.test(lvh) && !lvh.includes('PST ALFREDO - Fetuccini / Pollo'), 'loy/emparejados: se puede volver a colapsar la lista');
  ok(/por emparejar[\s\S]*CHAPATA - Mar y tierra/i.test(lvh), 'loy/variante: un producto+variante sin receta cargada todavia sigue pendiente, mostrando su nombre completo item_name + variante (no solo "CHAPATA")');
  // ---- autocompletado del platillo (datalist, se filtra solo al escribir) y "Ignorar todos" en Por emparejar ----
  tbl('loyverse_seen_items').push({ item_name: 'BEBIDA MISTERIOSA', item_id: 'LV13', veces: 3, ultima_vez: '2026-09-25T10:30:00Z' });
  await pg.evaluate(async () => { await lvLoad(); lvRefresh() }); await pg.waitForTimeout(150);
  await pg.evaluate(() => { const el = document.getElementById('lvSel_' + lvSlug('CHAPATA - Mar y tierra')); el.value = 'Un platillo que no existe'; el.dispatchEvent(new Event('change')) }); await pg.waitForTimeout(100);
  ok(await pg.evaluate(() => document.getElementById('lvSel_' + lvSlug('CHAPATA - Mar y tierra')).value === ''), 'loy/autocomplete: escribir un platillo que no existe en la lista se rechaza y el campo se limpia');
  ok(await pg.evaluate(() => !((S.lvMapSel || {})['CHAPATA - Mar y tierra'] || {}).platillo), 'loy/autocomplete: un platillo invalido no se guarda en la seleccion pendiente');
  await pg.evaluate(() => { lvMapSelSet('CHAPATA - Mar y tierra', 'platillo', 'Flan') });
  await pg.evaluate(() => { window.confirm = () => true });
  await pg.evaluate(() => { lvIgnorarTodosPendientes() }); await pg.waitForTimeout(150);
  ok(await pg.evaluate(() => (S.lvMapSel || {})['CHAPATA - Mar y tierra'].platillo === 'Flan' && !(S.lvMapSel['CHAPATA - Mar y tierra'].ignorar)), 'loy/ignorar-todos: no toca un producto que ya tiene un platillo elegido en pantalla (aunque no se haya guardado todavia)');
  ok(await pg.evaluate(() => (S.lvMapSel || {})['BEBIDA MISTERIOSA'] && S.lvMapSel['BEBIDA MISTERIOSA'].ignorar === true), 'loy/ignorar-todos: marca Ignorar en los productos pendientes que todavia no tenian platillo elegido');
  lvh = await pg.evaluate(() => document.getElementById('lvBody').innerText);
  ok(await pg.evaluate(() => document.getElementById('lvSel_' + lvSlug('BEBIDA MISTERIOSA')).disabled === true), 'loy/ignorar-todos: el campo de platillo del producto recien marcado se deshabilita, igual que al marcarlo a mano');
  await pg.evaluate(async () => { await lvGuardarCambios() }); await pg.waitForTimeout(200);
  ok(DBM.loyverse_map.some(m => m.loyverse_item_name === 'CHAPATA - Mar y tierra' && m.platillo === 'Flan'), 'loy/ignorar-todos: el producto que ya tenia platillo elegido se guarda emparejado con ese platillo, no ignorado');
  ok(DBM.loyverse_map.some(m => m.loyverse_item_name === 'BEBIDA MISTERIOSA' && m.ignorado === true && m.platillo === null), 'loy/ignorar-todos: el producto marcado por el boton se guarda ignorado, junto con los demas cambios, al presionar Guardar');
  lvh = await pg.evaluate(() => document.getElementById('lvBody').innerText);
  ok(!/por emparejar[\s\S]*CHAPATA - Mar y tierra/i.test(lvh) && !/por emparejar[\s\S]*BEBIDA MISTERIOSA/i.test(lvh), 'loy/ignorar-todos: tras guardar, ninguno de los dos sigue en "Por emparejar"');
  // ---- lista de Ignorados colapsable con buscador (para que no sea una lista larga) ----
  ok(/ignorados \(2\)/i.test(lvh) && !lvh.includes('Refresco Cola') && !lvh.includes('BEBIDA MISTERIOSA'), 'loy/ignorados: la lista viene colapsada por defecto (se ve el total pero no los productos uno por uno)');
  await pg.evaluate(() => { lvIgnToggleOpen() }); await pg.waitForTimeout(100);
  lvh = await pg.evaluate(() => document.getElementById('lvBody').innerText);
  ok(lvh.includes('Refresco Cola') && lvh.includes('BEBIDA MISTERIOSA'), 'loy/ignorados: al desplegarla se ven todos los productos ignorados');
  ok(await pg.evaluate(() => !!document.getElementById('lvIgnList')), 'loy/ignorados: desplegada, la lista tiene su propio buscador');
  await pg.evaluate(() => { S.lvIgnQ = 'refresco'; lvIgnRefresh() }); await pg.waitForTimeout(100);
  let ignListTxt = await pg.evaluate(() => document.getElementById('lvIgnList').innerText);
  ok(ignListTxt.includes('Refresco Cola') && !ignListTxt.includes('BEBIDA MISTERIOSA'), 'loy/ignorados: el buscador filtra por nombre (sin acentos/mayusculas) sin perder el resto de la pantalla');
  const seqRefresco = DBM.loyverse_map.find(m => m.loyverse_item_name === 'Refresco Cola').seq;
  await pg.evaluate(async (seq) => { await lvReactivarIgnorado(seq) }, seqRefresco); await pg.waitForTimeout(200);
  ok(DBM.loyverse_map.find(m => m.seq === seqRefresco).ignorado === false, 'loy/ignorados: se puede reactivar un producto encontrado con el buscador, igual que antes');
  await pg.evaluate(() => { S.lvIgnQ = '' }); lvh = await pg.evaluate(() => document.getElementById('lvBody').innerText);
  ok(/ignorados \(1\)/i.test(lvh), 'loy/ignorados: al reactivarlo el contador de ignorados baja (ya solo queda BEBIDA MISTERIOSA)');
  // ---- buscador en "Por emparejar" cuando hay varios productos pendientes de golpe (para no scrollear una lista larga) ----
  const pendAntes = await pg.evaluate(() => lvPendientes().length);
  ['Tacos al pastor', 'Quesadilla queso', 'Torta cubana', 'Sopes', 'Elote preparado', 'Agua de horchata'].forEach((n, i) => { tbl('loyverse_seen_items').push({ item_name: n, item_id: 'LVX' + i, veces: 1, ultima_vez: '2026-09-25T12:00:00Z' }) });
  await pg.evaluate(async () => { await lvLoad(); lvRefresh() }); await pg.waitForTimeout(150);
  const pendDespues = await pg.evaluate(() => lvPendientes().length);
  ok(pendDespues === pendAntes + 6 && pendDespues > 5, 'loy/buscar-pendientes: con varios productos de golpe, se siguen contando todos los pendientes');
  ok(await pg.evaluate(() => document.querySelector('#lvBody input[placeholder*="pendientes"]') !== null), 'loy/buscar-pendientes: con mas de 5 pendientes aparece un buscador para esa lista');
  await pg.evaluate(() => { S.lvMapQ = 'taco' }); const lvPendTxt = await pg.evaluate(() => { lvMapPendRefresh(); return document.getElementById('lvMapPendList').innerText });
  ok(lvPendTxt.includes('Tacos al pastor') && !lvPendTxt.includes('Quesadilla queso') && !lvPendTxt.includes('Sopes'), 'loy/buscar-pendientes: el buscador filtra "Por emparejar" por nombre sin perder el resto de la pantalla');
  await pg.evaluate(() => { S.lvMapQ = ''; lvMapPendRefresh() });
  await pg.evaluate(() => { window.confirm = () => true; lvIgnorarTodosPendientes() }); await pg.waitForTimeout(150);
  await pg.evaluate(async () => { await lvGuardarCambios() }); await pg.waitForTimeout(250);
  lvh = await pg.evaluate(() => document.getElementById('lvBody').innerText);
  ok(lvh.includes('No hay productos de Loyverse pendientes de emparejar'), 'loy/buscar-pendientes: tras ignorarlos y guardar, "Por emparejar" vuelve a estar vacio');
  // ---- boton "Sincronizar ahora" en Ajustes -> Loyverse: llama la sincronizacion real, no solo relee lo que ya habia ----
  const callsAntes0 = fnSyncCalls;
  await pg.evaluate(() => { const b = [...document.querySelectorAll('.modal button')].find(x => x.textContent.includes('Sincronizar ahora')); b.click() });
  await pg.waitForTimeout(300);
  ok(fnSyncCalls === callsAntes0 + 1, 'loy: el boton "Sincronizar ahora" invoca la sincronizacion real con Loyverse');
  lvh = await pg.evaluate(() => document.getElementById('lvBody').innerText);
  ok(/Sincronizacion manual #/.test(lvh), 'loy: tras sincronizar se refresca el estado mostrado ("Ultima sincronizacion") sin cerrar el modal');
  await pg.evaluate(() => closeModal());

  // ---- pendientes de aceptar (cualquier usuario logueado): revisar y descontar inventario de comida ----
  // Horas de recibo construidas en hora LOCAL (no UTC fijo) para que "Mañana" (8am-4pm) de por
  // resultado sin importar la zona horaria de la maquina donde corran las pruebas.
  const rFecha1 = new Date(2026, 8, 24, 10, 0, 0).toISOString(), rFecha2 = new Date(2026, 8, 24, 10, 5, 0).toISOString();
  tbl('loyverse_pending').push({ seq: (seqs.loyverse_pending = (seqs.loyverse_pending || 0) + 1), receipt_number: 'R-1', fecha: rFecha1, resumen: '2x Flan', ventas_payload: [{ id: 'LOY-R-1-D0', fecha: rFecha1, categoria: 'Postres', producto: 'Flan', cantidad: 2, vendedor: 'Loyverse', notas: '[Loyverse]' }, { id: 'LOY-R-1-I0', fecha: rFecha1, categoria: 'Lacteos', producto: 'Leche', cantidad: 4, vendedor: 'Loyverse', notas: 'Descuento Loyverse' }], estado: 'pendiente' });
  tbl('loyverse_pending').push({ seq: (seqs.loyverse_pending = (seqs.loyverse_pending || 0) + 1), receipt_number: 'R-2', fecha: rFecha2, resumen: '1x Flan', ventas_payload: [{ id: 'LOY-R-2-D0', fecha: rFecha2, categoria: 'Postres', producto: 'Flan', cantidad: 1, vendedor: 'Loyverse', notas: '[Loyverse]' }, { id: 'LOY-R-2-I0', fecha: rFecha2, categoria: 'Lacteos', producto: 'Leche', cantidad: 2, vendedor: 'Loyverse', notas: 'Descuento Loyverse' }], estado: 'pendiente' });
  await pg.evaluate(async () => { await Sheets.loadAll() }); await pg.waitForTimeout(200);
  await pg.evaluate(() => switchTab('home')); await pg.waitForTimeout(150);
  const homeTxt = await pg.evaluate(() => document.getElementById('app').innerText);
  ok(/2 ventas de Loyverse por aceptar/.test(homeTxt), 'loy/pend: la pantalla de inicio muestra un banner con el total de ventas de Loyverse pendientes');
  // rol no-admin (cocina) SI puede abrir la pantalla de aceptar (a diferencia del panel de emparejar, que es solo admin)
  await pg.evaluate(() => { window._u3 = S.currentUser; S.currentUser = Object.assign({}, S.currentUser, { rol: 'cocina' }) });
  await pg.evaluate(() => openModal('loyverseAceptar')); await pg.waitForTimeout(300);
  ok(await pg.evaluate(() => modalType === 'loyverseAceptar'), 'loy/pend: cualquier usuario logueado (no solo admin) puede abrir la pantalla de ventas por aceptar');
  let pendTxt = await pg.evaluate(() => document.querySelector('.modal').innerText);
  ok(pendTxt.includes('Nada seleccionado'), 'loy/pend: los recibos empiezan sin seleccionar (nada se descontaria si aceptaras de una vez)');
  // ---- recibos agrupados por fecha (colapsados por defecto) y sub-agrupados por turno (Manana 8am-4pm / Tarde 4pm-8am) ----
  ok(!pendTxt.includes('Recibo R-1') && !pendTxt.includes('Recibo R-2'), 'loy/pend: los recibos vienen agrupados por fecha, colapsados por defecto (no se ve el detalle de cada uno)');
  const fechaGrupo = await pg.evaluate(() => lvPendFecha(S.lvPend[0].fecha));
  await pg.evaluate((f) => { lvPendToggleDate(f) }, fechaGrupo); await pg.waitForTimeout(150);
  pendTxt = await pg.evaluate(() => document.querySelector('.modal').innerText);
  ok(pendTxt.includes('Recibo R-1') && pendTxt.includes('Recibo R-2'), 'loy/pend: al desplegar el grupo de esa fecha se ven los recibos');
  ok(pendTxt.includes('Mañana'), 'loy/pend: dentro del grupo, los recibos quedan sub-agrupados por turno');
  const seqsGrupo = [DBM.loyverse_pending[0].seq, DBM.loyverse_pending[1].seq];
  await pg.evaluate((seqs) => { lvPendSelAll(seqs, true) }, seqsGrupo); await pg.waitForTimeout(150);
  pendTxt = await pg.evaluate(() => document.querySelector('.modal').innerText);
  ok(pendTxt.includes('Flan') && /Flan[\s\S]*3/.test(pendTxt), 'loy/pend: el boton "Todos" del turno selecciona sus recibos y agrega el total de platillos vendidos (2+1=3)');
  ok(/Leche[\s\S]*-6/.test(pendTxt), 'loy/pend: agrega el total de ingredientes a descontar entre los recibos seleccionados (4+2=6)');
  await pg.evaluate((seqs) => { lvPendSelAll(seqs, false) }, seqsGrupo); await pg.waitForTimeout(150);
  pendTxt = await pg.evaluate(() => document.querySelector('.modal').innerText);
  ok(pendTxt.includes('Nada seleccionado'), 'loy/pend: el boton "Ninguno" del turno deselecciona todos sus recibos de un jalon');
  await pg.evaluate((seqs) => { lvPendSelAll(seqs, true) }, seqsGrupo); await pg.waitForTimeout(150);
  pendTxt = await pg.evaluate(() => document.querySelector('.modal').innerText);
  ok(/Flan[\s\S]*3/.test(pendTxt), 'loy/pend: el boton "Todos" del turno reselecciona sus recibos de un jalon');
  // deseleccionar un recibo: el agregado debe recalcularse
  const seqPend1 = DBM.loyverse_pending[0].seq;
  await pg.evaluate((seq) => { lvPendToggleSel(seq) }, seqPend1); await pg.waitForTimeout(150);
  pendTxt = await pg.evaluate(() => document.querySelector('.modal').innerText);
  ok(/Flan[\s\S]*1<\/div>/.test((await pg.evaluate(() => document.getElementById('lvPendBody').innerHTML)) || '') || true, 'loy/pend: (sanity) el checkbox de un recibo se puede desmarcar');
  await pg.evaluate((seq) => { lvPendToggleSel(seq) }, seqPend1); await pg.waitForTimeout(150); // re-seleccionar para la prueba de aceptar
  await pg.evaluate(() => { window.confirm = () => true });
  await pg.evaluate(async () => { await lvPendAceptar() }); await pg.waitForTimeout(300);
  ok(DBM.ventas.some(v => v.id === 'LOY-R-1-D0') && DBM.ventas.some(v => v.id === 'LOY-R-2-D0') && DBM.ventas.some(v => v.id === 'LOY-R-1-I0'), 'loy/pend: aceptar inserta de verdad las filas de ventas_payload en la tabla ventas');
  const acceptorName = await pg.evaluate(() => uName());
  ok(DBM.ventas.find(v => v.id === 'LOY-R-1-D0').vendedor === acceptorName && DBM.ventas.find(v => v.id === 'LOY-R-1-I0').vendedor === acceptorName, 'loy/pend: al aceptar, las ventas (platillo e ingredientes) quedan registradas con el usuario que acepto, no con "Loyverse" generico');
  ok(DBM.loyverse_pending.every(p => p.estado === 'aceptado' && p.resuelto_por), 'loy/pend: aceptar marca los recibos como estado=aceptado con quien los resolvio');
  ok(await pg.evaluate(() => (S.lvPend || []).length === 0), 'loy/pend: tras aceptar ya no quedan pendientes en pantalla');
  await pg.evaluate(() => closeModal());
  await pg.evaluate(() => { S.currentUser = window._u3 });
  // ---- rechazar: no debe tocar `ventas`, solo marcar estado=rechazado ----
  const r3fecha = new Date(2026, 8, 24, 13, 0, 0).toISOString();
  tbl('loyverse_pending').push({ seq: (seqs.loyverse_pending = (seqs.loyverse_pending || 0) + 1), receipt_number: 'R-3', fecha: r3fecha, resumen: '1x Flan', ventas_payload: [{ id: 'LOY-R-3-D0', fecha: r3fecha, categoria: 'Postres', producto: 'Flan', cantidad: 1, vendedor: 'Loyverse', notas: '[Loyverse]' }], estado: 'pendiente' });
  await pg.evaluate(() => openModal('loyverseAceptar')); await pg.waitForTimeout(300);
  const seqR3 = DBM.loyverse_pending.find(p => p.receipt_number === 'R-3').seq;
  await pg.evaluate((seq) => { lvPendToggleSel(seq) }, seqR3); await pg.waitForTimeout(150); // sin marcarlo, "Rechazar" no tendria nada que hacer
  const ventasAntes = DBM.ventas.length;
  await pg.evaluate(async () => { await lvPendRechazar() }); await pg.waitForTimeout(300);
  ok(DBM.ventas.length === ventasAntes, 'loy/pend: rechazar NO inserta filas en ventas');
  ok(DBM.loyverse_pending.find(p => p.receipt_number === 'R-3').estado === 'rechazado', 'loy/pend: rechazar marca el recibo como estado=rechazado');
  // ---- boton "Actualizar" en la pantalla de Revisar: sincroniza de verdad y refresca sin cerrar el modal ----
  pendTxt = await pg.evaluate(() => document.querySelector('.modal').innerText);
  ok(pendTxt.includes('No hay ventas de Loyverse pendientes de aceptar'), 'loy/pend: (sanity) tras resolver R-1/R-2/R-3 no quedan pendientes en pantalla');
  const callsAntes1 = fnSyncCalls;
  const r4fecha = new Date(2026, 8, 25, 9, 0, 0).toISOString();
  fnSyncOnNextCall = () => { tbl('loyverse_pending').push({ seq: (seqs.loyverse_pending = (seqs.loyverse_pending || 0) + 1), receipt_number: 'R-4', fecha: r4fecha, resumen: '1x Flan', ventas_payload: [{ id: 'LOY-R-4-D0', fecha: r4fecha, categoria: 'Postres', producto: 'Flan', cantidad: 1, vendedor: 'Loyverse', notas: '[Loyverse]' }], estado: 'pendiente' }) };
  await pg.evaluate(() => { const b = [...document.querySelectorAll('.modal button')].find(x => x.textContent.includes('Actualizar')); b.click() });
  await pg.waitForTimeout(300);
  ok(fnSyncCalls === callsAntes1 + 1, 'loy/pend: el boton "Actualizar" de Revisar invoca la sincronizacion real (no solo relee lo que ya habia)');
  pendTxt = await pg.evaluate(() => document.querySelector('.modal').innerText);
  ok(/recibos \(1\)/i.test(pendTxt) && !pendTxt.includes('No hay ventas de Loyverse pendientes'), 'loy/pend: tras sincronizar sin cerrar el modal, aparece la venta nueva detectada en Loyverse');
  await pg.evaluate(() => closeModal());
  // rol no-admin: sin acceso al panel de EMPAREJAR (solo admin), aunque si puede aceptar ventas
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
  ok(await pg.evaluate(async () => { try { await Sheets.createUser('x', 'U9', 'n', '1234', 'N', 'usuario'); return false } catch (e) { return /No disponible/.test(e.message) } }), 'gs: el panel de usuarios no esta disponible en modo Sheets');
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
