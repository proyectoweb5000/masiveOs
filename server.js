const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");
const https = require("https");
const httpClient = require("http");
const net = require("net");

const PORT = process.env.PORT || 10000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "cambiar1234";
const DATABASE_PATH = process.env.DATABASE_PATH || path.join(__dirname, "ea1fjz_cloud_os.json");
const UPLOADS_PATH = process.env.UPLOADS_PATH || path.join(__dirname, "uploads");
const PUBLIC_DIR = path.join(__dirname, "public");

const DROPBOX_CLIENT_ID = process.env.DROPBOX_CLIENT_ID || process.env.DROPBOX_APP_KEY || "";
const DROPBOX_CLIENT_SECRET = process.env.DROPBOX_CLIENT_SECRET || process.env.DROPBOX_APP_SECRET || "";
const APP_BASE_URL = (process.env.APP_BASE_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/+$/, "");


fs.mkdirSync(path.dirname(DATABASE_PATH), { recursive: true });
fs.mkdirSync(UPLOADS_PATH, { recursive: true });

const sessions = new Map();
const oauthStates = new Map();

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
      { id: "writer", title: "Textos", icon: "📝", type: "module", target: "writer", x: 520, y: 40 },
      { id: "ftp", title: "FTP", icon: "🧭", type: "module", target: "ftp", x: 640, y: 40 },
      { id: "drives", title: "Cloud Drives", icon: "💽", type: "module", target: "drives", x: 760, y: 40 },
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
    remoteConnections: [],
    docs: [],
    ftpAccounts: [],
    cloudDriveAccounts: [],
    webdavAccounts: []
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
      remoteConnections: Array.isArray(parsed.remoteConnections) ? parsed.remoteConnections : [],
      docs: Array.isArray(parsed.docs) ? parsed.docs : [],
      ftpAccounts: Array.isArray(parsed.ftpAccounts) ? parsed.ftpAccounts : [],
      cloudDriveAccounts: Array.isArray(parsed.cloudDriveAccounts) ? parsed.cloudDriveAccounts : [],
      webdavAccounts: Array.isArray(parsed.webdavAccounts) ? parsed.webdavAccounts : []
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


function ftpReadLine(socket, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => cleanup(() => reject(new Error("FTP timeout"))), timeoutMs);
    const onData = (chunk) => {
      buffer += chunk.toString("utf8");
      if (/\r?\n$/.test(buffer) && /^\d{3} /.test(buffer.split(/\r?\n/).filter(Boolean).slice(-1)[0] || "")) {
        cleanup(() => resolve(buffer));
      }
    };
    const onError = (err) => cleanup(() => reject(err));
    function cleanup(cb) {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      cb();
    }
    socket.on("data", onData);
    socket.on("error", onError);
  });
}

function ftpSend(socket, cmd) {
  socket.write(cmd + "\r\n");
}

function ftpCode(resp) {
  const m = String(resp).match(/(\d{3})/);
  return m ? Number(m[1]) : 0;
}

async function ftpConnect(account) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: account.host, port: Number(account.port || 21) });
    socket.setEncoding("utf8");
    socket.setTimeout(20000);
    socket.once("error", reject);
    socket.once("timeout", () => reject(new Error("Timeout conectando al FTP")));
    socket.once("connect", async () => {
      try {
        await ftpReadLine(socket);
        ftpSend(socket, "USER " + (account.username || "anonymous"));
        let r = await ftpReadLine(socket);
        if (ftpCode(r) === 331) {
          ftpSend(socket, "PASS " + (account.password || "anonymous@"));
          r = await ftpReadLine(socket);
        }
        if (![230, 202].includes(ftpCode(r))) throw new Error("Login FTP rechazado: " + r.trim());
        ftpSend(socket, "TYPE I");
        await ftpReadLine(socket);
        resolve(socket);
      } catch (err) {
        try { socket.end(); } catch {}
        reject(err);
      }
    });
  });
}

async function ftpEnterPassive(socket) {
  ftpSend(socket, "EPSV");
  let r = await ftpReadLine(socket);
  if (ftpCode(r) === 229) {
    const m = r.match(/\(\|\|\|(\d+)\|\)/);
    if (m) return { host: socket.remoteAddress, port: Number(m[1]) };
  }

  ftpSend(socket, "PASV");
  r = await ftpReadLine(socket);
  if (ftpCode(r) !== 227) throw new Error("El servidor FTP no acepta modo pasivo: " + r.trim());
  const nums = (r.match(/(\d+,\d+,\d+,\d+,\d+,\d+)/) || [])[1];
  if (!nums) throw new Error("Respuesta PASV no reconocida");
  const p = nums.split(",").map(Number);
  return { host: p.slice(0, 4).join("."), port: p[4] * 256 + p[5] };
}

function ftpDataSocket(host, port) {
  return new Promise((resolve, reject) => {
    const s = net.createConnection({ host, port });
    s.once("connect", () => resolve(s));
    s.once("error", reject);
    s.setTimeout(20000, () => reject(new Error("Timeout canal datos FTP")));
  });
}

function parseFtpList(text) {
  return String(text || "").split(/\r?\n/).filter(Boolean).map(line => {
    const parts = line.trim().split(/\s+/);
    const isDir = line[0] === "d";
    const size = Number(parts[4] || 0);
    const name = parts.slice(8).join(" ") || parts[parts.length - 1];
    return { name, type: isDir ? "dir" : "file", size: isDir ? "" : size, raw: line };
  }).filter(x => x.name && x.name !== "." && x.name !== "..");
}

