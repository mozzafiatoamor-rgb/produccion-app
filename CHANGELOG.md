# Registro de cambios

Formato: [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/). Cada cambio se hace en
una rama y se registra aquí y en git. `main` = producción (no se modifica sin aprobación).

## [Sin publicar] — rama `feat/supabase-migration`

### Agregado
- Capa de datos con backends intercambiables (`sheets` por defecto, `demo`, `supabase`) en `index.html`.
- `supabase/schema.sql`: tablas equivalentes a las hojas, RLS y funciones `app_login`, `app_list_users`, `admin_upsert_user`.
- `migration/`: script `export` / `import` / `verify` (Sheets → Supabase) con validaciones y reporte de avisos.
- `tests/backends.test.js`: comprobaciones de los 3 backends (mock local de Supabase).
- `docs/MIGRACION_SUPABASE.md`: guía, plan por pasos y riesgos abiertos.
- `.gitignore` (datos exportados y `.env` fuera de git).

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
