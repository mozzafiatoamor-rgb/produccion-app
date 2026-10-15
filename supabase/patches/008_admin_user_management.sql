-- =====================================================================
-- Parche 008 · Panel de usuarios: crear/editar/eliminar usuarios desde la app
-- Para proyectos donde YA se ejecutó schema.sql. Idempotente. Solo toca
-- produccion_app. Pegar en SQL Editor > Run.
--
-- Qué agrega:
--   admin_upsert_user() (ya existía) solo lo puede llamar service_role —
--   nunca el navegador — así que hasta ahora dar de alta/editar/borrar un
--   usuario requería entrar a Supabase y correr SQL a mano. Este parche
--   agrega tres funciones nuevas que SÍ puede llamar la app (anon) desde
--   un panel "👥 Usuarios" (solo admin, en Ajustes):
--     - admin_create_user   (crear)
--     - admin_update_user   (editar nombre/usuario/contraseña/rol)
--     - admin_delete_user   (eliminar, definitivo)
--
--   Como la app solo usa la llave pública (anon) y no hay sesión de
--   Supabase Auth por usuario, estas tres funciones no pueden confiar en
--   el "¿eres admin?" que ya calculó el navegador (cualquiera con la
--   llave pública podría llamarlas directo). Por eso cada una vuelve a
--   pedir la contraseña real de un admin y la verifica en el servidor
--   (p_admin_password), igual que ya hace app_verify_admin() para
--   reabrir turno / autorizar correcciones.
--
--   Protección extra: ninguna de las tres deja que el último admin se
--   quede sin el rol de admin ni se elimine a sí mismo si es el único
--   (para no quedarte sin forma de entrar).
--
--   Eliminar un usuario es definitivo (a propósito, por decisión de
--   Gustavo): no hay "desactivar". El historial de ventas/producción no
--   se pierde porque ahí solo se guarda el nombre, no una referencia a
--   la cuenta.
-- =====================================================================
do $$
declare v_comment text;
begin
  select obj_description(oid, 'pg_namespace') into v_comment from pg_namespace where nspname = 'produccion_app';
  if not found or coalesce(v_comment, '') not like 'produccion-app%' then
    raise exception 'produccion_app no existe o no es de produccion-app. Ejecuta primero schema.sql.';
  end if;
end $$;

-- Helper interno (NO se le da permiso a anon/authenticated; solo lo usan,
-- por dentro, las funciones SECURITY DEFINER de abajo).
create or replace function produccion_app._check_admin_password(p_password text)
returns void
language plpgsql security definer set search_path = produccion_app, extensions, pg_temp
as $$
begin
  if coalesce(p_password, '') = '' or not exists (
    select 1 from produccion_app.usuarios u
    where u.rol = 'admin' and u.password_hash is not null
      and u.password_hash = crypt(p_password, u.password_hash)
  ) then
    raise exception 'Contraseña de administrador incorrecta';
  end if;
end $$;
revoke all on function produccion_app._check_admin_password(text) from public, anon, authenticated;

create or replace function produccion_app.admin_create_user(
  p_admin_password text, p_id text, p_usuario text, p_password text, p_nombre text, p_rol text
) returns table (id text, usuario text, nombre text, rol text)
language plpgsql security definer set search_path = produccion_app, extensions, pg_temp
as $$
declare v_rol text;
begin
  perform produccion_app._check_admin_password(p_admin_password);
  if coalesce(trim(p_usuario), '') = '' then raise exception 'Falta el usuario'; end if;
  if coalesce(p_password, '') = '' then raise exception 'Falta la contraseña'; end if;
  v_rol := case when lower(trim(coalesce(p_rol, ''))) = 'admin' then 'admin' else 'usuario' end;
  if exists (select 1 from produccion_app.usuarios u where lower(u.usuario) = lower(trim(p_usuario))) then
    raise exception 'Ese usuario ya existe';
  end if;
  insert into produccion_app.usuarios (id, usuario, password_hash, nombre, rol)
  values (p_id, trim(p_usuario), crypt(p_password, gen_salt('bf')), coalesce(trim(p_nombre), ''), v_rol);
  return query select u.id, u.usuario, u.nombre, u.rol from produccion_app.usuarios u where lower(u.usuario) = lower(trim(p_usuario));
end $$;
revoke all on function produccion_app.admin_create_user(text,text,text,text,text,text) from public, anon, authenticated;
grant execute on function produccion_app.admin_create_user(text,text,text,text,text,text) to anon;

create or replace function produccion_app.admin_update_user(
  p_admin_password text, p_usuario_actual text, p_usuario_nuevo text, p_password text, p_nombre text, p_rol text
) returns table (id text, usuario text, nombre text, rol text)
language plpgsql security definer set search_path = produccion_app, extensions, pg_temp
as $$
declare v_rol text; v_old_rol text;
begin
  perform produccion_app._check_admin_password(p_admin_password);
  if coalesce(trim(p_usuario_nuevo), '') = '' then raise exception 'Falta el usuario'; end if;
  select u.rol into v_old_rol from produccion_app.usuarios u where u.usuario = p_usuario_actual;
  if v_old_rol is null then raise exception 'Usuario no encontrado'; end if;
  v_rol := case when lower(trim(coalesce(p_rol, ''))) = 'admin' then 'admin' else 'usuario' end;
  if v_old_rol = 'admin' and v_rol <> 'admin'
     and (select count(*) from produccion_app.usuarios u where u.rol = 'admin') <= 1 then
    raise exception 'No puedes quitarle el rol de admin al único administrador';
  end if;
  if lower(trim(p_usuario_nuevo)) <> lower(p_usuario_actual)
     and exists (select 1 from produccion_app.usuarios u where lower(u.usuario) = lower(trim(p_usuario_nuevo))) then
    raise exception 'Ese usuario ya existe';
  end if;
  update produccion_app.usuarios u set
    usuario = trim(p_usuario_nuevo),
    nombre = coalesce(trim(p_nombre), u.nombre),
    rol = v_rol,
    password_hash = case when coalesce(p_password, '') <> '' then crypt(p_password, gen_salt('bf')) else u.password_hash end
  where u.usuario = p_usuario_actual;
  return query select u.id, u.usuario, u.nombre, u.rol from produccion_app.usuarios u where u.usuario = trim(p_usuario_nuevo);
end $$;
revoke all on function produccion_app.admin_update_user(text,text,text,text,text,text) from public, anon, authenticated;
grant execute on function produccion_app.admin_update_user(text,text,text,text,text,text) to anon;

create or replace function produccion_app.admin_delete_user(p_admin_password text, p_usuario text)
returns void
language plpgsql security definer set search_path = produccion_app, extensions, pg_temp
as $$
declare v_rol text;
begin
  perform produccion_app._check_admin_password(p_admin_password);
  select u.rol into v_rol from produccion_app.usuarios u where u.usuario = p_usuario;
  if v_rol is null then raise exception 'Usuario no encontrado'; end if;
  if v_rol = 'admin' and (select count(*) from produccion_app.usuarios u where u.rol = 'admin') <= 1 then
    raise exception 'No puedes eliminar al único administrador';
  end if;
  delete from produccion_app.usuarios u where u.usuario = p_usuario;
end $$;
revoke all on function produccion_app.admin_delete_user(text,text) from public, anon, authenticated;
grant execute on function produccion_app.admin_delete_user(text,text) to anon;

notify pgrst, 'reload schema';
