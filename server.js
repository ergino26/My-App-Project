const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DB_FILE = path.join(ROOT, 'data', 'db.json');
const SQLITE_FILE = path.join(ROOT, 'data', 'farmer_system.sqlite');
const sqlite = new DatabaseSync(SQLITE_FILE);
sqlite.exec('PRAGMA journal_mode = WAL');
sqlite.exec(`CREATE TABLE IF NOT EXISTS app_data (collection TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (collection, id));`);

function seedSqliteFromJson() {
  const count = sqlite.prepare('SELECT COUNT(*) AS count FROM app_data').get().count;
  if (count > 0 || !fs.existsSync(DB_FILE)) return;
  const source = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  const insert = sqlite.prepare('INSERT OR REPLACE INTO app_data (collection, id, data) VALUES (?, ?, ?)');
  const tx = sqlite.createFunction ? null : null;
  const runSeed = (db) => {
    for (const [collection, rows] of Object.entries(db)) {
      if (!Array.isArray(rows)) continue;
      for (const row of rows) {
        if (row && row.id) insert.run(collection, String(row.id), JSON.stringify(row));
      }
    }
  };
  sqlite.exec('BEGIN');
  try { runSeed(source); sqlite.exec('COMMIT'); } catch (e) { sqlite.exec('ROLLBACK'); throw e; }
}
seedSqliteFromJson();
const sessions = new Map();

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8'
};

const COLLECTIONS = ['users', 'farmers', 'programs', 'assistance', 'announcements', 'auditLogs'];
function loadDb() {
  const db = Object.fromEntries(COLLECTIONS.map(c => [c, []]));
  const rows = sqlite.prepare('SELECT collection, data FROM app_data ORDER BY rowid').all();
  for (const row of rows) {
    if (db[row.collection]) db[row.collection].push(JSON.parse(row.data));
  }
  if (db.users[0] && !db.users[0].passwordHash) {
    db.users[0].passwordHash = hashPassword('admin123');
    saveDb(db);
  }
  return db;
}
function saveDb(db) {
  sqlite.exec('BEGIN');
  try {
    sqlite.prepare('DELETE FROM app_data').run();
    const insert = sqlite.prepare('INSERT INTO app_data (collection, id, data) VALUES (?, ?, ?)');
    for (const collection of COLLECTIONS) {
      for (const row of (db[collection] || [])) {
        if (row && row.id) insert.run(collection, String(row.id), JSON.stringify(row));
      }
    }
    sqlite.exec('COMMIT');
  } catch (e) { sqlite.exec('ROLLBACK'); throw e; }
}

function uid(prefix) { return `${prefix}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`; }
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  const [salt, key] = String(stored).split(':');
  if (!salt || !key) return false;
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(key, 'hex'), Buffer.from(derived, 'hex'));
}
function clean(value, max = 5000) { return String(value ?? '').trim().slice(0, max); }
function number(value, fallback = 0) { const n = Number(value); return Number.isFinite(n) ? n : fallback; }
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''; req.on('data', c => { body += c; if (body.length > 2_000_000) req.destroy(); });
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}
function send(res, status, data, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(data));
}
function ok(res, data = {}, headers = {}) { send(res, 200, { ok: true, ...data }, headers); }
function fail(res, status, message) { send(res, status, { ok: false, message }); }
function cookie(name, value, maxAge = 60 * 60 * 8) { return `${name}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`; }
function getSession(req) {
  const raw = req.headers.cookie || '';
  const m = raw.match(/(?:^|;\s*)sid=([^;]+)/);
  if (!m) return null;
  const s = sessions.get(m[1]);
  if (!s || s.expires < Date.now()) { sessions.delete(m[1]); return null; }
  return s;
}
function requireAuth(req, res, role = null) {
  const session = getSession(req);
  if (!session) { fail(res, 401, 'Please log in.'); return null; }
  if (role && session.role !== role) { fail(res, 403, 'Access denied.'); return null; }
  return session;
}
function audit(db, actor, action, target, details = '') {
  db.auditLogs.unshift({ id: uid('LOG'), actor, action, target, details, createdAt: new Date().toISOString() });
  db.auditLogs = db.auditLogs.slice(0, 500);
}
function fullName(f) { return [f.firstName, f.middleName, f.lastName, f.suffix].filter(Boolean).join(' '); }
function safeFarmer(f) { const x = { ...f }; delete x.userId; return x; }
function stats(db) {
  return {
    totalFarmers: db.farmers.length,
    verifiedFarmers: db.farmers.filter(x => x.status === 'Verified').length,
    pendingFarmers: db.farmers.filter(x => x.status === 'Pending').length,
    assistancePrograms: db.programs.filter(x => x.status === 'Open').length,
    assistanceDistributed: db.assistance.filter(x => x.status === 'Distributed').length,
    announcements: db.announcements.filter(x => x.published).length
  };
}
function matchFarmer(f, q) {
  if (!q) return true;
  const text = [f.id, fullName(f), f.phone, f.address, f.farmLocation, f.farmType, f.idNumber, f.status].join(' ').toLowerCase();
  return text.includes(q.toLowerCase());
}

