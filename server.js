const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");
const https = require("https");
const httpClient = require("http");

const PORT = process.env.PORT || 10000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "cambiar1234";
const DATABASE_PATH = process.env.DATABASE_PATH || path.join(__dirname, "ea1fjz_cloud_os.json");
const UPLOADS_PATH = process.env.UPLOADS_PATH || path.join(__dirname, "uploads");
const PUBLIC_DIR = path.join(__dirname, "public");

fs.mkdirSync(path.dirname(DATABASE_PATH), { recursive: true });
fs.mkdirSync(UPLOADS_PATH, { recursive: true });

const sessions = new Map();

function defaultState() {
  return {
    config: {
      title: "Masive OS",
      subtitle: "Sistema operativo web para dashboards, nube, archivos, meteo y radio",
      wallpaper: "",
      theme: "massive"
    },
    icons: [
      { id: "browser", title: "Navegador", icon: "🌐", type: "browser", target: "https://www.google.com", x: 40, y: 40 },
      { id: "files", title: "Archivos", icon: "📁", type: "module", target: "files", x: 160, y: 40 },
      { id: "dashboards", title: "Dashboards", icon: "📊", type: "module", target: "dashboards", x: 280, y: 40 },
      { id: "search", title: "Masive Search", icon: "🔎", type: "module", target: "search", x: 400, y: 40 },
      { id: "cloud", title: "Nube", icon: "☁️", type: "module", target: "cloud", x: 400, y: 40 },
      { id: "meteo", title: "Meteo & Radio", icon: "📡", type: "module", target: "meteo", x: 520, y: 40 },
      { id: "remote", title: "Ayuda remota", icon: "🖥️", type: "module", target: "remote", x: 640, y: 40 },
      { id: "settings", title: "Configuración", icon: "⚙️", type: "module", target: "settings", x: 760, y: 40 }
    ],
    files: [],
    folders: [
      { id: "fld_dashboards", name: "Dashboards", path: "/Dashboards", parent: "/", created_at: new Date().toISOString() },
      { id: "fld_meteo", name: "Meteo Radio", path: "/Meteo Radio", parent: "/", created_at: new Date().toISOString() },
      { id: "fld_docs", name: "Documentos", path: "/Documentos", parent: "/", created_at: new Date().toISOString() },
      { id: "fld_backups", name: "Backups", path: "/Backups", parent: "/", created_at: new Date().toISOString() }
    ],
    cloudAccounts: [],
    remoteConnections: []
  };
}

function mergeDefaultIcons(state) {
  const base = defaultState();
  if (!Array.isArray(state.icons)) state.icons = base.icons;
  for (const icon of base.icons) {
    if (!state.icons.some(i => i.id === icon.id)) state.icons.push(icon);
  }
  return state;
}

function loadState() {
  try {
    if (!fs.existsSync(DATABASE_PATH)) {
      const initial = defaultState();
      saveState(initial);
      return initial;
    }
    const raw = fs.readFileSync(DATABASE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return mergeDefaultIcons({
      ...defaultState(),
      ...parsed,
      config: { ...defaultState().config, ...(parsed.config || {}) },
      icons: Array.isArray(parsed.icons) ? parsed.icons : defaultState().icons,
      files: Array.isArray(parsed.files) ? parsed.files : [],
      folders: Array.isArray(parsed.folders) ? parsed.folders : defaultState().folders,
      cloudAccounts: Array.isArray(parsed.cloudAccounts) ? parsed.cloudAccounts : [],
      remoteConnections: Array.isArray(parsed.remoteConnections) ? parsed.remoteConnections : []
    });
  } catch (err) {
    console.error("Error leyendo DB JSON:", err);
    const fallback = defaultState();
    saveState(fallback);
    return fallback;
  }
}

function saveState(state) {
  fs.writeFileSync(DATABASE_PATH, JSON.stringify(state, null, 2), "utf8");
}

let state = loadState();
ensureFoldersState();
saveState(state);

function sendJson(res, status, data, extraHeaders = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extraHeaders });
  res.end(JSON.stringify(data));
}

function sendText(res, status, text) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
  res.end(text);
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const out = {};
  header.split(";").forEach(part => {
    const idx = part.indexOf("=");
    if (idx > -1) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  });
  return out;
}

function getSession(req) {
  const sid = parseCookies(req).ea1fjz_os_sid;
  if (!sid) return null;
  const session = sessions.get(sid);
  if (!session) return null;
  if (Date.now() > session.expires) {
    sessions.delete(sid);
    return null;
  }
  session.expires = Date.now() + 1000 * 60 * 60 * 12;
  return session;
}

