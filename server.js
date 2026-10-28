import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, uid, now, one, all, run, tx, insert, hashPw, checkPw } from './db.js';
import { createSuperAdmin } from './bootstrap.js';
import { MAIL_EVENTS, mailConfig, eventOn, renderEmail, postToFlow, setSetting, renderTemplate, toText, eventByKey, VARS, sampleVars, unknownVars, templateFor, BLOCKS } from './mailer.js';
import { calendar, addWorking, workingBetween, closePoints, POINTS, POINT_RULES, DEFAULT_HOLD_REASONS } from './sla.js';
import { assertTransition, PRIORITIES, DEFAULT_HOURS, REQUESTOR_TYPES, CHANNELS, FIELD_TYPES, STATUS_WORDS, FORM_TYPES, fieldsOf, hasLocation, hasStudent, isGeneral } from './public/shared.js';

const PORT = process.env.PORT || 4300;
const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
if (process.env.NODE_ENV === 'production' && (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32)) {
  console.error('Set JWT_SECRET (32+ random characters) before running in production.'); process.exit(1);
}
const BASE = `http://localhost:${PORT}`;
const base = () => mailConfig(BASE).base; // public address used in email links (Email page → Connection)
const UPLOAD_DIR = process.env.UPLOAD_DIR || 'data/uploads';
const ROOT = path.dirname(fileURLToPath(import.meta.url)); // the app's own folder, whatever the working directory

const app = express();
app.use(express.json({ limit: '40mb' }));

// ---------- helpers ----------
class HttpErr extends Error { constructor(status, code, message, details) { super(message); Object.assign(this, { status, code, details }); } }
const bad = (m, d) => new HttpErr(400, 'VALIDATION', m, d);
const notFound = () => new HttpErr(404, 'NOT_FOUND', 'Not found');
const forbid = () => new HttpErr(403, 'FORBIDDEN', 'Forbidden');
const wrap = fn => (req, res, next) => {
  try { const r = fn(req, res); if (r instanceof Promise) r.then(v => v !== undefined && res.json({ data: v }), next); else if (r !== undefined) res.json({ data: r }); }
  catch (e) { next(e); }
};
const audit = (req, action, entity, entity_id, meta = {}) =>
  insert('audit_logs', { id: uid(), tenant_id: req.tenantId || null, actor_id: req.user?.id, action, entity, entity_id, meta: JSON.stringify(meta), created_at: now() });
const req_ = (v, m) => { if (v === undefined || v === null || String(v).trim() === '') throw bad(m); return v; };
const safeEq = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

// JWT HS256 (minimal)
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const sign = p => { const h = b64({ alg: 'HS256', typ: 'JWT' }), b = b64({ ...p, exp: Date.now() / 1000 + 12 * 3600 });
  return `${h}.${b}.${crypto.createHmac('sha256', SECRET).update(`${h}.${b}`).digest('base64url')}`; };
const verify = t => { const [h, b, s] = (t || '').split('.'); if (!s) return null;
  if (!safeEq(s, crypto.createHmac('sha256', SECRET).update(`${h}.${b}`).digest('base64url'))) return null;
  const p = JSON.parse(Buffer.from(b, 'base64url')); return p.exp > Date.now() / 1000 ? p : null; };

// in-memory rate limiter
const hits = new Map();
function limit(key, max, ms = 3600e3) {
  const t = Date.now(), arr = (hits.get(key) || []).filter(x => t - x < ms);
  if (arr.length >= max) throw new HttpErr(429, 'RATE_LIMIT', 'Too many requests, try again later');
  arr.push(t); hits.set(key, arr);
}

// ---------- auth + tenant scope ----------
function auth(req, _res, next) {
  const p = verify((req.headers.authorization || '').replace('Bearer ', ''));
  if (!p) return next(new HttpErr(401, 'UNAUTHORIZED', 'Please sign in'));
  const u = one('SELECT * FROM users WHERE id=? AND is_active=1', p.sub);
  if (!u) return next(new HttpErr(401, 'UNAUTHORIZED', 'Please sign in'));
  req.user = u;
  const hdr = req.headers['x-tenant-id'];
  if (u.role === 'super_admin') req.tenantId = hdr || null;
  else { if (hdr && hdr !== u.tenant_id) return next(forbid()); req.tenantId = u.tenant_id; }
  next();
}
const needTenant = (req, _r, next) => next(req.tenantId && one('SELECT 1 FROM tenants WHERE id=?', req.tenantId) ? undefined : bad('Pick a tenant first'));
const role = (...r) => (req, _r, next) => next(r.includes(req.user.role) ? undefined : forbid());
const isAdmin = u => u.role !== 'provider';
const myServiceIds = (u, tenantId) => isAdmin(u)
  ? all('SELECT id FROM services WHERE tenant_id=?', tenantId).map(r => r.id)
  : all('SELECT service_id id FROM service_members WHERE tenant_id=? AND user_id=?', tenantId, u.id).map(r => r.id);

// ---------- domain ----------
const tenantBySlug = slug => { const t = one('SELECT * FROM tenants WHERE slug=? AND is_active=1', slug); if (!t) throw notFound(); return t; };
const providersFor = (tenantId, serviceId) => all(`SELECT u.id,u.name,u.email,u.phone FROM service_members m JOIN users u ON u.id=m.user_id
  WHERE m.tenant_id=? AND m.service_id=? AND u.is_active=1`, tenantId, serviceId);
function targetHours(tenantId, serviceId, priority) {
  const r = one('SELECT target_hours h FROM sla_policies WHERE tenant_id=? AND service_id=? AND priority=?', tenantId, serviceId, priority)
    || one('SELECT target_hours h FROM sla_policies WHERE tenant_id=? AND service_id IS NULL AND priority=?', tenantId, priority);
  return r ? r.h : DEFAULT_HOURS[priority];
}
const fmtIST = iso => new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
const addH = (iso, h) => new Date(new Date(iso).getTime() + h * 3600e3).toISOString();
const tenantRow = id => one('SELECT * FROM tenants WHERE id=?', id);
const calOf = tenantId => calendar(tenantRow(tenantId));
const holdReasons = tn => { try { return JSON.parse(tn.hold_reasons) || DEFAULT_HOLD_REASONS; } catch { return DEFAULT_HOLD_REASONS; } };
const dueFrom = (tenantId, startIso, minutes) => addWorking(calOf(tenantId), startIso, minutes);
function award(t, userId, points, reason) {
  if (userId) insert('provider_points', { id: uid(), tenant_id: t.tenant_id, user_id: userId, ticket_id: t.id, points, reason, created_at: now() });
}
// Leaving hold: shift the due time by the working time held, and penalise a hold that ran past its own SLA.
function leaveHold(t, ts) {
  const held = workingBetween(calOf(t.tenant_id), t.hold_started_at, ts);
  if (t.hold_due_at && ts > t.hold_due_at) award(t, t.hold_by, POINTS.holdBreach, 'Hold ran past its hold SLA');
  return { held, due: addWorking(calOf(t.tenant_id), t.due_at, held) };
}

// Validate and normalise a service's custom form (built in the admin's field builder).
function cleanSchema(fs) {
  const fields = Array.isArray(fs?.fields) ? fs.fields : [], keys = new Set();
  if (fields.length > 30) throw bad('At most 30 questions per service');
  const out = fields.map((f, i) => {
    const label = String(f.label || '').trim().slice(0, 80); if (!label) throw bad(`Question ${i + 1} needs a label`);
    if (!FIELD_TYPES.includes(f.type)) throw bad(`"${label}" has an unknown answer type`);
    const key = String(f.key || label).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'q' + (i + 1);
    if (keys.has(key)) throw bad(`Two questions share the key "${key}"`); keys.add(key);
    if (/^(loc|stu)_/.test(key)) throw bad(`"${label}" uses a reserved name; rename the question`);
    const o = { key, label, type: f.type, required: !!f.required };
    if (['select', 'multi_select'].includes(f.type)) {
      o.options = [...new Set((f.options || []).map(x => String(x).trim()).filter(Boolean))].slice(0, 50);
      if (o.options.length < 2) throw bad(`"${label}" needs at least two choices`);
    } else if (f.placeholder) o.placeholder = String(f.placeholder).trim().slice(0, 120);
    return o;
  });
  const list = a => [...new Set((Array.isArray(a) ? a : []).map(x => String(x).trim()).filter(Boolean))].slice(0, 100);
  const form_type = FORM_TYPES[fs?.form_type] ? fs.form_type : 'general';
  return { ...(fs?.icon ? { icon: String(fs.icon).slice(0, 20) } : {}), form_type,
    lists: { block: list(fs?.lists?.block), floor: list(fs?.lists?.floor ?? ['Ground floor', '1st floor', '2nd floor', '3rd floor', '4th floor']), branch: list(fs?.lists?.branch) }, fields: out };
}