function getFtpAccount(id) {
  return state.ftpAccounts.find(a => a.id === id);
}

async function ftpList(account, remotePath) {
  const ctrl = await ftpConnect(account);
  try {
    const pasv = await ftpEnterPassive(ctrl);
    const dataSock = await ftpDataSocket(pasv.host, pasv.port);
    let data = "";
    dataSock.on("data", chunk => data += chunk.toString("utf8"));
    ftpSend(ctrl, "LIST " + (remotePath || "/"));
    await ftpReadLine(ctrl);
    await new Promise(resolve => dataSock.on("end", resolve));
    await ftpReadLine(ctrl).catch(() => "");
    return parseFtpList(data);
  } finally {
    ftpSend(ctrl, "QUIT");
    ctrl.end();
  }
}

async function ftpDownloadBuffer(account, remotePath) {
  const ctrl = await ftpConnect(account);
  try {
    const pasv = await ftpEnterPassive(ctrl);
    const dataSock = await ftpDataSocket(pasv.host, pasv.port);
    const chunks = [];
    dataSock.on("data", chunk => chunks.push(Buffer.from(chunk)));
    ftpSend(ctrl, "RETR " + remotePath);
    const first = await ftpReadLine(ctrl);
    if (![125,150].includes(ftpCode(first))) throw new Error("No se puede descargar: " + first.trim());
    await new Promise(resolve => dataSock.on("end", resolve));
    await ftpReadLine(ctrl).catch(() => "");
    return Buffer.concat(chunks);
  } finally {
    ftpSend(ctrl, "QUIT");
    ctrl.end();
  }
}

async function ftpUploadBuffer(account, remotePath, buffer) {
  const ctrl = await ftpConnect(account);
  try {
    const pasv = await ftpEnterPassive(ctrl);
    const dataSock = await ftpDataSocket(pasv.host, pasv.port);
    ftpSend(ctrl, "STOR " + remotePath);
    const first = await ftpReadLine(ctrl);
    if (![125,150].includes(ftpCode(first))) throw new Error("No se puede subir: " + first.trim());
    dataSock.end(buffer);
    await ftpReadLine(ctrl).catch(() => "");
  } finally {
    ftpSend(ctrl, "QUIT");
    ctrl.end();
  }
}

async function ftpSimpleCommand(account, cmd) {
  const ctrl = await ftpConnect(account);
  try {
    ftpSend(ctrl, cmd);
    const r = await ftpReadLine(ctrl);
    const code = ftpCode(r);
    if (code >= 400) throw new Error(r.trim());
    return r;
  } finally {
    ftpSend(ctrl, "QUIT");
    ctrl.end();
  }
}


function getCloudDriveAccount(id) {
  state.cloudDriveAccounts ||= [];
  return state.cloudDriveAccounts.find(a => a.id === id);
}

function pcloudApiHost(account) {
  return account.region === "us" ? "https://api.pcloud.com" : "https://eapi.pcloud.com";
}

async function fetchJson(url, options = {}) {
  const r = await fetch(url, options);
  const text = await r.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!r.ok) throw new Error(data.error_summary || data.error || data.message || ("HTTP " + r.status));
  return data;
}

function joinCloudPath(base, name) {
  const b = String(base || "/").replace(/\/+$/,"");
  return (b || "") + "/" + String(name || "").replace(/^\/+/,"");
}


