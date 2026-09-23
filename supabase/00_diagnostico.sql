-- =====================================================================
-- produccion-app · DIAGNOSTICO (SOLO LECTURA: no crea ni modifica nada)
-- Pegar en Supabase > SQL Editor > Run, y pasarle el resultado a Claude.
-- No muestra datos de tus tablas: solo nombres, conteos y configuracion.
-- =====================================================================
select k as dato, v as valor from (
  select 1 o, 'version'                       k, split_part(version(), ' on ', 1) v
  union all select 2, 'tamano de la base de datos', pg_size_pretty(pg_database_size(current_database()))
  union all select 3, 'esquemas (con # de tablas)',
    (select string_agg(n.nspname || ' (' || (select count(*) from pg_class c where c.relnamespace = n.oid and c.relkind in ('r','p')) || ')', ', ' order by n.nspname)
       from pg_namespace n
      where n.nspname !~ '^(pg_|information_schema)'
        and n.nspname not in ('auth','storage','realtime','vault','graphql','graphql_public','extensions','pgsodium','pgsodium_masks','supabase_functions','supabase_migrations','net','cron','pgbouncer','_realtime','_analytics'))
  union all select 4, '¿ya existe el esquema produccion_app?',
    case when exists (select 1 from pg_namespace where nspname = 'produccion_app')
         then 'SI  -> ' || coalesce((select obj_description(oid, 'pg_namespace') from pg_namespace where nspname = 'produccion_app'), '(sin comentario: NO es de produccion-app)')
         else 'no' end
  union all select 5, 'extensiones (nombre@esquema)',
    (select string_agg(e.extname || '@' || n.nspname, ', ' order by e.extname) from pg_extension e join pg_namespace n on n.oid = e.extnamespace)
  union all select 6, '¿pgcrypto instalado?  (esquema)',
    coalesce((select n.nspname from pg_extension e join pg_namespace n on n.oid = e.extnamespace where e.extname = 'pgcrypto'), 'NO instalado')
  union all select 7, 'roles de la API',
    (select string_agg(rolname, ', ' order by rolname) from pg_roles where rolname in ('anon','authenticated','service_role','authenticator'))
  union all select 8, 'esquemas expuestos por la API (authenticator)',
    coalesce((select array_to_string(rolconfig, ' | ') from pg_roles where rolname = 'authenticator'), '(sin config visible: revisa Settings > API)')
  union all select 9, 'tablas en public SIN RLS (solo por informacion)',
    coalesce((select string_agg(tablename, ', ' order by tablename) from pg_tables where schemaname = 'public' and not rowsecurity), '(ninguna)')
  union all select 10, 'usa Supabase Auth (usuarios en auth.users)',
    coalesce((select count(*)::text from auth.users), 'no disponible')
) t order by o;
