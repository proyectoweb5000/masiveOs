'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const DB_PATH = process.env.DATABASE_PATH || process.env.DB_PATH || path.join(DATA_DIR, 'ea1fjz_cloud_os.json');
const UPLOADS_DIR = process.env.UPLOADS_PATH || path.join(DATA_DIR, 'uploads');
const COOKIE_NAME = 'ea1fjz_os_session';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'cambiar1234';

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const mime = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.pdf':'application/pdf'
};

function now(){ return new Date().toISOString(); }
function safeId(){ return crypto.randomBytes(8).toString('hex'); }
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')){
  const hash = crypto.pbkdf2Sync(String(password), salt, 120000, 32, 'sha256').toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored){
  const [salt, hash] = String(stored || '').split(':');
  if(!salt || !hash) return false;
  const test = crypto.pbkdf2Sync(String(password), salt, 120000, 32, 'sha256').toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(test));
}
function sign(value){ return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('hex'); }
function makeCookie(user){
  const payload = Buffer.from(JSON.stringify({ user, ts: Date.now() })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}
function parseCookies(req){
  return Object.fromEntries(String(req.headers.cookie || '').split(';').map(x=>x.trim()).filter(Boolean).map(x=>{ const i=x.indexOf('='); return [x.slice(0,i), decodeURIComponent(x.slice(i+1))]; }));
}
function getSession(req){
  const token = parseCookies(req)[COOKIE_NAME];
  if(!token || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  if(sig !== sign(payload)) return null;
  try { return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return null; }
}
function send(res, code, data, headers={}){
  const body = Buffer.isBuffer(data) ? data : (typeof data === 'string' ? data : JSON.stringify(data));
  res.writeHead(code, { 'Content-Type': Buffer.isBuffer(data) ? 'application/octet-stream' : (headers['Content-Type'] || 'application/json; charset=utf-8'), ...headers });
  res.end(body);
}
function sendJson(res, code, obj){ send(res, code, JSON.stringify(obj), {'Content-Type':'application/json; charset=utf-8'}); }
function notFound(res){ sendJson(res, 404, { ok:false, error:'No encontrado' }); }
function bad(res, msg, code=400){ sendJson(res, code, { ok:false, error:msg }); }
function readBody(req){
  return new Promise((resolve, reject)=>{
    const chunks=[]; let size=0;
    req.on('data', c=>{ size+=c.length; if(size>50*1024*1024){ reject(new Error('Payload demasiado grande')); req.destroy(); } else chunks.push(c); });
    req.on('end', ()=>resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req){
  const raw = await readBody(req);
  if(!raw.length) return {};
  return JSON.parse(raw.toString('utf8'));
}
function defaultDb(){
  return {
    users:[{ id:1, username:'admin', password_hash:hashPassword(ADMIN_PASSWORD), role:'admin', created_at:now(), last_login:null }],
    system_config:{
      title:'EA1FJZ Cloud OS', subtitle:'Sistema operativo web privado para dashboards, nube, meteo/radio y ayuda remota.',
      wallpaper:'linear-gradient(135deg,#0f172a,#1e1b4b 45%,#0b1120)', accent:'#7c3aed'
    },
    desktop_icons:[
      {id:1,title:'Navegador',icon:'🌐',type:'browser',target:'https://www.google.com',x:36,y:60,width:120,height:92,visible:1},
      {id:2,title:'Meteo & Radio',icon:'📡',type:'iframe',target:'https://www.windy.com',x:36,y:170,width:120,height:92,visible:1},
      {id:3,title:'DSN Now',icon:'🛰️',type:'iframe',target:'https://eyes.nasa.gov/apps/dsn-now/dsn.html',x:36,y:280,width:120,height:92,visible:1},
      {id:4,title:'Gestor archivos',icon:'🗂️',type:'files',target:'',x:36,y:390,width:120,height:92,visible:1},
      {id:5,title:'Nube',icon:'☁️',type:'cloud',target:'',x:180,y:60,width:120,height:92,visible:1},
      {id:6,title:'Ayuda remota',icon:'🖥️',type:'remote',target:'',x:180,y:170,width:120,height:92,visible:1},
      {id:7,title:'Configuración',icon:'⚙️',type:'settings',target:'',x:180,y:280,width:120,height:92,visible:1}
    ],
    files:[], cloud_accounts:[], remote_connections:[], _seq:{icons:8,files:1,cloud:1,remote:1}
  };
}
function loadDb(){
  if(!fs.existsSync(DB_PATH)){ const db=defaultDb(); saveDb(db); return db; }
  try { return JSON.parse(fs.readFileSync(DB_PATH,'utf8')); }
  catch(e){ const backup = DB_PATH+'.corrupt-'+Date.now(); try{fs.copyFileSync(DB_PATH, backup)}catch{}; const db=defaultDb(); saveDb(db); return db; }
}
function saveDb(db){ fs.writeFileSync(DB_PATH, JSON.stringify(db,null,2)); }
function nextId(db, key){ db._seq = db._seq || {}; const v = db._seq[key] || 1; db._seq[key] = v + 1; return v; }
function requireAuth(req, res){ const s=getSession(req); if(!s || !s.user) { bad(res,'No autorizado',401); return null; } return s; }
function cleanFileName(name){ return path.basename(String(name||'archivo')).replace(/[^a-zA-Z0-9._ -]/g,'_').slice(0,160) || 'archivo'; }
function parseMultipart(buffer, contentType){
  const match = /boundary=(.+)$/i.exec(contentType || ''); if(!match) return null;
  const boundary = Buffer.from('--' + match[1]);
  const parts=[]; let start = buffer.indexOf(boundary);
  while(start !== -1){
    start += boundary.length;
    if(buffer[start]===45 && buffer[start+1]===45) break;
    if(buffer[start]===13 && buffer[start+1]===10) start += 2;
    const headerEnd = buffer.indexOf(Buffer.from('\r\n\r\n'), start); if(headerEnd<0) break;
    const headers = buffer.slice(start, headerEnd).toString('utf8');
    let dataStart = headerEnd + 4;
    let next = buffer.indexOf(boundary, dataStart); if(next<0) break;
    let dataEnd = next - 2; // remove CRLF
    const cd = /content-disposition:[^\n]*name="([^"]+)"(?:;\s*filename="([^"]*)")?/i.exec(headers);
    const ct = /content-type:\s*([^\r\n]+)/i.exec(headers);
    parts.push({ name:cd?.[1], filename:cd?.[2], contentType:ct?.[1], data:buffer.slice(dataStart, dataEnd) });
    start = next;
  }
  return parts;
}

async function handleApi(req, res, pathname){
  const db = loadDb();
  try{
    if(req.method==='POST' && pathname==='/api/login'){
      const body = await readJson(req); const user = db.users.find(u=>u.username===body.username);
      if(!user || !verifyPassword(body.password, user.password_hash)) return bad(res,'Usuario o contraseña incorrectos',401);
      user.last_login = now(); saveDb(db);
      sendJson(res,200,{ok:true,user:{username:user.username,role:user.role}}, {'Set-Cookie': `${COOKIE_NAME}=${makeCookie(user.username)}; Path=/; HttpOnly; SameSite=Lax`});
      return;
    }
    if(req.method==='POST' && pathname==='/api/logout'){
      res.writeHead(200, {'Content-Type':'application/json; charset=utf-8','Set-Cookie':`${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`}); res.end(JSON.stringify({ok:true})); return;
    }
    if(pathname==='/api/health') return sendJson(res,200,{ok:true,mode:'no-deps-json-persistence',dbPath:DB_PATH,uploadsPath:UPLOADS_DIR,writable:true,time:now()});
    const session = requireAuth(req,res); if(!session) return;
    if(req.method==='GET' && pathname==='/api/session') return sendJson(res,200,{ok:true,user:{username:session.user,role:'admin'}});
    if(req.method==='POST' && pathname==='/api/change-password'){
      const body=await readJson(req); const u=db.users.find(x=>x.username===session.user);
      if(!u || !verifyPassword(body.oldPassword, u.password_hash)) return bad(res,'Contraseña actual incorrecta',403);
      if(!body.newPassword || String(body.newPassword).length<6) return bad(res,'La nueva contraseña debe tener al menos 6 caracteres');
      u.password_hash=hashPassword(body.newPassword); saveDb(db); return sendJson(res,200,{ok:true});
    }
    if(req.method==='GET' && pathname==='/api/config') return sendJson(res,200,{ok:true,config:db.system_config||{}});
    if(req.method==='POST' && pathname==='/api/config'){
      const body=await readJson(req); db.system_config={...(db.system_config||{}), ...(body.config||body)}; saveDb(db); return sendJson(res,200,{ok:true,config:db.system_config});
    }
    if(req.method==='GET' && pathname==='/api/icons') return sendJson(res,200,{ok:true,icons:db.desktop_icons||[]});
    if(req.method==='POST' && pathname==='/api/icons'){
      const body=await readJson(req); const item={id:nextId(db,'icons'), title:body.title||'Nuevo acceso', icon:body.icon||'🔗', type:body.type||'iframe', target:body.target||'', x:body.x||80, y:body.y||80, width:120, height:92, visible:1};
      db.desktop_icons.push(item); saveDb(db); return sendJson(res,200,{ok:true,icon:item});
    }
    let m = pathname.match(/^\/api\/icons\/(\d+)$/);
    if(m && req.method==='PUT'){
      const body=await readJson(req); const item=db.desktop_icons.find(x=>String(x.id)===m[1]); if(!item) return notFound(res);
      Object.assign(item, body); saveDb(db); return sendJson(res,200,{ok:true,icon:item});
    }
    if(m && req.method==='DELETE'){
      db.desktop_icons = db.desktop_icons.filter(x=>String(x.id)!==m[1]); saveDb(db); return sendJson(res,200,{ok:true});
    }
    if(req.method==='GET' && pathname==='/api/files') return sendJson(res,200,{ok:true,files:db.files||[]});
    if(req.method==='POST' && pathname==='/api/files/upload'){
      const raw=await readBody(req); const parts=parseMultipart(raw, req.headers['content-type']); const file=parts && parts.find(p=>p.filename);
      if(!file) return bad(res,'No se recibió archivo');
      const original=cleanFileName(file.filename); const stored=`${Date.now()}_${safeId()}_${original}`; const dest=path.join(UPLOADS_DIR, stored); fs.writeFileSync(dest, file.data);
      const row={id:nextId(db,'files'), name:original, stored_name:stored, path:dest, type:file.contentType||'application/octet-stream', size:file.data.length, created_at:now(), updated_at:now()};
      db.files.push(row); saveDb(db); return sendJson(res,200,{ok:true,file:row});
    }
    m = pathname.match(/^\/api\/files\/download\/(\d+)$/);
    if(m && req.method==='GET'){
      const f=(db.files||[]).find(x=>String(x.id)===m[1]); if(!f || !fs.existsSync(f.path)) return notFound(res);
      res.writeHead(200, {'Content-Type':f.type||'application/octet-stream','Content-Disposition':`attachment; filename="${encodeURIComponent(f.name)}"`}); fs.createReadStream(f.path).pipe(res); return;
    }
    m = pathname.match(/^\/api\/files\/(\d+)$/);
    if(m && req.method==='DELETE'){
      const f=(db.files||[]).find(x=>String(x.id)===m[1]); if(f) try{fs.unlinkSync(f.path)}catch{}; db.files=(db.files||[]).filter(x=>String(x.id)!==m[1]); saveDb(db); return sendJson(res,200,{ok:true});
    }
    if(req.method==='GET' && pathname==='/api/cloud/accounts') return sendJson(res,200,{ok:true,accounts:db.cloud_accounts||[]});
    if(req.method==='POST' && pathname==='/api/cloud/accounts'){
      const b=await readJson(req); const row={id:nextId(db,'cloud'), provider:b.provider||'GitHub', display_name:b.display_name||b.name||'Cuenta nube', auth_type:b.auth_type||'token', encrypted_config:b.encrypted_config||b.token||'', enabled:b.enabled!==false, created_at:now()}; db.cloud_accounts.push(row); saveDb(db); return sendJson(res,200,{ok:true,account:row});
    }
    m = pathname.match(/^\/api\/cloud\/accounts\/(\d+)$/);
    if(m && req.method==='DELETE'){ db.cloud_accounts=(db.cloud_accounts||[]).filter(x=>String(x.id)!==m[1]); saveDb(db); return sendJson(res,200,{ok:true}); }
    if(req.method==='GET' && pathname==='/api/remote/connections') return sendJson(res,200,{ok:true,connections:db.remote_connections||[]});
    if(req.method==='POST' && pathname==='/api/remote/connections'){
      const b=await readJson(req); const row={id:nextId(db,'remote'), name:b.name||'Equipo remoto', protocol:b.protocol||'external', host:b.host||'', port:b.port||'', username:b.username||'', encrypted_password:b.encrypted_password||'', enabled:b.enabled!==false, created_at:now()}; db.remote_connections.push(row); saveDb(db); return sendJson(res,200,{ok:true,connection:row});
    }
    m = pathname.match(/^\/api\/remote\/connections\/(\d+)$/);
    if(m && req.method==='DELETE'){ db.remote_connections=(db.remote_connections||[]).filter(x=>String(x.id)!==m[1]); saveDb(db); return sendJson(res,200,{ok:true}); }
    if(req.method==='GET' && pathname==='/api/db-backup'){
      const buf=fs.readFileSync(DB_PATH); res.writeHead(200, {'Content-Type':'application/json','Content-Disposition':'attachment; filename="ea1fjz_cloud_os_backup.json"'}); res.end(buf); return;
    }
    notFound(res);
  }catch(e){ console.error(e); bad(res, e.message || 'Error interno', 500); }
}

function handleStatic(req,res,pathname){
  let file = pathname === '/' ? path.join(PUBLIC_DIR,'index.html') : path.join(PUBLIC_DIR, decodeURIComponent(pathname));
  if(!file.startsWith(PUBLIC_DIR)) return bad(res,'Ruta no permitida',403);
  fs.stat(file, (err, st)=>{
    if(err || !st.isFile()) return notFound(res);
    res.writeHead(200, {'Content-Type': mime[path.extname(file).toLowerCase()] || 'application/octet-stream'});
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer((req,res)=>{
  const u = new URL(req.url, `http://${req.headers.host}`);
  if(u.pathname.startsWith('/api/')) return handleApi(req,res,u.pathname);
  return handleStatic(req,res,u.pathname);
});
server.listen(PORT, ()=> console.log(`EA1FJZ Cloud OS escuchando en puerto ${PORT}. Persistencia: ${DB_PATH}`));