function buildFormCheck(schema, data = {}) {
  const errs = {};
  for (const f of fieldsOf(schema)) {
    const v = data[f.key];
    const empty = v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);
    if (f.required && empty) { errs[f.key] = `${f.label} is required`; continue; }
    if (empty) continue;
    if (f.type === 'number' && isNaN(Number(v))) errs[f.key] = 'Must be a number';
    if (f.type === 'email' && !/^\S+@\S+\.\S+$/.test(v)) errs[f.key] = 'Invalid email';
    if (f.type === 'select' && !(f.options || []).includes(v)) errs[f.key] = 'Pick an option';
    if (f.type === 'multi_select' && (!Array.isArray(v) || v.some(x => !(f.options || []).includes(x)))) errs[f.key] = 'Pick options';
  }
  if (Object.keys(errs).length) throw bad('Please fix the form', errs);
}

// Plain running number per campus: 0001, 0002, ... (year 0 = one counter that never resets)
const normNo = no => { const s = String(no).trim(); return /^\d+$/.test(s) ? s.padStart(4, '0') : s.toUpperCase(); };
function nextTicketNo(tenant) {
  const r = one(`INSERT INTO ticket_counters (tenant_id,year,last_number) VALUES (?,0,1)
    ON CONFLICT (tenant_id,year) DO UPDATE SET last_number=last_number+1 RETURNING last_number`, tenant.id);
  return String(r.last_number).padStart(4, '0');
}

function addEvent(t, actor, type, o = {}) {
  const r = insert('ticket_events', { tenant_id: t.tenant_id, ticket_id: t.id, actor_type: actor.type, actor_id: actor.id, actor_name: actor.name,
    event_type: type, from_value: o.from, to_value: o.to, body: o.body, is_internal: o.internal ? 1 : 0, meta: JSON.stringify(o.meta || {}), created_at: now() });
  return Number(one('SELECT last_insert_rowid() id').id);
}

// files arrive as [{name, type, data(base64 dataURL), source}]
function saveFiles(t, eventId, files = [], byType) {
  if (!Array.isArray(files)) return;
  if (files.length > 5) throw bad('At most 5 files');
  for (const f of files) {
    if (!/^(image\/(jpeg|png|webp|gif|heic)|application\/pdf)$/.test(f.type || '')) throw bad('Only images or PDF');
    const buf = Buffer.from(String(f.data).split(',').pop(), 'base64');
    if (buf.length > 5 * 1024 * 1024) throw new HttpErr(413, 'TOO_LARGE', 'Each file must be under 5 MB');
    const key = crypto.randomBytes(18).toString('hex') + path.extname(f.name || '').toLowerCase().replace(/[^.a-z0-9]/g, '');
    fs.writeFileSync(path.join(UPLOAD_DIR, key), buf);
    insert('attachments', { id: uid(), tenant_id: t.tenant_id, ticket_id: t.id, event_id: eventId, uploaded_by_type: byType,
      source: ['camera', 'gallery', 'file'].includes(f.source) ? f.source : 'file', file_name: String(f.name || 'file').slice(0, 120),
      mime_type: f.type, size_bytes: buf.length, stamped_at: f.source === 'camera' ? now() : null, storage_key: key, created_at: now() });
  }
}

// ---------- notifications (outbox + worker) ----------
const queue = [];
// Queue one email per recipient, written from that step's template (Email page → Emails sent) and these values.
function notify(t, recipients, key, vars = {}) {
  const cfg = mailConfig(BASE), on = eventOn(cfg, key); // events switched off on the Email page are logged as skipped
  const v = { login_link: `${base()}/#/login`, ...vars }, { subject, body } = renderTemplate(cfg, key, v);
  const blocks = Object.fromEntries(BLOCKS.filter(b => v[b]).map(b => [b, v[b]]));
  const html = renderEmail({ subject, body, campus: t.tenant_id ? tenantRow(t.tenant_id)?.name : '', blocks }), text_body = toText(body, blocks);
  for (const to of [...new Set(recipients.filter(Boolean))]) {
    const id = uid();
    insert('notifications', { id, tenant_id: t.tenant_id, ticket_id: t.id || null, recipient: to, template_key: key,
      subject, body, html, text_body, status: on ? 'queued' : 'skipped', created_at: now() });
    if (on) queue.push(id);
  }
}
// Everything a ticket email can show; `extra` adds the values for one step (note, hold reason…).
function ticketVars(t, extra = {}) {
  t = one('SELECT * FROM tickets WHERE id=?', t.id) || t;
  const tn = tenantRow(t.tenant_id), svc = one('SELECT name FROM services WHERE id=?', t.service_id), r = one('SELECT name FROM requestors WHERE id=?', t.requestor_id);
  const svcRow = one('SELECT name, form_schema FROM services WHERE id=?', t.service_id), fd = JSON.parse(t.form_data || '{}'), held = t.status === 'hold';
  const answers = fieldsOf(JSON.parse(svcRow?.form_schema || '{}')).filter(f => !f.key.startsWith('loc_')).map(f => [f.label, Array.isArray(fd[f.key]) ? fd[f.key].join(', ') : fd[f.key]]).filter(([, a]) => a !== undefined && a !== '');
  const provNames = providersFor(t.tenant_id, t.service_id).map(p => p.name).join(', ');
  const escName = t.escalated_to ? one('SELECT name FROM users WHERE id=?', t.escalated_to)?.name || '' : '';
  const progress = { escalated_to: ['open', 'hold'].includes(t.status) ? escName : '', status: t.status, service: svc?.name, due: fmtIST(t.due_at), reopen_days: tn.reopen_window_days, closed_at: t.closed_at ? fmtIST(t.closed_at) : '',
    hold_reason: held && t.hold_reason ? holdReasons(tn).find(x => x.key === t.hold_reason)?.label || '' : '', resume_by: held && t.hold_due_at ? fmtIST(t.hold_due_at) : '' };
  const ticket_details = [['Ticket', t.ticket_no], ['Service', svc?.name], ['Subject', t.subject], ['Description', t.description], ['Location', t.location], ...answers,
    ['Priority', t.priority[0].toUpperCase() + t.priority.slice(1)], ['Raised on', fmtIST(t.created_at)], ...(['open', 'hold'].includes(t.status) ? [['Target', fmtIST(t.due_at)]] : []),
    ['Handled by', provNames || 'Being assigned']].filter(([, x]) => x !== undefined && x !== null && String(x).trim() !== '').map(([k, x]) => [k, String(x)]);
  const SW = { hold: 'Put on hold', open: 'Work resumed', closed: 'Resolved', rejected: 'Not accepted' };
  const timeline = all('SELECT * FROM ticket_events WHERE ticket_id=? AND is_internal=0 ORDER BY id DESC LIMIT 6', t.id).map(e => {
    const m = JSON.parse(e.meta || '{}'), who = e.actor_name || '';
    const label = { escalated: `Escalated to ${e.to_value}`, created: 'Ticket received', note: `Note from ${who}`, reopened: `Reopened by ${who}`, transferred: `Moved to ${e.to_value}`,
      status_changed: `${SW[e.to_value] || e.to_value}${who ? ` by ${who}` : ''}${m.hold_reason ? ` · ${m.hold_reason}` : ''}` }[e.event_type] || e.event_type;
    return { at: new Date(e.created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }), label, body: e.body || '' };
  });
  return { progress, ticket_details, timeline, escalated_to_name: escName,
    ticket_no: t.ticket_no, subject: t.subject, description: t.description || '', location: t.location || '', service: svc?.name || '', campus: tn.name,
    requestor_name: r?.name || '', status: STATUS_WORDS[t.status] || t.status, priority: t.priority[0].toUpperCase() + t.priority.slice(1), due: fmtIST(t.due_at),
    providers: providersFor(t.tenant_id, t.service_id).map(p => p.name).join(', '), ticket_link: trackUrl(t), staff_link: `${base()}/#/c/t/${t.id}`,
    portal_link: `${base()}/#/d/${tn.slug}`, reopen_days: tn.reopen_window_days, ...extra };
}
const staffVars = (u, pw) => ({ staff_name: u.name, staff_email: u.email, temp_password: pw, campus: u.tenant_id ? tenantRow(u.tenant_id)?.name : 'ONE Desk' });
const trackUrl = (t) => { const tn = one('SELECT slug FROM tenants WHERE id=?', t.tenant_id); return `${base()}/#/d/${tn.slug}/t/${t.ticket_no}?k=${t.tracking_token}`; };
// Statuses: queued → sent | failed (after 4 tries); 'logged' = no flow connected or sending paused (printed to the server log only).
async function sendOne(id) {
  const n = one('SELECT * FROM notifications WHERE id=?', id); if (!n || n.status !== 'queued') return;
  const cfg = mailConfig(BASE);
  if (!cfg.url || !cfg.sending) {
    console.log(`✉  ${n.recipient} — ${n.subject}`);
    return run("UPDATE notifications SET status='logged', last_error=? WHERE id=?", cfg.url ? 'Sending is paused' : 'No Power Automate flow connected', id);
  }
  const campus = n.tenant_id ? one('SELECT name FROM tenants WHERE id=?', n.tenant_id)?.name : '';
  const r = await postToFlow(cfg, { to: n.recipient, subject: n.subject, html: n.html || renderEmail({ subject: n.subject, body: n.body, campus }), text: n.text_body || toText(n.body) });
  if (r.ok) { run("UPDATE notifications SET status='sent', sent_at=?, attempts=attempts+1, last_error=NULL WHERE id=?", now(), id); setSetting('mail_last_ok_at', now()); return; }
  const a = n.attempts + 1;
  run('UPDATE notifications SET attempts=?, last_error=?, status=? WHERE id=?', a, `${r.status || 'network'}: ${r.hint}`, a >= 4 ? 'failed' : 'queued', id);
  if (a < 4) setTimeout(() => queue.push(id), [60e3, 300e3, 1800e3][a - 1]);
}
setInterval(() => { while (queue.length) sendOne(queue.shift()); }, 1000);
for (const r of all("SELECT id FROM notifications WHERE status='queued'")) queue.push(r.id); // resume after a restart

