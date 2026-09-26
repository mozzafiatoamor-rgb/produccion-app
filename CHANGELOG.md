# Registro de cambios

Formato: [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/). Cada cambio se hace en
una rama y se registra aquí y en git. `main` = producción (no se modifica sin aprobación).

## [Sin publicar] — rama `feat/loyverse-integration`

### Agregado — ventas de Loyverse por aceptar, con descuento de inventario de comida (solo Mozzafiato)
- Nueva sincronización periódica (Edge Function `loyverse-sync`, se llama sola cada pocos
  minutos vía cron de Supabase — ver `docs/LOYVERSE.md`): lee los recibos nuevos de Loyverse y los
  cruza con **Recetas**. **Cambio de diseño tras probar con datos reales**: en vez de descontar el
  inventario apenas se detecta la venta, arma una fila **pendiente** por recibo (con el platillo
  vendido + el descuento de ingredientes que se aplicaría). Un usuario logueado la revisa y la
  acepta o rechaza desde la app — igual que se hacía a mano al cerrar turno — y solo al aceptar se
  escribe de verdad en `ventas` y se descuenta el inventario. "Venta TPV" **no se quita**: sigue
  disponible como respaldo manual.
- **Mapeo de productos** (Ajustes → 🔗 Loyverse, solo admin): como los nombres de producto en
  Loyverse no necesariamente coinciden con los platillos de Recetas, cada producto vendido en
  Loyverse aparece una vez en "Por emparejar" hasta que el admin elige a qué platillo corresponde
  o lo marca **Ignorar** (por ejemplo una bebida: esta app solo lleva inventario de comida); un
  producto ignorado no vuelve a pedirse y se puede reactivar en cualquier momento. Un mapeo se
  puede pausar/reactivar.
- **Pantalla de ventas pendientes** (banner en Inicio, visible para cualquier usuario logueado):
  muestra el total agregado por platillo vendido y por ingrediente a descontar entre los recibos
  seleccionados (todos por defecto, con casilla para incluir/excluir alguno), y botones
  Aceptar/Rechazar.
- Reembolsos y recibos cancelados se detectan y se omiten por completo (no generan pendiente).
- Un recibo nunca se aplica dos veces así se cruce un reintento con la siguiente corrida:
  cursor por fecha + tabla `loyverse_processed_receipts` + índice único parcial en `ventas.id`
  (solo para los ids sintéticos `LOY-*`, no afecta los ids normales); cada fila de un recibo
  (platillo o ingrediente) tiene su propio id, así que un recibo con dos platillos distintos ya no
  pierde silenciosamente una de las ventas.
- `supabase/patches/003_loyverse.sql` + `004_loyverse_pendientes.sql` (y `schema.sql`): tablas
  `loyverse_map`, `loyverse_seen_items`, `loyverse_sync_state`, `loyverse_processed_receipts`,
  `loyverse_pending`; `loyverse_map.platillo` admite NULL (productos ignorados); RLS y permisos
  para `anon` (leer/administrar el mapeo y aceptar/rechazar pendientes desde el navegador; el
  resto solo lectura, lo escribe la Edge Function con la llave de servicio). **Hay que ejecutar
  ambos parches en el SQL Editor antes de publicar** (003 ya se corrió; falta 004).
- `supabase/functions/loyverse-sync/`: `logic.mjs` (lógica pura, sin red — probada con Node) +
  `index.ts` (Edge Function Deno: llama a la API de Loyverse, llama a `logic.mjs`, arma los
  pendientes en Supabase). **Ya desplegada y validada contra la cuenta real de Loyverse**
  (dry-run primero, luego real); falta redesplegar con el código de este cambio.
- Tres corridas contra datos reales (no detectables con datos sintéticos) encontradas y
  corregidas: falta de permisos de `service_role` sobre las tablas nuevas (el `grant` de
  `schema.sql` es una foto del momento en que corre, no cubre tablas creadas después por un
  parche — ahora cada parche nuevo da permisos explícitos); primera corrida pedía el historial
  completo de Loyverse y tronaba con 402 (plan sin "Unlimited Sales History") — ahora la primera
  corrida solo inicializa el cursor, sin importar ventas previas a la activación; formato de fecha
  (Postgres manda `+00:00`, Loyverse exige `Z`) — se normaliza antes de mandarlo.
