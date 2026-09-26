-- =====================================================================
-- Parche 005 · Loyverse: modificadores (proteina, tipo de pasta, etc.)
-- Para proyectos donde YA se ejecutaron 003_loyverse.sql y 004_loyverse_pendientes.sql.
-- Idempotente. Solo toca produccion_app. Pegar en SQL Editor > Run.
--
-- Por que hace falta: en Loyverse un platillo como "PST Amatriciana" siempre se
-- llama igual sin importar que tipo de pasta o proteina eligio el cliente -- esa
-- eleccion viaja aparte, como "modificador" del recibo (ej. grupo "Proteina",
-- opcion "Arrachera"). Emparejar el platillo con Recetas ya no alcanza para saber
-- que ingrediente descontar de verdad.
--
-- Que agrega:
--   * loyverse_modifiers_seen: cada OPCION de modificador que Loyverse ya vendio
--     y todavia no tiene decision (paralelo a loyverse_seen_items, pero para
--     modificadores en vez de productos).
--   * loyverse_modifier_map: "opcion de modificador" -> "ingrediente + cantidad"
--     que se descuenta por cada vez que se vende (paralelo a loyverse_map, pero
--     una opcion se mapea UNA sola vez, no por cada platillo que la use).
--
-- Permisos: mismo patron que loyverse_map/loyverse_seen_items -- anon puede leer
-- y administrar el mapeo desde el navegador; la Edge Function (service_role)
-- escribe lo que va viendo en cada corrida.
-- =====================================================================
do $$
declare v_comment text;
begin
  select obj_description(oid, 'pg_namespace') into v_comment from pg_namespace where nspname = 'produccion_app';
  if not found or coalesce(v_comment, '') not like 'produccion-app%' then
    raise exception 'produccion_app no existe o no es de produccion-app. Ejecuta primero schema.sql.';
  end if;
end $$;

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

alter table produccion_app.loyverse_modifiers_seen enable row level security;
alter table produccion_app.loyverse_modifier_map   enable row level security;

drop policy if exists app_select on produccion_app.loyverse_modifiers_seen;
create policy app_select on produccion_app.loyverse_modifiers_seen for select to anon using (true);

drop policy if exists app_select on produccion_app.loyverse_modifier_map;
create policy app_select on produccion_app.loyverse_modifier_map for select to anon using (true);
drop policy if exists app_insert on produccion_app.loyverse_modifier_map;
create policy app_insert on produccion_app.loyverse_modifier_map for insert to anon with check (true);
drop policy if exists app_update on produccion_app.loyverse_modifier_map;
create policy app_update on produccion_app.loyverse_modifier_map for update to anon using (true) with check (true);

grant select on produccion_app.loyverse_modifiers_seen to anon;
grant select, insert, update on produccion_app.loyverse_modifier_map to anon;
grant usage, select on all sequences in schema produccion_app to anon;

-- El GRANT ALL ... IN SCHEMA de schema.sql es una foto del momento en que corre
-- (no cubre tablas creadas despues por un parche): la Edge Function necesita su
-- propio acceso explicito a estas 2 tablas nuevas.
grant all on produccion_app.loyverse_modifiers_seen, produccion_app.loyverse_modifier_map to service_role;
grant usage, select on all sequences in schema produccion_app to service_role;

notify pgrst, 'reload schema';