async function refreshDropboxTokenIfNeeded(account) {
  if (account.provider !== "dropbox") return account;

  const now = Date.now();
  const expiresAt = Number(account.expires_at || 0);

  if (account.refresh_token && expiresAt && now > expiresAt - 2 * 60 * 1000) {
    if (!DROPBOX_CLIENT_ID || !DROPBOX_CLIENT_SECRET) {
      throw new Error("Faltan DROPBOX_CLIENT_ID y DROPBOX_CLIENT_SECRET para refrescar token.");
    }

    const body = new URLSearchParams();
    body.set("grant_type", "refresh_token");
    body.set("refresh_token", account.refresh_token);
    body.set("client_id", DROPBOX_CLIENT_ID);
    body.set("client_secret", DROPBOX_CLIENT_SECRET);

    const r = await fetch("https://api.dropboxapi.com/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    });

    const data = await r.json().catch(() => ({}));

    if (!r.ok) {
      throw new Error(data.error_description || data.error || "No se pudo refrescar token Dropbox");
    }

    account.token = data.access_token;
    account.expires_at = Date.now() + Number(data.expires_in || 14400) * 1000;
    account.updated_at = new Date().toISOString();
    saveState(state);
  }

  return account;
}

async function cloudDriveList(account, folderPath) {
  account = await refreshDropboxTokenIfNeeded(account);
  if (account.provider === "pcloud") {
    const host = pcloudApiHost(account);
    const url = new URL(host + "/listfolder");
    url.searchParams.set("auth", account.token);
    url.searchParams.set("path", folderPath || account.root || "/");
    const data = await fetchJson(url);
    if (data.result && data.result !== 0) throw new Error(data.error || "Error pCloud");
    return (data.metadata?.contents || []).map(x => ({ id: x.fileid || x.folderid || x.path, name: x.name, type: x.isfolder ? "folder" : "file", path: x.path, size: x.size || 0, modified: x.modified || "" }));
  }
  if (account.provider === "dropbox") {
    const data = await fetchJson("https://api.dropboxapi.com/2/files/list_folder", {
      method:"POST", headers:{"Authorization":"Bearer " + account.token,"Content-Type":"application/json"},
      body:JSON.stringify({path: folderPath === "/" ? "" : (folderPath || ""), recursive:false, include_media_info:false, include_deleted:false, include_has_explicit_shared_members:false})
    });
    return (data.entries || []).map(x => ({ id: x.id || x.path_lower, name: x.name, type: x[".tag"] === "folder" ? "folder" : "file", path: x.path_lower || x.path_display || "", size: x.size || 0, modified: x.server_modified || "" }));
  }
  if (account.provider === "googledrive") {
    const folderId = (!folderPath || folderPath === "/") ? "root" : folderPath;
    const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
    const data = await fetchJson(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,mimeType,size,modifiedTime)`, {headers:{"Authorization":"Bearer " + account.token}});
    return (data.files || []).map(x => ({ id:x.id, name:x.name, type:x.mimeType === "application/vnd.google-apps.folder" ? "folder" : "file", path:x.id, size:x.size || 0, modified:x.modifiedTime || "", mimeType:x.mimeType }));
  }
  if (account.provider === "onedrive") {
    const url = (!folderPath || folderPath === "/") ? "https://graph.microsoft.com/v1.0/me/drive/root/children" : `https://graph.microsoft.com/v1.0/me/drive/items/${encodeURIComponent(folderPath)}/children`;
    const data = await fetchJson(url, {headers:{"Authorization":"Bearer " + account.token}});
    return (data.value || []).map(x => ({ id:x.id, name:x.name, type:x.folder ? "folder" : "file", path:x.id, size:x.size || 0, modified:x.lastModifiedDateTime || "", downloadUrl:x["@microsoft.graph.downloadUrl"] || "" }));
  }
  throw new Error("Proveedor no soportado");
}

async function cloudDriveDownload(account, id, filePath) {
  account = await refreshDropboxTokenIfNeeded(account);
  if (account.provider === "pcloud") {
    const url = new URL(pcloudApiHost(account) + "/getfilelink");
    url.searchParams.set("auth", account.token);
    if (filePath) url.searchParams.set("path", filePath); else url.searchParams.set("fileid", id);
    const data = await fetchJson(url);
    if (data.result && data.result !== 0) throw new Error(data.error || "Error pCloud");
    const r = await fetch("https://" + data.hosts[0] + data.path);
    if (!r.ok) throw new Error("No se pudo descargar pCloud");
    return Buffer.from(await r.arrayBuffer());
  }
  if (account.provider === "dropbox") {
    const r = await fetch("https://content.dropboxapi.com/2/files/download", {method:"POST", headers:{"Authorization":"Bearer " + account.token,"Dropbox-API-Arg":JSON.stringify({path:filePath || id})}});
    if (!r.ok) throw new Error("No se pudo descargar Dropbox");
    return Buffer.from(await r.arrayBuffer());
  }
  if (account.provider === "googledrive") {
    const r = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id || filePath)}?alt=media`, {headers:{"Authorization":"Bearer " + account.token}});
    if (!r.ok) throw new Error("No se pudo descargar Google Drive");
    return Buffer.from(await r.arrayBuffer());
  }
  if (account.provider === "onedrive") {
    const r = await fetch(`https://graph.microsoft.com/v1.0/me/drive/items/${encodeURIComponent(id || filePath)}/content`, {headers:{"Authorization":"Bearer " + account.token}});
    if (!r.ok) throw new Error("No se pudo descargar OneDrive");
    return Buffer.from(await r.arrayBuffer());
  }
  throw new Error("Proveedor no soportado");
}

async function cloudDriveMkdir(account, basePath, name) {
  account = await refreshDropboxTokenIfNeeded(account);
  if (account.mode === "ro") throw new Error("Cuenta en solo lectura");
  if (account.provider === "pcloud") {
    const url = new URL(pcloudApiHost(account) + "/createfolder");
    url.searchParams.set("auth", account.token);
    url.searchParams.set("path", joinCloudPath(basePath || "/", name));
    const data = await fetchJson(url);
    if (data.result && data.result !== 0) throw new Error(data.error || "Error pCloud");
    return data;
  }
  if (account.provider === "dropbox") return fetchJson("https://api.dropboxapi.com/2/files/create_folder_v2", {method:"POST", headers:{"Authorization":"Bearer " + account.token,"Content-Type":"application/json"}, body:JSON.stringify({path:joinCloudPath(basePath === "/" ? "" : basePath, name), autorename:false})});
  if (account.provider === "googledrive") {
    const parent = (!basePath || basePath === "/") ? "root" : basePath;
    return fetchJson("https://www.googleapis.com/drive/v3/files", {method:"POST", headers:{"Authorization":"Bearer " + account.token,"Content-Type":"application/json"}, body:JSON.stringify({name,mimeType:"application/vnd.google-apps.folder",parents:[parent]})});
  }
  if (account.provider === "onedrive") {
    const url = (!basePath || basePath === "/") ? "https://graph.microsoft.com/v1.0/me/drive/root/children" : `https://graph.microsoft.com/v1.0/me/drive/items/${encodeURIComponent(basePath)}/children`;
    return fetchJson(url, {method:"POST", headers:{"Authorization":"Bearer " + account.token,"Content-Type":"application/json"}, body:JSON.stringify({name,folder:{},"@microsoft.graph.conflictBehavior":"rename"})});
  }
  throw new Error("Proveedor no soportado");
}

