# Registro de cambios

Formato: [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/). Cada cambio se hace en
una rama y se registra aquí y en git. `main` = producción (no se modifica sin aprobación).

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