// daily 08:30 digest
let lastDigest = '';
setInterval(() => {
  const d = new Date(), key = d.toDateString();
  if (d.getHours() !== 8 || d.getMinutes() < 30 || lastDigest === key) return;
  lastDigest = key;
  for (const u of all("SELECT * FROM users WHERE is_active=1 AND role!='super_admin'")) {
    const sids = myServiceIds(u, u.tenant_id); if (!sids.length) continue;
    const q = all(`SELECT ticket_no,subject,status,due_at FROM tickets WHERE tenant_id=? AND service_id IN (${sids.map(() => '?').join()})
      AND ((status='open' AND due_at<?) OR status='hold')`, u.tenant_id, ...sids, now());
    if (q.length) notify({ tenant_id: u.tenant_id }, [u.email], 'digest', { staff_name: u.name, campus: tenantRow(u.tenant_id)?.name, count: q.length,
      ticket_list: q.map(x => `${x.ticket_no} · ${x.status === 'hold' ? 'on hold' : 'overdue'} · ${x.subject}`).join('\n') });
  }
}, 60e3);

// ---------- escalation ----------
// A ticket goes to its service's providers first. When it misses its target (or a hold passes its limit) by the
// campus's "escalate after" working days, it escalates to the service's escalation person (a campus admin if none is set).
function escalationDue(t, tn) {
  const cal = calendar(tn), mins = Math.round((tn.escalate_after_days || 0) * (cal.end - cal.start));
  const from = t.status === 'open' ? t.due_at : tn.escalate_holds ? t.hold_due_at : null;
  if (!from) return null;
  return mins > 0 ? addWorking(cal, from, mins) : from; // 0 days = the moment the target is missed
}
function escalate(t) {
  const svc = one('SELECT escalation_user_id FROM services WHERE id=?', t.service_id);
  const target = (svc?.escalation_user_id && one('SELECT id, name, email FROM users WHERE id=? AND is_active=1', svc.escalation_user_id))
    || one("SELECT id, name, email FROM users WHERE tenant_id=? AND role='tenant_admin' AND is_active=1 ORDER BY name LIMIT 1", t.tenant_id);
  if (!target) return; // nobody to escalate to: the ticket stays on the attention list as overdue
  const ts = now(), missed = t.status === 'open' ? `its target of ${fmtIST(t.due_at)}` : `its hold limit of ${fmtIST(t.hold_due_at)}`;
  const done = tx(() => {
    if (!run('UPDATE tickets SET escalated_at=?, escalated_to=?, updated_at=? WHERE id=? AND escalated_at IS NULL', ts, target.id, ts, t.id).changes) return false;
    addEvent(t, { type: 'system', name: 'ONE Desk' }, 'escalated', { to: target.name, body: `Escalated automatically: the ticket passed ${missed}.` });
    return true;
  });
  if (!done) return;
  const v = ticketVars(t, { escalated_to_name: target.name, note: `The ticket passed ${missed}.` });
  notify(t, [target.email, ...providersFor(t.tenant_id, t.service_id).map(p => p.email)], 'escalated', v);
  notify(t, [one('SELECT email FROM requestors WHERE id=?', t.requestor_id)?.email], 'escalated_requestor', v);
}
function runEscalations() {
  const n = now();
  for (const tn of all('SELECT * FROM tenants WHERE is_active=1')) {
    const due = all(`SELECT * FROM tickets WHERE tenant_id=? AND escalated_at IS NULL AND ((status='open' AND due_at<?) OR (status='hold' AND hold_due_at<?))`, tn.id, n, n);
    for (const t of due) { try { const at = escalationDue(t, tn); if (at && at <= n) escalate(t); } catch (e) { console.error('escalation', t.ticket_no, e.message); } }
  }
}
setInterval(runEscalations, 60e3); setTimeout(runEscalations, 3000);

// ---------- ticket creation (shared by portal and staff) ----------
function createTicket(tenant, b, opts) {
  const svc = one('SELECT * FROM services WHERE id=? AND tenant_id=? AND is_active=1', b.service_id, tenant.id);
  if (!svc) throw notFound();
  req_(b.name, 'Name is required'); req_(b.subject, 'Subject is required');
  if (!/^\S+@\S+\.\S+$/.test(String(b.email || '').trim())) throw bad('A valid email address is required, so we can send you updates');
  if (b.requestor_type && !REQUESTOR_TYPES.includes(b.requestor_type)) throw bad('Bad requestor type');
  const schema = JSON.parse(svc.form_schema || '{}'), fd = b.form_data || {};
  buildFormCheck(schema, fd);
  // the form type's answers fill the ticket's location and the requestor's ID / department
  if (hasLocation(schema)) b.location = [fd.loc_block, fd.loc_floor, fd.loc_room].filter(Boolean).join(' · ');
  else if (isGeneral(schema) && opts.channel !== 'internal') req_(b.location, 'Location is required');
  if (hasStudent(schema)) Object.assign(b, { identifier: fd.stu_id, department: fd.stu_dept, requestor_type: b.requestor_type || 'student' });
  if (b.idempotency_key) {
    const ex = one('SELECT * FROM tickets WHERE tenant_id=? AND idempotency_key=?', tenant.id, b.idempotency_key);
    if (ex) return ex;
  }
  const t = tx(() => {
    const email = b.email ? String(b.email).toLowerCase().trim() : null, phone = b.phone ? String(b.phone).trim() : null;
    let r = (email && one('SELECT * FROM requestors WHERE tenant_id=? AND lower(email)=?', tenant.id, email))
      || (phone && one('SELECT * FROM requestors WHERE tenant_id=? AND phone=?', tenant.id, phone));
    if (r) run('UPDATE requestors SET name=?, email=coalesce(?,email), phone=coalesce(?,phone), requestor_type=coalesce(?,requestor_type), identifier=coalesce(?,identifier), department=coalesce(?,department) WHERE id=?',
      b.name, email, phone, b.requestor_type || null, b.identifier || null, b.department || null, r.id);
    else r = insert('requestors', { id: uid(), tenant_id: tenant.id, name: b.name, email, phone, requestor_type: b.requestor_type, identifier: b.identifier, department: b.department });
    const ts = now(), priority = PRIORITIES.includes(b.priority) && opts.actor.type === 'user' ? b.priority : 'medium';
    const t = insert('tickets', { id: uid(), tenant_id: tenant.id, ticket_no: nextTicketNo(tenant), service_id: svc.id, requestor_id: r.id,
      subject: String(b.subject).slice(0, 200), description: b.description, location: b.location, form_data: JSON.stringify(b.form_data || {}),
      priority, status: 'open', channel: opts.channel, is_internal: opts.channel === 'internal' ? 1 : 0, created_by_user_id: opts.actor.type === 'user' ? opts.actor.id : null,
      due_at: dueFrom(tenant.id, ts, targetHours(tenant.id, svc.id, priority) * 60), tracking_token: crypto.randomBytes(24).toString('base64url'),
      idempotency_key: b.idempotency_key || null, created_at: ts, updated_at: ts, held_minutes: 0, reopen_count: 0 });
    const ev = addEvent(t, opts.actor, 'created', { to: svc.name, meta: b.related_ticket_no ? { related_ticket_no: b.related_ticket_no } : {} });
    saveFiles(t, ev, b.files, opts.actor.type);
    return t;
  });
  const prov = providersFor(tenant.id, svc.id);
  const v = ticketVars(t);
  notify(t, [b.email || null], 'created', v);
  notify(t, prov.map(p => p.email), 'new_ticket', v);
  return t;
}

