-- =====================================================================
-- Parche 006 · Loyverse: revertir el sistema de "modificadores" (parche 005)
-- Para proyectos donde YA se ejecuto 005_loyverse_modificadores.sql. Idempotente.
-- Solo toca produccion_app. Pegar en SQL Editor > Run.
--
-- Por que se revierte:
--   Se penso que Loyverse mandaba la proteina/tipo de pasta como un
--   "modificador" del recibo, y el parche 005 creo un sistema aparte para
--   mapear esas opciones. Al revisar recibos reales de Loyverse se confirmo
--   que para este negocio `line_modifiers` siempre viene vacio: la opcion
--   elegida (ej. "Fetuccini / Pollo") viaja en el campo `variant_name` del
--   propio producto, no en un modificador.
--
-- Que cambia:
--   * Ya no existe un mapeo aparte de "modificadores". Ahora la Edge
--     Function combina item_name + variant_name en un solo nombre (ej.
--     "PST ALFREDO - Fetuccini / Pollo") antes de guardarlo, y esa
--     combinacion se empareja con Recetas igual que cualquier otro
--     producto de Loyverse, en la misma pantalla "Por emparejar" de
--     siempre. No hace falta ninguna tabla ni pantalla nueva.
--   * Este parche solo borra las dos tablas que ya no se usan
--     (loyverse_modifiers_seen y loyverse_modifier_map). No afecta
--     loyverse_map, loyverse_seen_items ni ninguna otra tabla.
-- =====================================================================
do $$
begin
  drop table if exists produccion_app.loyverse_modifier_map;
  drop table if exists produccion_app.loyverse_modifiers_seen;
end $$;

-- Que PostgREST (la API) olvide las tablas eliminadas sin reiniciar
notify pgrst, 'reload schema';