- Pruebas: `tests/loyverse-sync.test.js` (36 comprobaciones de la lógica pura: mapeo, ignorado,
  suma de ingredientes compartidos antes de redondear, productos sin mapear, mapeo pausado,
  reembolsos/cancelaciones, reintentos, cursor por fecha, ids únicos por fila, cantidades como
  texto o en 0). `tests/backends.test.js` (Playwright): panel de emparejar/ignorar (solo admin) y
  pantalla de aceptar/rechazar ventas pendientes (cualquier usuario logueado): banner de Inicio,
  agregación de totales, aceptar inserta las ventas y marca `aceptado`, rechazar no toca `ventas`.
- Falta: correr el parche 004 y redesplegar la función — ver `docs/LOYVERSE.md`. `main` no se toca
  hasta probar el nuevo flujo de aceptación con datos reales y tu aprobación.

## [Sin publicar] — rama `feat/rediseno-azul`

### Cambiado (solo aspecto; los datos y la lógica no se tocan)
- Nuevo tema oscuro **azul**: fondo azul marino con destellos ambientales (azul, violeta, cian), tarjetas de cristal, textos y bordes en azul, complementarios cian / violeta / naranja / menta / rosa.
- **Accesos rápidos**: borde fino de su color y una luz suave solo por **debajo** del botón (sin brillo en iconos ni textos, sin animaciones de parpadeo); foco tenue que sigue al puntero y onda discreta al tocar.
- **Dock de navegación**: la barra inferior desaparece; queda un solo botón circular sólido que al tocarlo se despliega en un panel de 2 columnas (con la sección actual iluminada), animación escalonada de resorte, inclinación suave y foco de luz al pasar el puntero, y se pliega al elegir sección, tocar fuera o con Esc. Respeta `prefers-reduced-motion`.
- El contenido usa la altura completa (ya no hay barra de 72 px) y deja espacio para el botón. La etiqueta MODO DEMO / respaldo se hizo más pequeña para no chocar con el dock.
- `manifest.json` y `theme-color` en azul marino.
- Pruebas: 86 → 98 comprobaciones (dock plegado/desplegado, Escape, tocar fuera, navegar, sección activa, colores neón, espacio para el botón).

## [Sin publicar] — rama `perf/carga-rapida`

### Corregido (lentitud al guardar con Supabase)
- Causa 1: tras cada guardado `loadAll()` volvía a leer **todas** las tablas, página por página y una tras otra (~13 peticiones en serie con los datos actuales; hasta 40 con el historial completo). Ahora todas las tablas y todas las páginas se piden **a la vez** (usa `Content-Range`; si falta, cae al modo en serie de antes).
- Causa 2: tras guardar, la recarga es **incremental**: solo pide las filas nuevas (`seq` mayor al último) de producción, ventas y mermas y reutiliza lo que ya tiene en memoria. Los botones 🔄 Actualizar y el arranque siguen haciendo la carga completa.
- Causa 3: `today()` creaba un formateador de fechas nuevo en **cada fila** dentro de los filtros de la pantalla de inicio (≈2 s por dibujo con 33 mil filas, y se dibuja dos veces por carga). Ahora el formateador se crea una sola vez (50 ms).
- Pruebas: 72 → 86 comprobaciones (paginación en paralelo, incremental == completa, filas de otro dispositivo, sin `Content-Range`, borrar receta tras recargas incrementales, `today()` idéntico).

## [Sin publicar] — rama `feat/catalogo-admin`

### Agregado
- **Administrador de catálogo** (solo admin): botón "Catálogo" 📋 en el inicio. Lista por categoría con búsqueda y filtros Todos / Activos / Inactivos; **activar / desactivar** productos (pide confirmación al desactivar; el historial no se toca) y editar categoría, stock mínimo y unidad. El nombre no se edita para no perder el historial. Cada cambio queda en la Bitácora.
- Capa de datos: `Sheets.updateRow` (Supabase: `PATCH` por `seq`; demo: en local; Google Sheets: no disponible, avisa). `S.catalogoTodos` (activos e inactivos); `S.catalogo` sigue siendo solo los activos.
- `isDup` / `nextId` consideran también los productos inactivos (no se pueden recrear duplicados ni repetir IDs).
- `supabase/patches/002_catalogo_update.sql` (y `schema.sql`): `anon` puede actualizar **solo** las columnas de `catalogo`; ninguna otra tabla acepta UPDATE. **Hay que ejecutarlo en el SQL Editor antes de publicar.**
- Pruebas: 49 → 72 comprobaciones (app con mock Supabase, demo y Sheets) + prueba de permisos en Postgres real (WASM).
- En Ajustes ya no se pide Sheet ID / API Key cuando el backend es Supabase.