// ---------- public view ----------
function publicTicket(t) {
  const svc = one('SELECT name, code FROM services WHERE id=?', t.service_id), tn = one('SELECT * FROM tenants WHERE id=?', t.tenant_id);
  const ev = all('SELECT id,event_type,from_value,to_value,body,actor_type,actor_name,created_at FROM ticket_events WHERE ticket_id=? AND is_internal=0 ORDER BY id', t.id);
  const att = all('SELECT event_id,file_name,mime_type,storage_key,source,stamped_at FROM attachments WHERE ticket_id=?', t.id);
  return { ticket_no: t.ticket_no, subject: t.subject, description: t.description, location: t.location, status: t.status, priority: t.priority,
    due_at: t.due_at, created_at: t.created_at, closed_at: t.closed_at, reopen_count: t.reopen_count, service: svc.name,
    hold_label: t.status === 'hold' && t.hold_reason ? holdReasons(tn).find(r => r.key === t.hold_reason)?.label : null, hold_due_at: t.status === 'hold' ? t.hold_due_at : null,
    reopen_until: t.status === 'closed' ? addH(t.closed_at, tn.reopen_window_days * 24) : null,
    providers: tn.show_provider_contact ? providersFor(t.tenant_id, t.service_id).map(({ name, email, phone }) => ({ name, email, phone })) : [],
    events: ev.map(e => ({ ...e, actor_name: e.actor_type === 'requestor' ? 'You' : e.actor_name, files: att.filter(a => a.event_id === e.id) })) };
}
function findPublic(slug, no, q) {
  const tn = tenantBySlug(slug);
  const t = one('SELECT * FROM tickets WHERE tenant_id=? AND ticket_no=?', tn.id, normNo(no));
  if (!t) throw notFound();
  return t; // the ticket number alone opens the ticket

}

const P = express.Router();
P.get('/', wrap(() => all('SELECT name, code, slug FROM tenants WHERE is_active=1 ORDER BY name')));
P.get('/:slug', wrap(req => {
  const tn = tenantBySlug(req.params.slug);
  return { tenant: { name: tn.name, code: tn.code, slug: tn.slug },
    services: all('SELECT id,code,name,description,form_schema FROM services WHERE tenant_id=? AND is_active=1 ORDER BY sort_order,name', tn.id)
      .map(s => ({ ...s, form_schema: JSON.parse(s.form_schema), providers: providersFor(tn.id, s.id).map(p => p.name.split(' ')[0]) })) };
}));
P.post('/:slug/tickets', wrap(req => {
  const tn = tenantBySlug(req.params.slug), b = req.body;
  if (b.website) throw bad('Rejected'); // honeypot
  limit('ip:' + req.ip, 20); limit('c:' + (b.email || b.phone || ''), 5);
  const t = createTicket(tn, b, { channel: 'portal', actor: { type: 'requestor', name: b.name } });
  return { ticket_no: t.ticket_no, tracking_token: t.tracking_token, due_at: t.due_at,
    providers: providersFor(tn.id, t.service_id).map(({ name, phone }) => ({ name, phone })) };
}));
P.get('/:slug/tickets/:no', wrap(req => publicTicket(findPublic(req.params.slug, req.params.no, req.query))));
P.post('/:slug/tickets/:no/notes', wrap(req => {
  const t = findPublic(req.params.slug, req.params.no, req.body);
  limit('note:' + t.id, 20);
  if (t.status === 'rejected') throw new HttpErr(409, 'BAD_TRANSITION', 'This ticket is rejected; raise a new one');
  const r = one('SELECT name FROM requestors WHERE id=?', t.requestor_id);
  tx(() => { const ev = addEvent(t, { type: 'requestor', id: t.requestor_id, name: r.name }, 'note', { body: req_(req.body.body, 'Write a note') });
    saveFiles(t, ev, req.body.files, 'requestor'); run('UPDATE tickets SET updated_at=? WHERE id=?', now(), t.id); });
  notify(t, providersFor(t.tenant_id, t.service_id).map(p => p.email), 'requestor_note', ticketVars(t, { note: req.body.body }));
  return publicTicket(one('SELECT * FROM tickets WHERE id=?', t.id));
}));
P.post('/:slug/tickets/:no/reopen', wrap(req => {
  const t = findPublic(req.params.slug, req.params.no, req.body), tn = one('SELECT * FROM tenants WHERE id=?', t.tenant_id);
  assertTransition(t.status, 'open', 'requestor');
  if (Date.now() > new Date(addH(t.closed_at, tn.reopen_window_days * 24)).getTime()) throw new HttpErr(409, 'BAD_TRANSITION', 'The reopen window has passed; raise a new ticket');
  const r = one('SELECT name FROM requestors WHERE id=?', t.requestor_id);
  doReopen(t, { type: 'requestor', id: t.requestor_id, name: r.name }, req_(req.body.reason, 'Give a reason'));
  return publicTicket(one('SELECT * FROM tickets WHERE id=?', t.id));
}));
function doReopen(t, actor, reason) {
  tx(() => {
    if (actor.type === 'requestor') award(t, t.closed_by, POINTS.reopened, 'Requestor reopened the ticket');
    run('UPDATE tickets SET status=?, reopen_count=reopen_count+1, closed_at=NULL, closed_by=NULL, escalated_at=NULL, escalated_to=NULL, due_at=?, updated_at=? WHERE id=?',
      'open', dueFrom(t.tenant_id, now(), targetHours(t.tenant_id, t.service_id, t.priority) * 60), now(), t.id);
    addEvent(t, actor, 'reopened', { from: 'closed', to: 'open', body: reason });
  });
  notify(t, providersFor(t.tenant_id, t.service_id).map(p => p.email), 'reopened', ticketVars(t, { note: reason, actor_name: actor.type === 'requestor' ? `the requestor (${actor.name})` : actor.name }));
}
app.use('/api/public', P);
app.get('/api/files/:key', (req, res) => {
  const a = one('SELECT * FROM attachments WHERE storage_key=?', req.params.key);
  if (!a) return res.status(404).end();
  res.type(a.mime_type).sendFile(path.resolve(UPLOAD_DIR, a.storage_key));
});
app.get('/api/health', (_q, r) => r.json({ ok: true }));

// ---------- auth ----------
app.post('/api/auth/login', wrap(req => {
  limit('login:' + req.ip, 30, 900e3);
  const u = one('SELECT * FROM users WHERE lower(email)=lower(?) AND is_active=1', req.body.email || '');
  if (!u || !checkPw(req.body.password || '', u.password_hash)) throw new HttpErr(401, 'UNAUTHORIZED', 'Wrong email or password');
  run('UPDATE users SET last_login_at=? WHERE id=?', now(), u.id);
  return { token: sign({ sub: u.id, role: u.role, tid: u.tenant_id }) };
}));

const S = express.Router();
S.use(auth);
S.get('/me', wrap(req => {
  const { password_hash, ...u } = req.user;
  return { user: u, tenants: u.role === 'super_admin' ? all('SELECT * FROM tenants ORDER BY name') : all('SELECT * FROM tenants WHERE id=?', u.tenant_id) };
}));
S.post('/me/password', wrap(req => {
  const pw = String(req.body.password || '');
  // after an admin reset the temporary password was just used to sign in; otherwise the current password is required
  if (!req.user.must_change_pw && !checkPw(String(req.body.current || ''), req.user.password_hash)) throw bad('Current password is wrong');
  if (pw.length < 8 || !/[A-Za-z]/.test(pw) || !/\d/.test(pw)) throw bad('Use at least 8 characters with letters and numbers');
  if (checkPw(pw, req.user.password_hash)) throw bad('Pick a password different from the current one');
  run('UPDATE users SET password_hash=?, must_change_pw=0 WHERE id=?', hashPw(pw), req.user.id); return { ok: true };
}));

// tenants (super admin)
S.post('/tenants', role('super_admin'), wrap(req => {
  const b = req.body; req_(b.code, 'Code required'); req_(b.name, 'Name required'); req_(b.slug, 'Slug required');
  const code = String(b.code).trim().toUpperCase(), slug = String(b.slug).trim().toLowerCase();
  if (!/^[A-Z0-9]{2,10}$/.test(code)) throw bad('Code: 2–10 letters or digits, e.g. SMRU');
  if (!/^[a-z0-9-]{2,30}$/.test(slug)) throw bad('Slug: lowercase letters, digits and hyphens, e.g. smru');
  if (one('SELECT 1 FROM tenants WHERE code=? OR slug=?', code, slug)) throw new HttpErr(409, 'CONFLICT', 'A campus with that code or slug already exists');
  b.code = code; b.slug = slug;
  const t = insert('tenants', { id: uid(), code: b.code.toUpperCase(), name: b.name, slug: b.slug.toLowerCase(), timezone: b.timezone || 'Asia/Kolkata',
    show_provider_contact: b.show_provider_contact === false ? 0 : 1, reopen_window_days: Number(b.reopen_window_days) || 7, is_active: 1 });
  for (const [p, h] of Object.entries(DEFAULT_HOURS)) insert('sla_policies', { id: uid(), tenant_id: t.id, service_id: null, priority: p, target_hours: h });
  audit(req, 'tenant.create', 'tenant', t.id, b); return t;
}));
S.patch('/tenants/:id', role('super_admin'), wrap(req => {
  const b = req.body, t = one('SELECT * FROM tenants WHERE id=?', req.params.id); if (!t) throw notFound();
  run('UPDATE tenants SET name=?, timezone=?, show_provider_contact=?, reopen_window_days=?, is_active=? WHERE id=?',
    b.name ?? t.name, b.timezone ?? t.timezone, b.show_provider_contact ?? t.show_provider_contact, b.reopen_window_days ?? t.reopen_window_days, b.is_active ?? t.is_active, t.id);
  audit(req, 'tenant.update', 'tenant', t.id, b); return one('SELECT * FROM tenants WHERE id=?', t.id);
}));

