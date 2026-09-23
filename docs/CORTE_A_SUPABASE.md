# Corte a Supabase — checklist

Estado previo (hecho): esquema `produccion_app` instalado y con parche 001, importación de prueba verificada,
la app probada en modo Supabase (producción, venta, bitácora, merma, recetas). `main` sigue usando Google Sheets.

## Antes del corte
- Elegir un momento sin captura en cocina/ventas (~15 min).
- La hoja de Google **no se borra ni se modifica**: queda como respaldo.

## El corte (en este orden)
1. **Pausa**: avisar al equipo que no registre nada en la app.
2. **Datos finales** (los corre Claude desde la carpeta del repo, con `NODE_USE_ENV_PROXY=1` si hay proxy):
   ```
   node migration/migrate.mjs export                                   # relee la hoja
   node migration/migrate.mjs import --dry-run                         # 0 avisos esperados
   node migration/migrate.mjs import --replace --yes-vaciar-produccion_app   # vacia SOLO produccion_app y reimporta
   node migration/migrate.mjs verify                                   # todo ✓
   ```
   `--replace` borra únicamente las tablas de `produccion_app` (nunca `public`); usuarios se actualizan.
3. **Publicar** (lo haces tú, en Terminal, para que el cambio a producción sea decisión tuya):
   ```
   cd ~/Documents/GitHub/produccion-app
   git checkout main
   git merge --no-ff feat/supabase-migration -m "Migración a Supabase"
   git push origin main
   ```
4. Esperar 1–2 min a que GitHub Pages publique. Abrir la app de producción (recarga forzada), entrar y
   comprobar que aparecen los datos y el inventario de siempre.
5. Avisar al equipo. Los teléfonos conservan su sesión; la app pide la red primero, así que se actualiza sola
   (si ven la versión vieja: cerrar la app por completo y volver a abrir).
6. Después de unos días estables: desactivar el despliegue del Apps Script de Sheets y dejar la hoja en solo lectura.

## Volver atrás
- **Un dispositivo, al instante:** abrir la app con `?backend=sheets` (etiqueta naranja "GOOGLE SHEETS (respaldo)").
- **Todos:** `git revert -m 1 <commit del merge>` y `git push origin main`. Lo capturado en Supabase después del
  corte **no** vuelve a la hoja automáticamente: exportarlo antes de revertir.
- Desinstalar Supabase por completo: `supabase/uninstall.sql` (solo borra `produccion_app`).

## Qué cambia para el equipo
Nada visible. Misma app, mismos usuarios y contraseñas. Las contraseñas ya no se descargan al teléfono.
