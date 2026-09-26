-- =====================================================================
-- Parche 004 · Loyverse: aceptar ventas antes de descontar + ignorar bebidas
-- Para proyectos donde YA se ejecutó 003_loyverse.sql. Idempotente. Solo toca
-- produccion_app. Pegar en SQL Editor > Run.
--
-- Qué cambia respecto al parche 003:
--   * loyverse_map ahora admite "ignorado" (ej. bebidas: esta app solo
--     descuenta inventario de comida) y platillo puede quedar en NULL
--     mientras un producto esta ignorado.
--   * loyverse_pending: nueva tabla. La Edge Function ya NO escribe directo
--     en `ventas` — arma una fila pendiente por recibo (con las ventas que
--     se aplicarian) para que un usuario logueado la revise y la acepte
--     desde la app (como se hacia a mano al cerrar turno). Solo al aceptar
--     esas filas se insertan de verdad en `ventas`.
--
-- Permisos: cualquier usuario logueado (anon) puede leer y aceptar/rechazar
-- lo pendiente (select + update), igual que ya puede leer/emparejar
-- loyverse_map. Solo la Edge Function (service_role) inserta pendientes.
-- =====================================================================
do $$
declare v_comment text;
begin
  select obj_description(oid, 'pg_namespace') into v_comment from pg_namespace where nspname = 'produccion_app';
  if not found or coalesce(v_comment, '') not like 'produccion-app%' then
    raise exception 'produccion_app no existe o no es de produccion-app. Ejecuta primero schema.sql.';
  end if;
end $$;

alter table produccion_app.loyverse_map alter column platillo drop not null;
alter table produccion_app.loyverse_map add column if not exists ignorado boolean not null default false;

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

alter table produccion_app.loyverse_pending enable row level security;
drop policy if exists app_select on produccion_app.loyverse_pending;
create policy app_select on produccion_app.loyverse_pending for select to anon using (true);
drop policy if exists app_update on produccion_app.loyverse_pending;
create policy app_update on produccion_app.loyverse_pending for update to anon using (true) with check (true);

grant select, update on produccion_app.loyverse_pending to anon;

-- El GRANT ALL ... IN SCHEMA de schema.sql es una foto del momento en que se
-- ejecuto (no cubre tablas creadas despues por un parche), asi que cada
-- parche que agrega tablas debe darle acceso a service_role explicitamente
-- (leccion del parche 003: se nos olvido la primera vez y la Edge Function
-- recibia "permission denied").
grant all on produccion_app.loyverse_pending to service_role;
grant usage, select on all sequences in schema produccion_app to service_role;
grant usage, select on all sequences in schema produccion_app to anon;

notify pgrst, 'reload schema';