// everything below is tenant scoped
S.use(needTenant);
S.get('/users', role('super_admin', 'tenant_admin'), wrap(req =>
  all(`SELECT u.id,u.name,u.email,u.phone,u.role,u.is_active,u.last_login_at,u.must_change_pw,
    (SELECT group_concat(s.name, ', ') FROM service_members m JOIN services s ON s.id=m.service_id WHERE m.user_id=u.id) services
    FROM users u WHERE u.tenant_id=? ORDER BY u.is_active DESC, u.role DESC, u.name`, req.tenantId)));
const tempPw = () => crypto.randomBytes(6).toString('base64url').replace(/[-_]/g, 'x') + Math.floor(10 + Math.random() * 90);
// a tenant admin manages providers (and edits themselves); only the super admin manages tenant admins
function managed(req) {
  const u = one('SELECT * FROM users WHERE id=? AND tenant_id=?', req.params.id, req.tenantId); if (!u) throw notFound();
  if (req.user.role !== 'super_admin' && u.role !== 'provider' && u.id !== req.user.id) throw forbid();
  return u;
}
S.post('/users', role('super_admin', 'tenant_admin'), wrap(req => {
  const b = req.body; req_(b.name, 'Name required'); req_(b.email, 'Email required');
  const r = b.role === 'tenant_admin' ? 'tenant_admin' : 'provider';
  if (r === 'tenant_admin' && req.user.role !== 'super_admin') throw forbid();
  if (one('SELECT 1 FROM users WHERE lower(email)=lower(?)', b.email)) throw new HttpErr(409, 'CONFLICT', 'Email already in use');
  const pw = tempPw();
  const u = insert('users', { id: uid(), tenant_id: req.tenantId, name: b.name, email: String(b.email).trim(), phone: b.phone, role: r, password_hash: hashPw(pw), is_active: 1, must_change_pw: 1 });
  notify({ tenant_id: req.tenantId }, [u.email], 'invite', staffVars(u, pw));
  audit(req, 'user.create', 'user', u.id, { email: u.email, role: r });
  return { id: u.id, temp_password: pw };
}));
S.patch('/users/:id', role('super_admin', 'tenant_admin'), wrap(req => {
  const u = managed(req), b = req.body;
  if (b.is_active === 0 && u.id === req.user.id) throw bad("You can't deactivate yourself");
  if (b.role && b.role !== u.role) {
    if (req.user.role !== 'super_admin' || !['provider', 'tenant_admin'].includes(b.role)) throw forbid();
  }
  const email = b.email ? String(b.email).trim() : u.email;
  if (!/^\S+@\S+\.\S+$/.test(email)) throw bad('Enter a valid email');
  if (email.toLowerCase() !== u.email.toLowerCase() && one('SELECT 1 FROM users WHERE lower(email)=lower(?)', email)) throw new HttpErr(409, 'CONFLICT', 'Email already in use');
  run('UPDATE users SET name=?, email=?, phone=?, role=?, is_active=? WHERE id=?', String(b.name ?? u.name).trim() || u.name, email, b.phone ?? u.phone, b.role || u.role, b.is_active ?? u.is_active, u.id);
  if (b.is_active === 0) run('DELETE FROM service_members WHERE user_id=?', u.id);
  audit(req, 'user.update', 'user', u.id, b); return { ok: true };
}));
S.post('/users/:id/reset-password', role('super_admin', 'tenant_admin'), wrap(req => {
  const u = managed(req);
  if (u.id === req.user.id) throw bad('Change your own password from Profile');
  if (!u.is_active) throw bad('Activate this account first');
  const pw = tempPw();
  run('UPDATE users SET password_hash=?, must_change_pw=1 WHERE id=?', hashPw(pw), u.id);
  notify({ tenant_id: req.tenantId }, [u.email], 'password_reset', staffVars(u, pw));
  audit(req, 'user.reset_password', 'user', u.id, { email: u.email });
  return { temp_password: pw };
}));

// The escalation person must be an active provider or campus admin of this campus.
function escalationUser(req, id) {
  if (!id) return null;
  if (!one("SELECT 1 FROM users WHERE id=? AND tenant_id=? AND is_active=1 AND role IN ('provider','tenant_admin')", id, req.tenantId)) throw bad('Pick an escalation person from this campus’s providers');
  return id;
}
S.get('/services', wrap(req => all('SELECT * FROM services WHERE tenant_id=? ORDER BY sort_order,name', req.tenantId)
  .map(s => ({ ...s, form_schema: JSON.parse(s.form_schema), members: providersFor(req.tenantId, s.id),
    escalation_user: s.escalation_user_id ? one('SELECT id, name FROM users WHERE id=? AND is_active=1', s.escalation_user_id) || null : null,
    sla: Object.fromEntries(all('SELECT priority,target_hours FROM sla_policies WHERE tenant_id=? AND service_id=?', req.tenantId, s.id).map(x => [x.priority, x.target_hours])) }))));
S.post('/services', role('super_admin', 'tenant_admin'), wrap(req => {
  const b = req.body; req_(b.code, 'Code required'); req_(b.name, 'Name required');
  if (one('SELECT 1 FROM services WHERE tenant_id=? AND code=?', req.tenantId, b.code.toUpperCase())) throw new HttpErr(409, 'CONFLICT', 'Code exists');
  const s = insert('services', { id: uid(), tenant_id: req.tenantId, code: b.code.toUpperCase(), name: b.name, description: b.description,
    form_schema: JSON.stringify(cleanSchema(b.form_schema)), is_active: 1, sort_order: Number(b.sort_order) || 0, escalation_user_id: escalationUser(req, b.escalation_user_id) });
  audit(req, 'service.create', 'service', s.id, b); return s;
}));
S.patch('/services/:id', role('super_admin', 'tenant_admin'), wrap(req => {
  const s = one('SELECT * FROM services WHERE id=? AND tenant_id=?', req.params.id, req.tenantId); if (!s) throw notFound();
  const b = req.body;
  run('UPDATE services SET name=?, description=?, form_schema=?, is_active=?, sort_order=? WHERE id=?', b.name ?? s.name, b.description ?? s.description,
    b.form_schema ? JSON.stringify(cleanSchema(b.form_schema)) : s.form_schema, b.is_active ?? s.is_active, b.sort_order ?? s.sort_order, s.id);
  if (b.escalation_user_id !== undefined) run('UPDATE services SET escalation_user_id=? WHERE id=?', escalationUser(req, b.escalation_user_id), s.id);
  if (b.sla) for (const p of PRIORITIES) {
    run('DELETE FROM sla_policies WHERE tenant_id=? AND service_id=? AND priority=?', req.tenantId, s.id, p);
    if (Number(b.sla[p]) > 0) insert('sla_policies', { id: uid(), tenant_id: req.tenantId, service_id: s.id, priority: p, target_hours: Number(b.sla[p]) });
  }
  audit(req, 'service.update', 'service', s.id, b); return { ok: true };
}));
S.put('/services/:id/members', role('super_admin', 'tenant_admin'), wrap(req => {
  const s = one('SELECT * FROM services WHERE id=? AND tenant_id=?', req.params.id, req.tenantId); if (!s) throw notFound();
  const ids = [...new Set(req.body.user_ids || [])];
  if (ids.length > 2) throw bad('A service holds at most two providers');
  for (const id of ids) if (!one("SELECT 1 FROM users WHERE id=? AND tenant_id=? AND is_active=1 AND role IN ('provider','tenant_admin')", id, req.tenantId)) throw notFound();
  tx(() => { run('DELETE FROM service_members WHERE service_id=?', s.id);
    for (const id of ids) insert('service_members', { id: uid(), tenant_id: req.tenantId, service_id: s.id, user_id: id, created_at: now() }); });
  audit(req, 'service.members', 'service', s.id, { user_ids: ids }); return providersFor(req.tenantId, s.id);
}));
// SLA settings: working window, target hours per priority (working hours), hold reasons with their own SLA
S.get('/sla', wrap(req => {
  const tn = tenantRow(req.tenantId);
  return { work_start: tn.work_start, work_end: tn.work_end, work_days: String(tn.work_days).split(',').filter(Boolean).map(Number),
    targets: Object.fromEntries(all('SELECT priority,target_hours FROM sla_policies WHERE tenant_id=? AND service_id IS NULL', req.tenantId).map(x => [x.priority, x.target_hours])),
    escalate_after_days: tn.escalate_after_days ?? 0, escalate_holds: !!tn.escalate_holds,
    hold_reasons: holdReasons(tn), point_rules: POINT_RULES.map(r => ({ ...r, upTo: r.upTo === Infinity ? null : r.upTo })), points: POINTS };
}));
S.put('/sla', role('super_admin', 'tenant_admin'), wrap(req => {
  const b = req.body, hhmm = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (!hhmm.test(b.work_start) || !hhmm.test(b.work_end) || b.work_end <= b.work_start) throw bad('Working hours must be like 09:00 – 17:00');
  const days = [...new Set((b.work_days || []).map(Number))].filter(d => d >= 0 && d <= 6);
  if (!days.length) throw bad('Pick at least one working day');
  const reasons = (b.hold_reasons || []).filter(r => String(r.label || '').trim()).map((r, i) => ({
    key: String(r.key || r.label).toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 30) || 'r' + i, label: String(r.label).trim().slice(0, 60), hours: Number(r.hours) }));
  if (!reasons.length || reasons.some(r => !(r.hours > 0))) throw bad('Each hold reason needs a name and hours above 0');
  if (new Set(reasons.map(r => r.key)).size !== reasons.length) throw bad('Hold reasons must have different names');
  tx(() => {
    run('UPDATE tenants SET work_start=?, work_end=?, work_days=?, hold_reasons=? WHERE id=?', b.work_start, b.work_end, days.join(','), JSON.stringify(reasons), req.tenantId);
    if (b.escalate_after_days !== undefined) {
      const d = Number(b.escalate_after_days); if (!(d >= 0 && d <= 60)) throw bad('Escalate after must be between 0 and 60 working days');
      run('UPDATE tenants SET escalate_after_days=?, escalate_holds=? WHERE id=?', d, b.escalate_holds ? 1 : 0, req.tenantId);
    }
    for (const p of PRIORITIES) if (Number(b.targets?.[p]) > 0) {
      run('DELETE FROM sla_policies WHERE tenant_id=? AND service_id IS NULL AND priority=?', req.tenantId, p);
      insert('sla_policies', { id: uid(), tenant_id: req.tenantId, service_id: null, priority: p, target_hours: Number(b.targets[p]) });
    }
  });
  audit(req, 'sla.update', 'sla', null, b); return { ok: true };
}));

