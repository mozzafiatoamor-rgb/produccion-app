# Integración con Loyverse (ventas por aceptar, descuento de inventario)

Rama: `feat/loyverse-integration`. Nada de esto toca `main` ni Loyverse en sí (solo lee recibos);
lo único que escribe es tu base de Supabase.

## Qué hace

Cada pocos minutos, la función `loyverse-sync` revisa los recibos nuevos de Loyverse (Mozzafiato).
Por cada recibo con al menos un producto ya emparejado con un platillo de **Recetas** (y que no
esté marcado como "ignorado"), arma una fila **pendiente** con las ventas que se aplicarían (el
platillo vendido + el descuento de ingredientes, ya sumado y redondeado hacia arriba) — pero **no
descuenta nada todavía**.

Un usuario logueado revisa esas ventas pendientes desde la app (banner en Inicio → "Revisar") y
las acepta o rechaza, igual que se hacía a mano al cerrar turno: se ve un agregado de todo lo
pendiente (cuánto se vendió de cada platillo y cuánto se va a descontar de cada ingrediente) y se
puede aceptar o rechazar por recibo o todo junto. Solo al aceptar se insertan de verdad las filas
en `ventas` y se descuenta el inventario.

"Venta TPV" sigue ahí sin cambios: es tu respaldo manual si algún día la sincronización falla o
quieres registrar algo que no pasó por Loyverse.

Los recibos reembolsados o cancelados se detectan y se ignoran (no generan pendiente). Un recibo
nunca se aplica dos veces, aunque la función se cruce consigo misma o se reintente.

### Bebidas y otros productos que esta app no descuenta

Esta app solo lleva inventario de comida. En Ajustes → 🔗 Loyverse, cualquier producto de la lista
"Por emparejar" se puede marcar **Ignorar** (por ejemplo una bebida) en vez de emparejarlo con un
platillo: no vuelve a pedirse que se empareje y sus ventas nunca generan un pendiente de descuento.
Un producto ignorado se puede "Reactivar" en cualquier momento si luego sí quieres empatarlo con un
platillo (por ejemplo si empiezas a llevar inventario de esa bebida).

## Estado del despliegue

Ya desplegado y validado contra la cuenta real de Loyverse (dry-run, luego real). Falta correr el
parche 004 (abajo) y redesplegar la función con el código de este cambio.

### Aplicar el parche 004

En Supabase → SQL Editor, pegar y correr `supabase/patches/004_loyverse_pendientes.sql`. Agrega la
tabla `loyverse_pending`, permite `platillo` en NULL para productos ignorados, y agrega la columna
`ignorado` a `loyverse_map`. Es idempotente, igual que los parches anteriores.

### Redesplegar la función

Desde tu Terminal (no desde aquí, por la política de red de tu cuenta):

```
cd produccion-app
npx supabase@latest functions deploy loyverse-sync --use-api
```

Los secretos (`LOYVERSE_TOKEN`, `LOYVERSE_DRY_RUN`) no cambian — ya están configurados en
Supabase → Edge Functions → Secrets.

## Emparejar tus productos

En la app: Ajustes → 🔗 Loyverse (solo visible para admin). Ahí aparecen tres listas:

- **Por emparejar**: productos que Loyverse ya vendió y que todavía no tienen decisión. Por cada
  uno se elige el platillo de Recetas que le corresponde ("Emparejar") o se marca **Ignorar** si
  esta app no debe descontar su inventario (bebidas, por ejemplo).
- **Emparejados**: ya tienen un platillo asignado; se pueden pausar (vuelven a "Por emparejar"
  hasta que se reactiven o se re-emparejen).
- **Ignorados**: nunca generan pendiente; se pueden reactivar en cualquier momento.

## Aceptar/rechazar ventas pendientes

Cualquier usuario logueado (no solo admin) ve, en la pantalla de Inicio, un aviso cuando hay ventas
de Loyverse por aceptar, con un botón "Revisar" que abre la pantalla de aceptación. Ahí se ve, para
los recibos seleccionados (todos por defecto): el total por platillo vendido y el total a
descontar por ingrediente, más la lista de recibos individuales con casilla para incluir/excluir
alguno antes de aceptar. "Aceptar" inserta esas ventas de verdad (descuenta inventario) y marca los
recibos como `aceptado`; "Rechazar" los marca como `rechazado` sin tocar el inventario.

## Alcance actual

Solo Mozzafiato (una sola tienda de Loyverse). Si más adelante manejas más de una tienda o
sucursal en Loyverse, hay que revisar si la función necesita filtrar por `store_id`.

## Pruebas

- `node tests/loyverse-sync.test.js` — lógica pura (mapeo, ignorado, redondeo, reembolsos,
  reintentos, cursor, colisión de ids, etc.), no necesita Deno ni red.
- `node tests/backends.test.js` (Playwright) — cubre el panel de emparejar/ignorar (solo admin) y
  la pantalla de aceptar/rechazar ventas pendientes (cualquier usuario logueado), incluyendo el
  banner de Inicio, la agregación de totales y que aceptar/rechazar escriban lo correcto.
