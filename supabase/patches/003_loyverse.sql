-- =====================================================================
-- Parche 003 · integración con Loyverse (descuento automático de inventario)
-- Para proyectos donde YA se ejecutó schema.sql. Idempotente. Solo toca
-- produccion_app. Pegar en SQL Editor > Run.
--
-- Qué agrega:
--   * loyverse_map:        "producto de Loyverse" -> "platillo de Recetas".
--   * loyverse_seen_items: productos vendidos en Loyverse que aún NO tienen
--                          mapeo (para que el admin los empareje una vez).
--   * loyverse_sync_state: en qué fecha va la última sincronización
--                          (una sola fila, la escribe la Edge Function).
--   * loyverse_processed_receipts: recibos ya aplicados, para no descontar
--                          el mismo recibo dos veces si el reintento se cruza.
--
-- Permisos:
--   * anon puede leer y administrar loyverse_map (como el Catálogo) para
--     que la app pueda emparejar productos desde el navegador.
--   * anon solo puede LEER loyverse_seen_items y loyverse_sync_state
--     (los escribe la Edge Function con la llave de servicio).
--   * loyverse_processed_receipts no es visible para anon (no hace falta).
-- =====================================================================
do $$
declare v_comment text;
begin
  select obj_description(oid, 'pg_namespace') into v_comment from pg_namespace where nspname = 'produccion_app';
  if not found or coalesce(v_comment, '') not like 'produccion-app%' then
    raise exception 'produccion_app no existe o no es de produccion-app. Ejecuta primero schema.sql.';
  end if;
end $$;

create table if not exists produccion_app.loyverse_map (
  seq              bigint generated always as identity primary key,
  loyverse_item_name text not null unique,
  platillo         text not null,
  activo           boolean not null default true,
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

-- Indice parcial para que la Edge Function pueda insertar las filas de venta
-- con `on_conflict=id&resolution=ignore-duplicates`: si un reintento vuelve a
-- mandar el mismo recibo, Postgres ignora la fila repetida en vez de duplicarla.
-- (No afecta ids de otras fuentes: 'V0001', etc., que no empiezan con 'LOY-'.)
create unique index if not exists loyverse_ventas_id_uk on produccion_app.ventas (id) where id like 'LOY-%';

alter table produccion_app.loyverse_map               enable row level security;
alter table produccion_app.loyverse_seen_items         enable row level security;
alter table produccion_app.loyverse_sync_state         enable row level security;
alter table produccion_app.loyverse_processed_receipts enable row level security;

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

grant select, insert, update on produccion_app.loyverse_map to anon;
grant select on produccion_app.loyverse_seen_items, produccion_app.loyverse_sync_state to anon;
grant usage, select on all sequences in schema produccion_app to anon;
-- la Edge Function usa la llave de servicio (service_role), que ya tiene acceso total al esquema.

notify pgrst, 'reload schema';