// provider points: my total + history, and the campus leaderboard
S.get('/points', wrap(req => ({
  me: one('SELECT coalesce(sum(points),0) total FROM provider_points WHERE tenant_id=? AND user_id=?', req.tenantId, req.user.id).total,
  history: all(`SELECT p.points, p.reason, p.created_at, t.ticket_no, t.id ticket_id FROM provider_points p LEFT JOIN tickets t ON t.id=p.ticket_id
    WHERE p.tenant_id=? AND p.user_id=? ORDER BY p.created_at DESC LIMIT 15`, req.tenantId, req.user.id),
  leaderboard: all(`SELECT u.id, u.name, coalesce((SELECT sum(points) FROM provider_points p WHERE p.user_id=u.id AND p.tenant_id=u.tenant_id),0) points,
      (SELECT count(*) FROM tickets t WHERE t.closed_by=u.id AND t.status='closed') closed,
      (SELECT round(100.0*sum(t.closed_at<=t.due_at)/max(1,count(*))) FROM tickets t WHERE t.closed_by=u.id AND t.status='closed') on_time
    FROM users u WHERE u.tenant_id=? AND u.is_active=1 AND (u.role='provider' OR EXISTS (SELECT 1 FROM service_members m WHERE m.user_id=u.id))
    ORDER BY points DESC, closed DESC`, req.tenantId),
})));

// tickets
function loadTicket(req) {
  const t = one('SELECT * FROM tickets WHERE id=? AND tenant_id=?', req.params.id, req.tenantId);
  if (!t || !(myServiceIds(req.user, req.tenantId).includes(t.service_id) || t.escalated_to === req.user.id)) throw notFound();
  return t;
}
const actorOf = req => ({ type: 'user', id: req.user.id, name: req.user.name });
const ticketQuery = (req) => {
  const sids = myServiceIds(req.user, req.tenantId);
  // my services' tickets, plus any ticket escalated to me
  const w = [`t.tenant_id=?`, sids.length ? `(t.service_id IN (${sids.map(() => '?').join()}) OR t.escalated_to=?)` : 't.escalated_to=?'], a = [req.tenantId, ...sids, req.user.id], q = req.query;
  if (q.status === 'overdue') { w.push("t.status='open' AND t.due_at<?"); a.push(now()); }
  else if (q.status === 'escalated') w.push("t.escalated_at IS NOT NULL AND t.status IN ('open','hold')");
  else if (q.status && q.status !== 'all') { w.push('t.status=?'); a.push(q.status); }
  if (q.service) { w.push('t.service_id=?'); a.push(q.service); }
  if (q.internal === '0') w.push('t.is_internal=0');
  if (q.q) { w.push('(t.ticket_no LIKE ? OR t.subject LIKE ? OR r.name LIKE ?)'); a.push(...Array(3).fill(`%${q.q}%`)); }
  return { sql: w.join(' AND '), args: a };
};
const LIST_SQL = `SELECT t.id,t.ticket_no,t.subject,t.status,t.priority,t.channel,t.is_internal,t.location,t.due_at,t.created_at,t.updated_at,t.closed_at,t.hold_due_at,t.hold_reason,
  t.escalated_at, eu.name escalated_name, s.name service, s.code service_code, r.name requestor
  FROM tickets t JOIN services s ON s.id=t.service_id JOIN requestors r ON r.id=t.requestor_id LEFT JOIN users eu ON eu.id=t.escalated_to`;
