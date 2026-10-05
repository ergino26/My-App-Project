const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'farmer-system.sqlite');
const LEGACY_FILE = path.join(DATA_DIR, 'db.json');

fs.mkdirSync(DATA_DIR, { recursive: true });
const sqlite = new DatabaseSync(DB_FILE);
sqlite.exec('PRAGMA foreign_keys = ON;');
sqlite.exec('PRAGMA journal_mode = WAL;');
sqlite.exec('PRAGMA synchronous = NORMAL;');

sqlite.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK(role IN ('admin','farmer')),
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  phone TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS farmers (
  id TEXT PRIMARY KEY,
  user_id TEXT UNIQUE,
  first_name TEXT NOT NULL,
  middle_name TEXT,
  last_name TEXT NOT NULL,
  suffix TEXT,
  birth_date TEXT NOT NULL,
  sex TEXT NOT NULL,
  civil_status TEXT,
  phone TEXT NOT NULL,
  address TEXT NOT NULL,
  farm_location TEXT NOT NULL,
  farm_size REAL NOT NULL DEFAULT 0,
  farm_type TEXT NOT NULL,
  crop_details TEXT,
  years_farming INTEGER NOT NULL DEFAULT 0,
  id_type TEXT,
  id_number TEXT,
  status TEXT NOT NULL DEFAULT 'Pending',
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS programs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT,
  description TEXT NOT NULL,
  eligibility TEXT,
  quantity TEXT,
  schedule TEXT,
  location TEXT,
  status TEXT NOT NULL DEFAULT 'Open',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS assistance (
  id TEXT PRIMARY KEY,
  farmer_id TEXT NOT NULL,
  program_id TEXT NOT NULL,
  quantity TEXT,
  date_received TEXT,
  status TEXT NOT NULL DEFAULT 'Distributed',
  remarks TEXT,
  recorded_by TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(farmer_id) REFERENCES farmers(id) ON DELETE CASCADE,
  FOREIGN KEY(program_id) REFERENCES programs(id) ON DELETE CASCADE,
  FOREIGN KEY(recorded_by) REFERENCES users(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS announcements (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  audience TEXT NOT NULL DEFAULT 'All Farmers',
  priority TEXT NOT NULL DEFAULT 'Normal',
  published INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  actor TEXT,
  action TEXT NOT NULL,
  target TEXT,
  details TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(actor) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_farmers_name ON farmers(last_name, first_name);
CREATE INDEX IF NOT EXISTS idx_farmers_status ON farmers(status);
CREATE INDEX IF NOT EXISTS idx_assistance_farmer ON assistance(farmer_id);
CREATE INDEX IF NOT EXISTS idx_assistance_program ON assistance(program_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
`);

function rows(sql, params = []) {
  return sqlite.prepare(sql).all(...params).map(row => ({ ...row }));
}
function one(sql, params = []) {
  const row = sqlite.prepare(sql).get(...params);
  return row ? { ...row } : null;
}
function run(sql, params = []) { return sqlite.prepare(sql).run(...params); }

function snapshot() {
  return {
    users: rows(`SELECT id, role, username, password_hash AS passwordHash, name, phone, created_at AS createdAt FROM users`),
    farmers: rows(`SELECT id, user_id AS userId, first_name AS firstName, middle_name AS middleName, last_name AS lastName, suffix,
      birth_date AS birthDate, sex, civil_status AS civilStatus, phone, address, farm_location AS farmLocation,
      farm_size AS farmSize, farm_type AS farmType, crop_details AS cropDetails, years_farming AS yearsFarming,
      id_type AS idType, id_number AS idNumber, status, notes, created_at AS createdAt, updated_at AS updatedAt FROM farmers`),
    programs: rows(`SELECT id, name, category, description, eligibility, quantity, schedule, location, status, created_at AS createdAt FROM programs`),
    assistance: rows(`SELECT id, farmer_id AS farmerId, program_id AS programId, quantity, date_received AS dateReceived,
      status, remarks, recorded_by AS recordedBy, created_at AS createdAt FROM assistance`),
    announcements: rows(`SELECT id, title, message, audience, priority, published, created_at AS createdAt FROM announcements`).map(x => ({ ...x, published: Boolean(x.published) })),
    auditLogs: rows(`SELECT id, actor, action, target, details, created_at AS createdAt FROM audit_logs ORDER BY created_at DESC LIMIT 500`)
  };
}

function replaceSnapshot(db) {
  const tx = sqlite.prepare('BEGIN');
  tx.run();
  try {
    sqlite.exec('DELETE FROM assistance; DELETE FROM audit_logs; DELETE FROM announcements; DELETE FROM programs; DELETE FROM farmers; DELETE FROM users;');
    const userStmt = sqlite.prepare(`INSERT INTO users(id,role,username,password_hash,name,phone,created_at) VALUES(?,?,?,?,?,?,?)`);
    db.users.forEach(u => userStmt.run(u.id,u.role,u.username,u.passwordHash,u.name,u.phone || null,u.createdAt));
    const farmerStmt = sqlite.prepare(`INSERT INTO farmers(id,user_id,first_name,middle_name,last_name,suffix,birth_date,sex,civil_status,phone,address,farm_location,farm_size,farm_type,crop_details,years_farming,id_type,id_number,status,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    db.farmers.forEach(f => farmerStmt.run(f.id,f.userId || null,f.firstName,f.middleName || null,f.lastName,f.suffix || null,f.birthDate,f.sex,f.civilStatus || null,f.phone,f.address,f.farmLocation,Number(f.farmSize)||0,f.farmType,f.cropDetails || null,Number(f.yearsFarming)||0,f.idType || null,f.idNumber || null,f.status,f.notes || null,f.createdAt,f.updatedAt));
    const programStmt = sqlite.prepare(`INSERT INTO programs(id,name,category,description,eligibility,quantity,schedule,location,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`);
    db.programs.forEach(p => programStmt.run(p.id,p.name,p.category || null,p.description,p.eligibility || null,p.quantity || null,p.schedule || null,p.location || null,p.status,p.createdAt));
    const assistanceStmt = sqlite.prepare(`INSERT INTO assistance(id,farmer_id,program_id,quantity,date_received,status,remarks,recorded_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)`);
    db.assistance.forEach(a => assistanceStmt.run(a.id,a.farmerId,a.programId,a.quantity || null,a.dateReceived || null,a.status,a.remarks || null,a.recordedBy || null,a.createdAt));
    const announcementStmt = sqlite.prepare(`INSERT INTO announcements(id,title,message,audience,priority,published,created_at) VALUES(?,?,?,?,?,?,?)`);
    db.announcements.forEach(a => announcementStmt.run(a.id,a.title,a.message,a.audience || 'All Farmers',a.priority || 'Normal',a.published ? 1 : 0,a.createdAt));
    const auditStmt = sqlite.prepare(`INSERT INTO audit_logs(id,actor,action,target,details,created_at) VALUES(?,?,?,?,?,?)`);
    db.auditLogs.forEach(l => auditStmt.run(l.id,l.actor || null,l.action,l.target || null,l.details || null,l.createdAt));
    sqlite.prepare('COMMIT').run();
  } catch (err) {
    sqlite.prepare('ROLLBACK').run();
    throw err;
  }
}

function migrateLegacy() {
  if (one('SELECT id FROM users LIMIT 1')) return;
  if (!fs.existsSync(LEGACY_FILE)) return;
  try {
    const legacy = JSON.parse(fs.readFileSync(LEGACY_FILE, 'utf8'));
    replaceSnapshot({
      users: legacy.users || [], farmers: legacy.farmers || [], programs: legacy.programs || [],
      assistance: legacy.assistance || [], announcements: legacy.announcements || [], auditLogs: legacy.auditLogs || []
    });
    console.log('Migrated existing data/db.json into SQLite database.');
  } catch (err) {
    console.error('Legacy database migration failed:', err.message);
  }
}

migrateLegacy();

function closeDb() { sqlite.close(); }
module.exports = { sqlite, DB_FILE, DB_PATH: DB_FILE, loadDb: snapshot, saveDb: replaceSnapshot, closeDb };

