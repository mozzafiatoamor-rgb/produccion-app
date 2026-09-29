-- =====================================================================
-- Parche 007 · Loyverse: programar la corrida automatica de loyverse-sync
-- Idempotente (se puede correr varias veces sin duplicar el cron). Solo
-- toca el job programado, ninguna tabla de produccion_app. Pegar en
-- Supabase -> SQL Editor > Run.
--
-- Por que hace falta:
--   La funcion loyverse-sync ya funciona bien, pero nada la estaba
--   llamando sola cada pocos minutos -- por eso "Ultima sincronizacion"
--   se quedaba pegada en la fecha de la ultima vez que alguien la invoco
--   a mano. Este parche programa un cron (via pg_cron + pg_net) que la
--   llama automaticamente cada 5 minutos, como estaba planeado desde el
--   principio.
--
-- Que cambia:
--   * Prende las extensiones pg_cron y pg_net (si Supabase no las tenia
--     prendidas ya desde el dashboard -- Database > Extensions).
--   * Crea (o reemplaza, si ya existia) un job llamado
--     'loyverse-sync-cada-5-min' que hace un POST a la Edge Function
--     cada 5 minutos, con la misma llave publica (anon) que ya usa la
--     app en el navegador -- no hace falta ningun secreto nuevo.
--
-- Como revisar que si esta funcionando:
--   * En la app: Ajustes -> Loyverse -> "Ultima sincronizacion" deberia
--     avanzar solo, sin que nadie la invoque a mano.
--   * En SQL Editor, para ver el historial de corridas del job:
--       select * from cron.job_run_details
--       where jobid = (select jobid from cron.job where jobname = 'loyverse-sync-cada-5-min')
--       order by start_time desc limit 20;
--
-- Como desactivarlo si algun dia quieres pausar la sincronizacion automatica:
--       select cron.unschedule('loyverse-sync-cada-5-min');
-- =====================================================================

create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'loyverse-sync-cada-5-min') then
    perform cron.unschedule('loyverse-sync-cada-5-min');
  end if;
end $$;

select cron.schedule(
  'loyverse-sync-cada-5-min',
  '*/5 * * * *',
  $sync$
  select net.http_post(
    url := 'https://ujmecfdsbqtwxusqqiqi.supabase.co/functions/v1/loyverse-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', 'sb_publishable_XY_anhqYY9rhgZau67wkcw_WkMx_PRA',
      'Authorization', 'Bearer sb_publishable_XY_anhqYY9rhgZau67wkcw_WkMx_PRA'
    ),
    body := '{}'::jsonb
  ) as request_id;
  $sync$
);
