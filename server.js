/*
  Massive OS - Server WebDAV
  ------------------------------------------------------------
  Funciones principales:
  - Servir index.html
  - Conectar unidades WebDAV
  - Listar carpetas
  - Ver/descargar archivos
  - Subir archivos
  - Crear carpetas
  - Borrar archivos/carpetas
  - Renombrar/mover elementos

  Instalación:
    npm install express multer webdav cors

  Arranque:
    node server.js

  Abrir:
    http://localhost:3000
*/

const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const cors = require('cors');
const { createClient } = require('webdav');

const app = express();
const PORT = process.env.PORT || 3000;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 1024 * 1024 * 1024 // 1 GB
  }
});

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Sirve archivos estáticos desde la carpeta del proyecto
app.use(express.static(__dirname));

// ===============================
// SESIONES WEBDAV EN MEMORIA
// ===============================

const webdavSessions = new Map();

function makeSessionId() {
  return 'dav_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2);
}

function normalizeDavPath(inputPath) {
  if (!inputPath || inputPath === '') return '/';
  let clean = String(inputPath).replace(/\\/g, '/');
  clean = clean.replace(/\/+/g, '/');
  if (!clean.startsWith('/')) clean = '/' + clean;
  return clean;
}

function safeJoinDavPath(folder, filename) {
  let base = normalizeDavPath(folder || '/');
  const cleanName = String(filename || '').replace(/^\/+/, '').replace(/\.\./g, '');
  if (!base.endsWith('/')) base += '/';
  return normalizeDavPath(base + cleanName);
}

function getDavSession(sessionId) {
  if (!sessionId) {
    throw new Error('Falta sessionId');
  }

  const session = webdavSessions.get(sessionId);
  if (!session) {
    throw new Error('Sesión WebDAV no encontrada. Vuelve a conectar la unidad.');
  }

  session.lastUse = Date.now();
  return session;
}

function mapDavItem(item) {
  return {
    filename: item.filename || '',
    basename: item.basename || path.basename(item.filename || ''),
    type: item.type || 'file',
    size: item.size || 0,
    lastmod: item.lastmod || '',
    mime: item.mime || '',
    etag: item.etag || ''
  };
}

function guessMime(filePath) {
  const ext = String(filePath).split('.').pop().toLowerCase();
  const mimes = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    pdf: 'application/pdf',
    txt: 'text/plain; charset=utf-8',
    csv: 'text/csv; charset=utf-8',
    json: 'application/json; charset=utf-8',
    html: 'text/html; charset=utf-8',
    htm: 'text/html; charset=utf-8',
    js: 'text/javascript; charset=utf-8',
    css: 'text/css; charset=utf-8',
    xml: 'application/xml; charset=utf-8',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    zip: 'application/zip',
    rar: 'application/vnd.rar',
    '7z': 'application/x-7z-compressed',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    mp4: 'video/mp4',
    webm: 'video/webm'
  };
  return mimes[ext] || 'application/octet-stream';
}

function sendError(res, err, fallback, code = 500) {
  res.status(code).json({
    ok: false,
    error: err && err.message ? err.message : fallback
  });
}

// Limpieza simple de sesiones antiguas cada hora
setInterval(() => {
  const now = Date.now();
  const maxAge = 12 * 60 * 60 * 1000;

  for (const [id, session] of webdavSessions.entries()) {
    if (now - (session.lastUse || session.createdAt || now) > maxAge) {
      webdavSessions.delete(id);
    }
  }
}, 60 * 60 * 1000).unref();

// ===============================
// RUTAS GENERALES
// ===============================

app.get('/', (req, res) => {
  const indexPath = path.join(__dirname, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).send('No existe index.html en la carpeta del servidor.');
  }
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    app: 'Massive OS WebDAV Server',
    port: PORT,
    activeWebdavSessions: webdavSessions.size,
    now: new Date().toISOString()
  });
});

// ===============================
// API WEBDAV
// ===============================

app.post('/api/webdav/connect', async (req, res) => {
  try {
    const { name, url, username, password } = req.body || {};

    if (!url || !String(url).trim()) {
      return res.status(400).json({ ok: false, error: 'Falta la URL WebDAV' });
    }

    const cleanUrl = String(url).trim();

    const client = createClient(cleanUrl, {
      username: username || undefined,
      password: password || undefined,
      maxBodyLength: Infinity,
      maxContentLength: Infinity
    });

    // Prueba real de acceso
    await client.getDirectoryContents('/');

    const sessionId = makeSessionId();
    const unitName = name && String(name).trim() ? String(name).trim() : 'Unidad WebDAV';

    webdavSessions.set(sessionId, {
      name: unitName,
      url: cleanUrl,
      client,
      createdAt: Date.now(),
      lastUse: Date.now()
    });

    res.json({
      ok: true,
      sessionId,
      name: unitName,
      url: cleanUrl
    });
  } catch (err) {
    sendError(res, err, 'No se pudo conectar con la unidad WebDAV');
  }
});

