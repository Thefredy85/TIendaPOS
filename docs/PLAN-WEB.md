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

## Fase 2: app v0.2.14, envío en tiempo real (sin tocar productos ni inventario) ✅
- [x] Tabla local `outbox` en SQLite. Cada venta, movimiento, corte X o Z y cambio de usuario se encola.
- [x] Envío inmediato cuando hay internet, con reintentos y backoff. La sincronización de 20 minutos queda como respaldo.
- [x] Latido cada 60 segundos a `pos_devices`.
- [x] Carga inicial: un envío completo de productos, usuarios y stock actual. Solo lectura local, sin modificar nada.
- [x] `cargo test` y publicar (salió en la v0.2.14, el 2026-10-16).
- [x] Registro de cada caja con token propio; nombre = equipo de Windows y luego el nombre asignado de la tienda (migración `20261013000000`).
- [x] Aprobar las cajas de las tiendas existentes (DELFOS y Cafe Ambar aprobadas; Tienda de Conveniencia aún sin caja).

## Fase 3: panel web de lectura (`web/`)
- [x] Login y selector de negocio.
- [x] Inicio: ventas del día en vivo, total, ticket promedio y estado de la caja (en línea o última conexión, versión).
- [x] Ventas: lista con detalle, filtros por fecha y cajero, cancelaciones y devoluciones.
- [x] Inventario: stock actual y búsqueda por código de barras.
- [x] Movimientos: entradas, salidas, altas y bajas, con quién y cuándo.
- [x] Cortes X y Z: lista y vista con el formato del ticket.
- [x] Usuarios y permisos (solo lectura).
- [x] Reportes: ventas por día, por producto y por cajero.
- [x] PWA instalable en la tablet y despliegue en Cloudflare Pages (https://tienda-pos-panel.pages.dev).
- [x] Cajas: aprobar, rechazar o dar de baja (owner o superadmin).
- Primera entrega publicada el 2026-10-12 (diseño A, colores del POS).
- Segunda entrega publicada el 2026-10-28 (migración `20261028000000_panel_tiendas.sql`, solo funciones): inventario, movimientos, reportes (por día, producto y cajero), usuarios y permisos, todo con CSV.
- Dos paneles en la misma página, según el rol: el superadmin ve **Tiendas** (todas a la vez) y **Licencias**; el **dueño** ve su tienda, aprueba cajas y da o quita accesos de gestores (Usuarios → Accesos); el **gestor** solo consulta. Dueño y gestor ven su licencia en Inicio (solo lectura).
- Las cuentas las controla solo el superadmin (2026-11-09): en Tiendas → Crear cuenta da correo, contraseña temporal, tienda y rol, y restablece contraseñas desde Accesos o Cuentas sin tienda (Edge Function `cuentas`, publicada con `--no-verify-jwt`; valida la sesión y la tabla `superadmins`). El registro público sigue apagado en Supabase: no encender "Allow new users to sign up".

## Fase 4: edición desde la web (requiere actualizar la app)
Paso 1 y 2 en la v0.2.15 (diseño en `docs/superpowers/specs/2026-11-09-fase4-editar-productos-design.md`):
- [x] Editar costo, precio, nombre, categoría y mínimo (`product_edit`), con revisión antes/después y avisos de error de dedo.
- [x] Entradas, salidas y mermas (`stock_move`): siempre suman o restan; la orden repetida no cuenta doble.
- [x] Desactivar y activar productos (`product_active`).
- [x] Alta de productos (`product_create`): existencia 0, código único revisado en la nube y en la caja.
- [x] Sección **Modificados** (30 días, cancelar lo que espera, deshacer ediciones y movimientos).
- [x] Sección **Revisión** (solo lectura): códigos repetidos, negativos, sin costo, precio ≤ costo, ventas sin descuento y nombres distintos a sus ventas. Reportes con Excel del periodo.
Paso 3 en la v0.2.16 (migración `20261111000100_catalogos.sql`):
- [x] La caja sube categorías, presentaciones, unidades y proveedores (`pos_catalogs`; las cajas que ya tenían la carga inicial los suben una vez).
- [x] Sección **Catálogos**: alta, editar datos, activar/desactivar y renombrar (`catalog_save`). Al renombrar, la caja cambia ese campo en los productos que lo usan (nunca precio, código ni existencia), todo o nada, y rechaza nombres repetidos o un nombre que cambió en la caja. No se borra desde el panel.
- [x] "Nuevo producto" y "Editar" usan la lista real de categorías de la caja.
Paso 4 en la v0.2.17 (migración `20261112000000_usuarios_panel.sql`):
- [x] En la caja el usuario ES el PIN. Cada usuario recibe un identificador interno `uid` ("U-…", no secreto) y la caja sube ese uid a `pos_users` en lugar del PIN (las cajas ya conectadas lo hacen una vez, `usersUidDone`). El inicio de sesión no cambia.
- [x] Sección **Usuarios**: alta (nombre, PIN que escribe el dueño, rol), editar nombre y rol, cambiar PIN (cierra su sesión) y activar/desactivar (`user_save`). No se borra desde el panel. Rol administrador con aviso; nunca deja la caja sin un administrador activo. Rechaza PIN repetido y cambios sobre datos que ya cambiaron en la caja.
- [x] Permisos por rol (encargado y cajero) editables (`role_permissions`), con revisión antes de enviar.
- [x] El PIN nunca va en `pos_commands` (la lee el gestor): viaja en `pos_command_secrets` (sin acceso desde el panel), la caja lo recibe dentro de su orden y se borra en cuanto la orden se aplica, se rechaza o se cancela.
- [ ] Cuando DELFOS tenga la 0.2.17: borrar de la nube las 4 filas viejas de `pos_users` que tenían el PIN como usuario (con autorización) y cambiar esos PIN.

- La web nunca escribe en la base de la tienda. Inserta **órdenes** en `pos_commands`: tipo, datos, quién y cuándo.
- La app las descarga al tener internet, las aplica en orden, valida (por ejemplo, rechaza un código de barras duplicado) y confirma con `aplicado` o `rechazado` más el motivo.
- El panel muestra cada cambio como "pendiente" hasta que la tienda lo confirma.
- **El inventario se ajusta por movimientos (+/−), nunca fijando un stock absoluto.** Así no se pisan las ventas que se hicieron sin internet.
- Alcance: productos (alta, edición, precio, deshabilitar, información), catálogos, entradas y salidas, usuarios (alta, baja, permisos y restablecer contraseña).
- Estas órdenes son acciones explícitas de un administrador, así que no violan la regla de que "las actualizaciones no modifican productos".

## Fase 5: licencias (solo superadmin) ✅
Salió en la v0.2.14 (migración `20261016000000_licencias.sql`, Edge Function `licencia`).
- [x] Licencias mensuales por negocio: día de corte, monto, pagado hasta y bloqueo encendido o apagado.
- [x] La app valida la licencia (firma Ed25519), avisa 3/2/1 días antes y da 3 días de gracia sin internet; suspendida solo deja corte X/Z, consulta y actualización.
- [x] Sección Licencias del superadmin: registrar pagos, código de 8 caracteres por teléfono (7 días) y versión mínima.

## Fase 6: alertas
- [x] Sección Alertas en el panel (2026-11-09): caja pendiente o sin conexión, licencia, agotados, bajo mínimo, cancelaciones y sin costo.
- [ ] Corte con diferencia y descuentos altos: hoy la caja no guarda descuentos ni el efectivo contado en el Z. Requiere que el Z pida el efectivo contado (toca cortes y el ticket de 57 mm).
- [ ] Notificación push en la PWA.

## Pendientes de integración
- Correo diario con el resumen de alertas.
- Corte con diferencia (ver fase 6).

## Decisiones pendientes
- ¿Los gestores pueden editar todo o solo algunas secciones? ¿Hay permisos por gestor?
- ¿Cuántos días de gracia tiene la licencia sin internet? ¿Qué pasa al vencer: aviso o bloqueo?
- ¿Se puede restablecer la contraseña de un usuario del POS desde la web?
- ¿Cuánto historial se guarda en la nube (por ejemplo, 12 meses)?
