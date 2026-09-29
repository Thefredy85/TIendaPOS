# Sistema de licencias / suscripcion mensual

## Como funciona

- Cada instalacion de la app genera sola, la primera vez que se abre, una
  "llave de licencia" unica (ej. `TP-4F91A2C3`). Esa llave aparece en una
  etiqueta pequeña, gris, en la esquina inferior derecha de la app.
- La app consulta una Google Sheet tuya (publicada como CSV) para saber si
  esa llave esta "activo" o "suspendido".
- Si esta suspendida, **se bloquean las ventas nuevas** (el checkout), pero
  se puede seguir viendo inventario, reportes, etc. -- no se pierde nada.
- Si la computadora se queda sin internet, la app sigue funcionando normal
  hasta por **7 dias** desde la ultima vez que logro confirmar su estado.
  Pasados esos 7 dias sin poder conectarse, se bloquean las ventas por
  seguridad (para evitar que alguien desconecte el internet a proposito).

## Paso 1: Crear tu Google Sheet de licencias

1. Ve a https://sheets.google.com y crea una hoja nueva.
2. En la primera fila, pon estos encabezados (en este orden, los nombres
   deben ser exactos):
   ```
   nombre_negocio | license_key | estado | notas
   ```
3. Cuando actives a un cliente nuevo, agregas una fila con su nombre, la
   llave que te de su instalacion (la ves en la esquina de su app), y en
   "estado" escribes `activo` o `suspendido`.

## Paso 2: Publicar la hoja como CSV

1. En Google Sheets: **Archivo > Compartir > Publicar en la web**.
2. En el primer menu desplegable, selecciona la hoja correcta (no "Todo el
   documento" si tienes varias pestañas).
3. En el segundo menu, selecciona **Valores separados por comas (.csv)**.
4. Dale clic en **Publicar** y confirma.
5. Copia el link que te da (algo como
   `https://docs.google.com/spreadsheets/d/e/.../pub?output=csv`).

## Paso 3: Poner ese link en el proyecto

1. Abre `src-tauri/src/main.rs`.
2. Busca la linea:
   ```rust
   const LICENSE_SHEET_URL: &str = "REEMPLAZAR_CON_TU_URL_DE_HOJA_PUBLICADA_CSV";
   ```
3. Reemplaza el texto entre comillas por el link que copiaste en el paso
   anterior.
4. Guarda, compila (`tauri build`) y publica la nueva version (con el
   proceso normal o con GitHub Actions).

## Como activar un negocio nuevo

1. Instalas la app en su computadora (proceso normal).
2. La abres una vez -- va a mostrar su llave de licencia en la esquina
   (algo como "Licencia: Sin registrar · TP-XXXXXXXX").
3. Copias esa llave (le das clic al recuadro y se copia sola).
4. La agregas a tu Google Sheet en una fila nueva, con estado `activo`.
5. La proxima vez que esa app revise (al abrir, o cada 30 minutos mientras
   esta abierta), va a decir "Licencia: Activo".

## Como suspender a alguien que no pago

1. Entra a tu Google Sheet (desde el celular tambien funciona).
2. Busca su fila, cambia la columna "estado" de `activo` a `suspendido`.
3. Listo -- la proxima vez que su app revise, se bloquean sus ventas
   nuevas automaticamente, con un mensaje explicandole que debe contactarte.
4. Para reactivarlo, solo vuelves a poner `activo`.

## Notas importantes

- Que sea publica esta hoja de licencias es igual de sensible que el
  repositorio de codigo: cualquiera con el link puede ver los nombres de
  tus clientes y su estado de pago. Si te preocupa, podemos platicar
  opciones mas privadas mas adelante (por ejemplo, un pequeño servidor
  propio en vez de una hoja de calculo), pero para 1-3 clientes esto es
  rapido, gratis, y suficiente para empezar.
- El "estado" que escribas en la hoja debe ser exactamente `activo` o
  `suspendido` (sin mayusculas, sin espacios extra) para que la app lo
  reconozca bien.
