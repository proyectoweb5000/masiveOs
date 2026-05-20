# EA1FJZ Cloud OS V0.1

Primera versión funcional del sistema operativo web EA1FJZ / Massive Online OS.

## Qué incluye

- Login protegido con usuario `admin`.
- Escritorio web tipo OS con barra superior, dock, iconos movibles y ventanas flotantes.
- Configuración persistente en SQLite.
- Base de datos preparada para Render con `DATABASE_PATH=/var/data/ea1fjz_cloud_os.sqlite`.
- Motor SQLite mediante `sql.js`, evitando compilaciones nativas de `sqlite3` en despliegues complicados.
- Gestor de archivos persistentes.
- Creación, edición y borrado de iconos/accesos.
- Navegador interno por iframe y botón de apertura externa.
- Centro Meteo & Radio preparado para integrar EA1FJZ Observatory.
- Centro de cuentas nube preparado para GitHub, Render, OneDrive, SharePoint, Dropbox y SFTP.
- Módulo de ayuda remota preparado para Guacamole, noVNC o enlaces externos.
- Backup descargable de la base de datos.
- `render.yaml` listo para desplegar en Render con disco persistente.

## Instalación local

```bash
npm install
npm start
```

Abrir:

```text
http://localhost:3000
```

Usuario inicial:

```text
admin
```

Contraseña inicial local:

```text
cambiar1234
```

En Render, la contraseña inicial se configura con la variable de entorno `ADMIN_PASSWORD`.

## Variables de entorno recomendadas en Render

```text
DATABASE_PATH=/var/data/ea1fjz_cloud_os.sqlite
UPLOADS_PATH=/var/data/uploads
SESSION_SECRET=<generado automáticamente>
ADMIN_PASSWORD=<contraseña inicial segura>
```

## Estructura de carpetas

```text
public/index.html       # Interfaz del sistema operativo
server.js               # API Node/Express + SQLite
package.json            # Dependencias y arranque
render.yaml             # Configuración Render con disco persistente
/var/data               # Disco persistente en Render
/var/data/uploads       # Archivos, iconos, fondos y backups
```

## Siguiente fase recomendada

1. Integrar el HTML real de EA1FJZ Observatory como app interna.
2. Añadir importador de dashboards HTML propios.
3. Añadir conexión real con GitHub API para subir/descargar ficheros.
4. Añadir conexión Render API para ver estado/redeploy/logs si el token lo permite.
5. Diseñar módulo Guacamole/noVNC para ayuda remota real.

## Nota importante sobre escritorio remoto

El navegador no puede abrir directamente RDP de Windows de forma segura. Esta versión deja preparado el gestor de conexiones. Para escritorio remoto real se recomienda integrar Apache Guacamole, noVNC o una herramienta externa corporativa.
