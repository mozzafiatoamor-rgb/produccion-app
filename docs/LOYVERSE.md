# Integración con Loyverse (descuento automático de inventario)

Rama: `feat/loyverse-integration`. Nada de esto toca `main` ni Loyverse en sí (solo lee recibos);
lo único que escribe es tu base de Supabase, igual que hace la app hoy con "Venta TPV".

## Qué hace

Cada pocos minutos, una función revisa los recibos nuevos de Loyverse (Mozzafiato), y por cada
producto vendido que ya esté emparejado con un platillo de **Recetas**, agrega en `ventas`:

- una fila del platillo vendido (para que aparezca en reportes, igual que "Venta TPV"), y
- una fila por cada ingrediente de la receta, ya sumada y redondeada hacia arriba, para descontar
  el inventario — igual que si lo hubieras registrado a mano en "Venta TPV".

"Venta TPV" sigue ahí sin cambios: es tu respaldo manual si algún día la sincronización falla o
quieres registrar algo que no pasó por Loyverse.

Los recibos reembolsados o cancelados se detectan y se ignoran (no descuentan nada). Un recibo
nunca se aplica dos veces, aunque la función se cruce consigo misma o se reintente.

## Lo que falta para que funcione (nada de esto está hecho todavía)

### 1. Ejecutar el parche SQL

En Supabase → SQL Editor, pegar y correr `supabase/patches/003_loyverse.sql`. Es el mismo patrón
que los parches anteriores (idempotente, solo toca `produccion_app`).

### 2. Desplegar la función `loyverse-sync`

El código ya está en `supabase/functions/loyverse-sync/` (`index.ts` + `logic.mjs`). Para subirla
a Supabase hace falta la CLI de Supabase (no viene instalada en tu compu todavía):

```
npm install -g supabase
supabase login
supabase link --project-ref <tu-project-ref>          # el que ya usas para produccion_app
supabase functions deploy loyverse-sync
```

El `<project-ref>` es el que aparece en la URL de tu proyecto (`https://<project-ref>.supabase.co`).
Si prefieres no instalar nada, dime y lo vemos juntos por videollamada o buscamos si tu plan de
Supabase permite pegar el código directo desde el dashboard (varía según el plan y no lo pude
confirmar desde aquí).

### 3. Configurar el token de Loyverse y el modo de prueba

En Supabase → Project Settings → Edge Functions → Secrets, agregar:

- `LOYVERSE_TOKEN`: un Personal Access Token creado en Loyverse Back Office → Access Tokens
  (no hace falta nada más para leer recibos).
- `LOYVERSE_DRY_RUN` = `true` (así, en modo prueba, la función **no escribe nada** — solo devuelve
  un JSON con lo que *habría* insertado).

### 4. Probar en modo prueba y confirmar juntos los nombres de campo

Los nombres exactos que la API de Loyverse usa en sus recibos (`item_name`, `quantity`,
`receipt_number`, `created_at`, `cancelled_at`, etc.) los tomé de la documentación pública, pero
**no los pude verificar contra datos reales tuyos** desde aquí. Antes de desactivar el modo
prueba, hay que:

1. Llamar la función una vez (desde el dashboard de Supabase, botón "Invoke", o con `curl`).
2. Revisar el JSON de respuesta juntos: ¿aparecen tus recibos reales? ¿las cantidades y nombres
   de producto se ven correctos?
3. Si algo no cuadra (por ejemplo si Loyverse usa otro nombre de campo en tu cuenta), se ajusta
   `logic.mjs` antes de seguir — es un archivo aparte, sin red, fácil de corregir y volver a
   probar con `node tests/loyverse-sync.test.js`.

### 5. Desactivar el modo prueba y programar la corrida periódica

Cuando el modo prueba se vea bien, cambiar `LOYVERSE_DRY_RUN` a `false` y programar un cron de
Supabase (Database → Cron Jobs, o `pg_cron` desde SQL) que llame la función cada pocos minutos.

### 6. Emparejar tus productos

En la app: Ajustes → 🔗 Loyverse (solo visible para admin). Ahí aparece la lista de productos que
Loyverse ya vendió y que todavía no tienen platillo asignado ("Por emparejar"). Se elige el
platillo de Recetas que le corresponde a cada uno y "Emparejar". Mientras un producto no está
emparejado, sus ventas no descuentan inventario (quedan pendientes, visibles en el panel — no se
pierden ni se inventa un descuento).

## Alcance actual

Solo Mozzafiato (una sola tienda de Loyverse). Si más adelante manejas más de una tienda o
sucursal en Loyverse, hay que revisar si la función necesita filtrar por `store_id`.

## Pruebas

- `node tests/loyverse-sync.test.js` — lógica pura (mapeo, redondeo, reembolsos, reintentos,
  cursor, etc.), no necesita Deno ni red.
- `tests/backends.test.js` (Playwright) — cubre el panel de Loyverse en la app: emparejar,
  pausar/reactivar, que solo lo vea el admin, que no aparezca en modo demo/Sheets.