## [Sin publicar] — rama `feat/supabase-migration`

### Agregado
- Capa de datos con backends intercambiables (`sheets` por defecto, `demo`, `supabase`) en `index.html`.
- `supabase/schema.sql`: tablas equivalentes a las hojas, RLS y funciones `app_login`, `app_list_users`, `admin_upsert_user`.
- `migration/`: script `export` / `import` / `verify` (Sheets → Supabase) con validaciones y reporte de avisos.
- `tests/backends.test.js`: comprobaciones de los 3 backends (mock local de Supabase).
- `docs/MIGRACION_SUPABASE.md`: guía, plan por pasos y riesgos abiertos.
- `.gitignore` (datos exportados y `.env` fuera de git).

### Corte a Supabase (preparado, pendiente de publicar en `main`)
- Supabase pasa a ser el backend **por defecto** (URL, llave pública y esquema `produccion_app` incluidos en `index.html`). `?backend=sheets` vuelve a Google Sheets en ese dispositivo (etiqueta naranja); `demo` conserva su etiqueta; producción no muestra etiquetas.
- `migrate.mjs import --replace --yes-vaciar-produccion_app`: vacía solo `produccion_app` y reimporta (se niega con `public` o sin confirmación).
- `docs/CORTE_A_SUPABASE.md`: checklist del corte y de vuelta atrás. 49 pruebas (incluye teléfono que venía de Sheets con sesión y cola offline pendiente).

### Migración de datos (23-sep-2026, proyecto Supabase de Gustavo, esquema `produccion_app`)
- Importadas 11,400 filas desde la hoja real; `verify` = conteos y sumas idénticos (producción 12,996, ventas 20,685, mermas 395, recetas 419.5).
- Prueba de aceptación: la app calculando desde Google Sheets (export) y desde Supabase da resultados idénticos en producción, ventas, mermas, recetas, inventario (28 productos), stock bajo (12), bitácora y turnos. Única diferencia cosmética: catálogo `activo` "SÍ" (hoja) vs "SI" (Supabase); la app solo lo usa como `!== 'NO'`.
- `migrate.mjs` acepta `SUPABASE_URL` con o sin `/rest/v1/` al final.

### Corregido
- Backend `sheets` (Google Sheets): una sustitución masiva dejó `GS.read` y `GS.deleteRow` llamándose a sí mismos (recursión infinita). Restaurados idénticos a `main`. Nunca llegó a `main`. Ahora hay 7 pruebas del backend `sheets` con Google interceptado.
- Roles: la hoja tiene usuarios con rol `cocina`; el esquema los convertía a `usuario`. Ahora el rol se conserva tal cual (sin CHECK).
- Contraseña de admin (reabrir turno / aplicar correcciones): se comparaba en el navegador contra `S.usuarios[].password`, que en Supabase está vacío (una contraseña vacía habría pasado). Nuevo `Sheets.verifyAdmin` (servidor: función `app_verify_admin`); rechaza contraseña vacía en todos los backends.
- `supabase/patches/001_roles_y_verificar_admin.sql` para el proyecto donde ya se ejecutó la versión anterior de `schema.sql`.

### Cambiado (proyecto Supabase compartido)
- `migration/check.mjs`: verificación de solo lectura con la llave pública (esquema expuesto, `usuarios` protegido, funciones de login). Nueva variable `SUPABASE_ANON_KEY` en `.env.example`.
- `supabase/schema.sql` ahora instala en un esquema propio `produccion_app` (antes `public`), con guarda que aborta ante un esquema ajeno y `grant`s limitados a ese esquema; agrega `notify pgrst, 'reload schema'`.
- Nuevos `supabase/00_diagnostico.sql` (solo lectura) y `supabase/uninstall.sql` (borra solo `produccion_app`).
- App y `migrate.mjs` envían `Accept-Profile`/`Content-Profile` (config `sbschema` / `SUPABASE_SCHEMA`); las llaves no-JWT (`sb_publishable_`, `sb_secret_`) van solo en `apikey`.
- Pruebas: 33 comprobaciones (verifican perfil de esquema y ausencia de `Authorization` con llave no-JWT).

### Cambiado
- `Sheets.read/append/deleteRow` y `retryQueue` ahora delegan al backend activo (comportamiento idéntico en `sheets`).
- El login pasa por `Sheets.checkLogin` (en `supabase` se valida en el servidor).
- `resetApp()` conserva la configuración del backend.
