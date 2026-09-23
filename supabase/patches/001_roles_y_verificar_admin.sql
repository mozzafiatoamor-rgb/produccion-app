-- =====================================================================
-- Parche 001 · roles libres + verificacion de admin en el servidor
-- Para proyectos donde YA se ejecuto una version anterior de schema.sql.
-- Solo toca objetos de produccion_app. Idempotente. Pegar en SQL Editor > Run.
--   1) Quita el CHECK que solo permitia rol 'admin'/'usuario' (tus usuarios
--      usan tambien 'cocina').
--   2) admin_upsert_user conserva el rol tal cual (en minusculas).
--   3) Agrega app_verify_admin(): la app pide contraseña de admin para reabrir
--      turnos / aplicar correcciones y ya no puede compararla en el navegador.
-- =====================================================================
do $$
declare v_comment text;
begin
  select obj_description(oid, 'pg_namespace') into v_comment from pg_namespace where nspname = 'produccion_app';
  if not found or coalesce(v_comment, '') not like 'produccion-app%' then
    raise exception 'produccion_app no existe o no es de produccion-app. Ejecuta primero schema.sql.';
  end if;
end $$;

alter table produccion_app.usuarios drop constraint if exists usuarios_rol_check;

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
revoke all on function produccion_app.app_verify_admin(text) from public;
grant execute on function produccion_app.app_verify_admin(text) to anon;

notify pgrst, 'reload schema';
