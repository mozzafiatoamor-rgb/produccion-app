-- =====================================================================
-- produccion-app · Esquema Supabase (Postgres)  ->  esquema PROPIO: produccion_app
-- Equivale 1:1 a las hojas de Google Sheets que usa la app hoy.
--
-- PENSADO PARA UN PROYECTO SUPABASE COMPARTIDO:
--   * Todo vive en el esquema `produccion_app`. No se crea, modifica ni
--     concede NADA en `public` ni en ningun otro esquema.
--   * Si `produccion_app` ya existe y no lo creo este script, ABORTA.
--   * Deshacer todo: supabase/uninstall.sql  (borra solo produccion_app).
--
-- Ejecutar completo en: Supabase > SQL Editor.  Es idempotente (se puede
-- volver a correr).  DESPUES: Settings > API > Exposed schemas -> AGREGAR
-- `produccion_app` (sin quitar los que ya estan).
-- =====================================================================

do $$
declare v_exists boolean; v_comment text;
begin
  select true, obj_description(oid, 'pg_namespace') into v_exists, v_comment
  from pg_namespace where nspname = 'produccion_app';
  if v_exists and coalesce(v_comment, '') not like 'produccion-app%' then
    raise exception 'El esquema produccion_app ya existe y NO fue creado por produccion-app. Aborto para no tocar otro proyecto. Elige otro nombre (buscar/reemplazar produccion_app en este archivo).';
  end if;
end $$;

create schema if not exists produccion_app;
comment on schema produccion_app is 'produccion-app v1 (migrado desde Google Sheets)';

-- pgcrypto (bcrypt). En Supabase vive en el esquema `extensions`; si ya esta
-- instalado en otro lado, esto no hace nada.
create extension if not exists pgcrypto with schema extensions;

-- Cada tabla tiene `seq` (orden de inserción = "número de fila" de la hoja)
-- y `created_at`. La app usa `seq` para borrar filas (ej. recetas).

-- ---------- Usuarios ------------------------------------------------
create table if not exists produccion_app.usuarios (
  seq           bigint generated always as identity primary key,
  id            text,
  usuario       text not null unique,
  password_hash text,                       -- bcrypt; nunca texto plano
  nombre        text not null default '',
  rol           text not null default 'usuario',   -- 'admin', 'cocina', etc. (la app decide que hace cada rol)
  created_at    timestamptz not null default now()
);

-- ---------- Catálogo ------------------------------------------------
create table if not exists produccion_app.catalogo (
  seq          bigint generated always as identity primary key,
  id           text,
  categoria    text not null default '',
  producto     text not null,
  stock_minimo integer not null default 0,
  unidad       text not null default '',
  activo       boolean not null default true,   -- hoja: 'SI' / 'NO'
  created_at   timestamptz not null default now()
);

-- ---------- Producción ----------------------------------------------
create table if not exists produccion_app.produccion (
  seq         bigint generated always as identity primary key,
  id          text,
  fecha       date,
  dia         text not null default '',
  turno       text not null default '',
  categoria   text not null default '',
  producto    text not null,
  cantidad    numeric not null default 0,
  responsable text not null default '',
  notas       text not null default '',
  created_at  timestamptz not null default now()
);

-- ---------- Ventas --------------------------------------------------
create table if not exists produccion_app.ventas (
  seq        bigint generated always as identity primary key,
  id         text,
  fecha      date,
  categoria  text not null default '',
  producto   text not null,
  cantidad   numeric not null default 0,
  vendedor   text not null default '',
  notas      text not null default '',   -- '[TPV]' marca ventas de punto de venta
  created_at timestamptz not null default now()
);

-- ---------- Recetas -------------------------------------------------
create table if not exists produccion_app.recetas (
  seq         bigint generated always as identity primary key,
  platillo    text not null,
  categoria   text not null default '',
  ingrediente text not null,
  cantidad    numeric not null default 0,
  unidad      text not null default '',
  created_at  timestamptz not null default now()
);

-- ---------- Mermas --------------------------------------------------
create table if not exists produccion_app.mermas (
  seq         bigint generated always as identity primary key,
  id          text,
  fecha       date,
  hora        text not null default '',   -- texto tal cual lo escribe la app (es-MX)
  categoria   text not null default '',
  producto    text not null,
  cantidad    numeric not null default 0,
  motivo      text not null default '',
  responsable text not null default '',
  created_at  timestamptz not null default now()
);

-- ---------- Saldo Inicial (cierres de periodo) ----------------------
create table if not exists produccion_app.saldo_inicial (
  seq              bigint generated always as identity primary key,
  producto         text not null,
  categoria        text not null default '',
  stock_actual     numeric not null default 0,
  total_producido  numeric not null default 0,
  total_vendido    numeric not null default 0,
  total_merma      numeric not null default 0,
  fecha_corte      date,
  created_at       timestamptz not null default now()
);

