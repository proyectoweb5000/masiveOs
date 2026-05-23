# MasiveOS / EA1FJZ Cloud OS V0.1.2

Versión Render sin dependencias externas de npm.

## Cambios V0.1.2

- Explorador de archivos tipo Windows: carpetas, listado, ruta, subir archivos a carpeta actual, crear carpeta, borrar y vista previa dentro de MasiveOS.
- Endpoint seguro `/api/fs/list`, `/api/fs/view`, `/api/fs/text`, `/api/fs/mkdir` y borrado seguro limitado al directorio persistente de uploads.
- Nuevo tema visual `Windows stile` con ventanas tipo Windows 11.
- Ajuste de resolución/escala de interfaz desde Configuración general.
- Corrección de login/sesión y lectura de respuestas API.

## Variables Render recomendadas

```text
ADMIN_PASSWORD=tu_contraseña
DATABASE_PATH=/var/data/ea1fjz_cloud_os.json
UPLOADS_PATH=/var/data/uploads
```

## Render

Build Command:

```text
npm install
```

Start Command:

```text
npm start
```

Persistent Disk:

```text
Mount Path: /var/data
Size: 1 GB
```