S.get('/tickets', wrap(req => {
  const { sql, args } = ticketQuery(req);
  return all(`${LIST_SQL} WHERE ${sql} ORDER BY CASE t.status WHEN 'open' THEN 0 WHEN 'hold' THEN 1 ELSE 2 END, t.due_at LIMIT 500`, ...args)
    .map(x => ({ ...x, overdue: x.status === 'open' && x.due_at < now() }));
}));
S.get('/tickets.csv', (req, res, next) => { try {
  const { sql, args } = ticketQuery(req);
  const rows = all(`${LIST_SQL} WHERE ${sql} ORDER BY t.created_at DESC`, ...args);
  const cols = ['ticket_no', 'service', 'subject', 'status', 'priority', 'channel', 'requestor', 'location', 'created_at', 'due_at', 'closed_at'];
  res.type('text/csv').attachment('tickets.csv').send([cols.join(','), ...rows.map(r => cols.map(c => `"${String(r[c] ?? '').replace(/"/g, '""')}"`).join(','))].join('\n'));
} catch (e) { next(e); } });
S.get('/tickets/:id', wrap(req => {
  const t = loadTicket(req);
  const tn = tenantRow(t.tenant_id), cal = calendar(tn), n = now();
  return { ...t, form_data: JSON.parse(t.form_data), overdue: t.status === 'open' && t.due_at < n,
    sla_left_min: t.status === 'open' ? (n <= t.due_at ? workingBetween(cal, n, t.due_at) : -workingBetween(cal, t.due_at, n)) : null,
    hold_label: t.hold_reason ? holdReasons(tn).find(r => r.key === t.hold_reason)?.label || t.hold_reason : null,
    hold_over: t.status === 'hold' && t.hold_due_at && t.hold_due_at < n, hold_reasons: holdReasons(tn),
    escalated_name: t.escalated_to ? one('SELECT name FROM users WHERE id=?', t.escalated_to)?.name || null : null,
    service: one('SELECT id,name,code,form_schema FROM services WHERE id=?', t.service_id),
    providers: providersFor(req.tenantId, t.service_id),
    requestor: one('SELECT * FROM requestors WHERE id=?', t.requestor_id),
    requestor_history: all('SELECT id,ticket_no,subject,status,created_at FROM tickets WHERE requestor_id=? AND id!=? ORDER BY created_at DESC LIMIT 5', t.requestor_id, t.id),
    events: all('SELECT * FROM ticket_events WHERE ticket_id=? ORDER BY id', t.id),
    attachments: all('SELECT * FROM attachments WHERE ticket_id=?', t.id),
    tracking_url: trackUrl(t) };
}));
S.post('/tickets', wrap(req => {
  const b = req.body, channel = CHANNELS.includes(b.channel) && b.channel !== 'portal' ? b.channel : 'walk_in';
  const tn = one('SELECT * FROM tenants WHERE id=?', req.tenantId);
  if (channel === 'internal') Object.assign(b, { name: req.user.name, email: req.user.email, phone: req.user.phone, requestor_type: 'staff' });
  return createTicket(tn, b, { channel, actor: actorOf(req) });
}));
S.post('/tickets/:id/status', wrap(req => {
  const t = loadTicket(req), to = req.body.to;
  let note = req_(req.body.note, 'A note is required'), meta = {};
  if (t.status === 'closed' && to === 'open') { doReopen(t, actorOf(req), note); return { ok: true }; }
  assertTransition(t.status, to);
  const ts = now();
  tx(() => {
    if (to === 'hold') {
      const hr = holdReasons(tenantRow(t.tenant_id)).find(r => r.key === req.body.hold_reason);
      if (!hr) throw bad('Pick a hold reason');
      const hdue = dueFrom(t.tenant_id, ts, hr.hours * 60);
      run('UPDATE tickets SET status=?, hold_started_at=?, hold_reason=?, hold_due_at=?, hold_by=?, updated_at=? WHERE id=?', to, ts, hr.key, hdue, req.user.id, ts, t.id);
      meta = { hold_reason: hr.label, hold_due_at: hdue };
    } else if (to === 'open') { const { held, due } = leaveHold(t, ts);
      run('UPDATE tickets SET status=?, held_minutes=held_minutes+?, due_at=?, hold_started_at=NULL, hold_reason=NULL, hold_due_at=NULL, updated_at=? WHERE id=?', to, held, due, ts, t.id); }
    else { let held = 0, due = t.due_at; if (t.status === 'hold') ({ held, due } = leaveHold(t, ts));
      run('UPDATE tickets SET status=?, closed_at=?, closed_by=?, held_minutes=held_minutes+?, due_at=?, hold_started_at=NULL, hold_reason=NULL, hold_due_at=NULL, updated_at=? WHERE id=?', to, ts, req.user.id, held, due, ts, t.id);
      if (to === 'closed') {
        // share of the SLA window used: before due → 1 - remaining/target, after due → 1 + late/target
        const cal = calOf(t.tenant_id), target = targetHours(t.tenant_id, t.service_id, t.priority) * 60;
        const ratio = ts <= due ? 1 - workingBetween(cal, ts, due) / target : 1 + workingBetween(cal, due, ts) / target;
        const rule = closePoints(ratio); award(t, req.user.id, rule.points, rule.reason); meta = { points: rule.points, sla_used_pct: Math.round(ratio * 100) };
      }
    }
    const ev = addEvent(t, actorOf(req), 'status_changed', { from: t.status, to, body: note, internal: req.body.is_internal, meta });
    saveFiles(t, ev, req.body.files, 'user');
  });
  if (!req.body.is_internal) {
    const r = one('SELECT * FROM requestors WHERE id=?', t.requestor_id), url = trackUrl(t);
    notify(t, [r.email], 'status_' + to, ticketVars(t, { note, actor_name: req.user.name,
      hold_reason: meta.hold_reason || '', resume_by: meta.hold_due_at ? fmtIST(meta.hold_due_at) : '' }));
  }
  return { ok: true, points: meta.points };
}));
S.post('/tickets/:id/notes', wrap(req => {
  const t = loadTicket(req), body = req_(req.body.body, 'Write a note');
  tx(() => { const ev = addEvent(t, actorOf(req), 'note', { body, internal: req.body.is_internal }); saveFiles(t, ev, req.body.files, 'user');
    run('UPDATE tickets SET updated_at=? WHERE id=?', now(), t.id); });
  if (!req.body.is_internal) notify(t, [one('SELECT email FROM requestors WHERE id=?', t.requestor_id).email], 'note', ticketVars(t, { note: body, actor_name: req.user.name }));
  return { ok: true };
}));
S.post('/tickets/:id/transfer', wrap(req => {
  const t = loadTicket(req), note = req_(req.body.note, 'A note is required');
  if (!['open', 'hold'].includes(t.status)) throw new HttpErr(409, 'BAD_TRANSITION', 'Only open or on-hold tickets can be transferred', { current: t.status });
  const ns = one('SELECT * FROM services WHERE id=? AND tenant_id=? AND is_active=1', req.body.service_id, req.tenantId);
  if (!ns || ns.id === t.service_id) throw notFound();
  const old = one('SELECT name FROM services WHERE id=?', t.service_id), oldProv = providersFor(t.tenant_id, t.service_id);
  tx(() => { run('UPDATE tickets SET service_id=?, escalated_at=NULL, escalated_to=NULL, updated_at=? WHERE id=?', ns.id, now(), t.id);
    addEvent(t, actorOf(req), 'transferred', { from: old.name, to: ns.name, body: note }); });
  const tv = ticketVars(t, { note, actor_name: req.user.name, from_service: old.name, to_service: ns.name });
  notify(t, [...oldProv, ...providersFor(t.tenant_id, ns.id)].map(p => p.email), 'transferred', tv);
  notify(t, [one('SELECT email FROM requestors WHERE id=?', t.requestor_id).email], 'transferred_requestor', tv);
  return { ok: true };
}));
S.post('/tickets/:id/priority', wrap(req => {
  const t = loadTicket(req), p = req.body.priority;
  if (!PRIORITIES.includes(p) || p === t.priority) throw bad('Pick a different priority');
  if (!['open', 'hold'].includes(t.status)) throw new HttpErr(409, 'BAD_TRANSITION', 'Ticket is not active');
  const due = dueFrom(t.tenant_id, t.created_at, targetHours(t.tenant_id, t.service_id, p) * 60 + t.held_minutes);
  tx(() => { run('UPDATE tickets SET priority=?, due_at=?, updated_at=? WHERE id=?', p, due, now(), t.id);
    addEvent(t, actorOf(req), 'priority_changed', { from: t.priority, to: p, internal: true }); });
  return { ok: true };
}));
S.post('/tickets/:id/extend', role('super_admin', 'tenant_admin'), wrap(req => {
  const t = loadTicket(req), h = Number(req.body.hours), reason = req_(req.body.reason, 'Give a reason');
  if (!(h > 0)) throw bad('Hours must be positive');
  const due = dueFrom(t.tenant_id, t.due_at, h * 60);
  tx(() => { run('UPDATE tickets SET due_at=?, updated_at=? WHERE id=?', due, now(), t.id);
    addEvent(t, actorOf(req), 'due_extended', { from: t.due_at, to: due, body: reason, internal: true }); });
  return { ok: true };
}));

// attention, reports, audit, notifications
S.get('/attention', role('super_admin', 'tenant_admin'), wrap(req => ({
  no_provider: all(`SELECT s.id,s.name,s.code,(SELECT count(*) FROM tickets t WHERE t.service_id=s.id AND t.status IN ('open','hold')) open_count FROM services s
    WHERE s.tenant_id=? AND s.is_active=1 AND NOT EXISTS (SELECT 1 FROM service_members m JOIN users u ON u.id=m.user_id WHERE m.service_id=s.id AND u.is_active=1)`, req.tenantId),
  overdue: all(`${LIST_SQL} WHERE t.tenant_id=? AND t.status='open' AND t.due_at<? ORDER BY t.due_at`, req.tenantId, now()),
  escalated: all(`${LIST_SQL} WHERE t.tenant_id=? AND t.escalated_at IS NOT NULL AND t.status IN ('open','hold') ORDER BY t.escalated_at`, req.tenantId),
  stuck_hold: all(`${LIST_SQL} WHERE t.tenant_id=? AND t.status='hold' AND t.hold_due_at<? ORDER BY t.hold_due_at`, req.tenantId, now()),
  failed_mail: all("SELECT * FROM notifications WHERE tenant_id=? AND status='failed' ORDER BY created_at DESC LIMIT 50", req.tenantId),
})));
S.post('/notifications/:id/resend', role('super_admin', 'tenant_admin'), wrap(req => {
  run("UPDATE notifications SET status='queued', attempts=0 WHERE id=? AND tenant_id=?", req.params.id, req.tenantId); queue.push(req.params.id); return { ok: true };
}));
S.get('/reports', wrap(req => {
  // my services' tickets plus any escalated to me
  const sids = myServiceIds(req.user, req.tenantId);
  const inS = sids.length ? `(service_id IN (${sids.map(() => '?').join()}) OR escalated_to=?)` : 'escalated_to=?', base = [req.tenantId, ...sids, req.user.id], from = addH(now(), -24 * (Number(req.query.days) || 30));
  const n = now();
  return {
    counts: one(`SELECT sum(status='open') open, sum(status='hold') hold, sum(status='open' AND due_at<?) overdue,
      sum(status='closed' AND closed_at>=?) closed_period, sum(created_at>=?) created_period,
      round(avg(CASE WHEN status='closed' AND closed_at>=? THEN (julianday(closed_at)-julianday(created_at))*24 - held_minutes/60.0 END),1) avg_hours,
      round(100.0*sum(status='closed' AND closed_at>=? AND closed_at<=due_at)/max(1,sum(status='closed' AND closed_at>=?)),0) on_time_pct
      FROM tickets WHERE tenant_id=? AND ${inS}`, n, from, from, from, from, from, ...base),
    by_service: all(`SELECT s.name, sum(t.status='open') open, sum(t.status='hold') hold, sum(t.status='closed') closed, sum(t.status='rejected') rejected,
      sum(t.status='open' AND t.due_at<?) overdue FROM tickets t JOIN services s ON s.id=t.service_id WHERE t.tenant_id=? AND ${inS} AND t.created_at>=? GROUP BY s.name`, n, ...base, from),
    daily: all(`SELECT substr(created_at,1,10) d, count(*) c FROM tickets WHERE tenant_id=? AND ${inS} AND created_at>=? GROUP BY d ORDER BY d`, ...base, from),
    by_priority: all(`SELECT priority k, count(*) c FROM tickets WHERE tenant_id=? AND ${inS} AND created_at>=? GROUP BY priority`, ...base, from),
    aging: all(`SELECT CASE WHEN julianday(?)-julianday(created_at)<1 THEN '<1d' WHEN julianday(?)-julianday(created_at)<3 THEN '1-3d'
      WHEN julianday(?)-julianday(created_at)<7 THEN '3-7d' ELSE '7d+' END k, count(*) c FROM tickets WHERE tenant_id=? AND ${inS} AND status IN ('open','hold') GROUP BY k`, n, n, n, ...base),
  };
}));
S.get('/audit', role('super_admin', 'tenant_admin'), wrap(req =>
  all('SELECT a.*, u.name actor FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id WHERE a.tenant_id=? ORDER BY a.created_at DESC LIMIT 200', req.tenantId)));
