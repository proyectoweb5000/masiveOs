const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");

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
      theme: "dark"
    },
    icons: [
      {
        id: "browser",
        title: "Navegador",
        icon: "🌐",
        type: "browser",
        target: "https://www.google.com",
        x: 40,
        y: 40
      },
      {
        id: "files",
        title: "Archivos",
        icon: "📁",
        type: "module",
        target: "files",
        x: 160,
        y: 40
      },
      {
        id: "cloud",
        title: "Nube",
        icon: "☁️",
        type: "module",
        target: "cloud",
        x: 280,
        y: 40
      },
      {
        id: "meteo",
        title: "Meteo & Radio",
        icon: "📡",
        type: "module",
        target: "meteo",
        x: 400,
        y: 40
      },
      {
        id: "remote",
        title: "Ayuda remota",
        icon: "🖥️",
        type: "module",
        target: "remote",
        x: 520,
        y: 40
      },
      {
        id: "settings",
        title: "Configuración",
        icon: "⚙️",
        type: "module",
        target: "settings",
        x: 640,
        y: 40
      }
    ],
    files: [],
    cloudAccounts: [],
    remoteConnections: []
  };
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
    return {
      ...defaultState(),
      ...parsed,
      config: { ...defaultState().config, ...(parsed.config || {}) },
      icons: Array.isArray(parsed.icons) ? parsed.icons : defaultState().icons,
      files: Array.isArray(parsed.files) ? parsed.files : [],
      cloudAccounts: Array.isArray(parsed.cloudAccounts) ? parsed.cloudAccounts : [],
      remoteConnections: Array.isArray(parsed.remoteConnections) ? parsed.remoteConnections : []
    };
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

function sendJson(res, status, data, extraHeaders = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...extraHeaders
  });
  res.end(JSON.stringify(data));
}

function sendText(res, status, text) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const out = {};
  header.split(";").forEach(part => {
    const idx = part.indexOf("=");
    if (idx > -1) {
      const key = part.slice(0, idx).trim();
      const value = part.slice(idx + 1).trim();
      out[key] = decodeURIComponent(value);
    }
  });
  return out;
}

function getSession(req) {
  const cookies = parseCookies(req);
  const sid = cookies.ea1fjz_os_sid;
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
      if (body.length > 20 * 1024 * 1024) {
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
  try {
    return JSON.parse(body);
  } catch {
    return {};
  }
}

function getMime(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".txt": "text/plain; charset=utf-8",
    ".pdf": "application/pdf"
  };
  return map[ext] || "application/octet-stream";
}

function serveStatic(req, res, pathname) {
  let filePath = pathname === "/" ? path.join(PUBLIC_DIR, "index.html") : path.join(PUBLIC_DIR, pathname);

  const normalized = path.normalize(filePath);
  if (!normalized.startsWith(PUBLIC_DIR)) {
    sendText(res, 403, "Forbidden");
    return;
  }

  if (!fs.existsSync(normalized) || fs.statSync(normalized).isDirectory()) {
    sendText(res, 404, "Not found");
    return;
  }

  res.writeHead(200, {
    "Content-Type": getMime(normalized),
    "Cache-Control": "no-store"
  });
  fs.createReadStream(normalized).pipe(res);
}

