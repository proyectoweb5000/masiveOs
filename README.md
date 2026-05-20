# EA1FJZ Cloud OS V0.1.1 Render No-Deps

Versión de arranque robusto para Render sin dependencias externas de npm.

## Render

Build Command:

```bash
npm install
```

Start Command:

```bash
npm start
```

Variables:

```text
ADMIN_PASSWORD=tu_contraseña
DATABASE_PATH=/var/data/ea1fjz_cloud_os.json
UPLOADS_PATH=/var/data/uploads
```

Disco persistente:

```text
Mount Path: /var/data
Size: 1 GB
```

Usuario inicial: `admin`.

Esta versión usa persistencia JSON para eliminar el problema de dependencias en el primer despliegue. La capa SQL se reintroducirá después, cuando el servicio base ya esté estable en Render.
