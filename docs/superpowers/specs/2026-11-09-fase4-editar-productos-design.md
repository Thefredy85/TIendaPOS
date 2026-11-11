# Fase 4, paso 1: editar datos de un producto desde el panel

Aprobado por el dueño el 2026-11-09.

## Para qué
Corregir costo, precio, nombre, categoría y mínimo de un producto desde la web, sin ir a la tienda. El primer uso real son los 81 productos de DELFOS sin costo.

**Fracaso, aunque funcione:** errores de dedo que lleguen a la caja, o un cambio que no se pueda ver ni revertir.

## Decidido por el dueño
- Editan solo el superadmin y el dueño de la tienda. El gestor sigue consultando.
- Laptop primero, tablet también, celular al final.
- Edición uno por uno: se toca el producto en Inventario y se abre su ficha (opción A).
- Sección de cambios recientes.
- La existencia no se edita.

## Aprobado a propuesta del asistente
- Siempre se revisa el antes y el después antes de enviar.
- Avisos que no impiden guardar: costo o precio cambian 50 % o más, precio igual o menor que el costo, precio en cero.
- Sin internet, el cambio espera y la tienda sigue con el dato anterior.
- Si el campo cambió en la caja mientras la orden esperaba, la caja la rechaza y da el motivo.
- Deshacer manda otra orden con los valores anteriores; solo en cambios aplicados.
- Modificados: 30 días, quién y cuándo, por tienda.
- Aviso si la tienda todavía no tiene la v0.2.15.

## Cómo funciona
1. El panel llama a `panel_edit_product` (solo dueño o superadmin), que inserta una orden `product_edit` en `pos_commands` con `internal_id`, `before` y `after`. Solo acepta `cost`, `price`, `name`, `category` y `min_stock`, y solo una orden pendiente por producto.
2. En cada ciclo, `cloud_step` baja las órdenes con `pos_pull_commands`, las aplica y confirma con `pos_ack_command`. Con el servicio suspendido se quedan esperando.
3. `apply_product_edit` valida y usa `patch_item`, así que el cambio entra a `outbox` y sube a la nube en el mismo ciclo. Conserva el IVA desglosado.
4. La pantalla de la caja consulta `remote_sync` cada 20 s; si hubo cambios, toma los productos nuevos y actualiza el ticket en curso.

## Reglas de seguridad de la caja
- Un campo fuera de los cinco permitidos rechaza la orden completa. `stock` nunca se aplica.
- Una orden ya aplicada se confirma sin volver a escribir (corte de luz entre aplicar y avisar).
- La categoría debe existir en el catálogo de la caja, para que el producto no desaparezca de la cuadrícula.
- La aplicación es todo o nada.

## Decisiones del asistente durante la construcción
- Botón Cancelar en órdenes que siguen esperando; sin él, una tienda sin actualizar dejaría el producto bloqueado para nuevos cambios.
- El gestor puede ver Modificados, sin acciones.
- La categoría se elige de una lista, no se escribe.
- Una orden de tipo desconocido se rechaza con su motivo.
- La pantalla usa una consulta periódica en vez de eventos de Tauri, para poder probarla con el puente de `ui-smoke`.

## Fuera de este paso
Entradas y salidas, alta y baja de productos, catálogos, usuarios de la caja.

## Orden de publicación
1. Migración `20261109000100_fase4_editar_productos.sql`.
2. App v0.2.15, con la rutina de diagnóstico y autorización del dueño.
3. Panel. Si se publica antes que la app, las órdenes solo se quedan esperando y el panel lo avisa.
