# MasiveOS V0.1.3 - rollback estable + resolución + WebDAV

Versión basada en la rama anterior estable sin dependencias externas de npm.

## Cambios

- Se descarta el tema Windows stile.
- Se mantiene el aspecto anterior.
- Se añade ajuste de resolución / escala desde Configuración general.
- Se añade explorador WebDAV dentro del Gestor de archivos.
- Las carpetas WebDAV se abren dentro de MasiveOS, no como URL directa del navegador.
- Los archivos WebDAV se visualizan mediante proxy seguro `/api/webdav/view`.
- También se añade exploración local de `/var/data/uploads` con carpetas, subida y vista previa.

## Render

Variables recomendadas:

```text
ADMIN_PASSWORD=tu contraseña
DATABASE_PATH=/var/data/ea1fjz_cloud_os.json
UPLOADS_PATH=/var/data/uploads
```

Comandos:

```text
Build Command: npm install
Start Command: npm start
```

## WebDAV

En la app Nube, crea una cuenta con proveedor `WebDAV` y configuración JSON:

```json
{
  "url": "https://servidor/remote.php/dav/files/usuario",
  "username": "usuario",
  "password": "contraseña_o_token"
}
```

Después abre `Gestor archivos > WebDAV`, selecciona la cuenta y entra en carpetas.