async function cloudDriveUpload(account, basePath, name, buffer) {
  account = await refreshDropboxTokenIfNeeded(account);
  if (account.mode === "ro") throw new Error("Cuenta en solo lectura");
  if (account.provider === "dropbox") {
    const target = joinCloudPath(basePath === "/" ? "" : basePath, name);
    const r = await fetch("https://content.dropboxapi.com/2/files/upload", {method:"POST", headers:{"Authorization":"Bearer " + account.token,"Content-Type":"application/octet-stream","Dropbox-API-Arg":JSON.stringify({path:target,mode:"add",autorename:true,mute:false})}, body:buffer});
    if (!r.ok) throw new Error("No se pudo subir a Dropbox");
    return await r.json();
  }
  if (account.provider === "onedrive") {
    const url = (!basePath || basePath === "/") ? `https://graph.microsoft.com/v1.0/me/drive/root:/${encodeURIComponent(name)}:/content` : `https://graph.microsoft.com/v1.0/me/drive/items/${encodeURIComponent(basePath)}:/${encodeURIComponent(name)}:/content`;
    const r = await fetch(url, {method:"PUT", headers:{"Authorization":"Bearer " + account.token}, body:buffer});
    if (!r.ok) throw new Error("No se pudo subir a OneDrive");
    return await r.json();
  }
  throw new Error("Subida directa todavía implementada solo para Dropbox y OneDrive en esta versión");
}


function getAppBaseUrl(req) {
  if (APP_BASE_URL) return APP_BASE_URL;
  const proto = req.headers["x-forwarded-proto"] || "https";
  return `${proto}://${req.headers.host}`;
}

function redirectText(res, status, location) {
  res.writeHead(status, {
    "Location": location,
    "Cache-Control": "no-store"
  });
  res.end();
}

async function exchangeDropboxCode({ code, redirectUri }) {
  const body = new URLSearchParams();
  body.set("code", code);
  body.set("grant_type", "authorization_code");
  body.set("client_id", DROPBOX_CLIENT_ID);
  body.set("client_secret", DROPBOX_CLIENT_SECRET);
  body.set("redirect_uri", redirectUri);

  const r = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });

  const data = await r.json().catch(() => ({}));

  if (!r.ok) {
    throw new Error(data.error_description || data.error || "Dropbox rechazó el código OAuth");
  }

  return data;
}

async function getDropboxAccountName(accessToken) {
  const r = await fetch("https://api.dropboxapi.com/2/users/get_current_account", {
    method: "POST",
    headers: { "Authorization": "Bearer " + accessToken }
  });

  const data = await r.json().catch(() => ({}));

  if (!r.ok) return "Dropbox";

  const name = data.name?.display_name || data.email || "Dropbox";
  return "Dropbox " + name;
}


/* ======================================================
   WEBDAV DRIVES
   ====================================================== */

function getWebdavAccount(id) {
  state.webdavAccounts ||= [];
  return state.webdavAccounts.find(a => a.id === id);
}