function newId(prefix = "id") {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(6).toString("hex")}`;
}

async function handleApi(req, res, pathname) {
  if (pathname === "/api/health") {
    return sendJson(res, 200, {
      ok: true,
      service: "EA1FJZ Cloud OS",
      dbPath: DATABASE_PATH,
      uploadsPath: UPLOADS_PATH,
      node: process.version,
      persistent: DATABASE_PATH.startsWith("/var/data")
    });
  }

  if (pathname === "/api/login" && req.method === "POST") {
    const data = await readJson(req);
    const password = data.password || data.pass || "";

    if (password !== ADMIN_PASSWORD) {
      return sendJson(res, 401, { ok: false, error: "Contraseña incorrecta" });
    }

    const sid = crypto.randomBytes(32).toString("hex");
    sessions.set(sid, {
      user: "admin",
      created: Date.now(),
      expires: Date.now() + 1000 * 60 * 60 * 12
    });

    return sendJson(
      res,
      200,
      { ok: true, user: "admin" },
      {
        "Set-Cookie": `ea1fjz_os_sid=${encodeURIComponent(sid)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200`
      }
    );
  }

  if (pathname === "/api/logout" && (req.method === "POST" || req.method === "GET")) {
    const cookies = parseCookies(req);
    if (cookies.ea1fjz_os_sid) sessions.delete(cookies.ea1fjz_os_sid);
    return sendJson(
      res,
      200,
      { ok: true },
      { "Set-Cookie": "ea1fjz_os_sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0" }
    );
  }

  if (pathname === "/api/session") {
    const session = getSession(req);
    return sendJson(res, 200, {
      ok: !!session,
      authenticated: !!session,
      user: session ? session.user : null
    });
  }

  if (!requireAuth(req, res)) return;

  if (pathname === "/api/config") {
    if (req.method === "GET") {
      return sendJson(res, 200, state.config);
    }
    if (req.method === "POST" || req.method === "PUT") {
      const data = await readJson(req);
      state.config = { ...state.config, ...data };
      saveState(state);
      return sendJson(res, 200, state.config);
    }
  }

  if (pathname === "/api/icons") {
    if (req.method === "GET") {
      return sendJson(res, 200, state.icons);
    }
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

  if (pathname === "/api/files") {
    if (req.method === "GET") {
      return sendJson(res, 200, state.files);
    }
    if (req.method === "POST") {
      return sendJson(res, 501, {
        ok: false,
        error: "Subida avanzada pendiente en esta versión no-deps. Usa el módulo de configuración o enlaces externos por ahora."
      });
    }
  }

  if (pathname.startsWith("/api/files/download/")) {
    const id = decodeURIComponent(pathname.split("/").pop());
    const file = state.files.find(f => f.id === id);
    if (!file) return sendJson(res, 404, { ok: false, error: "Archivo no encontrado" });

    const filePath = path.join(UPLOADS_PATH, file.stored_name || file.name);
    if (!fs.existsSync(filePath)) return sendJson(res, 404, { ok: false, error: "Archivo físico no encontrado" });

    res.writeHead(200, {
      "Content-Type": getMime(filePath),
      "Content-Disposition": `attachment; filename="${encodeURIComponent(file.original_name || file.name)}"`
    });
    return fs.createReadStream(filePath).pipe(res);
  }

  if (pathname === "/api/cloud/accounts") {
    if (req.method === "GET") {
      return sendJson(res, 200, state.cloudAccounts);
    }
    if (req.method === "POST") {
      const data = await readJson(req);
      const account = {
        id: data.id || newId("cloud"),
        provider: data.provider || "custom",
        display_name: data.display_name || data.name || "Cuenta nube",
        auth_type: data.auth_type || "token",
        enabled: data.enabled !== false,
        config: data.config || {}
      };
      state.cloudAccounts.push(account);
      saveState(state);
      return sendJson(res, 200, account);
    }
  }

  if (pathname === "/api/remote/connections") {
    if (req.method === "GET") {
      return sendJson(res, 200, state.remoteConnections);
    }
    if (req.method === "POST") {
      const data = await readJson(req);
      const conn = {
        id: data.id || newId("remote"),
        name: data.name || "Equipo remoto",
        protocol: data.protocol || "external",
        host: data.host || "",
        port: data.port || "",
        username: data.username || "",
        enabled: data.enabled !== false
      };
      state.remoteConnections.push(conn);
      saveState(state);
      return sendJson(res, 200, conn);
    }
  }

  if (pathname === "/api/password" && req.method === "POST") {
    const data = await readJson(req);
    return sendJson(res, 200, {
      ok: false,
      error: "En esta versión la contraseña se cambia desde la variable ADMIN_PASSWORD de Render."
    });
  }

  if (pathname === "/api/backup") {
    return sendJson(res, 200, {
      ok: true,
      database: state,
      exported_at: new Date().toISOString()
    });
  }

  return sendJson(res, 404, { ok: false, error: "Ruta API no encontrada", path: pathname });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = decodeURIComponent(url.pathname);

    if (pathname.startsWith("/api/")) {
      return await handleApi(req, res, pathname);
    }

    return serveStatic(req, res, pathname);
  } catch (err) {
    console.error(err);
    return sendJson(res, 500, { ok: false, error: err.message || "Error interno" });
  }
});

server.listen(PORT, () => {
  console.log(`EA1FJZ Cloud OS escuchando en puerto ${PORT}`);
  console.log(`DB: ${DATABASE_PATH}`);
  console.log(`Uploads: ${UPLOADS_PATH}`);
});
