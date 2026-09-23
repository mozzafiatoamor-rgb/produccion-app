-- =====================================================================
-- produccion-app · Esquema Supabase (Postgres)
-- Equivale 1:1 a las hojas de Google Sheets que usa la app hoy.
-- Ejecutar completo en: Supabase > SQL Editor (proyecto NUEVO o de pruebas).
-- Es idempotente: se puede volver a correr sin duplicar nada.
-- =====================================================================

create extension if not exists pgcrypto;

-- Cada tabla tiene `seq` (orden de inserción = "número de fila" de la hoja)
-- y `created_at`. La app usa `seq` para borrar filas (ej. recetas).

-- ---------- Usuarios ------------------------------------------------
create table if not exists public.usuarios (
  seq           bigint generated always as identity primary key,
  id            text,
  usuario       text not null unique,
  password_hash text,                       -- bcrypt; nunca texto plano
  nombre        text not null default '',
  rol           text not null default 'usuario' check (rol in ('admin','usuario')),
  created_at    timestamptz not null default now()
);

-- ---------- Catálogo ------------------------------------------------
create table if not exists public.catalogo (
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
create table if not exists public.produccion (
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
create table if not exists public.ventas (
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
create table if not exists public.recetas (
  seq         bigint generated always as identity primary key,
  platillo    text not null,
  categoria   text not null default '',
  ingrediente text not null,
  cantidad    numeric not null default 0,
  unidad      text not null default '',
  created_at  timestamptz not null default now()
);

-- ---------- Mermas --------------------------------------------------
create table if not exists public.mermas (
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
create table if not exists public.saldo_inicial (
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
create table if not exists public.bitacora (
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
create table if not exists public.turnos (
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
create index if not exists produccion_fecha_idx on public.produccion (fecha);
create index if not exists ventas_fecha_idx     on public.ventas (fecha);
create index if not exists mermas_fecha_idx     on public.mermas (fecha);
create index if not exists bitacora_fecha_idx   on public.bitacora (fecha);
create index if not exists turnos_fecha_idx     on public.turnos (fecha);

-- =====================================================================
-- SEGURIDAD (Row Level Security)
-- La app usa la llave `anon` desde el navegador, así que TODO acceso
-- pasa por estas políticas. Modelo actual = igual de abierto que hoy
-- (quien tenga la llave puede leer/escribir datos operativos), pero:
--   * `usuarios` NO es legible por anon (las contraseñas ya no viajan
--     al navegador): el login se hace con la función app_login().
--   * anon solo puede BORRAR en `recetas` (único borrado que hace la app).
--   * Nadie puede hacer UPDATE desde anon (la app nunca actualiza filas).
-- Fase 2 recomendada: Supabase Auth y políticas por rol (ver docs).
-- =====================================================================
alter table public.usuarios      enable row level security;
alter table public.catalogo      enable row level security;
alter table public.produccion    enable row level security;
alter table public.ventas        enable row level security;
alter table public.recetas       enable row level security;
alter table public.mermas        enable row level security;
alter table public.saldo_inicial enable row level security;
alter table public.bitacora      enable row level security;
alter table public.turnos        enable row level security;

do $$
declare t text;
begin
  foreach t in array array['catalogo','produccion','ventas','recetas','mermas','saldo_inicial','bitacora','turnos'] loop
    execute format('drop policy if exists app_select on public.%I', t);
    execute format('create policy app_select on public.%I for select to anon using (true)', t);
    execute format('drop policy if exists app_insert on public.%I', t);
    execute format('create policy app_insert on public.%I for insert to anon with check (true)', t);
  end loop;
end $$;

drop policy if exists app_delete on public.recetas;
create policy app_delete on public.recetas for delete to anon using (true);

-- Permisos a nivel de tabla (RLS filtra encima de esto)
revoke all on public.usuarios from anon, authenticated;
grant select, insert on public.catalogo, public.produccion, public.ventas, public.recetas,
                        public.mermas, public.saldo_inicial, public.bitacora, public.turnos to anon;
grant delete on public.recetas to anon;
grant usage, select on all sequences in schema public to anon;

-- =====================================================================
-- FUNCIONES (RPC) para usuarios / login
-- =====================================================================

-- Lista de usuarios SIN contraseñas (para el "cambio rápido" de admin)
create or replace function public.app_list_users()
returns table (id text, usuario text, nombre text, rol text)
language sql security definer set search_path = public, extensions
as $$ select u.id, u.usuario, u.nombre, u.rol from public.usuarios u order by u.seq $$;

-- Login: devuelve la fila del usuario si usuario+contraseña coinciden
create or replace function public.app_login(p_usuario text, p_password text)
returns table (id text, usuario text, nombre text, rol text)
language sql security definer set search_path = public, extensions
as $$
  select u.id, u.usuario, u.nombre, u.rol
  from public.usuarios u
  where lower(u.usuario) = lower(p_usuario)
    and u.password_hash is not null
    and u.password_hash = crypt(p_password, u.password_hash)
  limit 1
$$;

-- Alta/cambio de usuario con contraseña hasheada. SOLO service_role
-- (lo usa el script de migración y el panel de Supabase; nunca el navegador).
create or replace function public.admin_upsert_user(
  p_id text, p_usuario text, p_password text, p_nombre text, p_rol text
) returns void
language plpgsql security definer set search_path = public, extensions
as $$
begin
  insert into public.usuarios (id, usuario, password_hash, nombre, rol)
  values (p_id, p_usuario, crypt(p_password, gen_salt('bf')), coalesce(p_nombre,''),
          case when lower(p_rol) = 'admin' then 'admin' else 'usuario' end)
  on conflict (usuario) do update
    set id = excluded.id, password_hash = excluded.password_hash,
        nombre = excluded.nombre, rol = excluded.rol;
end $$;

revoke all on function public.admin_upsert_user(text,text,text,text,text) from public, anon, authenticated;
grant execute on function public.admin_upsert_user(text,text,text,text,text) to service_role;
revoke all on function public.app_login(text,text)  from public;
revoke all on function public.app_list_users()      from public;
grant execute on function public.app_login(text,text) to anon;
grant execute on function public.app_list_users()     to anon;
