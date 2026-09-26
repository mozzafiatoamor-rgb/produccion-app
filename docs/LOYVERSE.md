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
parche 005 (abajo, si no se corrió ya el 004) y redesplegar la función con el código de este
cambio.

### Aplicar los parches 004 y 005

En Supabase → SQL Editor, pegar y correr `supabase/patches/004_loyverse_pendientes.sql` (si no se
corrió antes) y luego `supabase/patches/005_loyverse_modificadores.sql`. El 004 agrega la tabla
`loyverse_pending`, permite `platillo` en NULL para productos ignorados, y agrega la columna
`ignorado` a `loyverse_map`. El 005 agrega `loyverse_modifiers_seen` y `loyverse_modifier_map`
(mapeo de modificadores — ver más abajo). Ambos son idempotentes, igual que los parches
anteriores.

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

Para elegir varios a la vez ya no hace falta guardar uno por uno: se elige platillo (o se marca
Ignorar) en cuantos productos se quiera y un solo botón "💾 Guardar" manda todos los cambios juntos.

## Modificadores (proteína, tipo de pasta, etc.)

**Por qué hace falta esto.** En Loyverse un platillo como "PST Amatriciana" siempre se llama igual
sin importar qué tipo de pasta o proteína eligió el cliente — esa elección viaja aparte, como
"modificador" del recibo (por ejemplo grupo "Proteína", opción "Arrachera"). Emparejar el platillo
con Recetas (arriba) no alcanza para saber qué ingrediente descontar de verdad: sin esto, una
"PST Amatriciana" con fusilli y una con fettuccine, o con pollo y con arrachera, se verían idénticas
y solo se descontaría lo que ya trae la receta base del platillo.

**Cómo se resuelve.** En vez de mapear cada combinación de platillo+modificador (que obligaría a
crear una Receta distinta por cada variedad), cada **opción** de modificador se mapea **una sola
vez** a un ingrediente + una cantidad, sin importar en qué platillo venga: "Arrachera" siempre
descuenta lo mismo de arrachera, se haya vendido en la pasta que se haya vendido. Ese descuento se
**suma** al de la receta del platillo (nunca la reemplaza).

En la misma pantalla de Ajustes → 🔗 Loyverse, debajo del mapeo de productos, hay una sección
"🧂 Modificadores" con las mismas tres listas y el mismo flujo:

- **Por emparejar**: opciones de modificador que ya se vendieron y no tienen decisión. Por cada una
  se elige el ingrediente (de los mismos que usas en Recetas) y la cantidad que descuenta cada vez
  que se vende, o se marca **Ignorar** si no afecta inventario (ej. "Sin queso", "Extra picante").
  Igual que con productos, se pueden elegir varias a la vez y guardar todo junto con un botón.
- **Emparejados**: ya tienen ingrediente + cantidad asignados; se pueden pausar/reactivar.
- **Ignorados**: nunca descuentan nada; se pueden reactivar en cualquier momento.

Un modificador sin mapear **no bloquea** la venta pendiente del platillo — simplemente ese
descuento en particular no se aplica todavía hasta que lo mapees, y queda registrado en "Por
emparejar" para que lo veas.

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
  reintentos, cursor, colisión de ids, modificadores mapeados/sin mapear/ignorados/pausados y su
  suma con la receta, etc.), no necesita Deno ni red.
- `node tests/backends.test.js` (Playwright) — cubre el panel de emparejar/ignorar de productos y
  de modificadores (solo admin), el mapeo masivo de ambos (elegir varios y guardar todo junto), y
  la pantalla de aceptar/rechazar ventas pendientes (cualquier usuario logueado), incluyendo el
  banner de Inicio, la agregación de totales y que aceptar/rechazar escriban lo correcto.