app.post('/api/webdav/disconnect', async (req, res) => {
  try {
    const { sessionId } = req.body || {};
    if (sessionId) webdavSessions.delete(sessionId);
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err, 'No se pudo desconectar la unidad WebDAV');
  }
});

app.get('/api/webdav/list', async (req, res) => {
  try {
    const { sessionId, path: davPathInput = '/' } = req.query;
    const session = getDavSession(sessionId);
    const davPath = normalizeDavPath(davPathInput);

    const contents = await session.client.getDirectoryContents(davPath);
    const items = Array.isArray(contents) ? contents.map(mapDavItem) : [];

    res.json({
      ok: true,
      name: session.name,
      path: davPath,
      items
    });
  } catch (err) {
    sendError(res, err, 'No se pudo listar la carpeta WebDAV');
  }
});

app.get('/api/webdav/view', async (req, res) => {
  try {
    const { sessionId, path: davPathInput } = req.query;
    if (!davPathInput) return res.status(400).json({ ok: false, error: 'Falta path' });

    const session = getDavSession(sessionId);
    const davPath = normalizeDavPath(davPathInput);
    const buffer = await session.client.getFileContents(davPath, { format: 'binary' });

    res.setHeader('Content-Type', guessMime(davPath));
    res.setHeader('Cache-Control', 'no-store');
    res.send(Buffer.from(buffer));
  } catch (err) {
    sendError(res, err, 'No se pudo abrir el archivo WebDAV');
  }
});

app.get('/api/webdav/download', async (req, res) => {
  try {
    const { sessionId, path: davPathInput } = req.query;
    if (!davPathInput) return res.status(400).json({ ok: false, error: 'Falta path' });

    const session = getDavSession(sessionId);
    const davPath = normalizeDavPath(davPathInput);
    const buffer = await session.client.getFileContents(davPath, { format: 'binary' });
    const filename = path.basename(davPath) || 'archivo';

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(Buffer.from(buffer));
  } catch (err) {
    sendError(res, err, 'No se pudo descargar el archivo WebDAV');
  }
});

app.post('/api/webdav/upload', upload.single('file'), async (req, res) => {
  try {
    const { sessionId, path: folderPath = '/' } = req.body || {};
    const session = getDavSession(sessionId);

    if (!req.file) {
      return res.status(400).json({ ok: false, error: 'No se ha recibido ningún archivo' });
    }

    const remotePath = safeJoinDavPath(folderPath, req.file.originalname);

    await session.client.putFileContents(remotePath, req.file.buffer, {
      overwrite: true
    });

    res.json({
      ok: true,
      path: remotePath,
      size: req.file.size
    });
  } catch (err) {
    sendError(res, err, 'No se pudo subir el archivo WebDAV');
  }
});

app.post('/api/webdav/mkdir', async (req, res) => {
  try {
    const { sessionId, path: davPathInput } = req.body || {};
    if (!davPathInput) return res.status(400).json({ ok: false, error: 'Falta path' });

    const session = getDavSession(sessionId);
    const davPath = normalizeDavPath(davPathInput);

    await session.client.createDirectory(davPath);

    res.json({ ok: true, path: davPath });
  } catch (err) {
    sendError(res, err, 'No se pudo crear la carpeta WebDAV');
  }
});

app.delete('/api/webdav/delete', async (req, res) => {
  try {
    const { sessionId, path: davPathInput } = req.body || {};
    if (!davPathInput) return res.status(400).json({ ok: false, error: 'Falta path' });

    const session = getDavSession(sessionId);
    const davPath = normalizeDavPath(davPathInput);

    await session.client.deleteFile(davPath);

    res.json({ ok: true, path: davPath });
  } catch (err) {
    sendError(res, err, 'No se pudo borrar el elemento WebDAV');
  }
});

app.post('/api/webdav/move', async (req, res) => {
  try {
    const { sessionId, from, to } = req.body || {};
    if (!from || !to) {
      return res.status(400).json({ ok: false, error: 'Falta from o to' });
    }

    const session = getDavSession(sessionId);
    const fromPath = normalizeDavPath(from);
    const toPath = normalizeDavPath(to);

    await session.client.moveFile(fromPath, toPath, { overwrite: false });

    res.json({ ok: true, from: fromPath, to: toPath });
  } catch (err) {
    sendError(res, err, 'No se pudo mover o renombrar el elemento WebDAV');
  }
});

app.get('/api/webdav/sessions', (req, res) => {
  const sessions = [];
  for (const [sessionId, session] of webdavSessions.entries()) {
    sessions.push({
      sessionId,
      name: session.name,
      url: session.url,
      createdAt: session.createdAt,
      lastUse: session.lastUse
    });
  }
  res.json({ ok: true, sessions });
});

app.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ ok: false, error: 'Archivo demasiado grande. Límite actual: 1 GB.' });
  }
  sendError(res, err, 'Error interno del servidor');
});

app.listen(PORT, () => {
  console.log('Massive OS WebDAV Server activo');
  console.log(`URL local: http://localhost:${PORT}`);
});