-- ---------- Bitácora ------------------------------------------------
create table if not exists produccion_app.bitacora (
  seq        bigint generated always as identity primary key,
  fecha      date,
  hora       text not null default '',
  usuario    text not null default '',
  accion     text not null default '',
  detalle    text not null default '',
  tipo       text not null default '',
  created_at timestamptz not null default now()
);

-- ---------- Turnos --------------------------------------------------
create table if not exists produccion_app.turnos (
  seq         bigint generated always as identity primary key,
  id          text,
  fecha       date,
  turno       text not null default '',
  fase        text not null default '',
  responsable text not null default '',
  hora        text not null default '',
  datos       text not null default '',   -- JSON serializado por la app
  created_at  timestamptz not null default now()
);

-- Índices útiles para los filtros por fecha / producto
create index if not exists produccion_fecha_idx on produccion_app.produccion (fecha);
create index if not exists ventas_fecha_idx     on produccion_app.ventas (fecha);
create index if not exists mermas_fecha_idx     on produccion_app.mermas (fecha);
create index if not exists bitacora_fecha_idx   on produccion_app.bitacora (fecha);
create index if not exists turnos_fecha_idx     on produccion_app.turnos (fecha);

-- =====================================================================
-- SEGURIDAD (Row Level Security)
-- La app usa la llave `anon` desde el navegador, así que TODO acceso
-- pasa por estas políticas. Modelo actual = igual de abierto que hoy
-- (quien tenga la llave puede leer/escribir datos operativos), pero:
--   * `usuarios` NO es legible por anon (las contraseñas ya no viajan
--     al navegador): el login se hace con la función app_login().
--   * anon solo puede BORRAR en `recetas` (único borrado que hace la app).
--   * anon solo puede ACTUALIZAR `catalogo` (activar/desactivar/editar productos
--     desde la app); ninguna otra tabla acepta UPDATE.
-- Fase 2 recomendada: Supabase Auth y políticas por rol (ver docs).
-- =====================================================================
alter table produccion_app.usuarios      enable row level security;
alter table produccion_app.catalogo      enable row level security;
alter table produccion_app.produccion    enable row level security;
alter table produccion_app.ventas        enable row level security;
alter table produccion_app.recetas       enable row level security;
alter table produccion_app.mermas        enable row level security;
alter table produccion_app.saldo_inicial enable row level security;
alter table produccion_app.bitacora      enable row level security;
alter table produccion_app.turnos        enable row level security;

do $$
declare t text;
begin
  foreach t in array array['catalogo','produccion','ventas','recetas','mermas','saldo_inicial','bitacora','turnos'] loop
    execute format('drop policy if exists app_select on produccion_app.%I', t);
    execute format('create policy app_select on produccion_app.%I for select to anon using (true)', t);
    execute format('drop policy if exists app_insert on produccion_app.%I', t);
    execute format('create policy app_insert on produccion_app.%I for insert to anon with check (true)', t);
  end loop;
end $$;

drop policy if exists app_delete on produccion_app.recetas;
create policy app_delete on produccion_app.recetas for delete to anon using (true);

drop policy if exists app_update on produccion_app.catalogo;
create policy app_update on produccion_app.catalogo for update to anon using (true) with check (true);

-- Permisos (RLS filtra encima de esto). Solo objetos de produccion_app.
grant usage on schema produccion_app to anon, service_role;
revoke all on produccion_app.usuarios from anon, authenticated;
grant select, insert on produccion_app.catalogo, produccion_app.produccion, produccion_app.ventas,
                        produccion_app.recetas, produccion_app.mermas, produccion_app.saldo_inicial,
                        produccion_app.bitacora, produccion_app.turnos to anon;
grant delete on produccion_app.recetas to anon;
grant update (id, categoria, producto, stock_minimo, unidad, activo) on produccion_app.catalogo to anon;
grant usage, select on all sequences in schema produccion_app to anon;
-- service_role (script de migracion / panel): acceso total, solo a este esquema
grant all on all tables    in schema produccion_app to service_role;
grant all on all sequences in schema produccion_app to service_role;

-- =====================================================================
-- FUNCIONES (RPC) para usuarios / login
-- =====================================================================

-- Lista de usuarios SIN contraseñas (para el "cambio rápido" de admin)
create or replace function produccion_app.app_list_users()
returns table (id text, usuario text, nombre text, rol text)
language sql security definer set search_path = produccion_app, extensions, pg_temp
as $$ select u.id, u.usuario, u.nombre, u.rol from produccion_app.usuarios u order by u.seq $$;

