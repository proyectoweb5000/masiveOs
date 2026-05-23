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
const SESSION_SECRET = process.env.SESSION_SECRET || 'ea1fjz-os-local-secret-change-in-render';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'cambiar1234';

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
fs.mkdirSync(PUBLIC_DIR, { recursive: true });

const mime = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
  '.pdf':'application/pdf', '.csv':'text/csv; charset=utf-8', '.md':'text/markdown; charset=utf-8',
  '.mp4':'video/mp4', '.webm':'video/webm', '.mp3':'audio/mpeg', '.wav':'audio/wav', '.webp':'image/webp'
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
  try { return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(test)); } catch { return false; }
}
function sign(value){ return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('hex'); }
function makeCookie(user){
  const payload = Buffer.from(JSON.stringify({ user, ts: Date.now() })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}
function parseCookies(req){
  const raw = String(req.headers.cookie || '');
  const out = {};
  raw.split(';').map(x=>x.trim()).filter(Boolean).forEach(x=>{ const i=x.indexOf('='); if(i>0) out[x.slice(0,i)] = decodeURIComponent(x.slice(i+1)); });
  return out;
}
function getSession(req){
  const token = parseCookies(req)[COOKIE_NAME];
  if(!token || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  if(sig !== sign(payload)) return null;
  try { return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return null; }
}
function send(res, code, data, headers={}){
  const isBuffer = Buffer.isBuffer(data);
  const body = isBuffer ? data : (typeof data === 'string' ? data : JSON.stringify(data));
  res.writeHead(code, { 'Content-Type': isBuffer ? 'application/octet-stream' : (headers['Content-Type'] || 'application/json; charset=utf-8'), ...headers });
  res.end(body);
}
function sendJson(res, code, obj, headers={}){ send(res, code, JSON.stringify(obj), {'Content-Type':'application/json; charset=utf-8', ...headers}); }
function notFound(res){ sendJson(res, 404, { ok:false, error:'No encontrado' }); }
function bad(res, msg, code=400){ sendJson(res, code, { ok:false, error:msg }); }
function requireAuth(req, res){ const s=getSession(req); if(!s || !s.user) { bad(res,'No autorizado',401); return null; } return s; }
function readBody(req){
  return new Promise((resolve, reject)=>{
    const chunks=[]; let size=0;
    req.on('data', c=>{ size+=c.length; if(size>100*1024*1024){ reject(new Error('Payload demasiado grande')); req.destroy(); } else chunks.push(c); });
    req.on('end', ()=>resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req){ const raw = await readBody(req); if(!raw.length) return {}; return JSON.parse(raw.toString('utf8')); }
function cleanFileName(name){ return path.basename(String(name||'archivo')).replace(/[^a-zA-Z0-9._ -]/g,'_').slice(0,180) || 'archivo'; }
function safeRel(p){ return String(p||'').replace(/\\/g,'/').split('/').filter(part=>part && part!=='.' && part!=='..').join('/'); }
function absUploadPath(rel=''){ const safe=safeRel(rel); const full=path.join(UPLOADS_DIR, safe); if(!full.startsWith(UPLOADS_DIR)) throw new Error('Ruta no permitida'); return full; }
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
    const dataStart = headerEnd + 4;
    const next = buffer.indexOf(boundary, dataStart); if(next<0) break;
    const dataEnd = next - 2;
    const cd = /content-disposition:[^\n]*name="([^"]+)"(?:;\s*filename="([^"]*)")?/i.exec(headers);
    const ct = /content-type:\s*([^\r\n]+)/i.exec(headers);
    parts.push({ name:cd?.[1], filename:cd?.[2], contentType:ct?.[1], data:buffer.slice(dataStart, dataEnd) });
    start = next;
  }
  return parts;
}
function defaultDb(){
  return {
    users:[{ id:1, username:'admin', password_hash:hashPassword(ADMIN_PASSWORD), role:'admin', created_at:now(), last_login:null }],
    system_config:{ os_title:'MasiveOS', os_subtitle:'Sistema operativo web privado', wallpaper:'linear-gradient(135deg,#09111f,#132b4f 45%,#0f172a)', accent:'#2f7df6', ui_scale:'0.90' },
    desktop_icons:[
      {id:1,title:'Navegador',icon:'🌐',type:'browser',target:'',x:36,y:60,width:120,height:92,visible:1},
      {id:2,title:'Meteo & Radio',icon:'📡',type:'internal',target:'meteo',x:36,y:170,width:120,height:92,visible:1},
      {id:3,title:'Gestor archivos',icon:'📁',type:'internal',target:'files',x:36,y:280,width:120,height:92,visible:1},
      {id:4,title:'Nube',icon:'☁️',type:'internal',target:'cloud',x:180,y:60,width:120,height:92,visible:1},
      {id:5,title:'Ayuda remota',icon:'🖥️',type:'internal',target:'remote',x:180,y:170,width:120,height:92,visible:1},
      {id:6,title:'Configuración',icon:'⚙️',type:'internal',target:'settings',x:180,y:280,width:120,height:92,visible:1}
    ],
    cloud_accounts:[], remote_connections:[], _seq:{icons:7,cloud:1,remote:1}
  };
}
function normalizeDb(db){
  const d = db && typeof db==='object' ? db : defaultDb();
  d.users = Array.isArray(d.users)&&d.users.length ? d.users : defaultDb().users;
  d.system_config = { ...defaultDb().system_config, ...(d.system_config||{}) };
  d.desktop_icons = Array.isArray(d.desktop_icons) ? d.desktop_icons : defaultDb().desktop_icons;
  d.cloud_accounts = Array.isArray(d.cloud_accounts) ? d.cloud_accounts : [];
  d.remote_connections = Array.isArray(d.remote_connections) ? d.remote_connections : [];
  d._seq = { icons: 1, cloud:1, remote:1, ...(d._seq||{}) };
  return d;
}
function loadDb(){
  if(!fs.existsSync(DB_PATH)){ const db=defaultDb(); saveDb(db); return db; }
  try { return normalizeDb(JSON.parse(fs.readFileSync(DB_PATH,'utf8'))); }
  catch(e){ try{ fs.copyFileSync(DB_PATH, DB_PATH+'.corrupt-'+Date.now()); }catch{} const db=defaultDb(); saveDb(db); return db; }
}
function saveDb(db){ fs.writeFileSync(DB_PATH, JSON.stringify(normalizeDb(db),null,2)); }
function nextId(db, key){ db._seq = db._seq || {}; const v = Number(db._seq[key] || 1); db._seq[key] = v + 1; return v; }
function listLocal(rel=''){
  const full = absUploadPath(rel); fs.mkdirSync(full,{recursive:true});
  const items = fs.readdirSync(full,{withFileTypes:true}).map(d=>{
    const p=path.join(full,d.name); const st=fs.statSync(p); const itemRel=safeRel(path.join(rel,d.name));
    return { name:d.name, path:itemRel, type:d.isDirectory()?'folder':'file', size:st.size, updated_at:st.mtime.toISOString(), mime:mime[path.extname(d.name).toLowerCase()]||'application/octet-stream' };
  }).sort((a,b)=>(a.type===b.type? a.name.localeCompare(b.name) : a.type==='folder'?-1:1));
  return { path:safeRel(rel), items };
}
function accountConfig(acc){
  if(!acc) return {};
  if(acc.config && typeof acc.config==='object') return acc.config;
  const raw = acc.config || acc.encrypted_config || acc.token || '{}';
  try { return JSON.parse(raw); } catch { return { raw }; }
}
function joinWebdav(base, rel){
  const b=String(base||'').replace(/\/+$/,'') + '/';
  const r=String(rel||'').replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/');
  return b + r;
}
async function webdavFetch(acc, rel, method='PROPFIND'){
  const cfg=accountConfig(acc); if(!cfg.url) throw new Error('La cuenta WebDAV no tiene URL configurada');
  const headers={};
  if(method==='PROPFIND') { headers.Depth='1'; headers['Content-Type']='application/xml; charset=utf-8'; }
  if(cfg.username || cfg.password) headers.Authorization = 'Basic ' + Buffer.from(`${cfg.username||''}:${cfg.password||''}`).toString('base64');
  const body = method==='PROPFIND' ? '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:allprop/></d:propfind>' : undefined;
  const response = await fetch(joinWebdav(cfg.url, rel), { method, headers, body });
  if(!response.ok && response.status!==207) throw new Error(`WebDAV respondió ${response.status} ${response.statusText}`);
  return response;
}
function decodeXml(s){ return String(s||'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'"); }
function parseWebdavList(xml, baseRel=''){
  const blocks = xml.match(/<[^:>]*:?response[\s\S]*?<\/[^:>]*:?response>/gi) || [];
  const base = '/' + String(baseRel||'').replace(/^\/+|\/+$/g,'');
  const out=[];
  for(const block of blocks){
    const href = decodeXml((block.match(/<[^:>]*:?href[^>]*>([\s\S]*?)<\/[^:>]*:?href>/i)||[])[1]||'');
    let name = decodeURIComponent(href.split('/').filter(Boolean).pop() || '');
    const isFolder = /<[^:>]*:?collection\s*\/?\s*>/i.test(block);
    const size = Number((block.match(/<[^:>]*:?getcontentlength[^>]*>([\s\S]*?)<\/[^:>]*:?getcontentlength>/i)||[])[1]||0);
    const lm = decodeXml((block.match(/<[^:>]*:?getlastmodified[^>]*>([\s\S]*?)<\/[^:>]*:?getlastmodified>/i)||[])[1]||'');
    if(!name) continue;
    const itemPath = String(path.posix.join(baseRel||'', name)).replace(/^\/+/, '');
    if(itemPath.replace(/\/+$/,'') === String(baseRel||'').replace(/\/+$/,'')) continue;
    out.push({ name, path:itemPath, type:isFolder?'folder':'file', size, updated_at:lm, mime:mime[path.extname(name).toLowerCase()]||'application/octet-stream' });
  }
  const seen=new Map(); out.forEach(x=>seen.set(x.path,x));
  return Array.from(seen.values()).sort((a,b)=>(a.type===b.type? a.name.localeCompare(b.name) : a.type==='folder'?-1:1));
}
async function handleApi(req,res,pathname,query){
  const db=loadDb();
  try{
    if(req.method==='POST' && pathname==='/api/login'){
      const body=await readJson(req); const user=db.users.find(u=>u.username===body.username);
      if(!user || !verifyPassword(body.password, user.password_hash)) return bad(res,'Usuario o contraseña incorrectos',401);
      user.last_login=now(); saveDb(db);
      return sendJson(res,200,{ok:true,user:{username:user.username,role:user.role}},{'Set-Cookie': `${COOKIE_NAME}=${makeCookie(user.username)}; Path=/; HttpOnly; SameSite=Lax`});
    }
    if(req.method==='POST' && pathname==='/api/logout') return sendJson(res,200,{ok:true},{'Set-Cookie':`${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`});
    if(pathname==='/api/health') return sendJson(res,200,{ok:true,mode:'no-deps-json-persistence',dbPath:DB_PATH,uploadsPath:UPLOADS_DIR,writable:true,time:now()});
    const session=requireAuth(req,res); if(!session) return;
    if(req.method==='GET' && pathname==='/api/session') return sendJson(res,200,{ok:true,user:{username:session.user,role:'admin'}});
    if(req.method==='POST' && pathname==='/api/change-password'){
      const body=await readJson(req); const u=db.users.find(x=>x.username===session.user);
      const old = body.oldPassword || body.currentPassword;
      if(!u || !verifyPassword(old, u.password_hash)) return bad(res,'Contraseña actual incorrecta',403);
      if(!body.newPassword || String(body.newPassword).length<6) return bad(res,'La nueva contraseña debe tener al menos 6 caracteres');
      u.password_hash=hashPassword(body.newPassword); saveDb(db); return sendJson(res,200,{ok:true});
    }
    if(req.method==='GET' && pathname==='/api/config') return sendJson(res,200,{ok:true,config:db.system_config||{}});
    if(req.method==='POST' && pathname==='/api/config'){
      const body=await readJson(req); db.system_config={...(db.system_config||{}), ...(body.config||body)}; saveDb(db); return sendJson(res,200,{ok:true,config:db.system_config});
    }
    if(req.method==='GET' && pathname==='/api/icons') return sendJson(res,200,{ok:true,icons:db.desktop_icons||[]});
    if(req.method==='POST' && pathname==='/api/icons'){
      const b=await readJson(req); const item={id:nextId(db,'icons'), title:b.title||'Nuevo acceso', icon:b.icon||'🔗', type:b.type||'url', target:b.target||'', x:b.x||80, y:b.y||80, width:120,height:92,visible:1}; db.desktop_icons.push(item); saveDb(db); return sendJson(res,200,{ok:true,icon:item});
    }
    let m=pathname.match(/^\/api\/icons\/(\d+)$/);
    if(m && req.method==='PUT'){ const b=await readJson(req); const item=db.desktop_icons.find(x=>String(x.id)===m[1]); if(!item) return notFound(res); Object.assign(item,b); saveDb(db); return sendJson(res,200,{ok:true,icon:item}); }
    if(m && req.method==='DELETE'){ db.desktop_icons=db.desktop_icons.filter(x=>String(x.id)!==m[1]); saveDb(db); return sendJson(res,200,{ok:true}); }

    if(req.method==='GET' && pathname==='/api/local/list') return sendJson(res,200,{ok:true,...listLocal(query.get('path')||'')});
    if(req.method==='POST' && pathname==='/api/local/mkdir'){ const b=await readJson(req); fs.mkdirSync(absUploadPath(path.join(b.path||'', cleanFileName(b.name||'Nueva carpeta'))),{recursive:true}); return sendJson(res,200,{ok:true}); }
    if(req.method==='POST' && pathname==='/api/local/upload'){
      const raw=await readBody(req); const parts=parseMultipart(raw, req.headers['content-type']); const file=parts && parts.find(p=>p.filename); if(!file) return bad(res,'No se recibió archivo');
      const targetPath = (parts.find(p=>p.name==='path')?.data || Buffer.from('')).toString('utf8');
      const dest=path.join(absUploadPath(targetPath), cleanFileName(file.filename)); fs.mkdirSync(path.dirname(dest),{recursive:true}); fs.writeFileSync(dest,file.data); return sendJson(res,200,{ok:true});
    }
    if(req.method==='GET' && pathname==='/api/local/view'){
      const rel=safeRel(query.get('path')||''); const f=absUploadPath(rel); if(!fs.existsSync(f)||!fs.statSync(f).isFile()) return notFound(res);
      res.writeHead(200, {'Content-Type': mime[path.extname(f).toLowerCase()]||'application/octet-stream', 'Content-Disposition':`inline; filename="${encodeURIComponent(path.basename(f))}"`}); fs.createReadStream(f).pipe(res); return;
    }
    if(req.method==='DELETE' && pathname==='/api/local/delete'){
      const f=absUploadPath(query.get('path')||''); if(!fs.existsSync(f)) return sendJson(res,200,{ok:true}); const st=fs.statSync(f); if(st.isDirectory()) fs.rmSync(f,{recursive:true,force:true}); else fs.unlinkSync(f); return sendJson(res,200,{ok:true});
    }

    if(req.method==='GET' && pathname==='/api/cloud/accounts') return sendJson(res,200,{ok:true,accounts:db.cloud_accounts||[]});
    if(req.method==='POST' && pathname==='/api/cloud/accounts'){
      const b=await readJson(req); let cfg=b.config||{}; if(typeof cfg==='string'){ try{cfg=JSON.parse(cfg)}catch{cfg={raw:cfg}} }
      const row={id:nextId(db,'cloud'), provider:b.provider||'WebDAV', display_name:b.display_name||b.name||'Cuenta nube', config:cfg, encrypted_config:typeof cfg==='string'?cfg:JSON.stringify(cfg), enabled:b.enabled!==false, created_at:now()}; db.cloud_accounts.push(row); saveDb(db); return sendJson(res,200,{ok:true,account:row});
    }
    m=pathname.match(/^\/api\/cloud\/accounts\/(\d+)$/); if(m && req.method==='DELETE'){ db.cloud_accounts=(db.cloud_accounts||[]).filter(x=>String(x.id)!==m[1]); saveDb(db); return sendJson(res,200,{ok:true}); }

    if(req.method==='POST' && pathname==='/api/webdav/list'){
      const b=await readJson(req); const acc=(db.cloud_accounts||[]).find(x=>String(x.id)===String(b.accountId)); if(!acc) return notFound(res);
      const response=await webdavFetch(acc, b.path||'', 'PROPFIND'); const xml=await response.text(); return sendJson(res,200,{ok:true,path:safeRel(b.path||''),items:parseWebdavList(xml,b.path||'')});
    }
    if(req.method==='GET' && pathname==='/api/webdav/view'){
      const acc=(db.cloud_accounts||[]).find(x=>String(x.id)===String(query.get('accountId'))); if(!acc) return notFound(res);
      const response=await webdavFetch(acc, query.get('path')||'', 'GET');
      const ct=response.headers.get('content-type') || mime[path.extname(query.get('path')||'').toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, {'Content-Type': ct, 'Content-Disposition':`inline; filename="${encodeURIComponent(path.basename(query.get('path')||'archivo'))}"`});
      const buf=Buffer.from(await response.arrayBuffer()); res.end(buf); return;
    }

    if(req.method==='GET' && pathname==='/api/remote/connections') return sendJson(res,200,{ok:true,connections:db.remote_connections||[]});
    if(req.method==='POST' && pathname==='/api/remote/connections'){
      const b=await readJson(req); const row={id:nextId(db,'remote'), name:b.name||'Equipo remoto', protocol:b.protocol||'external', host:b.host||'', port:b.port||'', launch_url:b.launch_url||'', notes:b.notes||'', enabled:b.enabled!==false, created_at:now()}; db.remote_connections.push(row); saveDb(db); return sendJson(res,200,{ok:true,connection:row});
    }
    m=pathname.match(/^\/api\/remote\/connections\/(\d+)$/); if(m && req.method==='DELETE'){ db.remote_connections=(db.remote_connections||[]).filter(x=>String(x.id)!==m[1]); saveDb(db); return sendJson(res,200,{ok:true}); }
    if(req.method==='GET' && pathname==='/api/db-backup'){ const buf=fs.readFileSync(DB_PATH); res.writeHead(200, {'Content-Type':'application/json','Content-Disposition':'attachment; filename="masiveos_backup.json"'}); res.end(buf); return; }
    notFound(res);
  }catch(e){ console.error(e); bad(res, e.message || 'Error interno', 500); }
}
function handleStatic(req,res,pathname){
  let file = pathname==='/' ? path.join(PUBLIC_DIR,'index.html') : path.join(PUBLIC_DIR, decodeURIComponent(pathname));
  if(!file.startsWith(PUBLIC_DIR)) return bad(res,'Ruta no permitida',403);
  fs.stat(file,(err,st)=>{ if(err||!st.isFile()) return notFound(res); res.writeHead(200, {'Content-Type': mime[path.extname(file).toLowerCase()] || 'application/octet-stream'}); fs.createReadStream(file).pipe(res); });
}
const server=http.createServer((req,res)=>{ const u=new URL(req.url, `http://${req.headers.host}`); if(u.pathname.startsWith('/api/')) return handleApi(req,res,u.pathname,u.searchParams); return handleStatic(req,res,u.pathname); });
server.listen(PORT,()=>console.log(`MasiveOS escuchando en puerto ${PORT}. Persistencia: ${DB_PATH}`));
