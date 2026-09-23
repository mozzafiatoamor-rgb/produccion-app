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
| `supabase` | Nube nueva (esquema `produccion_app` + RLS)      | `?backend=supabase&sburl=https://xxx.supabase.co&sbkey=<llave pública>` (opcional `&sbschema=`) |

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

## Proyecto Supabase compartido: esquema propio `produccion_app`

La app se instala en un proyecto que ya usan otras apps, así que **todo vive en el esquema
`produccion_app`**; `public` y demás esquemas no se tocan (se comprobó en un Postgres de prueba con
tablas homónimas: el catálogo de `public` —tablas, permisos, políticas, funciones y datos— queda
idéntico antes y después). Protecciones:

- `schema.sql` **aborta** si `produccion_app` ya existe y no lo creó este proyecto (marca en el comentario del esquema).
- Nunca hace `grant`/`revoke`/`alter` sobre objetos ajenos; `pgcrypto` solo se instala si falta.
- `uninstall.sql` borra únicamente `produccion_app` (y se niega si no es nuestro). Reversible en un paso.
- La app y el script mandan `Accept-Profile` / `Content-Profile: produccion_app` en cada petición.
- Las llaves nuevas (`sb_publishable_…` / `sb_secret_…`) se envían solo en `apikey` (no son JWT).

Único paso manual "global": en *Settings → API → Exposed schemas* **agregar** `produccion_app`
(sin quitar los existentes). Si se quita algo de esa lista se rompen las otras apps: solo agregar.

## Archivos nuevos

- `supabase/00_diagnostico.sql` — consulta de **solo lectura** para conocer el proyecto (esquemas, extensiones, pgcrypto, esquemas expuestos…). No muestra datos.
- `supabase/schema.sql` — esquema `produccion_app`: tablas, índices, RLS y funciones. Idempotente.
- `supabase/uninstall.sql` — desinstala solo `produccion_app`.
- `migration/migrate.mjs` + `tables.mjs` — `export` (Sheets → JSON local), `import`, `verify`.
- `migration/.env.example` — variables (copiar a `.env`, que está en `.gitignore`).
- `tests/backends.test.js` — pruebas de los 3 backends (Playwright + mock local de Supabase).
- `CHANGELOG.md` — registro de cambios.

## Plan de migración (nada de esto toca producción)

1. **Diagnóstico**: pegar `supabase/00_diagnostico.sql` en *SQL Editor* y revisar el resultado (¿existe ya el esquema? ¿dónde está pgcrypto? ¿qué esquemas expone la API?).
2. **Respaldo** del proyecto compartido antes de instalar (Database → Backups, o `pg_dump`). En plan Free no hay respaldos automáticos.
3. Pegar `supabase/schema.sql` en *SQL Editor* → Run. Agregar `produccion_app` a *Exposed schemas*.
3b. **Verificar la conexión** (solo lectura, con la llave pública): en `migration/.env` poner `SUPABASE_URL` y `SUPABASE_ANON_KEY`, y correr `node migration/check.mjs`. Todo debe salir ✓ antes de seguir.
4. `cp migration/.env.example migration/.env` y llenar `GOOGLE_SHEET_ID`, `GOOGLE_API_KEY`
   (los mismos que usa la app; solo lectura), `SUPABASE_URL` y `SUPABASE_SERVICE_KEY`
   (*Settings → API*; solo en tu computadora, **nunca** en `index.html`).
5. `node migration/migrate.mjs export` — copia las hojas a `migration/out/` (solo lee).
6. `node migration/migrate.mjs import --dry-run` — muestra conteos y `out/avisos.json`
   (fechas ilegibles, números con coma, usuarios duplicados). Revisar.
7. `node migration/migrate.mjs import` — escribe en `produccion_app` (aborta si sus tablas ya tienen datos).
8. `node migration/migrate.mjs verify` — compara filas y sumas de cantidades hoja vs. Supabase.
9. Abrir la app con `?backend=supabase&sburl=…&sbkey=<llave pública>` y comparar **inventario,
   stock bajo y reportes** contra la versión en producción con los mismos datos.
10. Probar en teléfono: registrar producción/venta/merma, modo avión → cola offline → reintentar.
11. Con todo verificado y **aprobación de Gustavo**: decidir fecha de corte, congelar la hoja,
    re-ejecutar export/import (esquema limpio con `uninstall.sql` + `schema.sql`), y recién ahí definir los
    valores por defecto (`sburl`/`sbkey`) y hacer merge a `main`. La hoja queda como respaldo de solo lectura.

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
6. Si el proyecto compartido se pausa por inactividad (plan Free) o llega a su límite de espacio, la app quedaría sin datos: conviene confirmar el plan.
7. `TABLES` está duplicado en `index.html` y `migration/tables.mjs` (la app es un solo archivo, sin
   build). Si cambia una columna, actualizar los dos + `schema.sql`.
