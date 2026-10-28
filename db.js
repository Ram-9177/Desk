import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';

fs.mkdirSync('data/uploads', { recursive: true });
export const db = new DatabaseSync(process.env.DB_FILE || 'data/desk.db');
db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');

db.exec(`
CREATE TABLE IF NOT EXISTS tenants (id TEXT PRIMARY KEY, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL,
  timezone TEXT DEFAULT 'Asia/Kolkata', show_provider_contact INT DEFAULT 1, reopen_window_days INT DEFAULT 7, is_active INT DEFAULT 1);
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, tenant_id TEXT REFERENCES tenants(id), name TEXT NOT NULL, email TEXT NOT NULL,
  phone TEXT, password_hash TEXT, role TEXT NOT NULL CHECK (role IN ('super_admin','tenant_admin','provider')),
  is_active INT DEFAULT 1, last_login_at TEXT, CHECK ((role='super_admin') = (tenant_id IS NULL)));
CREATE UNIQUE INDEX IF NOT EXISTS users_email ON users(lower(email));
CREATE TABLE IF NOT EXISTS services (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), code TEXT NOT NULL, name TEXT NOT NULL,
  description TEXT, form_schema TEXT DEFAULT '{"fields":[]}', is_active INT DEFAULT 1, sort_order INT DEFAULT 0, UNIQUE (tenant_id, code));
CREATE TABLE IF NOT EXISTS service_members (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, service_id TEXT NOT NULL REFERENCES services(id),
  user_id TEXT NOT NULL REFERENCES users(id), created_at TEXT DEFAULT CURRENT_TIMESTAMP, UNIQUE (service_id, user_id));
CREATE TABLE IF NOT EXISTS sla_policies (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, service_id TEXT, priority TEXT NOT NULL, target_hours INT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS sla_u ON sla_policies(tenant_id, ifnull(service_id,''), priority);
CREATE TABLE IF NOT EXISTS requestors (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL, email TEXT, phone TEXT,
  requestor_type TEXT, identifier TEXT, department TEXT, CHECK (email IS NOT NULL OR phone IS NOT NULL));
CREATE TABLE IF NOT EXISTS ticket_counters (tenant_id TEXT, year INT, last_number INT, PRIMARY KEY (tenant_id, year));
CREATE TABLE IF NOT EXISTS tickets (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, ticket_no TEXT NOT NULL, service_id TEXT NOT NULL,
  requestor_id TEXT NOT NULL, subject TEXT NOT NULL, description TEXT, location TEXT, form_data TEXT DEFAULT '{}',
  priority TEXT DEFAULT 'medium', status TEXT DEFAULT 'open', channel TEXT DEFAULT 'portal', is_internal INT DEFAULT 0,
  created_by_user_id TEXT, due_at TEXT, hold_started_at TEXT, held_minutes INT DEFAULT 0, closed_at TEXT, closed_by TEXT,
  reopen_count INT DEFAULT 0, tracking_token TEXT, idempotency_key TEXT, created_at TEXT, updated_at TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS t_no ON tickets(tenant_id, ticket_no);
CREATE INDEX IF NOT EXISTS t_ts ON tickets(tenant_id, service_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS t_idem ON tickets(tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS ticket_events (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL, ticket_id TEXT NOT NULL,
  actor_type TEXT, actor_id TEXT, actor_name TEXT, event_type TEXT NOT NULL, from_value TEXT, to_value TEXT, body TEXT,
  is_internal INT DEFAULT 0, meta TEXT DEFAULT '{}', created_at TEXT);
CREATE INDEX IF NOT EXISTS ev_t ON ticket_events(ticket_id, created_at);
CREATE TRIGGER IF NOT EXISTS ev_no_upd BEFORE UPDATE ON ticket_events BEGIN SELECT RAISE(ABORT,'ticket_events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS ev_no_del BEFORE DELETE ON ticket_events BEGIN SELECT RAISE(ABORT,'ticket_events is append-only'); END;
CREATE TABLE IF NOT EXISTS attachments (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, ticket_id TEXT NOT NULL, event_id INT,
  uploaded_by_type TEXT, source TEXT, file_name TEXT, mime_type TEXT, size_bytes INT, stamped_at TEXT, storage_key TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY, tenant_id TEXT, ticket_id TEXT, recipient TEXT, template_key TEXT,
  subject TEXT, body TEXT, status TEXT DEFAULT 'queued', attempts INT DEFAULT 0, last_error TEXT, sent_at TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS audit_logs (id TEXT PRIMARY KEY, tenant_id TEXT, actor_id TEXT, action TEXT, entity TEXT, entity_id TEXT,
  meta TEXT, created_at TEXT);
`);

