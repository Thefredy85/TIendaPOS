---
name: diagnostico-antes-de-publicar
description: Rutina obligatoria antes de lanzar cualquier versión de Tienda POS. Comprueba las partes sensibles (método de descuento del inventario, códigos y duplicados, alta de productos, cobro, cortes X/Z, historial de al menos un mes, tickets de 57 mm, volumen y actualización sobre bases viejas) y entrega al dueño una tabla de resultados. Usar antes de crear cualquier etiqueta vX.
---

# Diagnóstico antes de publicar

Ninguna versión se publica (etiqueta `vX`) sin completar esta rutina, mostrar la tabla de resultados al dueño y recibir su confirmación explícita. Lo más importante para el dueño: que **el método de descuento del inventario funcione** y que **nada se rompa al subir una actualización**.

## 1. Revisión del cambio
- `git diff <última etiqueta publicada>..HEAD -- src src-tauri`: enumera todo lo que toca productos, stock, ventas, cortes, el formulario de productos, la lectura de códigos o `create_item`/`patch_item`/`delete_item`. Cada punto debe tener su caso en las pruebas.
- Las migraciones (SQLite o Supabase) solo agregan tablas, columnas o índices. Nada que altere productos ni stock (regla 2).
- El cobro y la cancelación siguen guardándose "todo o nada" (`all_or_nothing`).
- `src-tauri/tauri.conf.json` tiene la versión de la etiqueta, sin BOM.

## 2. Pruebas automáticas (deben estar en verde)
- `cargo test` en `src-tauri`.
- `node tests/ui-smoke.mjs` (pantalla real + lógica real; `PW_CHANNEL=chrome`).
- El flujo **Pruebas** de GitHub en verde para el commit que se va a etiquetar: `gh run list --workflow pruebas.yml --limit 3`. Si la laptop no puede compilar, este es el resultado que vale.

## 3. Partes sensibles que DEBEN estar cubiertas por las pruebas
| Área | Qué se comprueba | Dónde |
|---|---|---|
| **Método de descuento** (prioridad del dueño) | escanear → cobrar → la existencia baja exactamente lo vendido en la base **y** en la pantalla; dos líneas del mismo producto descuentan ambas; un producto sin existencia se vende con aviso y queda en negativo; un pago que no cuadra o un producto inexistente no deja nada a medias | ui-smoke 8 y 10; Rust `el_cobro_descuenta_exacto…` |
| **Lectura de códigos** | el código se reconoce con o sin espacios y ceros a la izquierda (`0111` = `111`); no se puede dar de alta un código que solo difiere en ceros de otro | ui-smoke 8; Rust `el_diagnostico_encuentra…` |
| **Códigos duplicados** | la alerta sale al iniciar sesión (también si difieren en ceros); al escanear un código repetido sale la ventana **"¿Cuál producto es?"** con *Vender este* y *Corregir*; se descuenta el producto elegido y el otro no se toca; nada se corrige solo | ui-smoke 4 y 8 |
| Alta de productos | normal; categoría sin productos; buscador con texto; Editar → salir sin guardar → alta (no pisa a otro); Cancelar edición; cambio de nombre+código pide confirmar | ui-smoke 5 |
| Productos existentes | nombre, código y existencia idénticos antes y después | ui-smoke 5, Rust bases viejas |
| Inventario | solo cambia por venta, cancelación, entrada/salida o conteo; una actualización nunca lo toca; el diagnóstico no corrige nada | ui-smoke 6 y 8 |
| Cobro | tocar; escanear; producto sin código; precio cambiado; pago mixto; reintento con el mismo folio no descuenta dos veces | ui-smoke 1–3 y 6 |
| Cancelar venta | devuelve el inventario una sola vez | ui-smoke 6; Rust |
| Cortes | abrir caja; Corte X; Corte Z; Z se niega con tickets en espera o productos sin cobrar; después del Z se puede abrir otra vez | ui-smoke 6; Rust `cortes_x_y_z_completos` |
| Permisos | un cajero puede cobrar y hacer su corte; no puede editar productos ni mover inventario | ui-smoke 7; Rust |
| **Historial (al menos un mes)** | nada se borra; Ventas, Movimientos, Cortes y Conteos muestran 30 días por defecto y el filtro Desde/Hasta encuentra cualquier fecha anterior | ui-smoke 9; Rust `al_abrir_carga_pocos_dias…` |
| **Volumen** | con ≥2 meses de ventas acumuladas (7,000 ventas) la app entra en pocos segundos, cobra y la pantalla sigue al día; la copia del navegador queda pequeña | ui-smoke 10 |
| **Tickets (57 mm)** | venta, Corte X y Corte Z tienen las mismas opciones en Personalización; el papel de 57 mm y el ahorro de papel aplican a los tres; un corte reimpreso sale con SU fecha, usuario, fondo y efectivo esperado | ui-smoke 11; Rust `la_personalizacion_conserva…` |
| Actualización sobre base vieja | la versión nueva abre bases con forma de versiones anteriores (v0.1.2, v0.2.7) sin cambiar nada; se puede cobrar, dar de alta y cortar | Rust `la_version_nueva_abre_una_base…` |

Si un área no tiene prueba, se agrega antes de publicar. Para una falla nueva: primero se escribe la prueba, se demuestra que falla con el código viejo y luego que pasa con el arreglo.

## 4. Actualizador
- Tras publicar: `latest.json` de `releases/latest/download/` dice la versión nueva y su `url` descarga el instalador (HTTP 200, tamaño ~3 MB).
- La versión publicada es "Latest".

## 5. Reporte al dueño (antes de la etiqueta)
Tabla con cada fila de la sección 3 → OK / FALLA, más: qué cambia para las tiendas, si hay migraciones, si ventas/inventario/productos quedan intactos y qué debe revisar el dueño después (Diagnóstico de inventario). Publicar solo con su "sí".