function requireAuth(req, res) {
  const session = getSession(req);
  if (!session) {
    sendJson(res, 401, { ok: false, error: "No autorizado" });
    return null;
  }
  return session;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 32 * 1024 * 1024) {
        reject(new Error("Body demasiado grande"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

async function readJson(req) {
  const body = await readBody(req);
  if (!body) return {};
  try { return JSON.parse(body); } catch { return {}; }
}

function getMime(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8", ".png": "image/png",
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
    ".webp": "image/webp", ".svg": "image/svg+xml", ".ico": "image/x-icon",
    ".txt": "text/plain; charset=utf-8", ".pdf": "application/pdf",
    ".csv": "text/csv; charset=utf-8", ".db": "application/octet-stream", ".sqlite": "application/octet-stream"
  };
  return map[ext] || "application/octet-stream";
}

function serveStatic(req, res, pathname) {
  let filePath = pathname === "/" ? path.join(PUBLIC_DIR, "index.html") : path.join(PUBLIC_DIR, pathname);
  const normalized = path.normalize(filePath);
  if (!normalized.startsWith(PUBLIC_DIR)) return sendText(res, 403, "Forbidden");
  if (!fs.existsSync(normalized) || fs.statSync(normalized).isDirectory()) return sendText(res, 404, "Not found");
  res.writeHead(200, { "Content-Type": getMime(normalized), "Cache-Control": "no-store" });
  fs.createReadStream(normalized).pipe(res);
}

function newId(prefix = "id") {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(6).toString("hex")}`;
}

function safeFileName(name) {
  return String(name || "archivo")
    .normalize("NFKD")
    .replace(/[^\w.\- ]+/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 120) || "archivo";
}

function normalizeFolder(folderPath) {
  if (!folderPath || folderPath === "/") return "/";
  const clean = String(folderPath).replace(/^\/+|\/+$/g, "").replace(/\/+/g, "/");
  return clean ? "/" + clean : "/";
}

function parentFolder(folderPath) {
  const f = normalizeFolder(folderPath);
  if (f === "/") return "/";
  const parts = f.split("/").filter(Boolean);
  parts.pop();
  return parts.length ? "/" + parts.join("/") : "/";
}

function safeFolderName(name) {
  return String(name || "Nueva carpeta")
    .normalize("NFKD")
    .replace(/[^\w.\- áéíóúÁÉÍÓÚñÑ]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "Nueva carpeta";
}

function ensureFoldersState() {
  if (!Array.isArray(state.folders)) state.folders = defaultState().folders;
  const defaults = defaultState().folders;
  for (const f of defaults) {
    if (!state.folders.some(x => normalizeFolder(x.path) === normalizeFolder(f.path))) state.folders.push(f);
  }
}

function testHttpUrl(targetUrl) {
  return new Promise((resolve) => {
    let parsed;
    try { parsed = new URL(targetUrl); } catch { return resolve({ ok: false, error: "URL no válida" }); }
    if (!["http:", "https:"].includes(parsed.protocol)) return resolve({ ok: false, error: "Solo se permite http/https" });
    const client = parsed.protocol === "https:" ? https : httpClient;
    const started = Date.now();
    const req = client.request(parsed, { method: "GET", timeout: 8000 }, (response) => {
      response.resume();
      response.on("end", () => resolve({ ok: response.statusCode >= 200 && response.statusCode < 400, status: response.statusCode, ms: Date.now() - started }));
    });
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, error: "Timeout" }); });
    req.on("error", (err) => resolve({ ok: false, error: err.message }));
    req.end();
  });
}

function sanitizeCloudAccount(data, existing = {}) {
  return {
    ...existing,
    id: existing.id || data.id || newId("cloud"),
    provider: data.provider || existing.provider || "custom",
    display_name: data.display_name || data.name || existing.display_name || "Cuenta nube",
    auth_type: data.auth_type || existing.auth_type || "token",
    url: data.url || existing.url || "",
    resource: data.resource || existing.resource || "",
    branch: data.branch || existing.branch || "",
    token: data.token !== undefined ? data.token : (existing.token || ""),
    notes: data.notes || existing.notes || "",
    enabled: data.enabled !== false,
    config: {
      ...(existing.config || {}),
      ...(data.config || {}),
      url: data.url || data.config?.url || existing.config?.url || existing.url || "",
      resource: data.resource || data.config?.resource || existing.config?.resource || existing.resource || "",
      branch: data.branch || data.config?.branch || existing.config?.branch || existing.branch || "",
      token: data.token !== undefined ? data.token : (existing.config?.token || existing.token || ""),
      notes: data.notes || data.config?.notes || existing.config?.notes || existing.notes || ""
    },
    updated_at: new Date().toISOString(),
    created_at: existing.created_at || new Date().toISOString(),
    last_test: existing.last_test || null
  };
}

async function handleApi(req, res, pathname) {
  if (pathname === "/api/health") {
    return sendJson(res, 200, {
      ok: true,
      service: "Masive OS",
      dbPath: DATABASE_PATH,
      uploadsPath: UPLOADS_PATH,
      node: process.version,
      persistent: DATABASE_PATH.startsWith("/var/data")
    });
  }

  if (pathname === "/api/login" && req.method === "POST") {
    const data = await readJson(req);
    const password = data.password || data.pass || "";
    if (password !== ADMIN_PASSWORD) return sendJson(res, 401, { ok: false, error: "Contraseña incorrecta" });
    const sid = crypto.randomBytes(32).toString("hex");
    sessions.set(sid, { user: "admin", created: Date.now(), expires: Date.now() + 1000 * 60 * 60 * 12 });
    return sendJson(res, 200, { ok: true, user: "admin" }, {
      "Set-Cookie": `ea1fjz_os_sid=${encodeURIComponent(sid)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200`
    });
  }

  if (pathname === "/api/logout" && (req.method === "POST" || req.method === "GET")) {
    const sid = parseCookies(req).ea1fjz_os_sid;
    if (sid) sessions.delete(sid);
    return sendJson(res, 200, { ok: true }, { "Set-Cookie": "ea1fjz_os_sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0" });
  }

  if (pathname === "/api/session") {
    const session = getSession(req);
    return sendJson(res, 200, { ok: !!session, authenticated: !!session, user: session ? session.user : null });
  }

  if (!requireAuth(req, res)) return;

  if (pathname === "/api/config") {
    if (req.method === "GET") return sendJson(res, 200, state.config);
    if (req.method === "POST" || req.method === "PUT") {
      const data = await readJson(req);
      state.config = { ...state.config, ...data };
      saveState(state);
      return sendJson(res, 200, state.config);
    }
  }

  if (pathname === "/api/icons") {
    if (req.method === "GET") return sendJson(res, 200, state.icons);
    if (req.method === "POST") {
      const data = await readJson(req);
      const icon = {
        id: data.id || newId("icon"),
        title: data.title || "Nuevo icono",
        icon: data.icon || "🔗",
        type: data.type || "link",
        target: data.target || "",
        x: Number(data.x || 80),
        y: Number(data.y || 80)
      };
      state.icons.push(icon);
      saveState(state);
      return sendJson(res, 200, icon);
    }
  }

  if (pathname.startsWith("/api/icons/")) {
    const id = decodeURIComponent(pathname.split("/").pop());
    const idx = state.icons.findIndex(i => i.id === id);
    if (idx === -1) return sendJson(res, 404, { ok: false, error: "Icono no encontrado" });
    if (req.method === "PUT" || req.method === "PATCH") {
      const data = await readJson(req);
      state.icons[idx] = { ...state.icons[idx], ...data, id };
      saveState(state);
      return sendJson(res, 200, state.icons[idx]);
    }
    if (req.method === "DELETE") {
      const removed = state.icons.splice(idx, 1)[0];
      saveState(state);
      return sendJson(res, 200, removed);
    }
  }

  if (pathname === "/api/folders") {
    ensureFoldersState();

    if (req.method === "GET") {
      return sendJson(res, 200, state.folders);
    }

    if (req.method === "POST") {
      const data = await readJson(req);
      const name = safeFolderName(data.name || "Nueva carpeta");
      const parent = normalizeFolder(data.parent || "/");
      const pathValue = normalizeFolder(parent === "/" ? "/" + name : parent + "/" + name);

      if (state.folders.some(f => normalizeFolder(f.path) === pathValue)) {
        return sendJson(res, 409, { ok: false, error: "Ya existe una carpeta con ese nombre" });
      }

      const folder = {
        id: newId("folder"),
        name,
        path: pathValue,
        parent,
        created_at: new Date().toISOString()
      };

      state.folders.push(folder);
      saveState(state);

      return sendJson(res, 200, folder);
    }
  }

  if (pathname.startsWith("/api/folders/") && req.method === "DELETE") {
    ensureFoldersState();

    const id = decodeURIComponent(pathname.split("/").pop());
    const idx = state.folders.findIndex(f => String(f.id) === id || normalizeFolder(f.path) === normalizeFolder(id));

    if (idx === -1) {
      return sendJson(res, 404, { ok: false, error: "Carpeta no encontrada" });
    }

    const folder = state.folders[idx];

    if (["/Dashboards", "/Meteo Radio", "/Documentos", "/Backups"].includes(normalizeFolder(folder.path))) {
      return sendJson(res, 400, { ok: false, error: "Esta carpeta base no se puede eliminar" });
    }

    const removedPath = normalizeFolder(folder.path);
    state.folders.splice(idx, 1);

    for (const child of state.folders) {
      if (normalizeFolder(child.parent) === removedPath) child.parent = parentFolder(removedPath);
      if (normalizeFolder(child.path).startsWith(removedPath + "/")) {
        child.parent = "/";
      }
    }

    for (const file of state.files) {
      if (normalizeFolder(file.folder || "/") === removedPath || normalizeFolder(file.folder || "/").startsWith(removedPath + "/")) {
        file.folder = "/";
      }
    }

    saveState(state);
    return sendJson(res, 200, folder);
  }

  if (pathname === "/api/files") {
    if (req.method === "GET") return sendJson(res, 200, state.files);
  }

  if (pathname === "/api/files/upload-json" && req.method === "POST") {
    const data = await readJson(req);
    const original = safeFileName(data.name || "archivo.bin");
    const buffer = Buffer.from(String(data.data_base64 || ""), "base64");
    if (!buffer.length) return sendJson(res, 400, { ok: false, error: "Archivo vacío" });
    if (buffer.length > 12 * 1024 * 1024) return sendJson(res, 413, { ok: false, error: "Archivo demasiado grande. Máximo 12 MB." });

    const id = newId("file");
    const stored = `${id}_${original}`;
    const filePath = path.join(UPLOADS_PATH, stored);
    fs.writeFileSync(filePath, buffer);

    const rec = {
      id,
      original_name: original,
      stored_name: stored,
      mime_type: data.mime_type || getMime(original),
      size_bytes: buffer.length,
      folder: normalizeFolder(data.folder || "/"),
      created_at: new Date().toISOString(),
      path: filePath
    };
    state.files.push(rec);
    saveState(state);
    return sendJson(res, 200, rec);
  }

  if (pathname.startsWith("/api/files/download/")) {
    const id = decodeURIComponent(pathname.split("/").pop());
    const file = state.files.find(f => f.id === id);
    if (!file) return sendJson(res, 404, { ok: false, error: "Archivo no encontrado" });
    const filePath = path.join(UPLOADS_PATH, file.stored_name || file.name);
    if (!fs.existsSync(filePath)) return sendJson(res, 404, { ok: false, error: "Archivo físico no encontrado" });
    const inline = /\.(html?|pdf|png|jpe?g|gif|webp|svg|txt|csv)$/i.test(file.original_name || "");
    res.writeHead(200, {
      "Content-Type": file.mime_type || getMime(filePath),
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${encodeURIComponent(file.original_name || file.name || "archivo")}"`,
      "Cache-Control": "no-store"
    });
    return fs.createReadStream(filePath).pipe(res);
  }

  if (pathname.startsWith("/api/files/") && req.method === "DELETE") {
    const id = decodeURIComponent(pathname.split("/").pop());
    const idx = state.files.findIndex(f => f.id === id);
    if (idx === -1) return sendJson(res, 404, { ok: false, error: "Archivo no encontrado" });
    const file = state.files[idx];
    const filePath = path.join(UPLOADS_PATH, file.stored_name || file.name);
    try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (err) { console.warn(err); }
    const removed = state.files.splice(idx, 1)[0];
    saveState(state);
    return sendJson(res, 200, removed);
  }

  if (pathname === "/api/cloud/accounts") {
    if (req.method === "GET") return sendJson(res, 200, state.cloudAccounts);
    if (req.method === "POST") {
      const data = await readJson(req);
      const account = sanitizeCloudAccount(data);
      state.cloudAccounts.push(account);
      saveState(state);
      return sendJson(res, 200, account);
    }
  }

  if (pathname.startsWith("/api/cloud/accounts/")) {
    const id = decodeURIComponent(pathname.split("/").pop());
    const idx = state.cloudAccounts.findIndex(a => a.id === id);
    if (idx === -1) return sendJson(res, 404, { ok: false, error: "Servicio cloud no encontrado" });

    if (req.method === "PUT" || req.method === "PATCH") {
      const data = await readJson(req);
      state.cloudAccounts[idx] = sanitizeCloudAccount(data, state.cloudAccounts[idx]);
      saveState(state);
      return sendJson(res, 200, state.cloudAccounts[idx]);
    }

    if (req.method === "DELETE") {
      const removed = state.cloudAccounts.splice(idx, 1)[0];
      saveState(state);
      return sendJson(res, 200, removed);
    }
  }

  if (pathname.startsWith("/api/cloud/test/") && req.method === "POST") {
    const id = decodeURIComponent(pathname.split("/").pop());
    const idx = state.cloudAccounts.findIndex(a => a.id === id);
    if (idx === -1) return sendJson(res, 404, { ok: false, error: "Servicio cloud no encontrado" });

    const account = state.cloudAccounts[idx];
    const target = account.url || account.config?.url;
    if (!target) return sendJson(res, 400, { ok: false, error: "El servicio no tiene URL configurada" });

    const result = await testHttpUrl(target);
    state.cloudAccounts[idx].last_test = { ...result, tested_at: new Date().toISOString() };
    saveState(state);
    return sendJson(res, 200, result);
  }

  if (pathname === "/api/cloud/test-url" && req.method === "POST") {
    const data = await readJson(req);
    const result = await testHttpUrl(data.url || "");
    return sendJson(res, 200, result);
  }

  if (pathname === "/api/remote/connections") {
    if (req.method === "GET") return sendJson(res, 200, state.remoteConnections);

    if (req.method === "POST") {
      const data = await readJson(req);

      const conn = {
        id: data.id || newId("remote"),
        name: data.name || "Equipo remoto",
        protocol: data.protocol || "quickassist",
        host: data.host || "",
        port: data.port || "",
        username: data.username || "",
        code: data.code || "",
        notes: data.notes || "",
        enabled: data.enabled !== false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };

      state.remoteConnections.push(conn);
      saveState(state);

      return sendJson(res, 200, conn);
    }
  }

  if (pathname.startsWith("/api/remote/connections/")) {
    const id = decodeURIComponent(pathname.split("/").pop());
    const idx = state.remoteConnections.findIndex(r => r.id === id);

    if (idx === -1) {
      return sendJson(res, 404, { ok: false, error: "Conexión remota no encontrada" });
    }

    if (req.method === "PUT" || req.method === "PATCH") {
      const data = await readJson(req);
      state.remoteConnections[idx] = {
        ...state.remoteConnections[idx],
        name: data.name || state.remoteConnections[idx].name,
        protocol: data.protocol || state.remoteConnections[idx].protocol,
        host: data.host !== undefined ? data.host : state.remoteConnections[idx].host,
        port: data.port !== undefined ? data.port : state.remoteConnections[idx].port,
        username: data.username !== undefined ? data.username : state.remoteConnections[idx].username,
        code: data.code !== undefined ? data.code : state.remoteConnections[idx].code,
        notes: data.notes !== undefined ? data.notes : state.remoteConnections[idx].notes,
        enabled: data.enabled !== false,
        updated_at: new Date().toISOString()
      };
      saveState(state);
      return sendJson(res, 200, state.remoteConnections[idx]);
    }

    if (req.method === "DELETE") {
      const removed = state.remoteConnections.splice(idx, 1)[0];
      saveState(state);
      return sendJson(res, 200, removed);
    }
  }

  if (pathname === "/api/password" && req.method === "POST") {
    return sendJson(res, 200, { ok: false, error: "En esta versión la contraseña se cambia desde la variable ADMIN_PASSWORD de Render." });
  }

  if (pathname === "/api/backup") {
    return sendJson(res, 200, { ok: true, database: state, exported_at: new Date().toISOString() });
  }

  return sendJson(res, 404, { ok: false, error: "Ruta API no encontrada", path: pathname });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = decodeURIComponent(url.pathname);
    if (pathname.startsWith("/api/")) return await handleApi(req, res, pathname);
    return serveStatic(req, res, pathname);
  } catch (err) {
    console.error(err);
    return sendJson(res, 500, { ok: false, error: err.message || "Error interno" });
  }
});

server.listen(PORT, () => {
  console.log(`Masive OS escuchando en puerto ${PORT}`);
  console.log(`DB: ${DATABASE_PATH}`);
  console.log(`Uploads: ${UPLOADS_PATH}`);
});
