# Tienda POS — contexto para Claude Code

Responde siempre en español.

## Qué es
App de escritorio para Windows de punto de venta: ventas, inventario, cortes de caja (X y Z) y usuarios.
- Funciona sin internet, con datos locales en SQLite. Las tiendas tienen cortes de internet y de luz, así que lo local es la fuente de verdad.
- Stack: Tauri v1 + Rust + SQLite. Toda la interfaz está en un solo archivo: `src/index.html`.
- Roles: admin, encargado y cajero, con permisos configurables.
- Repo: `Thefredy85/TiendaPOS`. Carpeta local: `C:\Users\angel\Documents\POS\tienda-pos-git`.
- Se distribuye con GitHub Releases y un actualizador propio que lee `latest.json` desde `releases/latest/download/`.
- La PC de la tienda está en otro lugar (remota). Solo se actualiza mediante el actualizador.

## Estructura
- `src/index.html`: interfaz completa del POS.
- `src-tauri/`: backend en Rust y SQLite.
- `supabase/migrations/`: esquema de Supabase como migraciones versionadas (la primera es la línea base de lo que ya existía).
- `web/`: panel web de administración (nuevo, ver `docs/PLAN-WEB.md`).

## Reglas de trabajo (obligatorias)
1. Cuando el usuario diga "Trabajemos en una actualización", primero se define y confirma el alcance, y después se hace.
2. Las actualizaciones NO modifican inventarios ni productos existentes. Las migraciones solo agregan tablas o columnas y nunca alteran datos de productos ni de stock.
3. Los códigos de barras duplicados que ya existan solo se muestran en una alerta al iniciar sesión. Nunca se corrigen solos.
4. Productos: ya no hay SKU. Se identifican por código de barras (obligatorio y único) más un identificador interno automático. Las búsquedas van primero por código de barras y luego por identificador interno.
5. Antes de cada versión, correr `cargo test` en `src-tauri`.
6. Nunca subir llaves secretas (service_role, tokens) al repo. Van en `.env`, y `.env` va en `.gitignore`. La app solo usa la llave publishable, en el encabezado `apikey`.

## Cómo publicar una versión
Lo normal es con GitHub Actions (`.github/workflows/build.yml`): al subir una etiqueta `vX` corre `cargo test`, las pruebas de pantalla (`tests/ui-smoke.mjs`), compila, crea la release y sube `latest.json` solo.
1. Subir la versión en `src-tauri/tauri.conf.json` (debe coincidir con la etiqueta o el flujo se detiene).
2. `cargo test` en `src-tauri`.
3. `git commit` y `git push`.
4. `git tag vX` y `git push origin vX`.

Proceso manual de respaldo (PowerShell, en la laptop):
1. Subir la versión en `src-tauri/tauri.conf.json` (y en `Cargo.toml` si aplica).
2. `cargo test` en `src-tauri`.
3. `git add -A`, `git commit -m "vX"` y `git push`.
4. `npx tauri build`
5. `gh release create vX "src-tauri\target\release\bundle\nsis\Tienda POS_X_x64-setup.exe" --repo Thefredy85/TiendaPOS --title "vX" --notes "..."`
6. `gh release view vX --repo Thefredy85/TiendaPOS` para ver el nombre real del .exe. GitHub cambia los espacios por puntos, así que queda `Tienda.POS_X_x64-setup.exe`.
7. Generar `latest.json` con ese nombre. Para el formato, se puede tomar como base el de la versión anterior: `gh release download v0.2.10 -p latest.json --repo Thefredy85/TiendaPOS`.
8. `gh release upload vX latest.json --repo Thefredy85/TiendaPOS --clobber`

## Estado de versiones
- v0.2.9: publicada. Corrigió el error del instalador ("16 bits", os error 216).
- v0.2.10: publicada. Quitó el SKU, el Corte Z tiene las mismas opciones de diseño que el X y se guardan las opciones de papel 58mm y modo compacto. Bug: no deja cobrar porque el buscador comparaba solo contra el código de barras y la app mandaba el identificador interno.
- v0.2.11: publicada el 2026-10-11 con GitHub Actions. Corrige ese bug (busca por código de barras y luego por identificador interno) y actualiza los precios del ticket si cambian.

## Supabase (espejo en la nube)
- Proyecto `qizccncdyhzxeltwzjni` (tienda-pos-panel). La contraseña de la base va en `.env` (`SUPABASE_DB_PASSWORD`), nunca en el repo.
- Tablas viejas (apps <= v0.2.11): `pos_meta`, `pos_products`, `pos_sales` y `pos_cash_cuts`, con upsert directo cada 20 minutos y RLS abierto a cualquiera con la llave publishable.
- Fase 1 (migración `20261012000100`): las tablas viejas pasan al esquema `legacy` (sin acceso, datos intactos); esquema nuevo con `business_id`/`device_id`; la app escribe solo por RPC (`pos_register_device`, `pos_heartbeat`, `pos_push`, `pos_pull_commands`, `pos_ack_command`).
- La `license_key` NO es secreta: es `TP-` + 8 dígitos hex de la hora de instalación en nanosegundos (se puede adivinar). Cada caja se autentica con un token propio que da `pos_register_device`; en la nube solo se guarda su hash. En un negocio que ya existe, una caja nueva queda `pendiente` hasta que la apruebe el owner o el superadmin.
- En la app, el campo local `sku` es en realidad el identificador interno. En la nube se llama `internal_id`.

## Otros pendientes (no son parte del panel web)
- Pantalla de "movimientos de POS".
- Elegir uno de los 4 diseños de ejemplo.
- Atajos F6, F9 y F10.
- Dos cajas con servidor local.
- Ventas rápidas, ventas a granel y productos sin código de barras.