// --- migrations for business-hours SLA, hold SLA and provider points ---
const addCol = (t, c, def) => { try { db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${def}`); } catch { /* already there */ } };
addCol('tenants', 'work_start', "TEXT DEFAULT '09:00'");
addCol('tenants', 'work_end', "TEXT DEFAULT '17:00'");
addCol('tenants', 'work_days', "TEXT DEFAULT '1,2,3,4,5,6'");
addCol('tenants', 'hold_reasons', 'TEXT');
addCol('tickets', 'hold_reason', 'TEXT');
addCol('users', 'must_change_pw', 'INT DEFAULT 0');
addCol('notifications', 'html', 'TEXT');
// escalation: campus rule, per-service escalation person, ticket state
addCol('tenants', 'escalate_after_days', 'REAL DEFAULT 0');
addCol('tenants', 'escalate_holds', 'INT DEFAULT 1');
addCol('services', 'escalation_user_id', 'TEXT');
addCol('tickets', 'escalated_at', 'TEXT');
addCol('tickets', 'escalated_to', 'TEXT');
addCol('notifications', 'text_body', 'TEXT');
addCol('tickets', 'hold_due_at', 'TEXT');
addCol('tickets', 'hold_by', 'TEXT');
db.exec(`CREATE TABLE IF NOT EXISTS provider_points (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, ticket_id TEXT,
  points INT NOT NULL, reason TEXT, created_at TEXT);
CREATE INDEX IF NOT EXISTS pp_u ON provider_points(tenant_id, user_id);
CREATE TRIGGER IF NOT EXISTS pp_no_upd BEFORE UPDATE ON provider_points BEGIN SELECT RAISE(ABORT,'provider_points is append-only'); END;
-- old calendar-hour defaults (24/72/168) become working-hour defaults (5/8/24) plus critical 3
UPDATE sla_policies SET target_hours = CASE priority WHEN 'high' THEN 5 WHEN 'medium' THEN 8 ELSE 24 END
  WHERE service_id IS NULL AND ((priority='high' AND target_hours=24) OR (priority='medium' AND target_hours=72) OR (priority='low' AND target_hours=168));
INSERT INTO sla_policies (id, tenant_id, service_id, priority, target_hours)
  SELECT lower(hex(randomblob(16))), t.id, NULL, 'critical', 3 FROM tenants t
  WHERE NOT EXISTS (SELECT 1 FROM sla_policies s WHERE s.tenant_id=t.id AND s.service_id IS NULL AND s.priority='critical');`);

export const uid = () => crypto.randomUUID();
export const now = () => new Date().toISOString();
export const one = (sql, ...a) => db.prepare(sql).get(...a);
export const all = (sql, ...a) => db.prepare(sql).all(...a);
export const run = (sql, ...a) => db.prepare(sql).run(...a);
export function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}
export function insert(table, row) {
  const k = Object.keys(row);
  run(`INSERT INTO ${table} (${k.join(',')}) VALUES (${k.map(() => '?').join(',')})`, ...k.map(x => row[x] ?? null));
  return row;
}
export function hashPw(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
}
export function checkPw(pw, h) {
  if (!h) return false;
  const [salt, key] = h.split(':');
  return crypto.timingSafeEqual(Buffer.from(key, 'hex'), crypto.scryptSync(pw, salt, 64));
}