// group-wide report (super admin; mounted before tenant scope via separate path)
// ---------- Email page: connection, events, test, delivery log ----------
const M = express.Router();
M.use(auth, role('super_admin', 'tenant_admin'));
const superOnly = role('super_admin');
const SAMPLE_CAMPUS = "St. Mary's Rehabilitation University";
const maskKey = k => k ? '•'.repeat(Math.max(0, Math.min(12, k.length - 4))) + k.slice(-4) : '';
M.get('/config', superOnly, wrap(() => {
  const c = mailConfig(BASE);
  const stats = Object.fromEntries(all("SELECT status, count(*) n FROM notifications WHERE created_at >= ? GROUP BY status", addH(now(), -24 * 7)).map(r => [r.status, r.n]));
  return { url: c.url, key_masked: maskKey(c.key), has_key: !!c.key, base: c.base, sending: c.sending, last_ok_at: c.last_ok_at, stats,
    vars: VARS, events: MAIL_EVENTS.map(e => ({ key: e.key, label: e.label, who: e.who, when: e.when, on: eventOn(c, e.key), vars: e.vars,
      ...templateFor(c, e.key), default_subject: e.subject, default_body: e.body, custom: !!c.templates[e.key] })) };
}));
M.get('/key', superOnly, wrap(() => ({ key: mailConfig(BASE).key }))); // so the admin can paste it into the flow's Condition
M.put('/config', superOnly, wrap(req => {
  const b = req.body, c = mailConfig(BASE);
  if (b.url !== undefined) {
    const u = String(b.url).trim();
    if (u && !/^https:\/\/\S+$/.test(u) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(u)) throw bad('The flow URL must start with https://');
    setSetting('pa_url', u);
  }
  if (b.key) { if (String(b.key).length < 16) throw bad('Use a secret key of at least 16 characters'); setSetting('pa_key', String(b.key).trim()); }
  if (b.base !== undefined) { const u = String(b.base).trim().replace(/\/+$/, ''); if (!/^https?:\/\/\S+$/.test(u)) throw bad('The public address must start with http:// or https://'); setSetting('public_base_url', u); }
  if (b.sending !== undefined) setSetting('mail_enabled', b.sending ? '1' : '0');
  if (b.events) setSetting('mail_events', JSON.stringify({ ...c.events, ...Object.fromEntries(Object.entries(b.events).map(([k, v]) => [k, !!v])) }));
  audit(req, 'mail.config', 'settings', null, { ...b, key: b.key ? '(changed)' : undefined }); return { ok: true };
}));
M.post('/test', superOnly, wrap(async req => {
  const to = String(req.body.to || '').trim(); if (!/^\S+@\S+\.\S+$/.test(to)) throw bad('Enter the email address to send the test to');
  const c = mailConfig(BASE), cfg = { ...c, url: req.body.url?.trim() || c.url, key: req.body.key?.trim() || c.key };
  const subject = '[ONE Desk] Test email', body = `This is a test from ONE Desk.\nIf you can read this, the Power Automate connection works.\nSign in at ${c.base}/#/login`;
  const r = await postToFlow(cfg, { to, subject, html: renderEmail({ subject, body, campus: 'Email setup' }), text: body });
  insert('notifications', { id: uid(), tenant_id: null, ticket_id: null, recipient: to, template_key: 'test', subject, body, status: r.ok ? 'sent' : 'failed',
    attempts: 1, last_error: r.ok ? null : `${r.status || 'network'}: ${r.hint}`, sent_at: r.ok ? now() : null, created_at: now() });
  if (r.ok) setSetting('mail_last_ok_at', now());
  return r;
}));
// Save (or reset, when both are empty) one step's template.
M.put('/template/:key', superOnly, wrap(req => {
  const e = eventByKey(req.params.key); if (!e) throw notFound();
  const subject = String(req.body.subject ?? '').trim(), body = String(req.body.body ?? '').replace(/\r/g, '').trim();
  const c = mailConfig(BASE), all = { ...c.templates };
  if (!subject && !body) delete all[e.key];
  else {
    if (!subject || !body) throw bad('Both the subject and the message are needed');
    if (subject.length > 250 || body.length > 5000) throw bad('That template is too long');
    const bad1 = unknownVars(subject + '\n' + body, e.vars);
    if (bad1.length) throw bad(`Not available in this email: ${bad1.map(n => `{{${n}}}`).join(', ')}`);
    all[e.key] = { subject, body };
  }
  setSetting('mail_templates', JSON.stringify(all));
  audit(req, 'mail.template', 'template', e.key, { reset: !all[e.key] }); return { ok: true };
}));
// Preview a template (saved, or the unsaved text from the editor) with sample values.
M.post('/preview', superOnly, (req, res) => {
  const e = eventByKey(req.body.key); if (!e) return res.status(404).end();
  const t = { ...templateFor(mailConfig(BASE), e.key), ...(req.body.subject != null ? { subject: req.body.subject } : {}), ...(req.body.body != null ? { body: req.body.body } : {}) };
  const sv = sampleVars(base(), e.key), r = renderTemplate({ templates: { [e.key]: t } }, e.key, sv);
  res.json({ data: { subject: r.subject, html: renderEmail({ subject: r.subject, body: r.body, campus: SAMPLE_CAMPUS, blocks: sv }), unknown: unknownVars(t.subject + '\n' + t.body, e.vars) } });
});
M.get('/log', wrap(req => {
  const w = [], a = [];
  if (req.user.role !== 'super_admin') { w.push('n.tenant_id=?'); a.push(req.user.tenant_id); }
  if (req.query.status && req.query.status !== 'all') { w.push('n.status=?'); a.push(req.query.status); }
  if (req.query.q) { w.push('(n.recipient LIKE ? OR n.subject LIKE ?)'); a.push(`%${req.query.q}%`, `%${req.query.q}%`); }
  return all(`SELECT n.id, n.recipient, n.subject, n.template_key, n.status, n.attempts, n.last_error, n.created_at, n.sent_at, n.ticket_id, tn.code campus
    FROM notifications n LEFT JOIN tenants tn ON tn.id=n.tenant_id ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY n.created_at DESC LIMIT 200`, ...a);
}));
M.post('/resend', wrap(req => {
  const ids = (req.body.ids || []).slice(0, 500), scope = req.user.role === 'super_admin' ? '' : ' AND tenant_id=?';
  let n = 0;
  for (const id of ids) {
    const r = run(`UPDATE notifications SET status='queued', attempts=0, last_error=NULL WHERE id=? AND status IN ('failed','logged','skipped')${scope}`, id, ...(scope ? [req.user.tenant_id] : []));
    if (r.changes) { queue.push(id); n++; }
  }
  return { queued: n };
}));
app.use('/api/mail', M);

app.get('/api/group/report', auth, role('super_admin'), wrap(() =>
  all(`SELECT tn.name, tn.code, sum(t.status='open') open, sum(t.status='hold') hold, sum(t.status='closed') closed, sum(t.status='open' AND t.due_at<?) overdue
    FROM tenants tn LEFT JOIN tickets t ON t.tenant_id=tn.id GROUP BY tn.id ORDER BY tn.name`, now())));

app.use('/api', S);

app.use('/api', (_q, _r, next) => next(notFound()));
app.use((e, _req, res, _next) => {
  const status = e.status || 500; if (status === 500) console.error(e);
  res.status(status).json({ error: { code: e.code || 'INTERNAL', message: status === 500 ? 'Something went wrong' : e.message, details: e.details } });
});

app.use('/desk', express.static(path.join(ROOT, 'public')));
app.use('/', express.static(path.join(ROOT, 'public'))); // also served at the root, e.g. https://desk.supercxo.ai
// First start on an empty database: create the super admin from SUPER_ADMIN_EMAIL / SUPER_ADMIN_PASSWORD.
if (!one('SELECT 1 FROM users LIMIT 1')) {
  const r = createSuperAdmin(process.env.SUPER_ADMIN_EMAIL, process.env.SUPER_ADMIN_PASSWORD);
  console.log(r.created ? r.message : `No users yet. ${r.message} Then restart.`);
}
app.listen(PORT, () => console.log(`ONE Desk on http://localhost:${PORT}`));
