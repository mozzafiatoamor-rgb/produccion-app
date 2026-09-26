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
parche 006 (abajo) y redesplegar la función con el código de este cambio (combinación
item_name + variante — ver "Variantes de Loyverse" más abajo).

### Aplicar el parche 006 (revierte el sistema de modificadores)

Se probó primero un mapeo de "modificadores" aparte (parche `005_loyverse_modificadores.sql`, ya
corrido contra la base real). Al revisar recibos reales se confirmó que ese no era el mecanismo
correcto para este negocio (ver "Variantes de Loyverse" más abajo), así que se abandonó. En
Supabase → SQL Editor, pegar y correr `supabase/patches/006_revertir_modificadores.sql`: borra las
dos tablas que ya no se usan (`loyverse_modifiers_seen`, `loyverse_modifier_map`). Es idempotente,
igual que los parches anteriores, y no toca `loyverse_map` ni ninguna otra tabla. (`004` ya se
había corrido antes; nada que hacer ahí.)

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
  uno se elige el platillo de Recetas que le corresponde escribiendo en el campo de texto (se va
  filtrando solo, como un buscador, mientras escribes) o se marca **Ignorar** si esta app no debe
  descontar su inventario (bebidas, por ejemplo). Si escribes algo que no coincide con ningún
  platillo de Recetas, se rechaza y el campo se limpia (evita emparejar por error con un nombre que
  no existe).
- **Emparejados**: ya tienen un platillo asignado; se pueden pausar (vuelven a "Por emparejar"
  hasta que se reactiven o se re-emparejen).
- **Ignorados**: nunca generan pendiente; se pueden reactivar en cualquier momento. Esta lista
  viene colapsada (solo se ve el total) para no ocupar espacio cuando hay muchos; al desplegarla
  tiene su propio buscador para encontrar rápido el que quieras reactivar.

Para elegir varios a la vez ya no hace falta guardar uno por uno: se elige platillo (o se marca
Ignorar) en cuantos productos se quiera y un solo botón "💾 Guardar" manda todos los cambios juntos.
El botón "🚫 Ignorar todos" marca de un tirón la casilla Ignorar en todos los productos pendientes
que todavía no tengan un platillo elegido (útil cuando hay muchos productos que esta app no
descuenta, como bebidas o paquetes); un producto al que ya le elegiste platillo en pantalla no se
toca. Sigue haciendo falta presionar "💾 Guardar" para que se guarde de verdad.

## Variantes de Loyverse (proteína, tipo de pasta, etc.)

**El problema.** En Loyverse un platillo como "PST Amatriciana" siempre se llama igual sin importar
qué tipo de pasta o proteína eligió el cliente — esa elección viaja aparte, y emparejar el platillo
con Recetas (arriba) no alcanza para saber qué ingrediente descontar de verdad: sin esto, una
"PST Amatriciana" con fusilli y una con fettuccine, o con pollo y con arrachera, se verían idénticas
y solo se descontaría lo que ya trae la receta base del platillo.

**Cómo se investigó.** Se probó primero asumiendo que esa elección viajaba como "modificador" del
recibo (la terminología de Loyverse para eso), y se construyó un mapeo aparte para modificadores
(parche 005, ya revertido — ver arriba). Al inspeccionar recibos reales directo de la API de
Loyverse (con un endpoint de diagnóstico temporal en la Edge Function, ya quitado) se confirmó que
`line_modifiers` viene **vacío en todos los recibos** de este negocio. Lo que sí trae la
información completa es el campo **`variant_name`** de cada línea (ej. "Fetuccini / Pollo",
"Mar y tierra"): Loyverse usa **Variantes de producto**, no Modificadores, para este catálogo — se
puede confirmar en la propia app de Loyverse, en Reportes → Ventas por artículo (el nombre común
arriba, sus variantes desglosadas debajo).

**Cómo se resuelve.** No hace falta ninguna pantalla ni tabla nueva. La sincronización combina
`item_name + variant_name` en un solo nombre (ej. "PST ALFREDO - Fetuccini / Pollo") **antes** de
guardarlo como producto vendido, y esa combinación se empareja con Recetas exactamente igual que
cualquier otro producto, en la misma pantalla "Por emparejar" de siempre: cada combinación
pasta+proteína que ya tengas como Receta separada (ej. "Alfredo Fettuccini Pollo") se mapea una vez
a su nombre completo de Loyverse. Un producto sin variantes (`variant_name` vacío) sigue
apareciendo con solo su `item_name`, como siempre.

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
  reintentos, cursor, colisión de ids, variantes: dos variantes del mismo `item_name` no se
  confunden entre sí, producto sin variante sigue funcionando solo con `item_name`, dos líneas de
  un mismo recibo con variantes distintas registran dos vendidos separados, etc.), no necesita Deno
  ni red.
- `node tests/backends.test.js` (Playwright) — cubre el panel de emparejar/ignorar de productos
  (solo admin) y el mapeo masivo (elegir varios y guardar todo junto), incluyendo dos variantes del
  mismo producto base apareciendo como filas separadas con su nombre completo y emparejándose cada
  una a su receta exacta, y la pantalla de aceptar/rechazar ventas pendientes (cualquier usuario
  logueado), incluyendo el banner de Inicio, la agregación de totales y que aceptar/rechazar
  escriban lo correcto.
