---
name: diagnostico-antes-de-publicar
description: Rutina obligatoria antes de lanzar cualquier versión de Tienda POS. Comprueba las partes sensibles (alta de productos, inventario, productos existentes, códigos duplicados, cobro, cortes X/Z, actualización sobre bases viejas y actualizador) y entrega al dueño una tabla de resultados. Usar antes de crear cualquier etiqueta vX.
---

# Diagnóstico antes de publicar

Ninguna versión se publica (etiqueta `vX`) sin completar esta rutina, mostrar la tabla de resultados al dueño y recibir su confirmación explícita.

## 1. Revisión del cambio
- `git diff <última etiqueta publicada>..HEAD -- src src-tauri`: enumera todo lo que toca productos, stock, ventas, cortes, el formulario de productos o `create_item`/`patch_item`/`delete_item`. Cada punto debe tener su caso en las pruebas.
- Las migraciones (SQLite o Supabase) solo agregan tablas o columnas. Nada que altere productos ni stock (regla 2).
- `src-tauri/tauri.conf.json` tiene la versión de la etiqueta, sin BOM.

## 2. Pruebas automáticas (deben estar en verde)
- `cargo test` en `src-tauri`.
- `node tests/ui-smoke.mjs` (pantalla real + lógica real; `PW_CHANNEL=chrome`).
- El flujo **Pruebas** de GitHub en verde para el commit que se va a etiquetar: `gh run list --workflow pruebas.yml --limit 3`. Si la laptop no puede compilar, este es el resultado que vale.

## 3. Partes sensibles que DEBEN estar cubiertas por las pruebas
| Área | Qué se comprueba |
|---|---|
| Alta de productos | normal; categoría sin productos; buscador con texto; Editar → salir sin guardar → alta (no pisa a otro); Cancelar edición; cambio de nombre+código pide confirmar |
| Productos existentes | nombre, código y existencia idénticos antes y después |
| Inventario | solo cambia por venta, cancelación, entrada/salida o conteo; una actualización nunca lo toca |
| Códigos duplicados | la alerta sale al iniciar sesión; nada se corrige solo; su botón Editar no deja el formulario "pegado" |
| Cobro | tocar; escanear; producto sin código; precio cambiado; pago mixto; reintento con el mismo folio no descuenta dos veces |
| Cancelar venta | devuelve el inventario una sola vez |
| Cortes | abrir caja; Corte X; Corte Z; Z se niega con tickets en espera; después del Z se puede abrir otra vez |
| Permisos | un cajero puede cobrar y hacer su corte; no puede editar productos |
| Actualización sobre base vieja | la versión nueva abre bases con forma de versiones anteriores (`tests/fixtures/`) y: mismos productos, existencias, ventas y cortes; se puede cobrar, dar de alta y cortar |

Si un área no tiene prueba, se agrega antes de publicar. Para una falla nueva: primero se escribe la prueba, se demuestra que falla con el código viejo y luego que pasa con el arreglo.

## 4. Actualizador
- Tras publicar: `latest.json` de `releases/latest/download/` dice la versión nueva y su `url` descarga el instalador (HTTP 200, tamaño ~3 MB).
- La versión publicada es "Latest".

## 5. Reporte al dueño (antes de la etiqueta)
Tabla con cada fila de la sección 3 → OK / FALLA, más: qué cambia para las tiendas, si hay migraciones, y si ventas/inventario/productos quedan intactos. Publicar solo con su "sí".