function xmlUnescape(s) {
  return String(s || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function xmlTag(block, tag) {
  const re = new RegExp(`<[^>]*:?${tag}[^>]*>([\\s\\S]*?)<\\/[^>]*:?${tag}>`, "i");
  const m = String(block || "").match(re);
  return m ? xmlUnescape(m[1].trim()) : "";
}

function isWebdavCollection(block) {
  return /<[^>]*:?collection\s*\/?>/i.test(String(block || ""));
}

function normalizeDavPath(p) {
  if (!p || p === "/") return "/";
  const clean = String(p).replace(/^\/+|\/+$/g, "").replace(/\/+/g, "/");
  return clean ? "/" + clean : "/";
}

function joinDavPath(base, name) {
  const b = normalizeDavPath(base || "/").replace(/\/+$/, "");
  return normalizeDavPath((b || "") + "/" + String(name || "").replace(/^\/+/, ""));
}

function encodeDavPath(p) {
  const clean = normalizeDavPath(p);
  if (clean === "/") return "/";
  return "/" + clean.split("/").filter(Boolean).map(seg => encodeURIComponent(seg)).join("/");
}

function buildWebdavUrl(account, remotePath) {
  const base = String(account.base_url || "").replace(/\/+$/, "");
  const root = normalizeDavPath(account.root || "/");
  let p = normalizeDavPath(remotePath || root || "/");

  if (root !== "/" && !p.startsWith(root + "/") && p !== root) {
    p = joinDavPath(root, p);
  }

  return base + encodeDavPath(p);
}

function basicAuthHeader(account) {
  const raw = `${account.username || ""}:${account.password || ""}`;
  return "Basic " + Buffer.from(raw, "utf8").toString("base64");
}

function md5Hex(value) {
  return crypto.createHash("md5").update(value).digest("hex");
}

function parseDigestChallenge(header) {
  const raw = String(header || "").replace(/^Digest\s+/i, "");
  const out = {};
  const re = /(\w+)=("([^"]*)"|([^,\s]+))/g;
  let m;
  while ((m = re.exec(raw))) {
    out[m[1]] = m[3] !== undefined ? m[3] : m[4];
  }
  return out;
}

function buildDigestAuthHeader({ account, method, url, challenge }) {
  const parsedUrl = new URL(url);
  const uri = parsedUrl.pathname + parsedUrl.search;
  const username = account.username || "";
  const password = account.password || "";
  const realm = challenge.realm || "";
  const nonce = challenge.nonce || "";
  const qopRaw = challenge.qop || "";
  const qop = qopRaw.split(",").map(x => x.trim()).includes("auth") ? "auth" : "";
  const algorithm = (challenge.algorithm || "MD5").toUpperCase();
  const opaque = challenge.opaque;
  const nc = "00000001";
  const cnonce = crypto.randomBytes(8).toString("hex");

  let ha1 = md5Hex(`${username}:${realm}:${password}`);
  if (algorithm === "MD5-SESS") {
    ha1 = md5Hex(`${ha1}:${nonce}:${cnonce}`);
  }

  const ha2 = md5Hex(`${method}:${uri}`);
  const response = qop
    ? md5Hex(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : md5Hex(`${ha1}:${nonce}:${ha2}`);

  const safe = (s) => String(s || "").replace(/"/g, '\\"');
  const parts = [
    `username="${safe(username)}"`,
    `realm="${safe(realm)}"`,
    `nonce="${safe(nonce)}"`,
    `uri="${safe(uri)}"`,
    `response="${response}"`,
    `algorithm=${algorithm}`
  ];

  if (opaque) parts.push(`opaque="${safe(opaque)}"`);
  if (qop) {
    parts.push(`qop=${qop}`);
    parts.push(`nc=${nc}`);
    parts.push(`cnonce="${cnonce}"`);
  }

  return "Digest " + parts.join(", ");
}

async function webdavRequest(account, method, remotePath, opts = {}) {
  const url = buildWebdavUrl(account, remotePath);
  const baseHeaders = { ...(opts.headers || {}) };

  const timeoutMs = Number(account.timeout_ms || 20000);
  let controller = new AbortController();
  let timer = setTimeout(() => controller.abort(), timeoutMs);

  let headers = {
    ...baseHeaders,
    "Authorization": basicAuthHeader(account)
  };

  let r;

  try {
    r = await fetch(url, {
      method,
      headers,
      body: opts.body,
      signal: controller.signal
    });
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`WebDAV ${method} timeout tras ${Math.round(timeoutMs / 1000)} s. Revisa URL, ruta raíz o si el servidor está respondiendo.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (r.status === 401) {
    const www = r.headers.get("www-authenticate") || "";
    if (/Digest/i.test(www)) {
      const challenge = parseDigestChallenge(www);
      controller = new AbortController();
      timer = setTimeout(() => controller.abort(), timeoutMs);

      headers = {
        ...baseHeaders,
        "Authorization": buildDigestAuthHeader({ account, method, url, challenge })
      };

      try {
        r = await fetch(url, {
          method,
          headers,
          body: opts.body,
          signal: controller.signal
        });
      } catch (err) {
        if (err.name === "AbortError") {
          throw new Error(`WebDAV ${method} timeout Digest tras ${Math.round(timeoutMs / 1000)} s.`);
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
    }
  }

  if (!r.ok && ![207, 201, 204].includes(r.status)) {
    const authInfo = r.headers.get("www-authenticate") || "";
    const text = await r.text().catch(() => "");
    const detail = authInfo ? ` · Auth requerido: ${authInfo.slice(0, 160)}` : "";
    throw new Error(`WebDAV ${method} ${r.status}: ${text.slice(0, 300)}${detail}`);
  }

  return r;
}

function parseWebdavList(xml, currentPath) {
  const responses = String(xml || "").match(/<[^>]*:?response[\s\S]*?<\/[^>]*:?response>/gi) || [];
  const current = normalizeDavPath(currentPath || "/");
  const out = [];

  for (const block of responses) {
    const hrefRaw = xmlTag(block, "href");
    let name = decodeURIComponent(String(hrefRaw || "").split("?")[0].replace(/\/+$/, "").split("/").pop() || "");
    const isDir = isWebdavCollection(block);
    const size = Number(xmlTag(block, "getcontentlength") || 0);
    const modified = xmlTag(block, "getlastmodified");

    if (!name) continue;

    const lastCurrent = current.split("/").filter(Boolean).pop();
    if (lastCurrent && name === lastCurrent) continue;

    const pathValue = joinDavPath(current, name);

    out.push({
      id: pathValue,
      name,
      type: isDir ? "folder" : "file",
      path: pathValue,
      size: isDir ? 0 : size,
      modified
    });
  }

  return out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, "es") : a.type === "folder" ? -1 : 1));
}

async function webdavList(account, remotePath) {
  const pathValue = normalizeDavPath(remotePath || account.root || "/");
  const body = `<?xml version="1.0" encoding="utf-8" ?><propfind xmlns="DAV:"><allprop/></propfind>`;
  const r = await webdavRequest(account, "PROPFIND", pathValue, {
    headers: {
      "Depth": "1",
      "Content-Type": "application/xml; charset=utf-8"
    },
    body
  });
  const xml = await r.text();
  return parseWebdavList(xml, pathValue);
}

async function webdavDownload(account, remotePath) {
  const r = await webdavRequest(account, "GET", remotePath);
  return Buffer.from(await r.arrayBuffer());
}

async function webdavUpload(account, remotePath, buffer) {
  if (account.mode === "ro") throw new Error("Cuenta en solo lectura");
  const r = await webdavRequest(account, "PUT", remotePath, {
    headers: { "Content-Type": "application/octet-stream" },
    body: buffer
  });
  return { ok: true, status: r.status };
}

async function webdavMkdir(account, remotePath) {
  if (account.mode === "ro") throw new Error("Cuenta en solo lectura");
  const r = await webdavRequest(account, "MKCOL", remotePath);
  return { ok: true, status: r.status };
}

async function webdavDelete(account, remotePath) {
  if (account.mode === "ro") throw new Error("Cuenta en solo lectura");
  const r = await webdavRequest(account, "DELETE", remotePath);
  return { ok: true, status: r.status };
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
        url: data.url || data.web_url || "",
        username: data.username || "",
        password: data.password || "",
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
        url: data.url !== undefined ? data.url : state.remoteConnections[idx].url,
        username: data.username !== undefined ? data.username : state.remoteConnections[idx].username,
        password: data.password !== undefined ? data.password : state.remoteConnections[idx].password,
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


  if (pathname === "/api/ftp/download" && req.method === "GET") {
    const fullUrl = new URL(req.url, `http://${req.headers.host}`);
    const account = getFtpAccount(fullUrl.searchParams.get("account_id"));
    const remotePath = fullUrl.searchParams.get("path");
    if (!account) return sendJson(res, 404, { ok: false, error: "Cuenta FTP no encontrada" });
    const buffer = await ftpDownloadBuffer(account, remotePath);
    const filename = path.basename(remotePath || "archivo");
    res.writeHead(200, {
      "Content-Type": getMime(filename),
      "Content-Disposition": `attachment; filename="${encodeURIComponent(filename)}"`,
      "Cache-Control": "no-store"
    });
    return res.end(buffer);
  }


  if (pathname === "/api/docs") {
    if (req.method === "GET") return sendJson(res, 200, state.docs || []);
    if (req.method === "POST") {
      const data = await readJson(req);
      const doc = {
        id: newId("doc"),
        title: data.title || "Sin título",
        html: data.html || "",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      state.docs ||= [];
      state.docs.unshift(doc);
      saveState(state);
      return sendJson(res, 200, doc);
    }
  }

  if (pathname.startsWith("/api/docs/")) {
    const id = decodeURIComponent(pathname.split("/").pop());
    state.docs ||= [];
    const idx = state.docs.findIndex(d => d.id === id);
    if (idx === -1) return sendJson(res, 404, { ok: false, error: "Documento no encontrado" });

    if (req.method === "GET") return sendJson(res, 200, state.docs[idx]);

    if (req.method === "PUT" || req.method === "PATCH") {
      const data = await readJson(req);
      state.docs[idx] = {
        ...state.docs[idx],
        title: data.title || state.docs[idx].title,
        html: data.html !== undefined ? data.html : state.docs[idx].html,
        updated_at: new Date().toISOString()
      };
      saveState(state);
      return sendJson(res, 200, state.docs[idx]);
    }

    if (req.method === "DELETE") {
      const removed = state.docs.splice(idx, 1)[0];
      saveState(state);
      return sendJson(res, 200, removed);
    }
  }

  if (pathname === "/api/ftp/accounts") {
    state.ftpAccounts ||= [];

    if (req.method === "GET") return sendJson(res, 200, state.ftpAccounts);

    if (req.method === "POST") {
      const data = await readJson(req);
      const account = {
        id: newId("ftp"),
        name: data.name || data.host || "Servidor FTP",
        host: data.host || "",
        port: Number(data.port || 21),
        username: data.username || "anonymous",
        password: data.password || "",
        initial_path: data.initial_path || "/",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      state.ftpAccounts.push(account);
      saveState(state);
      return sendJson(res, 200, account);
    }
  }

  if (pathname.startsWith("/api/ftp/accounts/")) {
    const id = decodeURIComponent(pathname.split("/").pop());
    state.ftpAccounts ||= [];
    const idx = state.ftpAccounts.findIndex(a => a.id === id);
    if (idx === -1) return sendJson(res, 404, { ok: false, error: "Cuenta FTP no encontrada" });

    if (req.method === "PUT" || req.method === "PATCH") {
      const data = await readJson(req);
      state.ftpAccounts[idx] = {
        ...state.ftpAccounts[idx],
        name: data.name || state.ftpAccounts[idx].name,
        host: data.host !== undefined ? data.host : state.ftpAccounts[idx].host,
        port: data.port !== undefined ? Number(data.port) : state.ftpAccounts[idx].port,
        username: data.username !== undefined ? data.username : state.ftpAccounts[idx].username,
        password: data.password !== undefined ? data.password : state.ftpAccounts[idx].password,
        initial_path: data.initial_path !== undefined ? data.initial_path : state.ftpAccounts[idx].initial_path,
        updated_at: new Date().toISOString()
      };
      saveState(state);
      return sendJson(res, 200, state.ftpAccounts[idx]);
    }

    if (req.method === "DELETE") {
      const removed = state.ftpAccounts.splice(idx, 1)[0];
      saveState(state);
      return sendJson(res, 200, removed);
    }
  }

  if (pathname === "/api/ftp/list" && req.method === "POST") {
    const data = await readJson(req);
    const account = getFtpAccount(data.account_id);
    if (!account) return sendJson(res, 404, { ok: false, error: "Cuenta FTP no encontrada" });
    const items = await ftpList(account, data.path || account.initial_path || "/");
    return sendJson(res, 200, { ok: true, items });
  }

  if (pathname === "/api/ftp/upload" && req.method === "POST") {
    const data = await readJson(req);
    const account = getFtpAccount(data.account_id);
    if (!account) return sendJson(res, 404, { ok: false, error: "Cuenta FTP no encontrada" });
    const buffer = Buffer.from(String(data.data_base64 || ""), "base64");
    if (buffer.length > 12 * 1024 * 1024) return sendJson(res, 413, { ok: false, error: "Archivo demasiado grande. Máximo 12 MB." });
    await ftpUploadBuffer(account, data.path, buffer);
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === "/api/ftp/mkdir" && req.method === "POST") {
    const data = await readJson(req);
    const account = getFtpAccount(data.account_id);
    if (!account) return sendJson(res, 404, { ok: false, error: "Cuenta FTP no encontrada" });
    await ftpSimpleCommand(account, "MKD " + data.path);
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === "/api/ftp/delete" && req.method === "POST") {
    const data = await readJson(req);
    const account = getFtpAccount(data.account_id);
    if (!account) return sendJson(res, 404, { ok: false, error: "Cuenta FTP no encontrada" });
    await ftpSimpleCommand(account, (data.type === "dir" ? "RMD " : "DELE ") + data.path);
    return sendJson(res, 200, { ok: true });
  }


  if (pathname === "/api/cloud-drive/accounts") {
    state.cloudDriveAccounts ||= [];
    if (req.method === "GET") return sendJson(res, 200, state.cloudDriveAccounts);
    if (req.method === "POST") {
      const data = await readJson(req);
      const account = { id:newId("drive"), provider:data.provider || "dropbox", name:data.name || data.provider || "Cloud Drive", token:data.token || "", region:data.region || "eu", root:data.root || "/", mode:data.mode || "rw", created_at:new Date().toISOString(), updated_at:new Date().toISOString() };
      state.cloudDriveAccounts.push(account);
      saveState(state);
      return sendJson(res, 200, account);
    }
  }

  if (pathname.startsWith("/api/cloud-drive/accounts/")) {
    const id = decodeURIComponent(pathname.split("/").pop());
    state.cloudDriveAccounts ||= [];
    const idx = state.cloudDriveAccounts.findIndex(a => a.id === id);
    if (idx === -1) return sendJson(res, 404, { ok:false, error:"Cuenta cloud no encontrada" });
    if (req.method === "PUT" || req.method === "PATCH") {
      const data = await readJson(req);
      state.cloudDriveAccounts[idx] = {...state.cloudDriveAccounts[idx], provider:data.provider || state.cloudDriveAccounts[idx].provider, name:data.name || state.cloudDriveAccounts[idx].name, token:data.token !== undefined ? data.token : state.cloudDriveAccounts[idx].token, region:data.region || state.cloudDriveAccounts[idx].region, root:data.root !== undefined ? data.root : state.cloudDriveAccounts[idx].root, mode:data.mode || state.cloudDriveAccounts[idx].mode, updated_at:new Date().toISOString()};
      saveState(state);
      return sendJson(res, 200, state.cloudDriveAccounts[idx]);
    }
    if (req.method === "DELETE") {
      const removed = state.cloudDriveAccounts.splice(idx, 1)[0];
      saveState(state);
      return sendJson(res, 200, removed);
    }
  }

  if (pathname === "/api/cloud-drive/list" && req.method === "POST") {
    const data = await readJson(req);
    const account = getCloudDriveAccount(data.account_id);
    if (!account) return sendJson(res, 404, { ok:false, error:"Cuenta cloud no encontrada" });
    const items = await cloudDriveList(account, data.path || account.root || "/");
    return sendJson(res, 200, { ok:true, items });
  }

  if (pathname === "/api/cloud-drive/download" && req.method === "GET") {
    const fullUrl = new URL(req.url, `http://${req.headers.host}`);
    const account = getCloudDriveAccount(fullUrl.searchParams.get("account_id"));
    if (!account) return sendJson(res, 404, { ok:false, error:"Cuenta cloud no encontrada" });
    const id = fullUrl.searchParams.get("id");
    const filePath = fullUrl.searchParams.get("path");
    const buffer = await cloudDriveDownload(account, id, filePath);
    const filename = path.basename(filePath || id || "archivo");
    res.writeHead(200, {"Content-Type":getMime(filename), "Content-Disposition":`inline; filename="${encodeURIComponent(filename)}"`, "Cache-Control":"no-store"});
    return res.end(buffer);
  }

  if (pathname === "/api/cloud-drive/mkdir" && req.method === "POST") {
    const data = await readJson(req);
    const account = getCloudDriveAccount(data.account_id);
    if (!account) return sendJson(res, 404, { ok:false, error:"Cuenta cloud no encontrada" });
    const result = await cloudDriveMkdir(account, data.path || account.root || "/", data.name);
    return sendJson(res, 200, { ok:true, result });
  }

  if (pathname === "/api/cloud-drive/upload" && req.method === "POST") {
    const data = await readJson(req);
    const account = getCloudDriveAccount(data.account_id);
    if (!account) return sendJson(res, 404, { ok:false, error:"Cuenta cloud no encontrada" });
    const buffer = Buffer.from(String(data.data_base64 || ""), "base64");
    if (buffer.length > 12 * 1024 * 1024) return sendJson(res, 413, { ok:false, error:"Archivo demasiado grande. Máximo 12 MB." });
    const result = await cloudDriveUpload(account, data.path || account.root || "/", data.name, buffer);
    return sendJson(res, 200, { ok:true, result });
  }


  /* WEBDAV DRIVES */

  if (pathname === "/api/webdav/accounts") {
    state.webdavAccounts ||= [];

    if (req.method === "GET") return sendJson(res, 200, state.webdavAccounts);

    if (req.method === "POST") {
      const data = await readJson(req);

      const account = {
        id: newId("webdav"),
        provider: data.provider || "custom",
        name: data.name || data.provider || "WebDAV",
        base_url: data.base_url || data.url || "",
        username: data.username || "",
        password: data.password || "",
        root: data.root || "/",
        mode: data.mode || "rw",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };

      state.webdavAccounts.push(account);
      saveState(state);

      return sendJson(res, 200, account);
    }
  }

  if (pathname.startsWith("/api/webdav/accounts/")) {
    const id = decodeURIComponent(pathname.split("/").pop());
    state.webdavAccounts ||= [];
    const idx = state.webdavAccounts.findIndex(a => a.id === id);

    if (idx === -1) return sendJson(res, 404, { ok: false, error: "Cuenta WebDAV no encontrada" });

    if (req.method === "PUT" || req.method === "PATCH") {
      const data = await readJson(req);

      state.webdavAccounts[idx] = {
        ...state.webdavAccounts[idx],
        provider: data.provider || state.webdavAccounts[idx].provider,
        name: data.name || state.webdavAccounts[idx].name,
        base_url: data.base_url !== undefined ? data.base_url : state.webdavAccounts[idx].base_url,
        username: data.username !== undefined ? data.username : state.webdavAccounts[idx].username,
        password: data.password !== undefined ? data.password : state.webdavAccounts[idx].password,
        root: data.root !== undefined ? data.root : state.webdavAccounts[idx].root,
        mode: data.mode || state.webdavAccounts[idx].mode,
        updated_at: new Date().toISOString()
      };

      saveState(state);
      return sendJson(res, 200, state.webdavAccounts[idx]);
    }

    if (req.method === "DELETE") {
      const removed = state.webdavAccounts.splice(idx, 1)[0];
      saveState(state);
      return sendJson(res, 200, removed);
    }
  }

  if (pathname === "/api/webdav/test" && req.method === "POST") {
    const data = await readJson(req);
    const account = getWebdavAccount(data.account_id);
    if (!account) return sendJson(res, 404, { ok: false, error: "Cuenta WebDAV no encontrada" });
    const items = await webdavList(account, account.root || "/");
    return sendJson(res, 200, { ok: true, count: items.length });
  }

  if (pathname === "/api/webdav/list" && req.method === "POST") {
    const data = await readJson(req);
    const account = getWebdavAccount(data.account_id);
    if (!account) return sendJson(res, 404, { ok: false, error: "Cuenta WebDAV no encontrada" });
    const items = await webdavList(account, data.path || account.root || "/");
    return sendJson(res, 200, { ok: true, items });
  }

  if (pathname === "/api/webdav/download" && req.method === "GET") {
    const fullUrl = new URL(req.url, `http://${req.headers.host}`);
    const account = getWebdavAccount(fullUrl.searchParams.get("account_id"));
    const remotePath = fullUrl.searchParams.get("path");
    if (!account) return sendJson(res, 404, { ok: false, error: "Cuenta WebDAV no encontrada" });

    const buffer = await webdavDownload(account, remotePath);
    const filename = path.basename(remotePath || "archivo");

    res.writeHead(200, {
      "Content-Type": getMime(filename),
      "Content-Disposition": `inline; filename="${encodeURIComponent(filename)}"`,
      "Cache-Control": "no-store"
    });

    return res.end(buffer);
  }

  if (pathname === "/api/webdav/upload" && req.method === "POST") {
    const data = await readJson(req);
    const account = getWebdavAccount(data.account_id);
    if (!account) return sendJson(res, 404, { ok: false, error: "Cuenta WebDAV no encontrada" });

    const base = normalizeDavPath(data.path || account.root || "/");
    const remotePath = joinDavPath(base, data.name);
    const buffer = Buffer.from(String(data.data_base64 || ""), "base64");

    if (buffer.length > 30 * 1024 * 1024) {
      return sendJson(res, 413, { ok: false, error: "Archivo demasiado grande. Máximo 30 MB." });
    }

    const result = await webdavUpload(account, remotePath, buffer);
    return sendJson(res, 200, { ok: true, result });
  }

  if (pathname === "/api/webdav/mkdir" && req.method === "POST") {
    const data = await readJson(req);
    const account = getWebdavAccount(data.account_id);
    if (!account) return sendJson(res, 404, { ok: false, error: "Cuenta WebDAV no encontrada" });

    const remotePath = joinDavPath(data.path || account.root || "/", data.name);
    const result = await webdavMkdir(account, remotePath);
    return sendJson(res, 200, { ok: true, result });
  }

  if (pathname === "/api/webdav/delete" && req.method === "POST") {
    const data = await readJson(req);
    const account = getWebdavAccount(data.account_id);
    if (!account) return sendJson(res, 404, { ok: false, error: "Cuenta WebDAV no encontrada" });

    const result = await webdavDelete(account, data.path);
    return sendJson(res, 200, { ok: true, result });
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
