# Migración a Supabase — guía y estado

Rama de trabajo: `feat/supabase-migration`. **`main` (producción) no se toca** hasta que
Gustavo apruebe explícitamente. Mientras tanto la app publicada sigue usando Google Sheets.

## Cómo quedó armada la app

`index.html` sigue siendo un solo archivo. Toda la app llama a `Sheets.read / append /
deleteRow` (nombres de hoja + filas-arreglo). Ahora esas 3 funciones delegan a un
backend intercambiable (`DB`):

| Backend    | Para qué sirve                                   | Cómo activarlo                                         |
|------------|--------------------------------------------------|--------------------------------------------------------|
| `sheets`   | Producción actual (Google Sheets + Apps Script)  | Por defecto. `?backend=sheets` vuelve a él             |
| `demo`     | Probar la app sin tocar datos reales (localStorage) | `?backend=demo` — usuarios `admin/admin123`, `demo/demo123` |
| `supabase` | Nube nueva (Postgres + RLS)                      | `?backend=supabase&sburl=https://xxx.supabase.co&sbkey=<anon key>` |

La elección se recuerda en el navegador (localStorage). Fuera de `sheets` aparece una
etiqueta flotante (🧪 DEMO / ☁️ SUPABASE) para no confundir datos de prueba con reales.
`resetApp()` conserva esta configuración.

Como el backend `supabase` devuelve las filas **con el mismo orden de columnas y formato**
que Sheets (fechas `dd/mm/aaaa`, `SI/NO`, números como texto), el resto del código
(`loadAll`, inventario, reportes, cola offline) no cambió.

### Cambios de comportamiento solo en modo `supabase`
- **Login en el servidor**: la función SQL `app_login(usuario, clave)` valida con bcrypt.
  Las contraseñas **ya no viajan al navegador** (hoy `loadUsers` las descarga en texto plano).
- Borrar una fila (recetas) usa el `seq` de la fila en vez del número de fila de la hoja.
- La lectura pagina de 1000 en 1000 (límite por defecto de Supabase).

## Archivos nuevos

- `supabase/schema.sql` — tablas, índices, RLS y funciones. Idempotente.
- `migration/migrate.mjs` + `tables.mjs` — `export` (Sheets → JSON local), `import`, `verify`.
- `migration/.env.example` — variables (copiar a `.env`, que está en `.gitignore`).
- `tests/backends.test.js` — pruebas de los 3 backends (Playwright + mock local de Supabase).
- `CHANGELOG.md` — registro de cambios.

## Plan de migración (nada de esto toca producción)

1. **Crear un proyecto Supabase nuevo** (de pruebas). Pegar `supabase/schema.sql` en *SQL Editor* → Run.
2. `cp migration/.env.example migration/.env` y llenar `GOOGLE_SHEET_ID`, `GOOGLE_API_KEY`
   (los mismos que usa la app; solo lectura), `SUPABASE_URL` y `SUPABASE_SERVICE_KEY`
   (*Settings → API → service_role*; solo en tu computadora, **nunca** en `index.html`).
3. `node migration/migrate.mjs export` — copia las hojas a `migration/out/` (solo lee).
4. `node migration/migrate.mjs import --dry-run` — muestra conteos y `out/avisos.json`
   (fechas ilegibles, números con coma, usuarios duplicados). Revisar.
5. `node migration/migrate.mjs import` — escribe en Supabase (aborta si las tablas ya tienen datos).
6. `node migration/migrate.mjs verify` — compara filas y sumas de cantidades hoja vs. Supabase.
7. Abrir la app con `?backend=supabase&sburl=…&sbkey=<anon key>` y comparar **inventario,
   stock bajo y reportes** contra la versión en producción con los mismos datos.
8. Probar en teléfono: registrar producción/venta/merma, modo avión → cola offline → reintentar.
9. Con todo verificado y **aprobación de Gustavo**: decidir fecha de corte, congelar la hoja,
   re-ejecutar export/import (proyecto limpio), y recién ahí definir los valores por defecto
   (`sburl`/`sbkey`) y hacer merge a `main`. La hoja queda como respaldo de solo lectura.

## Decisiones / riesgos pendientes (para revisar antes de aprobar)

1. **Seguridad**: la llave `anon` irá en el navegador, y las políticas RLS actuales dejan
   leer/insertar datos operativos a quien tenga la llave (igual de abierto que hoy con el Apps
   Script, pero ya sin contraseñas expuestas). Fase 2 recomendada: Supabase Auth + políticas por rol.
2. **IDs (`P0001`, `V0001`…)** los calcula el cliente como máximo+1; con 2 teléfonos a la vez pueden
   repetirse (pasa igual hoy). No hay `unique` para no romper la cola offline; se puede migrar a
   `seq`/UUID generado por la base de datos más adelante.
3. **Cola offline**: si una petición llega pero se pierde la respuesta, el reintento puede duplicar
   el registro (igual que hoy). Solución futura: llave de idempotencia.
4. **Números con coma** (`1,5`): la app los lee con `parseFloat` (→ 1). El import replica eso para
   que el inventario migrado sea idéntico, y los marca en `avisos.json` para corregir a mano.
5. `sw.js` lista `icon-192.png` / `icon-512.png`, que **no existen** en el repo, así que
   `cache.addAll` falla y el service worker puede no instalarse. No se cambió (afecta producción);
   conviene corregirlo aparte.
6. `TABLES` está duplicado en `index.html` y `migration/tables.mjs` (la app es un solo archivo, sin
   build). Si cambia una columna, actualizar los dos + `schema.sql`.
