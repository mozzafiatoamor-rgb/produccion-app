-- =====================================================================
-- Parche 002 · administrar el catalogo desde la app (activar/desactivar/editar)
-- Para proyectos donde YA se ejecuto schema.sql. Solo toca produccion_app.catalogo.
-- Idempotente. Pegar en SQL Editor > Run.
--   * anon puede ACTUALIZAR filas de catalogo (solo esas columnas).
--   * Sigue sin poder actualizar ni borrar nada en las demas tablas.
-- =====================================================================
do $$
declare v_comment text;
begin
  select obj_description(oid, 'pg_namespace') into v_comment from pg_namespace where nspname = 'produccion_app';
  if not found or coalesce(v_comment, '') not like 'produccion-app%' then
    raise exception 'produccion_app no existe o no es de produccion-app. Ejecuta primero schema.sql.';
  end if;
end $$;

grant update (id, categoria, producto, stock_minimo, unidad, activo) on produccion_app.catalogo to anon;
drop policy if exists app_update on produccion_app.catalogo;
create policy app_update on produccion_app.catalogo for update to anon using (true) with check (true);

notify pgrst, 'reload schema';