-- Login: devuelve la fila del usuario si usuario+contraseña coinciden
create or replace function produccion_app.app_login(p_usuario text, p_password text)
returns table (id text, usuario text, nombre text, rol text)
language sql security definer set search_path = produccion_app, extensions, pg_temp
as $$
  select u.id, u.usuario, u.nombre, u.rol
  from produccion_app.usuarios u
  where lower(u.usuario) = lower(p_usuario)
    and u.password_hash is not null
    and u.password_hash = crypt(p_password, u.password_hash)
  limit 1
$$;

-- Verifica la contraseña de un ADMIN en el servidor (la app la pide para reabrir
-- turnos y aplicar correcciones). Devuelve el admin si coincide; vacio si no.
create or replace function produccion_app.app_verify_admin(p_password text)
returns table (id text, usuario text, nombre text, rol text)
language sql security definer set search_path = produccion_app, extensions, pg_temp
as $$
  select u.id, u.usuario, u.nombre, u.rol
  from produccion_app.usuarios u
  where u.rol = 'admin'
    and coalesce(p_password, '') <> ''
    and u.password_hash is not null
    and u.password_hash = crypt(p_password, u.password_hash)
  limit 1
$$;

-- Alta/cambio de usuario con contraseña hasheada. SOLO service_role
-- (lo usa el script de migración y el panel de Supabase; nunca el navegador).
create or replace function produccion_app.admin_upsert_user(
  p_id text, p_usuario text, p_password text, p_nombre text, p_rol text
) returns void
language plpgsql security definer set search_path = produccion_app, extensions, pg_temp
as $$
begin
  insert into produccion_app.usuarios (id, usuario, password_hash, nombre, rol)
  values (p_id, p_usuario, crypt(p_password, gen_salt('bf')), coalesce(p_nombre,''),
          coalesce(nullif(lower(trim(p_rol)), ''), 'usuario'))
  on conflict (usuario) do update
    set id = excluded.id, password_hash = excluded.password_hash,
        nombre = excluded.nombre, rol = excluded.rol;
end $$;

revoke all on function produccion_app.admin_upsert_user(text,text,text,text,text) from public, anon, authenticated;
grant execute on function produccion_app.admin_upsert_user(text,text,text,text,text) to service_role;
revoke all on function produccion_app.app_login(text,text)  from public;
revoke all on function produccion_app.app_list_users()      from public;
revoke all on function produccion_app.app_verify_admin(text)  from public;
grant execute on function produccion_app.app_login(text,text) to anon;
grant execute on function produccion_app.app_list_users()     to anon;
grant execute on function produccion_app.app_verify_admin(text) to anon;


-- =====================================================================
-- Integración con Loyverse (descuento automático de inventario por venta)
-- =====================================================================
create table if not exists produccion_app.loyverse_map (
  seq              bigint generated always as identity primary key,
  loyverse_item_name text not null unique,
  platillo         text, -- NULL cuando ignorado=true (ej. una bebida: no aplica en esta app)
  activo           boolean not null default true,
  ignorado         boolean not null default false,
  created_at       timestamptz not null default now()
);

create table if not exists produccion_app.loyverse_seen_items (
  item_name    text primary key,
  item_id      text,
  veces        integer not null default 1,
  ultima_vez   timestamptz not null default now(),
  ultimo_recibo text
);

create table if not exists produccion_app.loyverse_sync_state (
  id               integer primary key default 1,
  last_created_at  timestamptz,
  last_run_at      timestamptz,
  last_run_ok      boolean,
  last_run_detalle text,
  check (id = 1)
);
insert into produccion_app.loyverse_sync_state (id) values (1) on conflict (id) do nothing;

create table if not exists produccion_app.loyverse_processed_receipts (
  receipt_number text primary key,
  processed_at   timestamptz not null default now()
);

-- Cada recibo con al menos un producto mapeado (y no ignorado) genera una fila aqui con las
-- ventas que se aplicarian (platillo + descuento de ingredientes). La Edge Function NO escribe
-- directo en `ventas`: un usuario logueado revisa esto y lo acepta desde la app (como se hacia
-- a mano al cerrar turno); solo entonces esas filas se insertan de verdad.
create table if not exists produccion_app.loyverse_pending (
  seq            bigint generated always as identity primary key,
  receipt_number text not null unique,
  fecha          timestamptz not null,
  resumen        text not null,
  ventas_payload jsonb not null,
  estado         text not null default 'pendiente' check (estado in ('pendiente','aceptado','rechazado')),
  resuelto_por   text,
  resuelto_at    timestamptz,
  created_at     timestamptz not null default now()
);

