# Plan: panel web de administración + licencias

Este archivo va en `docs/PLAN-WEB.md`. Se trabaja fase por fase, confirmando el alcance antes de empezar cada una.

## Decisiones ya tomadas
- **Usuarios del panel**: el dueño del sistema (superadmin) y los gestores de cada negocio. Cada gestor ve solo sus negocios.
- **Dispositivo**: principalmente una tablet. Diseño pensado primero para tablet y para que se pueda instalar como app (PWA).
- **Hosting**: gratuito y sin dominio propio, en Cloudflare Pages (`algo.pages.dev`). Vercel queda como alternativa.
- **Fuente de datos**: la web lee de Supabase y nunca se conecta directo a la PC de la tienda. La tienda puede quedarse sin internet o sin luz, y por eso lo local sigue siendo la verdad.
- **Tiempo real**: Supabase Realtime sobre las tablas de ventas, movimientos y cortes.
- **Qué debe verse**: transacciones, inventario y sus movimientos (entradas, salidas, altas y bajas), usuarios, cortes X y Z (cada uno en cuanto se genera), reportes y estado de la caja. En resumen, todo lo que necesita un administrador.
- **Edición**: todo lo que hoy tiene el panel de configuración del POS: productos (alta, edición, precio, deshabilitar, información), catálogos, entradas y salidas, inventario, usuarios y permisos.
- **Licencias**: solo las administra el superadmin. No aparecen en el panel de los gestores.
- **Alertas**: van al final, pero el esquema se prepara desde ahora (tabla `pos_events`).
- **Ubicación del código**: carpeta `web/` en el mismo repo. Stack sugerido: Vite + TypeScript + supabase-js. Se puede confirmar al iniciar la fase 3.

## Fase 0: publicar v0.2.11 ✅
Publicada el 2026-10-11 por GitHub Actions. Verificado el 2026-10-12: release, instalador y `latest.json` accesibles, `cargo test` en verde y dos cajas ya sincronizando con 0.2.11.

## Fase 1: Supabase, seguridad y esquema (sin actualizar la app) ✅
Aplicada el 2026-10-12 (`supabase/migrations/20261012000100_fase1_seguridad_y_esquema.sql`). Verificado: la llave publishable ya no lee, escribe ni borra; respaldo intacto en `legacy` (4 negocios, 423 productos, 75 ventas, 45 cortes); superadmin dado de alta.

- [x] Activar Supabase Auth con correo y contraseña para los usuarios del panel.
- [x] Crear `businesses` (license_key, nombre, estado) y `business_members` (user_id, business_id, rol `owner` | `gestor`).
- [x] Reescribir las reglas RLS: lectura solo para usuarios con sesión que sean miembros del negocio, y escritura directa con la llave publishable desactivada.
- [x] Crear funciones RPC para la app (`pos_push`, `pos_pull_commands`, `pos_ack_command`, `pos_heartbeat`) que validen la `license_key` (y a futuro un secreto por instalación).
- [x] `pos_products`: el `sku` de la nube es en realidad el identificador interno → en el esquema nuevo se llama `internal_id` y se agrega `barcode`.
- [x] Tablas nuevas:
  - `pos_sale_items`: detalle de cada venta.
  - `pos_inventory_movements`: entradas, salidas, ajustes, altas y bajas, con usuario y motivo.
  - `pos_users`: usuarios del POS y sus permisos, sin contraseñas.
  - `pos_cash_cuts`: ampliarla con el detalle completo de X y Z.
  - `pos_devices`: device_id, versión, último latido, sesión activa y caja abierta.
  - `pos_events`: base para las alertas.
  - `pos_commands`: ver fase 4.
- [x] Toda tabla lleva `business_id` y `device_id`. Así queda listo el proyecto de dos cajas.
- [x] Actualizar `supabase-schema.sql` como migración versionada.
- [x] Compatibilidad: se eligió la opción 1. Las tablas viejas se cierran ya (pasan a `legacy`) y el espejo se pausa hasta la v0.2.12, que vuelve a subir todo desde lo local.

## Fase 2: app v0.2.12, envío en tiempo real (sin tocar productos ni inventario)
- [ ] Tabla local `outbox` en SQLite. Cada venta, movimiento, corte X o Z y cambio de usuario se encola.
- [ ] Envío inmediato cuando hay internet, con reintentos y backoff. La sincronización de 20 minutos queda como respaldo.
- [ ] Latido cada 60 segundos a `pos_devices`.
- [ ] Carga inicial: un envío completo de productos, usuarios y stock actual. Solo lectura local, sin modificar nada.
- [ ] `cargo test` y publicar.

## Fase 3: panel web de lectura (`web/`)
- [ ] Login y selector de negocio.
- [ ] Inicio: ventas del día en vivo, total, ticket promedio y estado de la caja (en línea o última conexión, versión).
- [ ] Ventas: lista con detalle, filtros por fecha y cajero, cancelaciones y devoluciones.
- [ ] Inventario: stock actual y búsqueda por código de barras.
- [ ] Movimientos: entradas, salidas, altas y bajas, con quién y cuándo.
- [ ] Cortes X y Z: lista y vista con el formato del ticket.
- [ ] Usuarios y permisos (solo lectura).
- [ ] Reportes: ventas por día, por producto y por cajero.
- [ ] PWA instalable en la tablet y despliegue en Cloudflare Pages.

## Fase 4: edición desde la web (requiere actualizar la app)
- La web nunca escribe en la base de la tienda. Inserta **órdenes** en `pos_commands`: tipo, datos, quién y cuándo.
- La app las descarga al tener internet, las aplica en orden, valida (por ejemplo, rechaza un código de barras duplicado) y confirma con `aplicado` o `rechazado` más el motivo.
- El panel muestra cada cambio como "pendiente" hasta que la tienda lo confirma.
- **El inventario se ajusta por movimientos (+/−), nunca fijando un stock absoluto.** Así no se pisan las ventas que se hicieron sin internet.
- Alcance: productos (alta, edición, precio, deshabilitar, información), catálogos, entradas y salidas, usuarios (alta, baja, permisos y restablecer contraseña).
- Estas órdenes son acciones explícitas de un administrador, así que no violan la regla de que "las actualizaciones no modifican productos".

## Fase 5: licencias (solo superadmin)
- [ ] Tabla `licenses`: license_key, negocio, plan, vigencia y estado. Reemplaza la hoja de Google.
- [ ] La app valida la licencia al iniciar y en cada latido, con días de gracia sin internet.
- [ ] Sección privada del superadmin para crear, renovar y suspender licencias.

## Fase 6: alertas
Ejemplos: cancelaciones, descuentos altos, caja sin conexión, stock bajo, corte con diferencia. Primero se muestran en el panel y después como notificación push en la PWA.

## Decisiones pendientes
- ¿Los gestores pueden editar todo o solo algunas secciones? ¿Hay permisos por gestor?
- ¿Cuántos días de gracia tiene la licencia sin internet? ¿Qué pasa al vencer: aviso o bloqueo?
- ¿Se puede restablecer la contraseña de un usuario del POS desde la web?
- ¿Cuánto historial se guarda en la nube (por ejemplo, 12 meses)?