async function api(req, res, url) {
  const method = req.method;
  const parts = url.pathname.split('/').filter(Boolean);
  const db = loadDb();
  const body = ['POST', 'PUT', 'PATCH'].includes(method) ? await parseBody(req) : {};

  if (method === 'POST' && url.pathname === '/api/auth/login') {
    const username = clean(body.username, 100).toLowerCase();
    const password = String(body.password || '');
    const user = db.users.find(u => u.username.toLowerCase() === username);
    if (!user || !verifyPassword(password, user.passwordHash)) return fail(res, 401, 'Invalid username or password.');
    const sid = crypto.randomBytes(32).toString('hex');
    sessions.set(sid, { userId: user.id, role: user.role, farmerId: db.farmers.find(f => f.userId === user.id)?.id || null, expires: Date.now() + 8 * 60 * 60 * 1000 });
    audit(db, user.id, 'LOGIN', 'AUTH', 'User logged in'); saveDb(db);
    return ok(res, { user: { id: user.id, role: user.role, name: user.name, username: user.username }, session: { role: user.role } }, { 'Set-Cookie': cookie('sid', sid) });
  }
  if (method === 'POST' && url.pathname === '/api/auth/logout') {
    const session = getSession(req); if (session) { audit(db, session.userId, 'LOGOUT', 'AUTH', 'User logged out'); saveDb(db); }
    const raw = req.headers.cookie || ''; const m = raw.match(/(?:^|;\s*)sid=([^;]+)/); if (m) sessions.delete(m[1]);
    return ok(res, {}, { 'Set-Cookie': cookie('sid', '', 0) });
  }
  if (method === 'GET' && url.pathname === '/api/auth/me') {
    const s = getSession(req); if (!s) return ok(res, { authenticated: false });
    const u = db.users.find(x => x.id === s.userId); return ok(res, { authenticated: true, user: { id: u.id, role: u.role, name: u.name, username: u.username, farmerId: s.farmerId } });
  }
  if (method === 'POST' && url.pathname === '/api/auth/register') {
    const required = ['firstName','lastName','birthDate','sex','phone','address','farmLocation','farmSize','farmType','password'];
    if (required.some(k => !String(body[k] ?? '').trim())) return fail(res, 400, 'Please complete all required registration fields.');
    const username = clean(body.phone, 30).replace(/\s+/g, '');
    if (db.users.some(u => u.username === username)) return fail(res, 409, 'A farmer account already exists for this phone number.');
    const userId = uid('U'); const farmerId = `F-${new Date().getFullYear()}-${String(db.farmers.length + 1).padStart(4,'0')}`;
    db.users.push({ id: userId, role: 'farmer', username, passwordHash: hashPassword(String(body.password)), name: fullName(body), phone: clean(body.phone, 30), createdAt: new Date().toISOString() });
    db.farmers.push({ id: farmerId, userId, firstName: clean(body.firstName,80), middleName: clean(body.middleName,80), lastName: clean(body.lastName,80), suffix: clean(body.suffix,20), birthDate: clean(body.birthDate,20), sex: clean(body.sex,30), civilStatus: clean(body.civilStatus,30), phone: clean(body.phone,30), address: clean(body.address,250), farmLocation: clean(body.farmLocation,250), farmSize: number(body.farmSize), farmType: clean(body.farmType,80), cropDetails: clean(body.cropDetails,250), yearsFarming: number(body.yearsFarming), idType: clean(body.idType,50), idNumber: clean(body.idNumber,80), status: 'Pending', notes: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    audit(db, userId, 'REGISTER', farmerId, 'New farmer registration'); saveDb(db);
    return ok(res, { message: 'Registration submitted. Your account can now be used to log in.', farmer: safeFarmer(db.farmers.at(-1)) });
  }

  const session = getSession(req);
  if (url.pathname.startsWith('/api/') && !session) return fail(res, 401, 'Please log in.');
  const currentFarmer = session?.farmerId ? db.farmers.find(f => f.id === session.farmerId) : null;

  if (method === 'GET' && url.pathname === '/api/dashboard') {
    if (session.role === 'admin') return ok(res, { stats: stats(db), recentFarmers: db.farmers.slice(-8).reverse().map(safeFarmer), recentAssistance: db.assistance.slice(-8).reverse() });
    return ok(res, { stats: { programs: db.programs.filter(p => p.status === 'Open').length, received: db.assistance.filter(a => a.farmerId === session.farmerId && a.status === 'Distributed').length, status: currentFarmer?.status || 'Pending' }, farmer: currentFarmer ? safeFarmer(currentFarmer) : null });
  }
  if (method === 'GET' && url.pathname === '/api/farmers') {
    if (session.role === 'admin') { const q = clean(url.searchParams.get('q'), 100); return ok(res, { farmers: db.farmers.filter(f => matchFarmer(f, q)).map(safeFarmer) }); }
    return ok(res, { farmers: currentFarmer ? [safeFarmer(currentFarmer)] : [] });
  }
  if (method === 'GET' && url.pathname === '/api/farmers/me') return currentFarmer ? ok(res, { farmer: safeFarmer(currentFarmer) }) : fail(res,404,'Farmer profile not found.');
  if (method === 'POST' && url.pathname === '/api/farmers') {
    if (!requireAuth(req,res,'admin')) return;
    const required = ['firstName','lastName','birthDate','sex','phone','address','farmLocation','farmSize','farmType'];
    if (required.some(k => !String(body[k] ?? '').trim())) return fail(res,400,'Please complete all required farmer fields.');
    const farmer = { id: `F-${new Date().getFullYear()}-${String(db.farmers.length+1).padStart(4,'0')}`, userId: null, firstName: clean(body.firstName,80), middleName: clean(body.middleName,80), lastName: clean(body.lastName,80), suffix: clean(body.suffix,20), birthDate: clean(body.birthDate,20), sex: clean(body.sex,30), civilStatus: clean(body.civilStatus,30), phone: clean(body.phone,30), address: clean(body.address,250), farmLocation: clean(body.farmLocation,250), farmSize: number(body.farmSize), farmType: clean(body.farmType,80), cropDetails: clean(body.cropDetails,250), yearsFarming: number(body.yearsFarming), idType: clean(body.idType,50), idNumber: clean(body.idNumber,80), status: clean(body.status,30) || 'Pending', notes: clean(body.notes,500), createdAt:new Date().toISOString(), updatedAt:new Date().toISOString() };
    db.farmers.push(farmer); audit(db,session.userId,'CREATE',farmer.id,'Created farmer record'); saveDb(db); return ok(res,{farmer:safeFarmer(farmer)});
  }
  if (parts[0] === 'api' && parts[1] === 'farmers' && parts[2] && method === 'PUT') {
    if (!requireAuth(req,res,'admin')) return; const farmer = db.farmers.find(f=>f.id===parts[2]); if(!farmer)return fail(res,404,'Farmer not found.');
    const allowed = ['firstName','middleName','lastName','suffix','birthDate','sex','civilStatus','phone','address','farmLocation','farmSize','farmType','cropDetails','yearsFarming','idType','idNumber','status','notes'];
    allowed.forEach(k => { if (body[k] !== undefined) farmer[k] = ['farmSize','yearsFarming'].includes(k) ? number(body[k]) : clean(body[k],500); }); farmer.updatedAt=new Date().toISOString(); audit(db,session.userId,'UPDATE',farmer.id,'Updated farmer record'); saveDb(db); return ok(res,{farmer:safeFarmer(farmer)});
  }
  if (parts[0] === 'api' && parts[1] === 'farmers' && parts[2] && method === 'DELETE') {
    if (!requireAuth(req,res,'admin')) return; const idx=db.farmers.findIndex(f=>f.id===parts[2]); if(idx<0)return fail(res,404,'Farmer not found.'); const id=db.farmers[idx].id; db.farmers.splice(idx,1); audit(db,session.userId,'DELETE',id,'Deleted farmer record'); saveDb(db); return ok(res);
  }
  if (method === 'PUT' && url.pathname === '/api/farmers/me') {
    if (!currentFarmer) return fail(res,404,'Farmer profile not found.');
    ['firstName','middleName','lastName','suffix','birthDate','sex','civilStatus','phone','address','farmLocation','farmSize','farmType','cropDetails','yearsFarming','idType','idNumber'].forEach(k=>{if(body[k]!==undefined) currentFarmer[k]=['farmSize','yearsFarming'].includes(k)?number(body[k]):clean(body[k],500);}); currentFarmer.updatedAt=new Date().toISOString(); const u=db.users.find(x=>x.id===session.userId); if(u){u.name=fullName(currentFarmer);u.phone=currentFarmer.phone;u.username=currentFarmer.phone.replace(/\s+/g,'');} audit(db,session.userId,'UPDATE',currentFarmer.id,'Farmer updated own profile'); saveDb(db); return ok(res,{farmer:safeFarmer(currentFarmer)});
  }

  if (method === 'GET' && url.pathname === '/api/programs') return ok(res,{programs:db.programs});
  if (method === 'POST' && url.pathname === '/api/programs') {
    if(!requireAuth(req,res,'admin'))return; const p={id:`A-${new Date().getFullYear()}-${String(db.programs.length+1).padStart(3,'0')}`,name:clean(body.name,120),category:clean(body.category,60),description:clean(body.description,1000),eligibility:clean(body.eligibility,500),quantity:clean(body.quantity,100),schedule:clean(body.schedule,30),location:clean(body.location,200),status:clean(body.status,30)||'Open',createdAt:new Date().toISOString()}; if(!p.name||!p.description)return fail(res,400,'Program name and description are required.'); db.programs.push(p); audit(db,session.userId,'CREATE',p.id,'Created assistance program');saveDb(db);return ok(res,{program:p});
  }
  if (parts[0]==='api'&&parts[1]==='programs'&&parts[2]&&method==='PUT') { if(!requireAuth(req,res,'admin'))return;const p=db.programs.find(x=>x.id===parts[2]);if(!p)return fail(res,404,'Program not found.');['name','category','description','eligibility','quantity','schedule','location','status'].forEach(k=>{if(body[k]!==undefined)p[k]=clean(body[k],1000)});audit(db,session.userId,'UPDATE',p.id,'Updated assistance program');saveDb(db);return ok(res,{program:p}); }
  if (parts[0]==='api'&&parts[1]==='programs'&&parts[2]&&method==='DELETE') { if(!requireAuth(req,res,'admin'))return;const i=db.programs.findIndex(x=>x.id===parts[2]);if(i<0)return fail(res,404,'Program not found.');db.programs.splice(i,1);audit(db,session.userId,'DELETE',parts[2],'Deleted assistance program');saveDb(db);return ok(res); }

  if (method === 'GET' && url.pathname === '/api/assistance') {
    const rows=db.assistance.map(a=>({...a, farmerName:db.farmers.find(f=>f.id===a.farmerId)?fullName(db.farmers.find(f=>f.id===a.farmerId)):'Unknown', programName:db.programs.find(p=>p.id===a.programId)?.name||'Unknown'}));
    return ok(res,{assistance:session.role==='admin'?rows:rows.filter(a=>a.farmerId===session.farmerId)});
  }
  if (method === 'POST' && url.pathname === '/api/assistance') { if(!requireAuth(req,res,'admin'))return; const farmer=db.farmers.find(f=>f.id===body.farmerId), program=db.programs.find(p=>p.id===body.programId); if(!farmer||!program)return fail(res,400,'Select a valid farmer and assistance program.');const a={id:uid('AS'),farmerId:farmer.id,programId:program.id,quantity:clean(body.quantity,100),dateReceived:clean(body.dateReceived,30)||new Date().toISOString().slice(0,10),status:clean(body.status,30)||'Distributed',remarks:clean(body.remarks,500),recordedBy:session.userId,createdAt:new Date().toISOString()};db.assistance.push(a);audit(db,session.userId,'CREATE',a.id,`Recorded ${program.name} for ${fullName(farmer)}`);saveDb(db);return ok(res,{assistance:a}); }
  if (parts[0]==='api'&&parts[1]==='assistance'&&parts[2]&&method==='PUT') { if(!requireAuth(req,res,'admin'))return;const a=db.assistance.find(x=>x.id===parts[2]);if(!a)return fail(res,404,'Assistance record not found.');['farmerId','programId','quantity','dateReceived','status','remarks'].forEach(k=>{if(body[k]!==undefined)a[k]=clean(body[k],500)});audit(db,session.userId,'UPDATE',a.id,'Updated assistance record');saveDb(db);return ok(res,{assistance:a}); }
  if (parts[0]==='api'&&parts[1]==='assistance'&&parts[2]&&method==='DELETE') { if(!requireAuth(req,res,'admin'))return;const i=db.assistance.findIndex(x=>x.id===parts[2]);if(i<0)return fail(res,404,'Assistance record not found.');db.assistance.splice(i,1);audit(db,session.userId,'DELETE',parts[2],'Deleted assistance record');saveDb(db);return ok(res); }

  if (method === 'GET' && url.pathname === '/api/announcements') return ok(res,{announcements:db.announcements.filter(a=>session.role==='admin'||a.published)});
  if (method === 'POST' && url.pathname === '/api/announcements') { if(!requireAuth(req,res,'admin'))return;const a={id:uid('N'),title:clean(body.title,160),message:clean(body.message,1500),audience:clean(body.audience,80)||'All Farmers',priority:clean(body.priority,30)||'Normal',published:Boolean(body.published),createdAt:new Date().toISOString()};if(!a.title||!a.message)return fail(res,400,'Title and message are required.');db.announcements.unshift(a);audit(db,session.userId,'CREATE',a.id,'Created announcement');saveDb(db);return ok(res,{announcement:a}); }
  if (parts[0]==='api'&&parts[1]==='announcements'&&parts[2]&&method==='PUT') {if(!requireAuth(req,res,'admin'))return;const a=db.announcements.find(x=>x.id===parts[2]);if(!a)return fail(res,404,'Announcement not found.');['title','message','audience','priority'].forEach(k=>{if(body[k]!==undefined)a[k]=clean(body[k],1600)});if(body.published!==undefined)a.published=Boolean(body.published);audit(db,session.userId,'UPDATE',a.id,'Updated announcement');saveDb(db);return ok(res,{announcement:a});}
  if (parts[0]==='api'&&parts[1]==='announcements'&&parts[2]&&method==='DELETE') {if(!requireAuth(req,res,'admin'))return;const i=db.announcements.findIndex(x=>x.id===parts[2]);if(i<0)return fail(res,404,'Announcement not found.');db.announcements.splice(i,1);audit(db,session.userId,'DELETE',parts[2],'Deleted announcement');saveDb(db);return ok(res);}

  if (method === 'GET' && url.pathname === '/api/audit') { if(!requireAuth(req,res,'admin'))return;return ok(res,{logs:db.auditLogs.slice(0,100)}); }
  if (method === 'GET' && url.pathname === '/api/export/farmers') { if(!requireAuth(req,res,'admin'))return; const headers=['ID','Name','Birth Date','Sex','Phone','Address','Farm Location','Farm Size (ha)','Farm Type','Status','Created At']; const rows=db.farmers.map(f=>[f.id,fullName(f),f.birthDate,f.sex,f.phone,f.address,f.farmLocation,f.farmSize,f.farmType,f.status,f.createdAt]); const csv=[headers,...rows].map(r=>r.map(v=>`"${String(v??'').replace(/"/g,'""')}"`).join(',')).join('\n');res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="farmers.csv"'});return res.end(csv); }

  return fail(res,404,'API route not found.');
}

function serve(req,res,url){
  let file = url.pathname === '/' ? path.join(PUBLIC,'index.html') : path.join(PUBLIC, decodeURIComponent(url.pathname));
  if (!file.startsWith(PUBLIC)) return fail(res,403,'Forbidden');
  fs.stat(file,(err,st)=>{if(err||!st.isFile())return fail(res,404,'Page not found.');const ext=path.extname(file);res.writeHead(200,{'Content-Type':MIME[ext]||'application/octet-stream','Cache-Control':'no-cache'});fs.createReadStream(file).pipe(res);});
}
const server=http.createServer(async(req,res)=>{try{const url=new URL(req.url,`http://${req.headers.host||'localhost'}`);if(url.pathname.startsWith('/api/'))await api(req,res,url);else serve(req,res,url);}catch(e){console.error(e);fail(res,500,'Server error.');}});
loadDb(); server.listen(PORT,HOST,()=>console.log(`Farmer System running at http://localhost:${PORT}`));