-- Modificadores (ej. proteina, tipo de pasta): un platillo como "PST Amatriciana" siempre se
-- llama igual en Loyverse sin importar la opcion elegida -- esa opcion viaja aparte, como
-- "modificador" del recibo. Cada OPCION se mapea una sola vez (no por platillo) a un
-- ingrediente+cantidad que se suma al descuento normal de la receta.
create table if not exists produccion_app.loyverse_modifiers_seen (
  modifier_option text primary key,
  modifier_name   text,
  veces           integer not null default 1,
  ultima_vez      timestamptz not null default now(),
  ultimo_recibo   text
);

create table if not exists produccion_app.loyverse_modifier_map (
  seq             bigint generated always as identity primary key,
  modifier_option text not null unique,
  ingrediente     text, -- NULL cuando ignorado=true (ej. "Sin queso": no afecta inventario)
  cantidad        numeric,
  unidad          text,
  activo          boolean not null default true,
  ignorado        boolean not null default false,
  created_at      timestamptz not null default now()
);

-- Indice parcial para que la Edge Function pueda insertar las filas de venta
-- con `on_conflict=id&resolution=ignore-duplicates`: si un reintento vuelve a
-- mandar el mismo recibo, Postgres ignora la fila repetida en vez de duplicarla.
-- (No afecta ids de otras fuentes: 'V0001', etc., que no empiezan con 'LOY-'.)
create unique index if not exists loyverse_ventas_id_uk on produccion_app.ventas (id) where id like 'LOY-%';

alter table produccion_app.loyverse_map               enable row level security;
alter table produccion_app.loyverse_seen_items         enable row level security;
alter table produccion_app.loyverse_sync_state         enable row level security;
alter table produccion_app.loyverse_processed_receipts enable row level security;
alter table produccion_app.loyverse_pending             enable row level security;
alter table produccion_app.loyverse_modifiers_seen       enable row level security;
alter table produccion_app.loyverse_modifier_map         enable row level security;

drop policy if exists app_select on produccion_app.loyverse_map;
create policy app_select on produccion_app.loyverse_map for select to anon using (true);
drop policy if exists app_insert on produccion_app.loyverse_map;
create policy app_insert on produccion_app.loyverse_map for insert to anon with check (true);
drop policy if exists app_update on produccion_app.loyverse_map;
create policy app_update on produccion_app.loyverse_map for update to anon using (true) with check (true);

drop policy if exists app_select on produccion_app.loyverse_seen_items;
create policy app_select on produccion_app.loyverse_seen_items for select to anon using (true);

drop policy if exists app_select on produccion_app.loyverse_sync_state;
create policy app_select on produccion_app.loyverse_sync_state for select to anon using (true);

drop policy if exists app_select on produccion_app.loyverse_pending;
create policy app_select on produccion_app.loyverse_pending for select to anon using (true);
drop policy if exists app_update on produccion_app.loyverse_pending;
create policy app_update on produccion_app.loyverse_pending for update to anon using (true) with check (true);

drop policy if exists app_select on produccion_app.loyverse_modifiers_seen;
create policy app_select on produccion_app.loyverse_modifiers_seen for select to anon using (true);

drop policy if exists app_select on produccion_app.loyverse_modifier_map;
create policy app_select on produccion_app.loyverse_modifier_map for select to anon using (true);
drop policy if exists app_insert on produccion_app.loyverse_modifier_map;
create policy app_insert on produccion_app.loyverse_modifier_map for insert to anon with check (true);
drop policy if exists app_update on produccion_app.loyverse_modifier_map;
create policy app_update on produccion_app.loyverse_modifier_map for update to anon using (true) with check (true);

grant select, insert, update on produccion_app.loyverse_map to anon;
grant select on produccion_app.loyverse_seen_items, produccion_app.loyverse_sync_state to anon;
grant select, update on produccion_app.loyverse_pending to anon;
grant select on produccion_app.loyverse_modifiers_seen to anon;
grant select, insert, update on produccion_app.loyverse_modifier_map to anon;
grant usage, select on all sequences in schema produccion_app to anon;

-- Ademas de anon (arriba), la Edge Function necesita estos permisos con service_role:
-- el GRANT ALL ... IN SCHEMA de mas arriba en este archivo es una foto del momento en que
-- se ejecuto (no aplica solo a tablas creadas despues), asi que estas 4 tablas nuevas
-- necesitan su propio grant explicito.
grant all on produccion_app.loyverse_map, produccion_app.loyverse_seen_items,
  produccion_app.loyverse_sync_state, produccion_app.loyverse_processed_receipts,
  produccion_app.loyverse_pending, produccion_app.loyverse_modifiers_seen,
  produccion_app.loyverse_modifier_map to service_role;
grant usage, select on all sequences in schema produccion_app to service_role;

-- Que PostgREST (la API) vea el esquema/tablas nuevas sin reiniciar
notify pgrst, 'reload schema';
