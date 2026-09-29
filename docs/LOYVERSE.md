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

Ya desplegado y validado contra la cuenta real de Loyverse (dry-run, luego real). El parche 006
(revierte "modificadores") y el redespliegue con el código de variantes ya se corrieron.

**Pendiente: correr el parche 007** para que la sincronización sea automática de verdad (ver
abajo) — sin eso, la función solo corre cuando alguien la invoca a mano.

### Aplicar el parche 007 (programa la corrida automática cada 5 minutos)

La función en sí ya funciona bien, pero hasta ahora nada la llamaba sola cada pocos minutos —
por eso "Última sincronización" se quedaba pegada en la fecha de la última vez que alguien la
invocó a mano (por ejemplo al probarla). En Supabase → SQL Editor, pegar y correr
`supabase/patches/007_cron_loyverse_sync.sql`: prende `pg_cron`/`pg_net` si hacía falta y programa
un job (`loyverse-sync-cada-5-min`) que llama la función cada 5 minutos con la misma llave pública
que ya usa la app — no requiere ningún secreto nuevo. Es idempotente: se puede volver a correr sin
duplicar el job. El propio archivo trae, en los comentarios de hasta arriba, la consulta para ver
el historial de corridas del cron y cómo desactivarlo si algún día hace falta pausar la
sincronización automática.

### Redesplegar la función (solo si cambia el código, no hace falta para el parche 007)

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
  no existe). Si hay más de 5 pendientes de golpe, aparece un buscador para esa lista.
- **Emparejados**: ya tienen un platillo asignado; se pueden pausar (vuelven a "Por emparejar"
  hasta que se reactiven o se re-emparejen). Igual que Ignorados, esta lista viene colapsada (solo
  se ve el total) para no ocupar toda la pantalla; al desplegarla, los productos aparecen agrupados
  por la categoría de su receta (en orden alfabético) y tiene su propio buscador.
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
los recibos seleccionados: el total por platillo vendido y el total a descontar por ingrediente,
más la lista de recibos individuales con casilla para incluir/excluir cada uno. Los recibos
**empiezan todos sin seleccionar** — hay que marcar (uno por uno, o con "Todos" por turno) los que
de verdad se quieran aplicar, así que si sigues descontando a mano en otro lado y solo quieres
revisar/limpiar la cola, no corres el riesgo de aceptar algo que no querías de un descuido.
"Aceptar" inserta esas ventas de verdad (descuenta inventario) y marca los recibos como
`aceptado`; "Rechazar" los marca como `rechazado` sin tocar el inventario — usa "Rechazar" para los
recibos que ya descontaste manualmente por otro lado, así no se duplica el descuento.

Con muchos recibos pendientes, la lista de recibos aparece agrupada por fecha (más reciente
primero) y cada fecha empieza colapsada (solo se ve el total del día, clic para desplegar). Dentro
de cada fecha, los recibos se sub-agrupan por turno — **Mañana** (8am–4pm) / **Tarde** (4pm–12am),
los mismos horarios que ya usa el resto de la app para el turno actual — cada uno con sus propios
botones "Todos"/"Ninguno" para seleccionar o quitar de un jalón los recibos de ese turno sin tocar
los de otro turno u otra fecha. El turno se calcula a partir de la hora local del dispositivo que
está revisando (igual que el resto de la app determina el turno actual), así que debe revisarse
desde un dispositivo con la hora/zona horaria correcta.

Al aceptar, las filas que se escriben en `ventas` (el platillo y sus descuentos de ingredientes) ya
no quedan con el vendedor genérico `Loyverse` de la sincronización — quedan con el nombre del
usuario que aceptó el recibo (igual que una venta de TPV normal), para que quede registrado quién
fue responsable de cada turno.

### Sincronizar/actualizar al momento

La sincronización automática corre sola cada 5 minutos (patch 007), pero tanto en Ajustes → 🔗
Loyverse como en esta pantalla de aceptar hay un botón ("🔄 Sincronizar ahora" / "🔄 Actualizar")
que llama la misma función `loyverse-sync` al instante, para ver los datos reales sin esperar el
siguiente ciclo. En la pantalla de aceptar, el botón refresca la lista de recibos sin cerrar el
modal, así que si aparece una venta nueva la ves de inmediato. Es una sincronización real (puede
crear pendientes nuevos, igual que el cron), no una vista previa — y como la función ya evita
duplicados por su cursor + tabla de recibos procesados, no pasa nada si se aprieta varias veces
seguidas.

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
