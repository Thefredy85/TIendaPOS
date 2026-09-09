# Tienda POS - version de escritorio (definitiva)

Convertida siguiendo el mismo proceso que la app de prueba de la cafeteria:
Tauri + SQLite local + actualizaciones remotas por GitHub.

## Que se hizo

- Se tomo el codigo real de tu app (`index.html`, con todo el frontend) y se
  reemplazaron las llamadas a la API de Vento (`fetch` a `/api/core/v1/...`)
  por un backend local en Rust que guarda todo en SQLite
  (`tienda_pos.sqlite`), sin necesitar internet para nada.
- Se reimplemento **exactamente la misma logica de negocio** que tenia el
  backend original: roles (`admin`, `encargado`, `cajero`), hash de
  contrasenas con sal, sesiones, ventas con descuento de inventario,
  entradas/salidas/mermas, conteos de inventario con ajuste automatico,
  catalogos (categorias, unidades, proveedores, presentaciones), IVA 16%, y
  personalizacion de tickets/corte de caja.
- Como la app de escritorio siempre esta "en linea" consigo misma (todo es
  local), se quitaron los bloqueos de "esto requiere internet" que tenia la
  version web, y la cola de sincronizacion offline ya no es necesaria.
- Se reutilizo la misma llave de firma que generamos para la app de prueba
  (`cafepos.key`), asi que **no hace falta generar una llave nueva** para
  esta app.

## Antes de compilar: 2 cosas pendientes

1. **Crea un repositorio nuevo en GitHub** para esta app (recomendado, para
   no mezclarla con la de prueba). Sigue el mismo proceso de la vez pasada:
   - Nombre sin espacios, ej: `TiendaPOS`
   - Privado
   - **Agrega un README al crearlo** (o justo despues) para que no quede
     vacio -- eso fue lo que causo el problema del boton "Publish release"
     la vez pasada.

2. **Reemplaza el nombre del repositorio** en
   `src-tauri/tauri.conf.json`, en el campo `endpoints`, donde dice
   `REEMPLAZAR-NOMBRE-REPO`, por el nombre real que le pusiste. Por ejemplo:
   ```
   "endpoints": [
     "https://github.com/Thefredy85/TiendaPOS/releases/latest/download/latest.json"
   ]
   ```

## Como compilar (mismos pasos que ya conoces)

1. Copia esta carpeta completa a tu PC con Windows (donde ya tienes Node,
   Rust y el CLI de Tauri instalados).
2. Abre PowerShell dentro de la carpeta `tienda-pos-desktop`.
3. Configura las variables de firma (con la misma llave y contrasena de
   antes):
   ```
   $env:TAURI_PRIVATE_KEY = (Get-Content C:\Users\angel\.tauri\cafepos.key -Raw)
   $env:TAURI_KEY_PASSWORD = "cafepos2026"
   ```
4. Prueba primero en modo desarrollo:
   ```
   tauri dev
   ```
5. Cuando confirmes que funciona bien, compila la version final:
   ```
   tauri build
   ```
6. El instalador y los archivos de firma quedan en:
   ```
   src-tauri\target\release\bundle\nsis\
   src-tauri\target\release\bundle\msi\
   ```

## Primer inicio de sesion

Como esta app usa el flujo original de "configuracion inicial" (no crea un
admin por defecto como la de cafeteria), la primera vez que abras la app te
va a pedir crear el usuario administrador: un codigo de al menos 4 digitos
numericos como usuario, y una contrasena de al menos 4 caracteres.

## Publicar actualizaciones (igual que la vez pasada)

Usa GitHub CLI (`gh`), ya autenticado en tu PC:

```
gh release create v0.1.0 "src-tauri\target\release\bundle\nsis\Tienda POS_0.1.0_x64-setup.exe" "src-tauri\target\release\bundle\nsis\Tienda POS_0.1.0_x64-setup.nsis.zip.sig" --repo Thefredy85/NOMBRE_DEL_REPO --title "Version inicial" --notes "Primera version de la tienda"
```

Y despues sube el `latest.json` correspondiente (te ayudo a armarlo igual
que la vez pasada, pegandome el contenido del archivo `.sig`).

Para cambios futuros: solo dime que quieres modificar, yo actualizo el
codigo (`src/index.html` y/o `src-tauri/src/main.rs` si es logica de
negocio), subimos el numero de version en `tauri.conf.json`, compilamos, y
publicamos una nueva release -- la PC lejana la va a detectar sola sin que
tengas que reinstalar nada ni perder datos.
