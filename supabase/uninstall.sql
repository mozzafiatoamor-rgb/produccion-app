-- =====================================================================
-- produccion-app · DESINSTALAR. Borra SOLO el esquema produccion_app y todo
-- lo que contiene (tablas, datos, funciones). No toca public ni otros esquemas.
-- Se niega a borrar un esquema que no haya creado produccion-app.
-- =====================================================================
do $$
declare v_comment text;
begin
  select obj_description(oid, 'pg_namespace') into v_comment from pg_namespace where nspname = 'produccion_app';
  if not found then
    raise notice 'produccion_app no existe; nada que borrar.';
  elsif coalesce(v_comment, '') not like 'produccion-app%' then
    raise exception 'produccion_app existe pero NO es de produccion-app. No se borra.';
  else
    drop schema produccion_app cascade;
    raise notice 'produccion_app eliminado.';
  end if;
end $$;
notify pgrst, 'reload schema';
-- Recuerda quitar `produccion_app` de Settings > API > Exposed schemas.
