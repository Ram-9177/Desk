import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { pool, uid, now, one, all, run, tx, insert, hashPw, checkPw, trgm } from './db.js';
import { SIMILARITY, MERGE_MODES, MERGEABLE, RANK, locationKey, problemOf, dayIn, priorityFor, similarity } from './merge.js';
import { food, foodService, feedbackIn, summarize, mealsFor } from './food.js';
import { kindOf, heicToJpeg, SHOWN, MIME } from './images.js';
import { PROVIDER_GUIDE, getSettings, MAIL_EVENTS, loadSettings, mailConfig, eventOn, renderEmail, postToFlow, setSetting, renderTemplate, toText, eventByKey, VARS, sampleVars, unknownVars, templateFor, BLOCKS, forRequestor } from './mailer.js';
import { calendar, addWorking, workingBetween, closePoints, POINTS, POINT_RULES, DEFAULT_HOLD_REASONS, localDay, dateStart } from './sla.js';
import { assertTransition, PRIORITIES, DEFAULT_HOURS, REQUESTOR_TYPES, DAILY_LIMITS, MAX_FILES, isOtherAnswer, CHANNELS, FIELD_TYPES, STATUS_WORDS, ACTIVE, FORM_TYPES, fieldsOf, hasLocation, hasStudent, isGeneral, MEALS, MEAL_NAMES } from './public/shared.js';

const PORT = process.env.PORT || 4300;
const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
if (process.env.NODE_ENV === 'production' && (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32)) {
  console.error('Set JWT_SECRET (32+ random characters) before running in production.'); process.exit(1);
}
const BASE = `http://localhost:${PORT}`;
const base = () => mailConfig(BASE).base; // public address used in email links (Email page → Connection)
const UPLOAD_DIR = process.env.UPLOAD_DIR || 'data/uploads';
await loadSettings(); // mailConfig() reads these from memory
const ROOT = path.dirname(fileURLToPath(import.meta.url)); // the app's own folder, whatever the working directory

const app = express();
// Behind nginx on the same host: take the client IP from X-Forwarded-For so per-IP rate limits work.
app.set('trust proxy', 'loopback');
app.disable('x-powered-by');
app.use((_q, res, next) => { res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin' }); next(); });
app.use(express.json({ limit: '40mb' }));
// Email buttons need the site's public address. Until someone sets it on the Email page, learn it from the first real
// (non-local) visit, e.g. https://stmarys-desk.supercxo.ai behind nginx, so links never point at the server's own localhost.
app.use((req, _res, next) => {
  const host = req.get('host') || '';
  // not from this computer, and not from a bare IP address: email buttons should carry the site's name
  if (!getSettings().public_base_url && !process.env.PUBLIC_BASE_URL && host && !/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host) && !/^((\d{1,3}\.){3}\d{1,3}|\[[0-9a-f:]+\])(:\d+)?$/i.test(host))
    setSetting('public_base_url', `${req.protocol}://${host}`).catch(e => console.error('public address', e.message));
  next();
});

// ---------- helpers ----------
class HttpErr extends Error { constructor(status, code, message, details) { super(message); Object.assign(this, { status, code, details }); } }
const bad = (m, d) => new HttpErr(400, 'VALIDATION', m, d);
const notFound = () => new HttpErr(404, 'NOT_FOUND', 'Not found');
const forbid = () => new HttpErr(403, 'FORBIDDEN', 'Forbidden');
const wrap = fn => (req, res, next) => {
  try { const r = fn(req, res); if (r instanceof Promise) r.then(v => v !== undefined && res.json({ data: v }), next); else if (r !== undefined) res.json({ data: r }); }
  catch (e) { next(e); }
};
// async middleware / raw handlers: send rejections to the error handler (Express 4 does not)
const mw = fn => (req, res, next) => fn(req, res, next).catch(next);
const audit = async (req, action, entity, entity_id, meta = {}) =>
  await insert('audit_logs', { id: uid(), tenant_id: req.tenantId || null, actor_id: req.user?.id, action, entity, entity_id, meta: JSON.stringify(meta), created_at: now() });
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
// drop keys idle for over an hour (the longest window) so the map doesn't grow forever
setInterval(() => { const t = Date.now(); for (const [k, arr] of hits) if (t - arr[arr.length - 1] > 3600e3) hits.delete(k); }, 600e3).unref();

// ---------- auth + tenant scope ----------
const auth = mw(async (req, _res, next) => {
  const p = verify((req.headers.authorization || '').replace('Bearer ', ''));
  if (!p) return next(new HttpErr(401, 'UNAUTHORIZED', 'Please sign in'));
  const u = await one('SELECT * FROM users WHERE id=? AND is_active=1', p.sub);
  if (!u) return next(new HttpErr(401, 'UNAUTHORIZED', 'Please sign in'));
  req.user = u;
  const hdr = req.headers['x-tenant-id'];
  if (u.role === 'super_admin') req.tenantId = hdr || null;
  else { if (hdr && hdr !== u.tenant_id) return next(forbid()); req.tenantId = u.tenant_id; }
  next();
});
const needTenant = mw(async (req, _r, next) => next(req.tenantId && await one('SELECT 1 FROM tenants WHERE id=?', req.tenantId) ? undefined : bad('Pick a tenant first')));
const role = (...r) => (req, _r, next) => next(r.includes(req.user.role) ? undefined : forbid());
const isAdmin = u => u.role !== 'provider';
const myServiceIds = async (u, tenantId) => isAdmin(u)
  ? (await all('SELECT id FROM services WHERE tenant_id=?', tenantId)).map(r => r.id)
  : (await all(`SELECT service_id id FROM service_members WHERE tenant_id=? AND user_id=?
      UNION SELECT s.id FROM services s JOIN service_members m ON m.service_id=s.parent_id WHERE s.tenant_id=? AND m.user_id=?`, tenantId, u.id, tenantId, u.id)).map(r => r.id); // a team's providers also see its sub-teams

// ---------- domain ----------
const tenantBySlug = async slug => { const t = await one('SELECT * FROM tenants WHERE slug=? AND is_active=1', slug); if (!t) throw notFound(); return t; };
const providersFor = async (tenantId, serviceId) => await all(`SELECT u.id,u.name,u.email,u.phone FROM service_members m JOIN users u ON u.id=m.user_id
  WHERE m.tenant_id=? AND m.service_id=? AND u.is_active=1`, tenantId, serviceId);
async function targetHours(tenantId, serviceId, priority) {
  const parent = serviceId ? (await one('SELECT parent_id FROM services WHERE id=?', serviceId))?.parent_id : null; // a sub-team uses its main team's SLA when it has none
  const r = await one('SELECT target_hours h FROM sla_policies WHERE tenant_id=? AND service_id=? AND priority=?', tenantId, serviceId, priority)
    || (parent && await one('SELECT target_hours h FROM sla_policies WHERE tenant_id=? AND service_id=? AND priority=?', tenantId, parent, priority))
    || await one('SELECT target_hours h FROM sla_policies WHERE tenant_id=? AND service_id IS NULL AND priority=?', tenantId, priority);
  return r ? r.h : DEFAULT_HOURS[priority];
}
const fmtIST = iso => new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
const addH = (iso, h) => new Date(new Date(iso).getTime() + h * 3600e3).toISOString();
const tenantRow = async id => await one('SELECT * FROM tenants WHERE id=?', id);
const calOf = async tenantId => calendar(await tenantRow(tenantId));
const holdReasons = tn => { try { return JSON.parse(tn.hold_reasons) || DEFAULT_HOLD_REASONS; } catch { return DEFAULT_HOLD_REASONS; } };
const dueFrom = async (tenantId, startIso, minutes) => addWorking(await calOf(tenantId), startIso, minutes);
async function award(t, userId, points, reason) {
  if (userId) await insert('provider_points', { id: uid(), tenant_id: t.tenant_id, user_id: userId, ticket_id: t.id, points, reason, created_at: now() });
}
// Leaving hold: shift the due time by the working time held, and penalise a hold that ran past its own SLA.
async function leaveHold(t, ts) {
  const held = workingBetween(await calOf(t.tenant_id), t.hold_started_at, ts);
  if (t.hold_due_at && ts > t.hold_due_at) await award(t, t.hold_by, POINTS.holdBreach, 'Hold ran past its hold SLA');
  return { held, due: t.due_at ? addWorking(await calOf(t.tenant_id), t.due_at, held) : null }; // a suggestion has no target to move
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

function buildFormCheck(schema, data = {}, skip = () => false) {
  const errs = {}, missing = [];
  for (const f of fieldsOf(schema)) {
    if (skip(f)) continue;
    const v = data[f.key];
    const empty = v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);
    if (f.required && empty) { missing.push(f.label); errs[f.key] = `Please fill in: ${f.label}`; continue; }
    if (empty) continue;
    const why = f.type === 'number' && isNaN(Number(v)) ? 'must be a number'
      : f.type === 'email' && !/^\S+@\S+\.\S+$/.test(v) ? 'not a valid email'
      : f.type === 'select' && !(f.options || []).includes(v) && !isOtherAnswer(f.options, v) ? 'pick one of the options'
      : f.type === 'multi_select' && (!Array.isArray(v) || v.some(x => !(f.options || []).includes(x))) ? 'pick from the options' : '';
    if (why) errs[f.key] = `${f.label}: ${why}`;
  }
  if (!Object.keys(errs).length) return;
  // one line the person can act on: the boxes still empty, then anything filled in wrongly
  const wrong = Object.values(errs).filter(m => !m.startsWith('Please fill in: '));
  throw bad([missing.length ? `Please fill in: ${missing.join(', ')}` : '', ...wrong].filter(Boolean).join('. '), errs);
}

// Plain running number per campus: 0001, 0002, ... (year 0 = one counter that never resets)
const normNo = no => { const s = String(no).trim(); return /^\d+$/.test(s) ? s.padStart(4, '0') : s.toUpperCase(); };
async function nextTicketNo(tenant) {
  const r = await one(`INSERT INTO ticket_counters (tenant_id,year,last_number) VALUES (?,0,1)
    ON CONFLICT (tenant_id,year) DO UPDATE SET last_number=ticket_counters.last_number+1 RETURNING last_number`, tenant.id);
  return String(r.last_number).padStart(4, '0');
}

async function addEvent(t, actor, type, o = {}) {
  return (await insert('ticket_events', { tenant_id: t.tenant_id, ticket_id: t.id, actor_type: actor.type, actor_id: actor.id, actor_name: actor.name,
    event_type: type, from_value: o.from, to_value: o.to, body: o.body, is_internal: o.internal ? 1 : 0, meta: JSON.stringify(o.meta || {}), created_at: now() })).id;
}

// files arrive as [{name, type, data(base64 dataURL), source}]
async function saveFiles(t, eventId, files = [], byType) {
  if (!Array.isArray(files)) return;
  if (files.length > MAX_FILES) throw bad(`You can attach at most ${MAX_FILES} photos or files`);
  for (const f of files) {
    // the bytes decide what a file is (not its name or the browser's word); HEIC photos become JPEG, so every browser and email app shows them
    let buf = Buffer.from(String(f.data).split(',').pop(), 'base64'), kind = kindOf(buf), name = String(f.name || 'file').slice(0, 120);
    if (!kind) throw bad('Only photos or PDF files');
    const max = kind === 'heic' ? 12 : 5; // the app shrinks other photos on the phone; HEIC is shrunk here
    if (buf.length > max * 1024 * 1024) throw new HttpErr(413, 'TOO_LARGE', `${name} is too large: each file must be under ${max} MB`);
    if (kind === 'heic') try { buf = await heicToJpeg(buf); kind = 'jpeg'; name = name.replace(/\.[a-z0-9]{2,5}$/i, '') + '.jpg'; } catch (e) { console.error(`photo ${name}: ${e.message}`); }
    const key = crypto.randomBytes(18).toString('hex') + '.' + (kind === 'jpeg' ? 'jpg' : kind);
    fs.writeFileSync(path.join(UPLOAD_DIR, key), buf);
    await insert('attachments', { id: uid(), tenant_id: t.tenant_id, ticket_id: t.id, event_id: eventId, uploaded_by_type: byType,
      source: ['camera', 'gallery', 'file'].includes(f.source) ? f.source : 'file', file_name: name,
      mime_type: MIME[kind], size_bytes: buf.length, stamped_at: f.source === 'camera' ? now() : null, storage_key: key, created_at: now() });
  }
}

// ---------- notifications (outbox + worker) ----------
const queue = [];
// Queue one email per recipient, written from that step's template (Email page → Emails sent) and these values.
async function notify(t, recipients, key, vars = {}, { hold } = {}) { // hold: write it but don't send (Resend later)
  const cfg = mailConfig(BASE), on = eventOn(cfg, key); // events switched off on the Email page are logged as skipped
  if (eventByKey(key)?.who === 'Requestor') vars = forRequestor(vars); // the priority is the team's own call: requestors never see it
  const v = { login_link: `${base()}/#/login`, ...vars }, { subject, body } = renderTemplate(cfg, key, v);
  const blocks = Object.fromEntries(BLOCKS.filter(b => v[b]).map(b => [b, v[b]]));
  const html = renderEmail({ subject, body, campus: t.tenant_id ? (await tenantRow(t.tenant_id))?.name : '', blocks }), text_body = toText(body, blocks);
  for (const to of [...new Set(recipients.filter(Boolean))]) {
    const id = uid();
    await insert('notifications', { id, tenant_id: t.tenant_id, ticket_id: t.id || null, recipient: to, template_key: key,
      subject, body, html, text_body, status: hold ? 'logged' : on ? 'queued' : 'skipped',
      last_error: hold ? 'Held: account added from provision/ at start-up. Use Resend to send it.' : null, created_at: now() });
    if (on && !hold) queue.push(id);
  }
}
// A ticket waiting in its team's daily queue: its place in the line (1 = next), how many wait, and the day it reaches the team.
async function queueInfo(t) {
  if (!t.queued) return null;
  const svc = await one('SELECT name, daily_cap FROM services WHERE id=?', t.service_id);
  const { pos, waiting } = await one(`SELECT count(*) FILTER (WHERE queue_day<? OR (queue_day=? AND (created_at<? OR (created_at=? AND id<=?))))::int pos, count(*)::int waiting
    FROM tickets WHERE service_id=? AND queued=1`, t.queue_day, t.queue_day, t.created_at, t.created_at, t.id, t.service_id);
  const lands_on = new Date(t.lands_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  return { queue_no: pos, ahead: Math.max(0, pos - 1), waiting, daily_cap: svc?.daily_cap || 0, service: svc?.name || '', lands_at: t.lands_at, lands_on };
}
const queueNote = q => q ? `${q.service} takes ${q.daily_cap} tickets a day and today's are full, so your ticket is in the queue. Queue number: ${q.queue_no}`
  + ` (${q.ahead ? `${q.ahead} ticket${q.ahead === 1 ? '' : 's'} ahead of you` : 'you are next'}). It reaches the team on ${q.lands_on}.` : '';
// Everything a ticket email can show; `extra` adds the values for one step (note, hold reason…).
async function ticketVars(t, extra = {}) {
  t = await one('SELECT * FROM tickets WHERE id=?', t.id) || t;
  const tn = await tenantRow(t.tenant_id), svc = await one('SELECT name FROM services WHERE id=?', t.service_id), r = await one('SELECT name FROM requestors WHERE id=?', t.requestor_id);
  const svcRow = await one('SELECT name, form_schema FROM services WHERE id=?', t.service_id), fd = JSON.parse(t.form_data || '{}'), held = t.status === 'hold';
  const answers = fieldsOf(JSON.parse(svcRow?.form_schema || '{}')).filter(f => !f.key.startsWith('loc_')).map(f => [f.label, Array.isArray(fd[f.key]) ? fd[f.key].join(', ') : fd[f.key]]).filter(([, a]) => a !== undefined && a !== '');
  const provNames = (await providersFor(t.tenant_id, t.service_id)).map(p => p.name).join(', ');
  const escName = t.escalated_to ? (await one('SELECT name FROM users WHERE id=?', t.escalated_to))?.name || '' : '';
  const q = t.status === 'open' ? await queueInfo(t) : null;
  const sug = t.kind === 'suggestion';
  const progress = { suggestion: sug, ...(q ? { queue_no: q.queue_no, queue_ahead: q.ahead, lands_on: q.lands_on, daily_cap: q.daily_cap } : {}), escalated_to: [...ACTIVE, 'hold'].includes(t.status) ? escName : '', status: t.status, service: svc?.name, due: sug ? '' : fmtIST(t.due_at), reopen_days: tn.reopen_window_days, closed_at: t.closed_at ? fmtIST(t.closed_at) : '',
    hold_reason: held && t.hold_reason ? holdReasons(tn).find(x => x.key === t.hold_reason)?.label || '' : '', resume_by: held && t.hold_due_at ? fmtIST(t.hold_due_at) : '' };
  const ticket_details = [['Ticket', t.ticket_no], ['Service', svc?.name], ['Subject', t.subject], ['Description', t.description], ['Location', t.location], ...answers,
    ['Priority', t.priority[0].toUpperCase() + t.priority.slice(1)], ['Raised on', fmtIST(t.created_at)],
    ...(q ? [['Queue number', `${q.queue_no} · reaches the team on ${q.lands_on}`]] : []), ...(!sug && [...ACTIVE, 'hold'].includes(t.status) ? [['Target', fmtIST(t.due_at)]] : []),
    ['Handled by', provNames || 'Being assigned']].filter(([, x]) => x !== undefined && x !== null && String(x).trim() !== '').map(([k, x]) => [k, String(x)]);
  // photos: the ones sent with the ticket go with its details, later ones with the update they came with
  const files = await all('SELECT event_id, file_name, mime_type, storage_key FROM attachments WHERE ticket_id=? ORDER BY created_at', t.id);
  const pics = id => files.filter(f => f.event_id === id && Object.values(SHOWN).includes(f.mime_type)).map(f => ({ url: `${base()}/api/files/${f.storage_key}`, name: f.file_name }));
  const first = await one("SELECT id FROM ticket_events WHERE ticket_id=? AND event_type='created' ORDER BY id LIMIT 1", t.id);
  if (first && pics(first.id).length) ticket_details.push(['Photos', pics(first.id)]);
  const SW = { hold: 'Put on hold', in_progress: 'Work started', open: 'Work resumed', closed: 'Resolved', rejected: 'Not accepted' };
  const timeline = (await all('SELECT * FROM ticket_events WHERE ticket_id=? AND is_internal=0 ORDER BY id DESC LIMIT 6', t.id)).map(e => {
    const m = JSON.parse(e.meta || '{}'), who = e.actor_name || '';
    const label = { escalated: `Escalated to ${e.to_value}`, created: 'Ticket received', landed: `Reached the ${e.to_value} team`, note: `Note from ${who}`, reopened: `Reopened by ${who}`, transferred: `Moved to ${e.to_value}`,
      status_changed: `${e.from_value === 'hold' && e.to_value === 'in_progress' ? 'Work resumed' : SW[e.to_value] || e.to_value}${who ? ` by ${who}` : ''}${m.hold_reason ? ` · ${m.hold_reason}` : ''}` }[e.event_type] || e.event_type;
    return { at: new Date(e.created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }), label, body: e.body || '',
      photos: e.event_type === 'created' ? [] : pics(e.id) };
  });
  return { progress, ticket_details, timeline, escalated_to_name: escName,
    ticket_no: t.ticket_no, subject: t.subject, description: t.description || '', location: t.location || '', service: svc?.name || '', campus: tn.name,
    requestor_name: r?.name || '', status: STATUS_WORDS[t.status] || t.status, priority: t.priority[0].toUpperCase() + t.priority.slice(1), kind: sug ? 'Suggestion' : 'Ticket', due: sug ? 'No target (suggestion)' : fmtIST(t.due_at),
    providers: (await providersFor(t.tenant_id, t.service_id)).map(p => p.name).join(', '), ticket_link: await trackUrl(t), staff_link: `${base()}/#/c/t/${t.id}`,
    portal_link: `${base()}/#/d/${tn.slug}`, reopen_days: tn.reopen_window_days, queue_no: q?.queue_no ?? '', lands_on: q?.lands_on || '', queue_note: queueNote(q), ...extra };
}
const ROLE_NAMES = { provider: 'Service provider', tenant_admin: 'Campus admin', super_admin: 'Super admin' };
// The requestor's step-by-step guide the app serves (public/guide), linked from a requestor's first ticket email.
const guideLink = kind => ({ kind, url: `${base()}/guide/${kind}.html` });
const staffVars = async (u, pw) => {
  const svcs = (await all('SELECT s.name FROM service_members m JOIN services s ON s.id=m.service_id WHERE m.user_id=? AND s.is_active=1 ORDER BY s.name', u.id)).map(r => r.name);
  return { staff_name: u.name, staff_email: u.email, temp_password: pw, campus: u.tenant_id ? (await tenantRow(u.tenant_id))?.name : 'ONE Desk', role_name: ROLE_NAMES[u.role] || 'Staff',
    guide: { kind: 'provider', url: PROVIDER_GUIDE }, // the welcome email links the provider guide
    services: svcs.length ? svcs.join(', ') : u.role === 'provider' ? 'Not assigned yet. Your admin will add you to a service.' : 'All services of your campus' };
};
const trackUrl = async (t) => { const tn = await one('SELECT slug FROM tenants WHERE id=?', t.tenant_id); return `${base()}/#/d/${tn.slug}/t/${t.ticket_no}?k=${t.tracking_token}`; };
// Statuses: queued → sent | failed (after 4 tries); 'logged' = no flow connected or sending paused (printed to the server log only).
async function sendOne(id) {
  const n = await one('SELECT * FROM notifications WHERE id=?', id); if (!n || n.status !== 'queued') return;
  const cfg = mailConfig(BASE);
  if (!cfg.url || !cfg.sending) {
    console.log(`✉  ${n.recipient} — ${n.subject}`);
    return await run("UPDATE notifications SET status='logged', last_error=? WHERE id=?", cfg.url ? 'Sending is paused' : 'No Power Automate flow connected', id);
  }
  const campus = n.tenant_id ? (await one('SELECT name FROM tenants WHERE id=?', n.tenant_id))?.name : '';
  const r = await postToFlow(cfg, { to: n.recipient, subject: n.subject, html: n.html || renderEmail({ subject: n.subject, body: n.body, campus }), text: n.text_body || toText(n.body) });
  if (r.ok) { await run("UPDATE notifications SET status='sent', sent_at=?, attempts=attempts+1, last_error=NULL WHERE id=?", now(), id); await setSetting('mail_last_ok_at', now()); return; }
  const a = n.attempts + 1;
  await run('UPDATE notifications SET attempts=?, last_error=?, status=? WHERE id=?', a, `${r.status || 'network'}: ${r.hint}`, a >= 4 ? 'failed' : 'queued', id);
  if (a < 4) setTimeout(() => queue.push(id), [60e3, 300e3, 1800e3][a - 1]);
}
setInterval(() => { while (queue.length) sendOne(queue.shift()).catch(e => console.error('mail', e.message)); }, 1000);
for (const r of await all("SELECT id FROM notifications WHERE status='queued'")) queue.push(r.id); // resume after a restart

// daily 08:30 IST digest (IST = UTC+5:30, no DST; the server itself usually runs on UTC)
let lastDigest = '';
setInterval(() => digest().catch(e => console.error('digest', e.message)), 60e3);
async function digest() {
  const d = new Date(Date.now() + 330 * 60e3), key = d.toISOString().slice(0, 10);
  if (d.getUTCHours() !== 8 || d.getUTCMinutes() < 30 || lastDigest === key) return;
  lastDigest = key;
  for (const u of await all("SELECT * FROM users WHERE is_active=1 AND role!='super_admin'")) {
    const sids = await myServiceIds(u, u.tenant_id); if (!sids.length) continue;
    const q = await all(`SELECT ticket_no,subject,status,due_at FROM tickets WHERE tenant_id=? AND service_id IN (${sids.map(() => '?').join()})
      AND ((status IN ('open','in_progress') AND due_at<?) OR status='hold')`, u.tenant_id, ...sids, now());
    if (q.length) await notify({ tenant_id: u.tenant_id }, [u.email], 'digest', { staff_name: u.name, campus: (await tenantRow(u.tenant_id))?.name, count: q.length,
      ticket_list: q.map(x => `${x.ticket_no} · ${x.status === 'hold' ? 'on hold' : 'overdue'} · ${x.subject}`).join('\n') });
  }
}

// ---------- escalation ----------
// A ticket goes to its service's providers first. When it misses its target (or a hold passes its limit) by the
// campus's "escalate after" working days, it escalates to the service's escalation person (else a campus admin, else the super admin).
// The team's own time (hours, Services → Escalate after) wins over the campus's (days, SLA & points); a sub-team without one uses its main team's.
function escalationDue(t, tn, hours) {
  const cal = calendar(tn), mins = hours != null ? Math.round(hours * 60) : Math.round((tn.escalate_after_days || 0) * (cal.end - cal.start));
  const from = ACTIVE.includes(t.status) ? t.due_at : tn.escalate_holds ? t.hold_due_at : null;
  if (!from) return null;
  return mins > 0 ? addWorking(cal, from, mins) : from; // 0 days = the moment the target is missed
}
const escalationOfficers = sid => all(`SELECT u.id, u.name, u.email FROM service_escalations e JOIN users u ON u.id=e.user_id
  WHERE e.service_id=? AND u.is_active=1 ORDER BY u.name`, sid);
async function escalate(t) {
  // the service's escalation officers (any number), else its parent team's, else a campus admin, else the super admin
  const svc = await one('SELECT parent_id FROM services WHERE id=?', t.service_id);
  let officers = await escalationOfficers(t.service_id);
  if (!officers.length && svc?.parent_id) officers = await escalationOfficers(svc.parent_id);
  const target = officers[0]
    || await one("SELECT id, name, email FROM users WHERE tenant_id=? AND role='tenant_admin' AND is_active=1 ORDER BY name LIMIT 1", t.tenant_id)
    || await one("SELECT id, name, email FROM users WHERE role='super_admin' AND is_active=1 ORDER BY name LIMIT 1"); // no campus admin: the super admin
  if (!target) return; // nobody to escalate to: the ticket stays on the attention list as overdue
  const ts = now(), missed = t.status === 'hold' ? `its hold limit of ${fmtIST(t.hold_due_at)}` : `its target of ${fmtIST(t.due_at)}`;
  const done = await tx(async () => {
    if (!(await run('UPDATE tickets SET escalated_at=?, escalated_to=?, updated_at=? WHERE id=? AND escalated_at IS NULL', ts, target.id, ts, t.id)).changes) return false;
    await addEvent(t, { type: 'system', name: 'ONE Desk' }, 'escalated', { to: officers.length ? officers.map(o => o.name).join(', ') : target.name, body: `Escalated automatically: the ticket passed ${missed}.` });
    return true;
  });
  if (!done) return;
  const names = officers.length ? officers.map(o => o.name).join(', ') : target.name;
  const v = await ticketVars(t, { escalated_to_name: names, note: `The ticket passed ${missed}.` });
  await notify(t, officers.length ? officers.map(o => o.email) : [target.email], 'escalated', v); // only the escalation officers (or the admin when the team has none)
  await notifyRequestors(t, 'escalated_requestor', v);
}
async function runEscalations() {
  const n = now();
  for (const tn of await all('SELECT * FROM tenants WHERE is_active=1')) {
    const due = await all(`SELECT * FROM tickets WHERE tenant_id=? AND escalated_at IS NULL AND ((status IN ('open','in_progress') AND due_at<?) OR (status='hold' AND hold_due_at<?))`, tn.id, n, n);
    const hrs = Object.fromEntries((await all('SELECT s.id, coalesce(s.escalate_after_hours, p.escalate_after_hours) h FROM services s LEFT JOIN services p ON p.id=s.parent_id WHERE s.tenant_id=?', tn.id)).map(r => [r.id, r.h]));
    for (const t of due) { try { const at = escalationDue(t, tn, hrs[t.service_id] ?? null); if (at && at <= n) await escalate(t); } catch (e) { console.error('escalation', t.ticket_no, e.message); } }
  }
}
const escalations = () => runEscalations().catch(e => console.error('escalation', e.message));
setInterval(escalations, 60e3); setTimeout(escalations, 3000);

// ---------- team daily intake (Services → Tickets a day) ----------
// A service may take N tickets a day. Past that, a portal ticket gets a place in the service's queue and lands on the next
// working day that still has room, at the start of working hours: only then do the providers see it and get the email.
const nextDay = ymd => { const d = new Date(ymd + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };
async function queueSlot(tn, svc, today) {
  await one('SELECT pg_advisory_xact_lock(hashtext(?)) AS x', 'cap|' + svc.id); // tickets for one team take their places one at a time
  const cal = calendar(tn), cap = svc.daily_cap;
  let d = today;
  for (let i = 0; i < 1000; i++) {
    if (d === today || cal.days.has(new Date(d + 'T00:00:00Z').getUTCDay())) {
      const { n } = await one('SELECT count(*)::int n FROM tickets WHERE service_id=? AND (queue_day=? OR (queue_day IS NULL AND created_date=?))', svc.id, d, d);
      if (n < cap) return d === today ? { day: d } : { day: d, queued: true, lands_at: addWorking(cal, dateStart(cal.tz, d), 0) };
    }
    d = nextDay(d);
  }
  throw new HttpErr(429, 'QUEUE_FULL', 'This team\'s queue is full for the coming months. Please contact the help desk.');
}
async function releaseQueued() {
  for (const t of await all('SELECT * FROM tickets WHERE queued=1 AND lands_at<=? ORDER BY queue_day, created_at LIMIT 1000', now())) {
    const svc = await one('SELECT name FROM services WHERE id=?', t.service_id);
    const done = await tx(async () => {
      if (!(await run('UPDATE tickets SET queued=0, updated_at=? WHERE id=? AND queued=1', now(), t.id)).changes) return false;
      await addEvent(t, { type: 'system', name: 'ONE Desk' }, 'landed', { to: svc?.name, body: 'Your ticket has reached the team from the queue.' }); return true;
    });
    if (!done) continue;
    const v = await ticketVars(t);
    await notify(t, (await providersFor(t.tenant_id, t.service_id)).map(p => p.email), 'new_ticket', v);
    await notifyRequestors(t, 'queue_landed', v);
  }
}
// due reminders: email the provider once; they stay on Home until marked done
async function fireReminders() {
  for (const m of await all('SELECT m.*, u.email, u.name, u.is_active FROM ticket_reminders m JOIN users u ON u.id=m.user_id WHERE m.fired_at IS NULL AND m.done_at IS NULL AND m.remind_at<=? ORDER BY m.remind_at LIMIT 500', now())) {
    if (!(await run('UPDATE ticket_reminders SET fired_at=? WHERE id=? AND fired_at IS NULL', now(), m.id)).changes) continue;
    const t = await one('SELECT * FROM tickets WHERE id=?', m.ticket_id); if (!t || !m.is_active) continue;
    await notify(t, [m.email], 'reminder', await ticketVars(t, { note: m.note, actor_name: m.name }));
  }
}
const reminders = () => fireReminders().catch(e => console.error('reminders', e.message));
setInterval(reminders, 60e3); setTimeout(reminders, 5000);
const releases = () => releaseQueued().catch(e => console.error('queue', e.message));
setInterval(releases, 60e3); setTimeout(releases, 4000);

// ---------- ticket creation (shared by portal and staff) ----------
const dailyLimits = tn => ({ ...DAILY_LIMITS, ...(tn.daily_limits ? JSON.parse(tn.daily_limits) : {}) });
// Public form: each email may raise N tickets per local day (5 by default, 9 for faculty). Staff-entered tickets don't count.
async function checkDailyLimit(tn, b) {
  const type = b.requestor_type || 'student', max = dailyLimits(tn)[type] ?? DAILY_LIMITS.student, day = localDay(tn.timezone || 'Asia/Kolkata');
  const { n } = await one(`SELECT count(*)::int n FROM tickets t JOIN requestors r ON r.id=t.requestor_id
    WHERE t.tenant_id=? AND t.channel='portal' AND lower(r.email)=? AND t.created_at>=?`, tn.id, String(b.email).toLowerCase().trim(), day.start);
  if (n < max) return;
  const when = new Date(day.next).toLocaleString('en-IN', { timeZone: tn.timezone || 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
  throw new HttpErr(429, 'DAILY_LIMIT', `Daily limit reached: ${{ student: 'students', faculty: 'faculty', staff: 'staff', parent: 'parents', visitor: 'visitors' }[type] || 'each person'} can raise ${max} tickets a day, and ${String(b.email).trim()} has raised ${n} today. `
    + `You can raise a new ticket after ${when}. For something urgent, add a note to one of today's tickets or contact the help desk.`);
}
async function createTicket(tenant, b, opts) {
  const svc = await one('SELECT * FROM services WHERE id=? AND tenant_id=? AND is_active=1', b.service_id, tenant.id);
  if (!svc) throw notFound();
  req_(b.name, 'Please fill in your name'); req_(b.subject, 'Please fill in the subject');
  if (!/^\S+@\S+\.\S+$/.test(String(b.email || '').trim())) throw bad('Please enter a valid email address, so we can send you updates');
  if (b.requestor_type && !REQUESTOR_TYPES.includes(b.requestor_type)) throw bad('Bad requestor type');
  const schema = JSON.parse(svc.form_schema || '{}'), portal = opts.channel === 'portal';
  // Suggestion box (on the same form): an idea for the team, not a problem; no location, no service questions, no target time
  const suggestion = b.kind === 'suggestion';
  // a suggestion keeps only the student's own details (branch, ID, department); the service's problem questions are skipped
  const fd = suggestion ? Object.fromEntries(Object.entries(b.form_data || {}).filter(([k]) => k.startsWith('stu_'))) : b.form_data || {}; if (suggestion) b.form_data = fd;
  // student details (branch, student ID, department) are asked only when the person says they are a student;
  // everyone else gives the ID and department that match who they are (faculty ID, staff ID, ward's ID…)
  const asStudent = hasStudent(schema) && (b.requestor_type || 'student') === 'student';
  if (!asStudent) for (const k of Object.keys(fd)) if (k.startsWith('stu_')) delete fd[k];
  // public form: the requestor's own details are required; the service's questions follow their Required setting
  if (portal) {
    if (!/^\+?[0-9 -]{7,15}$/.test(String(b.phone || '').trim())) throw bad('Please enter a valid phone number (7–15 digits)');
    if (!asStudent && !opts.food) { req_(b.identifier, 'Please fill in your ID (student ID, faculty ID, staff ID, or for visitors where you are from)'); req_(b.department, 'Please fill in your department (or for visitors the purpose of the visit)'); }
  }
  buildFormCheck(schema, fd, f => (f.key.startsWith('stu_') && !asStudent) || (suggestion && !f.key.startsWith('stu_')));
  // the form type's answers fill the ticket's location and the requestor's ID / department
  if (suggestion) { req_(b.description, 'Please write your suggestion'); b.location = b.location ? String(b.location).slice(0, 200) : null; }
  else if (hasLocation(schema)) b.location = [fd.loc_block, fd.loc_floor, fd.loc_room].filter(Boolean).join(' · ');
  else if (isGeneral(schema) && opts.channel !== 'internal') req_(b.location, 'Please fill in the location');
  if (asStudent) Object.assign(b, { identifier: fd.stu_id, department: fd.stu_dept, requestor_type: 'student' });
  if (b.idempotency_key) {
    const ex = await one('SELECT * FROM tickets WHERE tenant_id=? AND idempotency_key=?', tenant.id, b.idempotency_key);
    if (ex) return ex;
  }
  if (portal) await checkDailyLimit(tenant, b);
  // same-day duplicates: a report from the portal joins today's open ticket for the same place and problem (merge.js)
  const ts = now(), day = dayIn(tenant.timezone, ts), lkey = opts.channel === 'internal' ? null : locationKey(schema, fd, b.location), prob = problemOf(schema, fd);
  const mergeable = !suggestion && portal && lkey && prob && b.merge !== 'no';
  let t, first = false, merged = null; // first: this person's first report here, so the email also links the guide
  try { t = await tx(async () => {
    // every report for this place today waits its turn here, so 200 at once still make one ticket
    if (mergeable) await one('SELECT pg_advisory_xact_lock(hashtext(?)) AS x', `${tenant.id}|${svc.id}|${lkey}|${day}`);
    const email = b.email ? String(b.email).toLowerCase().trim() : null, phone = b.phone ? String(b.phone).trim() : null, contact = email || phone;
    let r = (email && await one('SELECT * FROM requestors WHERE tenant_id=? AND lower(email)=?', tenant.id, email))
      || (phone && await one('SELECT * FROM requestors WHERE tenant_id=? AND phone=?', tenant.id, phone));
    first = !r || !(await one('SELECT 1 AS x FROM ticket_requestors WHERE requestor_id=? LIMIT 1', r.id));
    if (r) await run('UPDATE requestors SET name=?, email=coalesce(?,email), phone=coalesce(?,phone), requestor_type=coalesce(?,requestor_type), identifier=coalesce(?,identifier), department=coalesce(?,department) WHERE id=?',
      b.name, email, phone, b.requestor_type || null, b.identifier || null, b.department || null, r.id);
    else r = await insert('requestors', { id: uid(), tenant_id: tenant.id, name: b.name, email, phone, requestor_type: b.requestor_type, identifier: b.identifier, department: b.department });
    const m = mergeable && await findMatch(tenant, svc.id, lkey, prob, day);
    if (m) {
      if (mergeMode() === 'confirm' && b.merge !== 'yes') // the form asks "Same issue?" first
        throw new HttpErr(409, 'POSSIBLE_DUPLICATE', `Ticket ${m.ticket_no} already exists for this problem.`, { ticket_no: m.ticket_no, subject: m.subject, affected_count: m.affected_count });
      merged = await joinTicket(m, r, b, contact, opts.actor, ts);
      return merged.ticket;
    }
    const byStaff = PRIORITIES.includes(b.priority) && opts.actor.type === 'user', priority = byStaff ? b.priority : suggestion ? 'low' : 'medium';
    // the team's daily intake: past it, a portal ticket waits in the team's queue (staff-entered tickets always land now)
    const slot = !suggestion && portal && svc.daily_cap > 0 ? await queueSlot(tenant, svc, day) : { day };
    const t = await insert('tickets', { id: uid(), tenant_id: tenant.id, ticket_no: await nextTicketNo(tenant), service_id: svc.id, requestor_id: r.id,
      subject: String(b.subject).slice(0, 200), description: b.description, location: b.location, form_data: JSON.stringify(b.form_data || {}),
      priority, status: 'open', channel: opts.channel, is_internal: opts.channel === 'internal' ? 1 : 0, created_by_user_id: opts.actor.type === 'user' ? opts.actor.id : null,
      due_at: suggestion ? null : await dueFrom(tenant.id, slot.lands_at || ts, await targetHours(tenant.id, svc.id, priority) * 60), kind: suggestion ? 'suggestion' : 'issue', tracking_token: crypto.randomBytes(24).toString('base64url'),
      idempotency_key: b.idempotency_key || null, created_at: ts, updated_at: ts, held_minutes: 0, reopen_count: 0,
      location_key: lkey, problem_key: prob?.key, problem_label: prob?.label, created_date: day, affected_count: 1, priority_by_staff: byStaff ? 1 : 0, not_merged: b.merge === 'no' ? 1 : 0,
      queued: slot.queued ? 1 : 0, queue_day: slot.day, lands_at: slot.lands_at || null });
    await insert('ticket_requestors', { id: uid(), ticket_id: t.id, requestor_id: r.id, name: b.name, contact, raised_at: ts, is_first: 1 });
    const ev = await addEvent(t, opts.actor, 'created', { to: svc.name, meta: b.related_ticket_no ? { related_ticket_no: b.related_ticket_no } : {} });
    await saveFiles(t, ev, b.files, opts.actor.type);
    return t;
  }); } catch (e) { // the same submission arriving twice at once: the unique index keeps one, return it
    const ex = e.code === '23505' && b.idempotency_key && await one('SELECT * FROM tickets WHERE tenant_id=? AND idempotency_key=?', tenant.id, b.idempotency_key);
    if (ex) return ex; throw e;
  }
  if (merged) { // the person gets their own acknowledgement for the ticket they joined; the providers already have it
    const others = merged.count - 1, guide = first ? { guide: guideLink('requestor') } : {};
    if (!merged.again) await notify(t, [b.email || null], 'created', { ...await ticketVars(t, { affected_note: `Known issue: ${others} other${others === 1 ? '' : 's'} reported this too. You will get updates by email.` }), requestor_name: b.name, ...guide });
    return Object.assign(t, { merged: true, affected_count: merged.count });
  }
  const prov = await providersFor(tenant.id, svc.id);
  const v = await ticketVars(t);
  await notify(t, [b.email || null], 'created', first ? { ...v, guide: guideLink('requestor') } : v);
  if (!t.queued) await notify(t, prov.map(p => p.email), 'new_ticket', v); // a queued ticket reaches the providers on the day it lands
  return t;
}

// ---------- same-day duplicate reports (rules in merge.js) ----------
const mergeMode = () => [getSettings().merge_mode, process.env.DUPLICATE_MERGE_MODE].find(m => MERGE_MODES.includes(m)) || 'silent';
// The ticket a report joins: same campus, service, place and problem, raised the same day, not closed or rejected
async function findMatch(tn, svcId, lkey, prob, day) {
  const base = `tenant_id=? AND service_id=? AND location_key=? AND created_date=? AND status IN (${MERGEABLE.map(() => '?').join()})`, a = [tn.id, svcId, lkey, day, ...MERGEABLE];
  if (!prob.fuzzy) return one(`SELECT * FROM tickets WHERE ${base} AND problem_key=? ORDER BY created_at LIMIT 1`, ...a, prob.key);
  const typed = prob.key.slice(6); // "Other": the typed words, matched by similarity
  if (trgm) return one(`SELECT * FROM tickets WHERE ${base} AND problem_key LIKE 'other:%' AND similarity(substr(problem_key, 7), ?) >= ?
    ORDER BY similarity(substr(problem_key, 7), ?) DESC, created_at LIMIT 1`, ...a, typed, SIMILARITY, typed);
  return (await all(`SELECT * FROM tickets WHERE ${base} AND problem_key LIKE 'other:%' ORDER BY created_at`, ...a))
    .map(t => [t, similarity(t.problem_key.slice(6), typed)]).filter(([, x]) => x >= SIMILARITY).sort((x, y) => y[1] - x[1])[0]?.[0];
}
// A later report of the same problem: one more requestor (and their photos) on the ticket. The same person never counts twice.
async function joinTicket(t, r, b, contact, actor, ts) {
  if (await one('SELECT 1 AS x FROM ticket_requestors WHERE ticket_id=? AND contact=?', t.id, contact)) return { ticket: t, again: true, count: t.affected_count };
  const ev = await addEvent(t, actor, 'merged', { body: `Also reported by ${b.name}${b.description ? `: ${b.description}` : ''}`, internal: true, meta: { contact } });
  await saveFiles(t, ev, b.files, actor.type);
  const pic = await one('SELECT storage_key FROM attachments WHERE event_id=? ORDER BY created_at LIMIT 1', ev);
  await insert('ticket_requestors', { id: uid(), ticket_id: t.id, requestor_id: r.id, name: b.name, contact, photo_url: pic ? `/api/files/${pic.storage_key}` : null, event_id: ev, raised_at: ts, is_first: 0 });
  const { n } = await one('SELECT count(*)::int n FROM ticket_requestors WHERE ticket_id=?', t.id);
  // more people affected raises the priority; it is never lowered, and a priority a provider set by hand is left alone
  const p = !t.priority_by_staff && RANK[priorityFor(n)] > RANK[t.priority] ? priorityFor(n) : t.priority;
  const due = p === t.priority ? t.due_at : await dueFrom(t.tenant_id, t.lands_at || t.created_at, await targetHours(t.tenant_id, t.service_id, p) * 60 + t.held_minutes);
  await run('UPDATE tickets SET affected_count=?, priority=?, due_at=?, updated_at=? WHERE id=?', n, p, due, ts, t.id);
  if (p !== t.priority) await addEvent(t, { type: 'system', name: 'ONE Desk' }, 'priority_changed', { from: t.priority, to: p, internal: true, meta: { reason: `${n} people affected` } });
  return { ticket: { ...t, affected_count: n, priority: p, due_at: due }, again: false, count: n };
}
// One email per person who reported the ticket, each greeted by name. A long list goes out after the reply (the outbox sends it).
async function notifyRequestors(t, key, vars) {
  const list = await all("SELECT name, contact FROM ticket_requestors WHERE ticket_id=? AND contact LIKE '%@%' ORDER BY raised_at", t.id);
  const send = async () => { for (const r of list) await notify(t, [r.contact], key, { ...vars, requestor_name: r.name }); };
  if (list.length <= 25) return send();
  send().catch(e => console.error('requestor emails', e.message));
}
// "Also close earlier open tickets for the same problem and location": older days' tickets close with the same note
async function closeEarlier(t, req, note) {
  const olds = await all(`SELECT * FROM tickets WHERE tenant_id=? AND service_id=? AND location_key=? AND problem_key=? AND id<>? AND created_date<? AND status IN (${MERGEABLE.map(() => '?').join()})`,
    t.tenant_id, t.service_id, t.location_key, t.problem_key, t.id, t.created_date, ...MERGEABLE);
  let n = 0;
  for (const o of olds) {
    const ts = now(); let done = false;
    await tx(async () => {
      if (!(await run('UPDATE tickets SET status=?, closed_at=?, closed_by=?, hold_started_at=NULL, hold_reason=NULL, hold_due_at=NULL, updated_at=? WHERE id=? AND status=?', 'closed', ts, req.user.id, ts, o.id, o.status)).changes) return;
      await addEvent(o, actorOf(req), 'status_changed', { from: o.status, to: 'closed', body: note, meta: { closed_with: t.ticket_no } }); done = true;
    });
    if (done) { n++; await notifyRequestors(o, 'status_closed', await ticketVars(o, { note, actor_name: req.user.name })); }
  }
  return n;
}

// ---------- public view ----------
// A provider as the requestor sees them. Students never see the provider's mobile number (only the name and email).
const providerCard = ({ name, email, phone }, type) => (type || 'student') === 'student' ? { name, email } : { name, email, phone };
async function publicTicket(t) {
  const svc = await one('SELECT name, code FROM services WHERE id=?', t.service_id), tn = await one('SELECT * FROM tenants WHERE id=?', t.tenant_id);
  const ev = await all('SELECT id,event_type,from_value,to_value,body,actor_type,actor_name,created_at FROM ticket_events WHERE ticket_id=? AND is_internal=0 ORDER BY id', t.id);
  const att = await all('SELECT event_id,file_name,mime_type,storage_key,source,stamped_at FROM attachments WHERE ticket_id=?', t.id);
  const r = await one('SELECT requestor_type FROM requestors WHERE id=?', t.requestor_id);
  // no priority here: the service provider sets it, for the team only
  return { ticket_no: t.ticket_no, subject: t.subject, description: t.description, location: t.location, status: t.status, affected_count: t.affected_count || 1,
    queue: t.status === 'open' ? await queueInfo(t) : null, kind: t.kind || 'issue',
    reopen_request: t.reopen_requested_at && t.status === 'closed' ? { at: t.reopen_requested_at, with: (await reopenDeciders(t)).map(x => x.name.split(' ')[0]).join(' or ') } : null,
    due_at: t.due_at, created_at: t.created_at, closed_at: t.closed_at, reopen_count: t.reopen_count, service: svc.name,
    hold_label: t.status === 'hold' && t.hold_reason ? holdReasons(tn).find(r => r.key === t.hold_reason)?.label : null, hold_due_at: t.status === 'hold' ? t.hold_due_at : null,
    reopen_until: t.status === 'closed' ? addH(t.closed_at, tn.reopen_window_days * 24) : null,
    providers: tn.show_provider_contact ? (await providersFor(t.tenant_id, t.service_id)).map(p => providerCard(p, r?.requestor_type)) : [],
    events: ev.map(e => ({ ...e, actor_name: e.actor_type === 'requestor' ? 'You' : e.actor_name, files: att.filter(a => a.event_id === e.id) })) };
}
async function findPublic(slug, no, q) {
  const tn = await tenantBySlug(slug);
  const t = await one('SELECT * FROM tickets WHERE tenant_id=? AND ticket_no=?', tn.id, normNo(no));
  if (!t) throw notFound();
  return t; // the ticket number alone opens the ticket

}

const P = express.Router();
P.get('/', wrap(async () => await all('SELECT name, code, slug FROM tenants WHERE is_active=1 ORDER BY name')));
P.get('/:slug', wrap(async req => {
  const tn = await tenantBySlug(req.params.slug);
  return { tenant: { name: tn.name, code: tn.code, slug: tn.slug },
    services: await Promise.all((await all('SELECT id,code,name,description,form_schema,parent_id FROM services WHERE tenant_id=? AND is_active=1 ORDER BY sort_order,name', tn.id))
      .map(async s => ({ ...s, form_schema: JSON.parse(s.form_schema) }))) }; // provider names show only after a ticket is raised
}));
P.post('/:slug/tickets', wrap(async req => {
  const tn = await tenantBySlug(req.params.slug), b = req.body;
  if (b.website) throw bad('Rejected'); // honeypot
  limit('ip:' + req.ip, 300); limit('c:' + (b.email || b.phone || ''), 12); // a hostel on one campus Wi-Fi shares one address
  const t = await createTicket(tn, b, { channel: 'portal', actor: { type: 'requestor', name: b.name } });
  const type = (await one('SELECT requestor_type FROM requestors WHERE id=?', t.requestor_id))?.requestor_type;
  return { ticket_no: t.ticket_no, tracking_token: t.tracking_token, due_at: t.due_at, merged: !!t.merged, affected_count: t.affected_count || 1, kind: t.kind || 'issue',
    queue: t.status === 'open' ? await queueInfo(t) : null,
    providers: (await providersFor(tn.id, t.service_id)).map(p => { const { email, ...c } = providerCard(p, type); return c; }) };
}));
P.get('/:slug/tickets/:no', wrap(async req => await publicTicket(await findPublic(req.params.slug, req.params.no, req.query))));
P.post('/:slug/tickets/:no/notes', wrap(async req => {
  const t = await findPublic(req.params.slug, req.params.no, req.body);
  limit('note:' + t.id, 20);
  if (t.status === 'rejected') throw new HttpErr(409, 'BAD_TRANSITION', 'This ticket is rejected; raise a new one');
  const r = await one('SELECT name FROM requestors WHERE id=?', t.requestor_id);
  await tx(async () => { const ev = await addEvent(t, { type: 'requestor', id: t.requestor_id, name: r.name }, 'note', { body: req_(req.body.body, 'Write a note') });
    await saveFiles(t, ev, req.body.files, 'requestor'); await run('UPDATE tickets SET updated_at=? WHERE id=?', now(), t.id); });
  await notify(t, (await providersFor(t.tenant_id, t.service_id)).map(p => p.email), 'requestor_note', await ticketVars(t, { note: req.body.body }));
  return await publicTicket(await one('SELECT * FROM tickets WHERE id=?', t.id));
}));
P.post('/:slug/tickets/:no/reopen', wrap(async req => {
  const t = await findPublic(req.params.slug, req.params.no, req.body), tn = await one('SELECT * FROM tenants WHERE id=?', t.tenant_id);
  assertTransition(t.status, 'open', 'requestor');
  if (Date.now() > new Date(addH(t.closed_at, tn.reopen_window_days * 24)).getTime()) throw new HttpErr(409, 'BAD_TRANSITION', 'The reopen window has passed; raise a new ticket');
  if (t.reopen_requested_at) throw new HttpErr(409, 'ALREADY_REQUESTED', 'You already asked to reopen this ticket. The team will answer soon; you can add a note meanwhile.');
  limit('reopen:' + t.id, 5);
  const r = await one('SELECT name FROM requestors WHERE id=?', t.requestor_id), reason = req_(req.body.reason, 'Give a reason'), ts = now();
  // a request, not a reopen: the provider who closed it accepts (it reopens) or declines (it stays closed)
  await tx(async () => {
    stillAs(await run('UPDATE tickets SET reopen_requested_at=?, reopen_request_note=?, updated_at=? WHERE id=? AND status=? AND reopen_requested_at IS NULL', ts, String(reason).slice(0, 2000), ts, t.id, 'closed'));
    await addEvent(t, { type: 'requestor', id: t.requestor_id, name: r.name }, 'reopen_requested', { body: reason });
  });
  await notify(t, (await reopenDeciders(t)).map(u => u.email), 'reopen_requested', await ticketVars(t, { note: reason, actor_name: r.name }));
  return await publicTicket(await one('SELECT * FROM tickets WHERE id=?', t.id));
}));
// a conditional UPDATE that matched nothing: someone else changed the ticket since we read it
const stillAs = r => { if (!r.changes) throw new HttpErr(409, 'BAD_TRANSITION', 'This ticket was just changed by someone else. Reload it and try again.'); };
// Who decides a reopen request: the provider who closed the ticket; if they have left, the service's providers.
async function reopenDeciders(t) {
  const closer = t.closed_by && await one('SELECT id, name, email FROM users WHERE id=? AND is_active=1', t.closed_by);
  return closer ? [closer] : await providersFor(t.tenant_id, t.service_id);
}
// penalty: the requestor asked for it (the ticket was not fixed), so the closer loses the reopen points
async function doReopen(t, actor, reason, { penalty = false } = {}) {
  await tx(async () => {
    if (penalty) await award(t, t.closed_by, POINTS.reopened, 'Requestor reopened the ticket');
    stillAs(await run('UPDATE tickets SET status=?, reopen_count=reopen_count+1, closed_at=NULL, closed_by=NULL, escalated_at=NULL, escalated_to=NULL, reopen_requested_at=NULL, reopen_request_note=NULL, due_at=?, updated_at=? WHERE id=? AND status=?',
      'open', t.kind === 'suggestion' ? null : await dueFrom(t.tenant_id, now(), await targetHours(t.tenant_id, t.service_id, t.priority) * 60), now(), t.id, t.status));
    await addEvent(t, actor, 'reopened', { from: 'closed', to: 'open', body: reason });
  });
  await notify(t, (await providersFor(t.tenant_id, t.service_id)).map(p => p.email), 'reopened', await ticketVars(t, { note: reason, actor_name: actor.type === 'requestor' ? `the requestor (${actor.name})` : actor.name }));
}
// ---------- ONE Desk Bot: answers from the app's own live data (no AI, nothing leaves the server) ----------
// Requestors (no sign-in) get what their ticket page shows; providers their own services; admins the whole campus.
const BOT_ST = { open: 'Open', in_progress: 'In progress', hold: 'On hold', closed: 'Closed', rejected: 'Rejected' };
const botNo = q => (q.match(/(?:#|\bno\.?\s*|\bticket\s*(?:no\.?|number)?\s*)(\d{1,6})\b/i) || q.match(/^\s*(\d{1,6})\s*$/))?.[1];
const said = (q, re) => re.test(q.toLowerCase());
const lastUpdate = async t => (await one("SELECT body, created_at FROM ticket_events WHERE ticket_id=? AND is_internal=0 AND coalesce(body,'')<>'' ORDER BY id DESC LIMIT 1", t.id));
const REQ_CHIPS = ['Track my ticket', 'How to raise a ticket', 'Which teams can help?', 'How long will it take?', 'Daily limit', 'Reopen a ticket'];
async function publicBot(tn, q) {
  const no = botNo(q), raiseLink = { title: 'Raise a ticket', href: `#/d/${tn.slug}/raise` };
  if (no) {
    const t = await one('SELECT * FROM tickets WHERE tenant_id=? AND ticket_no=?', tn.id, normNo(no));
    if (!t || t.is_internal) return { text: `I couldn't find ticket ${normNo(no)}. Check the number in your email, it looks like 0042.`, chips: ['Track my ticket', 'How to raise a ticket'] };
    const svc = await one('SELECT name FROM services WHERE id=?', t.service_id), up = await lastUpdate(t), names = (await providersFor(tn.id, t.service_id)).map(p => p.name.split(' ')[0]).join(', ');
    const qi = t.status === 'open' ? await queueInfo(t) : null;
    const when = t.kind === 'suggestion' ? (t.status === 'closed' ? `Your suggestion was closed on ${fmtIST(t.closed_at)}. Thank you!` : `Your suggestion is with the ${svc.name} team. Thank you!`) : qi ? `It is in the ${svc.name} queue: number ${qi.queue_no}, reaching the team on ${qi.lands_on}. Target: ${fmtIST(t.due_at)}.` : ACTIVE.includes(t.status) && t.due_at < now() ? `It is taking longer than planned (the target was ${fmtIST(t.due_at)})${t.escalated_at ? ' and has been escalated for faster help' : ''}. We are sorry for the wait.`
      : t.status === 'hold' ? `It is on hold${t.hold_due_at ? `, expected to resume by ${fmtIST(t.hold_due_at)}` : ''}.` : ACTIVE.includes(t.status) ? `Target: ${fmtIST(t.due_at)}.` : t.status === 'closed' ? `Closed on ${fmtIST(t.closed_at)}. Not fixed? You can reopen it within ${tn.reopen_window_days} days.` : 'This ticket was not accepted. You can raise a new one.';
    return { text: `Ticket ${t.ticket_no} is ${BOT_ST[t.status]}.\n${svc.name}${t.location ? ' · ' + t.location : ''}\n${when}${names ? `\nHandled by ${names}.` : ''}`
      + `${t.affected_count > 1 ? `\nKnown issue: ${t.affected_count} people reported this.` : ''}${up ? `\nLatest update (${fmtIST(up.created_at)}): ${up.body}` : ''}`,
      items: [{ title: `Open ticket ${t.ticket_no}`, href: `#/d/${tn.slug}/t/${t.ticket_no}` }], chips: ['Reopen a ticket', 'How long will it take?'] };
  }
  if (said(q, /\b(food|meal|mess|canteen|breakfast|lunch|snacks|dinner|rate|rating)/)) { const fs = await foodService(tn.id);
    if (fs) return { text: 'For food you can do two things:\n• Rate your meal: stars and a quick note. It goes to the kitchen team\'s report tonight; no ticket.\n• Report a serious problem (insect, spoiled food, hygiene, billing, staff behaviour): this raises a ticket and needs a photo.',
      items: [{ title: 'Rate your meal', href: `#/d/${tn.slug}/raise/${fs.code}?flow=rate` }, { title: 'Report a serious problem', href: `#/d/${tn.slug}/raise/${fs.code}?flow=report` }] }; }
  if (said(q, /\b(track|status|where|find|check|my ticket)/)) return { text: 'Type your ticket number, for example 0042. You find it on the screen after raising and in every email.' };
  if (said(q, /\b(raise|new|complain|report|problem|broken|not working|issue)/)) return { text: 'To raise a ticket:\n1. Pick the team that can help.\n2. Fill in your details, where the problem is and what happened.\n3. Add up to 4 photos if you like, then tap Raise ticket.\nYou get a ticket number straight away, and an email at every step. No login needed.', items: [raiseLink, { title: 'Step-by-step guide (2 min, with voice)', href: 'guide/requestor.html' }] };
  if (said(q, /\b(team|service|which|who can|department)/)) {
    const svcs = await all('SELECT code, name, description FROM services WHERE tenant_id=? AND is_active=1 ORDER BY sort_order, name', tn.id);
    return { text: `${svcs.length} teams can help at ${tn.name}. Tap one to raise a ticket with it.`, items: svcs.map(s => ({ title: s.name, sub: s.description || '', href: `#/d/${tn.slug}/raise/${s.code}` })) };
  }
  if (said(q, /\b(limit|how many|per day|a day)/)) { const l = dailyLimits(tn); return { text: `Each email can raise ${l.student} tickets a day (faculty ${l.faculty}, staff ${l.staff}). After that, the form tells you when you can raise the next one. For something urgent, add a note to one of today's tickets.` }; }
  if (said(q, /\b(reopen|again|not fixed)/)) return { text: `If a closed ticket is not fixed, open it (type its number here) and tap Reopen. You can reopen within ${tn.reopen_window_days} days of closing; after that, raise a new ticket.` };
  if (said(q, /\b(photo|image|picture|camera|attach)/)) return { text: 'You can add up to 4 photos from the camera or gallery, in any format, including iPhone HEIC. Big photos are made smaller on your phone before they upload.' };
  if (said(q, /\b(time|long|when|soon|sla|hours|target)/)) {
    const h = (await Promise.all(PRIORITIES.map(p => targetHours(tn.id, null, p)))).sort((a, b) => a - b);
    return { text: `Each ticket gets a target time in working hours (${tn.work_start}–${tn.work_end}), from ${h[0]} to ${h[h.length - 1]} working hours. The team decides how urgent each ticket is. Your ticket shows its own target time.`
      + '\nSome teams take a set number of tickets a day. When a day is full, your ticket gets a queue number and reaches the team on the next free day; the ticket page shows the date.' };
  }
  if (said(q, /\b(guide|learn|how does|how to use)/)) return { text: 'The 2-minute guide shows every step, with voice in English or Telugu.', items: [{ title: 'Open the guide', href: 'guide/requestor.html' }] };
  if (said(q, /\b(hi|hello|hey|namaste|namaskaram|help|menu|start)\b/)) return { text: `Hi! I'm the ONE Desk Bot for ${tn.name}. I can check your ticket, or tell you how ONE Desk works. What do you need?`, chips: REQ_CHIPS };
  return { text: "Sorry, I didn't get that. Type your ticket number (like 0042), or pick one of these:", chips: REQ_CHIPS };
}
P.post('/:slug/bot', wrap(async req => {
  const tn = await tenantBySlug(req.params.slug); limit('bot:' + req.ip, 600);
  return await publicBot(tn, String(req.body.q || '').slice(0, 300));
}));

app.use('/api/public', P);
app.get('/api/files/:key', mw(async (req, res) => {
  const a = await one('SELECT * FROM attachments WHERE storage_key=?', req.params.key);
  if (!a) return res.status(404).end();
  // the key is the permission (it is in the ticket and its emails); a stored file never changes, so it may be kept
  res.set({ 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=31536000, immutable' });
  if (!Object.values(SHOWN).includes(a.mime_type) && a.mime_type !== 'application/pdf') res.attachment(a.file_name); // other files download
  res.type(a.mime_type).sendFile(path.resolve(UPLOAD_DIR, a.storage_key));
}));
app.get('/api/health', mw(async (_q, r) => { await one('SELECT 1'); r.json({ ok: true }); })); // also checks the database

// ---------- version: the commit this process started from, and the one checked out now ----------
// Reads .git directly (no process spawned per request). restart_needed = pulled but not restarted yet.
const gitHead = () => { try {
  const head = fs.readFileSync(path.join(ROOT, '.git/HEAD'), 'utf8').trim();
  if (!head.startsWith('ref: ')) return head; // detached, e.g. after a rollback checkout
  const ref = head.slice(5);
  try { return fs.readFileSync(path.join(ROOT, '.git', ref), 'utf8').trim(); }
  catch { return fs.readFileSync(path.join(ROOT, '.git/packed-refs'), 'utf8').split('\n').find(l => l.endsWith(' ' + ref))?.split(' ')[0] || null; }
} catch { return null; } };
const RUNNING = (() => {
  let subject = null, committed_at = null;
  try { [subject, committed_at] = execFileSync('git', ['log', '-1', '--format=%s%n%cI'], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n'); } catch { /* not a git checkout */ }
  return { commit: gitHead()?.slice(0, 7) ?? null, subject, committed_at, started_at: now() };
})();
app.get('/api/version', (_q, r) => {
  const on_disk = gitHead()?.slice(0, 7) ?? null;
  r.set('Cache-Control', 'no-store').json({ ...RUNNING, on_disk, restart_needed: !!on_disk && on_disk !== RUNNING.commit });
});

// ---------- auth ----------
app.post('/api/auth/login', wrap(async req => {
  limit('login:' + req.ip, 30, 900e3);
  const u = await one('SELECT * FROM users WHERE lower(email)=lower(?) AND is_active=1', req.body.email || '');
  const own = u && checkPw(req.body.password || '', u.password_hash);
  const temp = u && !own && u.temp_pw_hash && u.temp_pw_expires > now() && checkPw(req.body.password || '', u.temp_pw_hash);
  if (!own && !temp) throw new HttpErr(401, 'UNAUTHORIZED', 'Wrong email or password');
  // signed in with the emailed temporary password: they must choose a new one now
  if (temp) await run('UPDATE users SET must_change_pw=1 WHERE id=?', u.id);
  if (OWNER && u.email.toLowerCase() === OWNER && (u.role !== 'super_admin' || u.tenant_id)) await run("UPDATE users SET role='super_admin', tenant_id=NULL WHERE id=?", u.id); // the owner signs in as super admin
  await run('UPDATE users SET last_login_at=? WHERE id=?', now(), u.id);
  return { token: sign({ sub: u.id, role: u.role, tid: u.tenant_id }) };
}));

// Forgot password: email a temporary password (valid 1 hour) to that address if it is a ONE Desk account. Their own password
// keeps working until they sign in with the temporary one, so a stranger typing their email can't lock them out.
// The answer is the same either way, so it doesn't reveal who has an account.
app.post('/api/auth/forgot', wrap(async req => {
  const email = String(req.body.email || '').trim().toLowerCase();
  limit('forgot:' + req.ip, 10, 900e3);
  if (!/^\S+@\S+\.\S+$/.test(email)) throw bad('Enter your email');
  const msg = { ok: true, message: 'If this email has a ONE Desk account, a temporary password is on its way. It works for 1 hour. Check your spam folder too.' };
  const u = await one('SELECT * FROM users WHERE lower(email)=? AND is_active=1', email); if (!u) return msg;
  try { limit('forgot-u:' + u.id, 3, 3600e3); } catch { return msg; } // at most 3 emails an hour per account
  const pw = tempPw(), exp = new Date(Date.now() + 3600e3).toISOString();
  await run('UPDATE users SET temp_pw_hash=?, temp_pw_expires=? WHERE id=?', hashPw(pw), exp, u.id);
  await notify({ tenant_id: u.tenant_id }, [u.email], 'password_forgot', await staffVars(u, pw));
  return msg;
}));

const S = express.Router();
S.use(auth);
S.get('/me', wrap(async req => {
  const { password_hash, ...u } = req.user;
  return { user: u, tenants: u.role === 'super_admin' ? await all('SELECT * FROM tenants ORDER BY name') : await all('SELECT * FROM tenants WHERE id=?', u.tenant_id) };
}));
S.post('/me/password', wrap(async req => {
  const pw = String(req.body.password || '');
  // the current password is always required: the temporary one from the email on first sign-in, the own one afterwards
  const cur = String(req.body.current || ''), viaTemp = req.user.temp_pw_hash && req.user.temp_pw_expires > now() && checkPw(cur, req.user.temp_pw_hash);
  if (!checkPw(cur, req.user.password_hash) && !viaTemp) throw bad(req.user.must_change_pw ? 'Temporary password is wrong' : 'Current password is wrong');
  if (pw.length < 8 || !/[A-Za-z]/.test(pw) || !/\d/.test(pw)) throw bad('Use at least 8 characters with letters and numbers');
  if (checkPw(pw, req.user.password_hash)) throw bad('Pick a password different from the current one');
  await run('UPDATE users SET password_hash=?, must_change_pw=0, temp_pw_hash=NULL, temp_pw_expires=NULL WHERE id=?', hashPw(pw), req.user.id);
  await notify({ tenant_id: req.user.tenant_id }, [req.user.email], 'password_changed', { ...await staffVars(req.user, pw), password: pw });
  await audit(req, 'user.password_changed', 'user', req.user.id, {});
  return { ok: true };
}));

// tenants (super admin)
S.post('/tenants', role('super_admin'), wrap(async req => {
  const b = req.body; req_(b.code, 'Code required'); req_(b.name, 'Name required'); req_(b.slug, 'Slug required');
  const code = String(b.code).trim().toUpperCase(), slug = String(b.slug).trim().toLowerCase();
  if (!/^[A-Z0-9]{2,10}$/.test(code)) throw bad('Code: 2–10 letters or digits, e.g. SMRU');
  if (!/^[a-z0-9-]{2,30}$/.test(slug)) throw bad('Slug: lowercase letters, digits and hyphens, e.g. smru');
  if (await one('SELECT 1 FROM tenants WHERE code=? OR slug=?', code, slug)) throw new HttpErr(409, 'CONFLICT', 'A campus with that code or slug already exists');
  b.code = code; b.slug = slug;
  const t = await insert('tenants', { id: uid(), code: b.code.toUpperCase(), name: b.name, slug: b.slug.toLowerCase(), timezone: b.timezone || 'Asia/Kolkata',
    show_provider_contact: b.show_provider_contact === false ? 0 : 1, reopen_window_days: Number(b.reopen_window_days) || 7, is_active: 1 });
  for (const [p, h] of Object.entries(DEFAULT_HOURS)) await insert('sla_policies', { id: uid(), tenant_id: t.id, service_id: null, priority: p, target_hours: h });
  await audit(req, 'tenant.create', 'tenant', t.id, b); return t;
}));
S.patch('/tenants/:id', role('super_admin'), wrap(async req => {
  const b = req.body, t = await one('SELECT * FROM tenants WHERE id=?', req.params.id); if (!t) throw notFound();
  await run('UPDATE tenants SET name=?, timezone=?, show_provider_contact=?, reopen_window_days=?, is_active=? WHERE id=?',
    b.name ?? t.name, b.timezone ?? t.timezone, b.show_provider_contact ?? t.show_provider_contact, b.reopen_window_days ?? t.reopen_window_days, b.is_active ?? t.is_active, t.id);
  await audit(req, 'tenant.update', 'tenant', t.id, b); return await one('SELECT * FROM tenants WHERE id=?', t.id);
}));

// everything below is tenant scoped
S.use(needTenant);
S.get('/users', role('super_admin', 'tenant_admin'), wrap(async req =>
  await all(`SELECT u.id,u.name,u.email,u.phone,u.role,u.is_active,u.last_login_at,u.must_change_pw,
    (SELECT string_agg(s.name, ', ' ORDER BY s.name) FROM service_members m JOIN services s ON s.id=m.service_id WHERE m.user_id=u.id) services
    FROM users u WHERE u.tenant_id=? ORDER BY u.is_active DESC, u.role DESC, u.name`, req.tenantId)));
const tempPw = () => crypto.randomBytes(6).toString('base64url').replace(/[-_]/g, 'x') + Math.floor(10 + Math.random() * 90);
// a tenant admin manages providers (and edits themselves); only the super admin manages tenant admins
async function managed(req) {
  const u = await one('SELECT * FROM users WHERE id=? AND tenant_id=?', req.params.id, req.tenantId); if (!u) throw notFound();
  if (req.user.role !== 'super_admin' && u.role !== 'provider' && u.id !== req.user.id) throw forbid();
  return u;
}
S.post('/users', role('super_admin', 'tenant_admin'), wrap(async req => {
  const b = req.body; req_(b.name, 'Name required'); req_(b.email, 'Email required');
  const r = b.role === 'tenant_admin' ? 'tenant_admin' : 'provider';
  if (r === 'tenant_admin' && req.user.role !== 'super_admin') throw forbid();
  if (await one('SELECT 1 FROM users WHERE lower(email)=lower(?)', b.email)) throw new HttpErr(409, 'CONFLICT', 'Email already in use');
  const svcs = [];
  for (const id of new Set(Array.isArray(b.service_ids) ? b.service_ids : [])) {
    const s = await one('SELECT id, name FROM services WHERE id=? AND tenant_id=? AND is_active=1', id, req.tenantId); if (!s) throw bad('Unknown service');
    svcs.push(s.id);
  }
  const pw = tempPw();
  const u = await insert('users', { id: uid(), tenant_id: req.tenantId, name: b.name, email: String(b.email).trim(), phone: b.phone, role: r, password_hash: hashPw(pw), is_active: 1, must_change_pw: 1 });
  for (const sid of svcs) await insert('service_members', { id: uid(), tenant_id: req.tenantId, service_id: sid, user_id: u.id, created_at: now() });
  await notify({ tenant_id: req.tenantId }, [u.email], 'invite', await staffVars(u, pw));
  await audit(req, 'user.create', 'user', u.id, { email: u.email, role: r });
  return { id: u.id, temp_password: pw };
}));
S.patch('/users/:id', role('super_admin', 'tenant_admin'), wrap(async req => {
  const u = await managed(req), b = req.body;
  if (b.is_active === 0 && u.id === req.user.id) throw bad("You can't deactivate yourself");
  if (b.role && b.role !== u.role) {
    if (req.user.role !== 'super_admin' || !['provider', 'tenant_admin'].includes(b.role)) throw forbid();
  }
  const email = b.email ? String(b.email).trim() : u.email;
  if (!/^\S+@\S+\.\S+$/.test(email)) throw bad('Enter a valid email');
  if (email.toLowerCase() !== u.email.toLowerCase() && await one('SELECT 1 FROM users WHERE lower(email)=lower(?)', email)) throw new HttpErr(409, 'CONFLICT', 'Email already in use');
  await run('UPDATE users SET name=?, email=?, phone=?, role=?, is_active=? WHERE id=?', String(b.name ?? u.name).trim() || u.name, email, b.phone ?? u.phone, b.role || u.role, b.is_active ?? u.is_active, u.id);
  if (b.is_active === 0) await run('DELETE FROM service_members WHERE user_id=?', u.id);
  await audit(req, 'user.update', 'user', u.id, b); return { ok: true };
}));
S.post('/users/:id/reset-password', role('super_admin', 'tenant_admin'), wrap(async req => {
  const u = await managed(req);
  if (u.id === req.user.id) throw bad('Change your own password from Profile');
  if (!u.is_active) throw bad('Activate this account first');
  const pw = tempPw();
  await run('UPDATE users SET password_hash=?, must_change_pw=1 WHERE id=?', hashPw(pw), u.id);
  await notify({ tenant_id: req.tenantId }, [u.email], 'password_reset', await staffVars(u, pw));
  await audit(req, 'user.reset_password', 'user', u.id, { email: u.email });
  return { temp_password: pw };
}));

// The escalation person must be an active provider or campus admin of this campus.
async function escalationUser(req, id) {
  if (!id) return null;
  if (!await one("SELECT 1 FROM users WHERE id=? AND tenant_id=? AND is_active=1 AND role IN ('provider','tenant_admin')", id, req.tenantId)) throw bad('Pick an escalation person from this campus’s providers');
  return id;
}
// A sub-team sits under one top-level team of the same campus (one level deep: Maintenance → Electrical)
async function parentTeam(req, id, selfId) {
  if (!id) return null;
  const p = await one('SELECT id, parent_id FROM services WHERE id=? AND tenant_id=?', id, req.tenantId);
  if (!p || p.id === selfId) throw bad('Pick a main team from this campus');
  if (p.parent_id) throw bad('A sub-team cannot have its own sub-teams; pick a main team');
  if (selfId && await one('SELECT 1 AS x FROM services WHERE parent_id=?', selfId)) throw bad('This team has sub-teams, so it cannot become a sub-team');
  return p.id;
}
// Escalation officers: any number of this campus's providers or admins; the first is also kept as escalation_user_id
async function setEscalations(req, sid, ids) {
  ids = [...new Set(ids.filter(Boolean))];
  for (const id of ids) await escalationUser(req, id);
  await tx(async () => { await run('DELETE FROM service_escalations WHERE service_id=?', sid);
    for (const id of ids) await run('INSERT INTO service_escalations (service_id, user_id) VALUES (?, ?)', sid, id);
    await run('UPDATE services SET escalation_user_id=? WHERE id=?', ids[0] || null, sid); });
  // tickets of this team (and its sub-teams that have no officers of their own) already escalated and still open move to the new officers
  if (!ids.length) return;
  const to = await one('SELECT id, name, email FROM users WHERE id=?', ids[0]);
  const open = await all(`SELECT t.* FROM tickets t JOIN services s ON s.id=t.service_id WHERE t.escalated_at IS NOT NULL AND t.status IN ('open','in_progress','hold')
    AND t.escalated_to IS DISTINCT FROM ? AND (s.id=? OR (s.parent_id=? AND NOT EXISTS (SELECT 1 FROM service_escalations e WHERE e.service_id=s.id)))`, to.id, sid, sid);
  for (const t of open) {
    await tx(async () => { await run('UPDATE tickets SET escalated_to=?, updated_at=? WHERE id=?', to.id, now(), t.id);
      await addEvent(t, actorOf(req), 'escalated', { to: to.name, body: 'Escalation officers changed by the admin.', internal: true }); });
    const officers = await all(`SELECT u.email FROM users u WHERE u.id IN (${ids.map(() => '?').join()}) AND u.is_active=1`, ...ids);
    await notify(t, officers.map(o => o.email), 'escalated', await ticketVars(t, { escalated_to_name: to.name, note: 'The escalation officers for this team were changed; this ticket is now with you.' }));
  }
}
// Escalate after: working hours past the target (0 = the moment it is missed; empty = the campus setting)
const escHours = v => { if (v === '' || v == null) return null; const n = Number(v); if (!(n >= 0 && n <= 2000)) throw bad('Escalate after: working hours, 0 to 2000 (empty = campus setting)'); return n; };
// Tickets a day the team takes in (0 or empty = no limit); the rest wait in its queue
const dailyCap = v => { const n = v === '' || v == null ? 0 : Number(v); if (!Number.isInteger(n) || n < 0 || n > 100000) throw bad('Tickets a day: a whole number (0 or empty = no limit)'); return n; };
S.get('/services', wrap(async req => Promise.all((await all('SELECT * FROM services WHERE tenant_id=? ORDER BY sort_order,name', req.tenantId))
  .map(async s => ({ ...s, form_schema: JSON.parse(s.form_schema), members: await providersFor(req.tenantId, s.id),
    queue: await one('SELECT count(*)::int waiting, min(queue_day) next_day FROM tickets WHERE service_id=? AND queued=1', s.id),
    escalation_users: await escalationOfficers(s.id),
    escalation_user: s.escalation_user_id ? await one('SELECT id, name FROM users WHERE id=? AND is_active=1', s.escalation_user_id) || null : null,
    sla: Object.fromEntries((await all('SELECT priority,target_hours FROM sla_policies WHERE tenant_id=? AND service_id=?', req.tenantId, s.id)).map(x => [x.priority, x.target_hours])) })))));
S.post('/services', role('super_admin', 'tenant_admin'), wrap(async req => {
  const b = req.body; req_(b.code, 'Code required'); req_(b.name, 'Name required');
  b.code = String(b.code).trim().toUpperCase();
  if (!/^[A-Z0-9-]{2,12}$/.test(b.code)) throw bad('Code: 2–12 letters or digits (no spaces), e.g. ADM');
  if (await one('SELECT 1 FROM services WHERE tenant_id=? AND code=?', req.tenantId, b.code)) throw new HttpErr(409, 'CONFLICT', 'Code exists');
  const s = await insert('services', { id: uid(), tenant_id: req.tenantId, code: b.code, name: b.name, description: b.description,
    form_schema: JSON.stringify(cleanSchema(b.form_schema)), is_active: 1, sort_order: Number(b.sort_order) || 0, escalation_user_id: await escalationUser(req, b.escalation_user_id),
    daily_cap: dailyCap(b.daily_cap), parent_id: await parentTeam(req, b.parent_id, null), escalate_after_hours: escHours(b.escalate_after_hours) });
  if (Array.isArray(b.escalation_user_ids)) await setEscalations(req, s.id, b.escalation_user_ids);
  else if (b.escalation_user_id) await setEscalations(req, s.id, [b.escalation_user_id]);
  if (b.sla) for (const p of PRIORITIES) if (Number(b.sla[p]) > 0) await insert('sla_policies', { id: uid(), tenant_id: req.tenantId, service_id: s.id, priority: p, target_hours: Number(b.sla[p]) });
  await audit(req, 'service.create', 'service', s.id, b); return s;
}));
S.patch('/services/:id', role('super_admin', 'tenant_admin'), wrap(async req => {
  const s = await one('SELECT * FROM services WHERE id=? AND tenant_id=?', req.params.id, req.tenantId); if (!s) throw notFound();
  const b = req.body;
  await run('UPDATE services SET name=?, description=?, form_schema=?, is_active=?, sort_order=? WHERE id=?', b.name ?? s.name, b.description ?? s.description,
    b.form_schema ? JSON.stringify(cleanSchema(b.form_schema)) : s.form_schema, b.is_active ?? s.is_active, b.sort_order ?? s.sort_order, s.id);
  if (b.escalation_user_id !== undefined && !Array.isArray(b.escalation_user_ids)) await setEscalations(req, s.id, [b.escalation_user_id]);
  if (b.daily_cap !== undefined) await run('UPDATE services SET daily_cap=? WHERE id=?', dailyCap(b.daily_cap), s.id);
  if (b.escalate_after_hours !== undefined) await run('UPDATE services SET escalate_after_hours=? WHERE id=?', escHours(b.escalate_after_hours), s.id);
  if (b.parent_id !== undefined) await run('UPDATE services SET parent_id=? WHERE id=?', await parentTeam(req, b.parent_id, s.id), s.id);
  if (Array.isArray(b.escalation_user_ids)) await setEscalations(req, s.id, b.escalation_user_ids);
  if (b.sla) for (const p of PRIORITIES) {
    await run('DELETE FROM sla_policies WHERE tenant_id=? AND service_id=? AND priority=?', req.tenantId, s.id, p);
    if (Number(b.sla[p]) > 0) await insert('sla_policies', { id: uid(), tenant_id: req.tenantId, service_id: s.id, priority: p, target_hours: Number(b.sla[p]) });
  }
  await audit(req, 'service.update', 'service', s.id, b); return { ok: true };
}));
// Delete a team for good: only when it never had a ticket and has no sub-teams (otherwise deactivate it, which keeps its history)
S.delete('/services/:id', role('super_admin', 'tenant_admin'), wrap(async req => {
  const s = await one('SELECT * FROM services WHERE id=? AND tenant_id=?', req.params.id, req.tenantId); if (!s) throw notFound();
  const { n } = await one('SELECT count(*)::int n FROM tickets WHERE service_id=?', s.id);
  if (n) throw new HttpErr(409, 'IN_USE', `${s.name} has ${n} ticket${n === 1 ? '' : 's'}, so it can't be deleted. Deactivate it instead: it leaves the portal and its tickets stay.`);
  const subs = await all('SELECT name FROM services WHERE parent_id=?', s.id);
  if (subs.length) throw new HttpErr(409, 'IN_USE', `${s.name} has sub-teams (${subs.map(x => x.name).join(', ')}). Move or delete them first.`);
  await tx(async () => {
    for (const t of ['service_members', 'service_escalations', 'sla_policies']) await run(`DELETE FROM ${t} WHERE service_id=?`, s.id);
    await run('DELETE FROM services WHERE id=?', s.id);
  });
  await audit(req, 'service.delete', 'service', s.id, { code: s.code, name: s.name }); return { ok: true };
}));
S.put('/services/:id/members', role('super_admin', 'tenant_admin'), wrap(async req => {
  const s = await one('SELECT * FROM services WHERE id=? AND tenant_id=?', req.params.id, req.tenantId); if (!s) throw notFound();
  const ids = [...new Set(req.body.user_ids || [])];
  for (const id of ids) if (!await one("SELECT 1 FROM users WHERE id=? AND tenant_id=? AND is_active=1 AND role IN ('provider','tenant_admin')", id, req.tenantId)) throw notFound();
  await tx(async () => { await run('DELETE FROM service_members WHERE service_id=?', s.id);
    for (const id of ids) await insert('service_members', { id: uid(), tenant_id: req.tenantId, service_id: s.id, user_id: id, created_at: now() }); });
  await audit(req, 'service.members', 'service', s.id, { user_ids: ids }); return await providersFor(req.tenantId, s.id);
}));
// SLA settings: working window, target hours per priority (working hours), hold reasons with their own SLA
S.get('/sla', wrap(async req => {
  const tn = await tenantRow(req.tenantId);
  return { work_start: tn.work_start, work_end: tn.work_end, work_days: String(tn.work_days).split(',').filter(Boolean).map(Number),
    targets: Object.fromEntries((await all('SELECT priority,target_hours FROM sla_policies WHERE tenant_id=? AND service_id IS NULL', req.tenantId)).map(x => [x.priority, x.target_hours])),
    escalate_after_days: tn.escalate_after_days ?? 0, escalate_holds: !!tn.escalate_holds,
    hold_reasons: holdReasons(tn), daily_limits: dailyLimits(tn), point_rules: POINT_RULES.map(r => ({ ...r, upTo: r.upTo === Infinity ? null : r.upTo })), points: POINTS };
}));
S.put('/sla', role('super_admin', 'tenant_admin'), wrap(async req => {
  const b = req.body, hhmm = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (!hhmm.test(b.work_start) || !hhmm.test(b.work_end) || b.work_end <= b.work_start) throw bad('Working hours must be like 09:00 – 17:00');
  const days = [...new Set((b.work_days || []).map(Number))].filter(d => d >= 0 && d <= 6);
  if (!days.length) throw bad('Pick at least one working day');
  const reasons = (b.hold_reasons || []).filter(r => String(r.label || '').trim()).map((r, i) => ({
    key: String(r.key || r.label).toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 30) || 'r' + i, label: String(r.label).trim().slice(0, 60), hours: Number(r.hours) }));
  if (!reasons.length || reasons.some(r => !(r.hours > 0))) throw bad('Each hold reason needs a name and hours above 0');
  if (new Set(reasons.map(r => r.key)).size !== reasons.length) throw bad('Hold reasons must have different names');
  await tx(async () => {
    await run('UPDATE tenants SET work_start=?, work_end=?, work_days=?, hold_reasons=? WHERE id=?', b.work_start, b.work_end, days.join(','), JSON.stringify(reasons), req.tenantId);
    if (b.daily_limits) {
      const lim = Object.fromEntries(REQUESTOR_TYPES.map(t => [t, Number(b.daily_limits[t] ?? DAILY_LIMITS[t])]));
      if (Object.values(lim).some(v => !(Number.isInteger(v) && v >= 1 && v <= 100))) throw bad('Daily limits must be whole numbers from 1 to 100');
      await run('UPDATE tenants SET daily_limits=? WHERE id=?', JSON.stringify(lim), req.tenantId);
    }
    if (b.escalate_after_days !== undefined) {
      const d = Number(b.escalate_after_days); if (!(d >= 0 && d <= 60)) throw bad('Escalate after must be between 0 and 60 working days');
      await run('UPDATE tenants SET escalate_after_days=?, escalate_holds=? WHERE id=?', d, b.escalate_holds ? 1 : 0, req.tenantId);
    }
    for (const p of PRIORITIES) if (Number(b.targets?.[p]) > 0) {
      await run('DELETE FROM sla_policies WHERE tenant_id=? AND service_id IS NULL AND priority=?', req.tenantId, p);
      await insert('sla_policies', { id: uid(), tenant_id: req.tenantId, service_id: null, priority: p, target_hours: Number(b.targets[p]) });
    }
  });
  await audit(req, 'sla.update', 'sla', null, b); return { ok: true };
}));

// provider points: my total + history, and the campus leaderboard
// ONE Desk Bot for staff: the same data the desk shows them. Providers: their services and tickets escalated to them.
const STAFF_CHIPS = ['My open tickets', 'Overdue', 'Due today', 'On hold', 'Escalated', 'In the queue', 'My points', "Today's summary"];
const ADMIN_CHIPS = [...STAFF_CHIPS, 'Services with no provider', 'Most affected places', 'Provider workload'];
async function staffBot(req, q) {
  const u = req.user, admin = isAdmin(u), tid = req.tenantId, sids = await myServiceIds(u, tid), n = now(), tn = await tenantRow(tid);
  const scope = `t.tenant_id=? AND (${sids.length ? `t.service_id IN (${sids.map(() => '?').join()}) OR ` : ''}t.escalated_to=? OR (t.escalated_at IS NOT NULL AND EXISTS
    (SELECT 1 FROM service_escalations e JOIN services sv ON sv.id=t.service_id WHERE e.user_id=? AND e.service_id IN (sv.id, sv.parent_id))))`, sa = [tid, ...sids, u.id, u.id]; // the same tickets Home lists
  const list = async (where, args, order = 't.due_at') => all(`SELECT t.id, t.ticket_no, t.subject, t.status, t.priority, t.due_at, t.hold_due_at, t.location, t.affected_count, s.name service
    FROM tickets t JOIN services s ON s.id=t.service_id WHERE ${scope} AND t.queued=0 AND ${where} ORDER BY ${order} LIMIT 8`, ...sa, ...args);
  const count = async (where, args = []) => (await one(`SELECT count(*)::int c FROM tickets t WHERE ${scope} AND t.queued=0 AND ${where}`, ...sa, ...args)).c;
  const items = rows => rows.map(r => ({ title: `#${r.ticket_no} · ${r.subject}`, sub: `${r.service}${r.location ? ' · ' + r.location : ''} · ${BOT_ST[r.status]}${r.affected_count > 1 ? ` · ${r.affected_count} students` : ''}${r.due_at && [...ACTIVE].includes(r.status) ? ` · due ${fmtIST(r.due_at)}` : ''}`, href: `#/c/t/${r.id}` }));
  const act = ACTIVE.map(() => '?').join(), chips = admin ? ADMIN_CHIPS : STAFF_CHIPS;
  const no = botNo(q);
  if (no) {
    const t = await one(`SELECT t.*, s.name service, r.name requestor FROM tickets t JOIN services s ON s.id=t.service_id JOIN requestors r ON r.id=t.requestor_id WHERE ${scope} AND t.ticket_no=?`, ...sa, normNo(no));
    if (!t) return { text: `Ticket ${normNo(no)} is not in your services (or does not exist).` };
    const up = await lastUpdate(t), late = ACTIVE.includes(t.status) && t.due_at < n, qi = t.status === 'open' ? await queueInfo(t) : null;
    const state = [qi ? `In the daily queue: number ${qi.queue_no} of ${qi.waiting}, reaches the team on ${qi.lands_on}` : '',
      t.status === 'hold' ? `On hold: ${holdReasons(tn).find(x => x.key === t.hold_reason)?.label || 'no reason given'}, resume by ${fmtIST(t.hold_due_at)}` : '',
      t.escalated_at && [...ACTIVE, 'hold'].includes(t.status) ? `Escalated on ${fmtIST(t.escalated_at)}` : '', t.status === 'closed' ? `Closed on ${fmtIST(t.closed_at)}` : ''].filter(Boolean).join('\n');
    return { text: `#${t.ticket_no} · ${t.subject}\n${BOT_ST[t.status]} · ${t.priority} priority${late ? ' · OVERDUE' : ''}${state ? '\n' + state : ''}\n${t.service}${t.location ? ' · ' + t.location : ''}${t.problem_label ? ' · ' + t.problem_label : ''}`
      + `\nRaised by ${t.requestor}${t.affected_count > 1 ? ` and ${t.affected_count - 1} more` : ''} on ${fmtIST(t.created_at)}${[...ACTIVE, 'hold'].includes(t.status) && t.due_at ? `\nDue ${fmtIST(t.due_at)}` : ''}${up ? `\nLatest: ${up.body}` : ''}`,
      items: [{ title: `Open #${t.ticket_no}`, href: `#/c/t/${t.id}` }] };
  }
  if (said(q, /overdue|late|missed|breach/)) { const c = await count(`t.status IN (${act}) AND t.due_at<?`, [...ACTIVE, n]);
    return { text: c ? `${c} ticket${c === 1 ? ' is' : 's are'} overdue. Do these first:` : 'Nothing is overdue. Well done!', items: items(await list(`t.status IN (${act}) AND t.due_at<?`, [...ACTIVE, n])) }; }
  if (said(q, /due today|today.*due|due soon/)) { const end = localDay(tn.timezone || 'Asia/Kolkata').next, c = await count(`t.status IN (${act}) AND t.due_at>=? AND t.due_at<?`, [...ACTIVE, n, end]);
    return { text: c ? `${c} ticket${c === 1 ? ' is' : 's are'} due before midnight:` : 'Nothing else is due today.', items: items(await list(`t.status IN (${act}) AND t.due_at>=? AND t.due_at<?`, [...ACTIVE, n, end])) }; }
  if (said(q, /queue|queued|daily limit|tickets a day/)) {
    const rows = await all(`SELECT s.name, s.daily_cap, count(t.id)::int waiting, min(t.lands_at) next FROM services s LEFT JOIN tickets t ON t.service_id=s.id AND t.queued=1
      WHERE s.tenant_id=? AND s.is_active=1 ${sids.length ? `AND s.id IN (${sids.map(() => '?').join()})` : 'AND false'} AND s.daily_cap>0 GROUP BY s.name, s.daily_cap ORDER BY waiting DESC, s.name`, tid, ...sids);
    const total = rows.reduce((a, r) => a + r.waiting, 0);
    return { text: !rows.length ? 'None of your teams has a daily ticket limit, so nothing waits in a queue.' : total ? `${total} ticket${total === 1 ? ' is' : 's are'} waiting in the daily queue:` : 'Nothing is waiting in the daily queue.',
      items: rows.map(r => ({ title: r.name, sub: `Takes ${r.daily_cap} a day · ${r.waiting} waiting${r.next ? ` · next reach the team ${fmtIST(r.next)}` : ''}`, href: '#/c' })) }; }
  if (said(q, /food|meal|rating|kitchen|mess|canteen|breakfast|lunch|snacks|dinner/)) {
    const fs = await foodService(tid);
    if (!fs || !sids.includes(fs.id)) return { text: 'Food scores are for the food team and admins.', chips };
    const day = dayIn(tn.timezone || 'Asia/Kolkata', n), rows_ = await feedbackIn(tid, day, day), sum = summarize(rows_, day, day, await mealsFor(tid, rows_));
    const open = (await one(`SELECT count(*)::int c FROM tickets WHERE service_id=? AND status IN ('open','in_progress','hold')`, fs.id)).c;
    return { text: sum.total ? `Food today: ${sum.avg ?? '—'} ★ from ${sum.rated} rating${sum.rated === 1 ? '' : 's'}.\n${sum.keys.map(m => `${sum.name[m]}: ${sum.per_meal[m].avg == null ? 'no ratings' : sum.per_meal[m].avg + ' ★ (' + sum.per_meal[m].count + ')'}`).join('\n')}`
        + `${sum.chips.length ? `\nTop issues: ${sum.chips.slice(0, 3).map(c => `${c.chip} ${c.count}`).join(', ')}` : ''}\nOpen complaints: ${open}.` : `No meal ratings yet today. Open complaints: ${open}.`,
      items: [{ title: 'Open Food scores', href: '#/c/food' }] }; }
  if (said(q, /hold|paused|waiting/)) { const rows = await list("t.status='hold'", [], 't.hold_due_at');
    return { text: rows.length ? `${await count("t.status='hold'")} on hold. Resume these when you can:` : 'Nothing is on hold.', items: items(rows).map((x, i) => ({ ...x, sub: `${x.sub}${rows[i].hold_due_at ? ` · resume by ${fmtIST(rows[i].hold_due_at)}` : ''}` })) }; }
  if (said(q, /escalat/)) { const w = `t.escalated_at IS NOT NULL AND t.status IN (${act},'hold')`;
    return { text: (await count(w, ACTIVE)) ? 'Escalated tickets still open:' : 'No open escalated tickets.', items: items(await list(w, ACTIVE)) }; }
  if (said(q, /point|score|rank|leader/)) {
    const board = await all(`SELECT u.id, u.name, coalesce((SELECT sum(points) FROM provider_points p WHERE p.user_id=u.id AND p.tenant_id=?),0)::int points FROM users u WHERE u.tenant_id=? AND u.is_active=1 AND (u.role='provider' OR EXISTS (SELECT 1 FROM service_members m WHERE m.user_id=u.id)) ORDER BY points DESC`, tid, tid);
    const me = board.findIndex(x => x.id === u.id), mine = (await one('SELECT coalesce(sum(points),0)::int p FROM provider_points WHERE tenant_id=? AND user_id=?', tid, u.id)).p;
    return { text: `You have ${mine} points${me >= 0 ? `, rank ${me + 1} of ${board.length}` : ''}.\nClose within half the target time for 10 points, within the target for 5.${board.length ? `\nTop: ${board.slice(0, 3).map(x => `${x.name} ${x.points}`).join(' · ')}` : ''}` }; }
  if (said(q, /no provider|unassigned|without provider/)) { if (!admin) return { text: 'That one is for admins.', chips };
    const rows = await all('SELECT s.name, s.code FROM services s WHERE s.tenant_id=? AND s.is_active=1 AND NOT EXISTS (SELECT 1 FROM service_members m JOIN users x ON x.id=m.user_id AND x.is_active=1 WHERE m.service_id=s.id) ORDER BY s.name', tid);
    return { text: rows.length ? `${rows.length} service${rows.length === 1 ? ' has' : 's have'} nobody to work on their tickets:` : 'Every service has a provider.', items: rows.map(r => ({ title: r.name, sub: r.code, href: '#/c/services' })) }; }
  if (said(q, /affected|place|location|busiest|hotspot/)) { if (!admin) return { text: 'That one is for admins.', chips };
    const rows = await all(`SELECT s.name service, t.location, count(*)::int tickets, sum(t.affected_count)::int affected FROM tickets t JOIN services s ON s.id=t.service_id
      WHERE ${scope} AND t.created_at>=? AND coalesce(t.location,'')<>'' GROUP BY s.name, t.location ORDER BY affected DESC LIMIT 8`, ...sa, addH(n, -24 * 7));
    return { text: rows.length ? 'Most affected places in the last 7 days:' : 'No tickets with a place in the last 7 days.', items: rows.map(r => ({ title: r.location, sub: `${r.service} · ${r.affected} students · ${r.tickets} ticket${r.tickets === 1 ? '' : 's'}`, href: '#/c/reports' })) }; }
  if (said(q, /workload|load|provider|who has|busy/)) { if (!admin) return { text: 'That one is for admins.', chips };
    const rows = await all(`SELECT u.name, count(t.id)::int open, count(t.id) FILTER (WHERE t.due_at<?)::int late FROM users u JOIN service_members m ON m.user_id=u.id
      LEFT JOIN tickets t ON t.queued=0 AND t.status IN (${act}) AND (t.service_id=m.service_id OR t.service_id IN (SELECT id FROM services WHERE parent_id=m.service_id)) WHERE u.tenant_id=? AND u.is_active=1 GROUP BY u.name ORDER BY open DESC`, n, ...ACTIVE, tid);
    return { text: rows.length ? 'Open tickets in each provider\'s services:' : 'No providers yet.', items: rows.map(r => ({ title: r.name, sub: `${r.open} open${r.late ? ` · ${r.late} overdue` : ''}`, href: '#/c/users' })) }; }
  if (said(q, /summary|today|report|stat|how are we/)) { const day = localDay(tn.timezone || 'Asia/Kolkata');
    const c = await one(`SELECT count(*) FILTER (WHERE t.created_at>=?)::int raised, count(*) FILTER (WHERE t.status='closed' AND t.closed_at>=?)::int closed,
      count(*) FILTER (WHERE t.status IN (${act}) AND t.queued=0)::int open, count(*) FILTER (WHERE t.status IN (${act}) AND t.due_at<?)::int overdue, count(*) FILTER (WHERE t.status='hold')::int hold, count(*) FILTER (WHERE t.queued=1)::int queued,
      coalesce(sum(t.affected_count) FILTER (WHERE t.created_at>=?),0)::int affected FROM tickets t WHERE ${scope}`, day.start, day.start, ...ACTIVE, ...ACTIVE, n, day.start, ...sa);
    return { text: `Today${admin ? ` at ${tn.name}` : ' in your services'}: ${c.raised} raised (${c.affected} people affected), ${c.closed} closed.\nRight now: ${c.open} open, ${c.hold} on hold, ${c.overdue} overdue${c.queued ? `, ${c.queued} waiting in the daily queue` : ''}.`, items: [{ title: 'Open Reports', href: '#/c/reports' }] }; }
  if (said(q, /open|pending|my|queue|ticket|work|new/)) { const c = await count(`t.status IN (${act})`, ACTIVE);
    return { text: c ? `${c} open ticket${c === 1 ? '' : 's'}${admin ? '' : ' in your services'}. Most urgent first:` : 'No open tickets. All clear!', items: items(await list(`t.status IN (${act})`, ACTIVE)) }; }
  if (said(q, /\b(hi|hello|hey|help|menu|start|namaste|namaskaram)\b/)) return { text: `Hi ${u.name.split(' ')[0]}! I'm the ONE Desk Bot. Ask me about ${admin ? 'your campus' : 'your tickets'}, or type a ticket number like 0042.`, chips };
  return { text: "Sorry, I didn't get that. Type a ticket number (like 0042), or pick one of these:", chips };
}
S.post('/bot', wrap(async req => { limit('sbot:' + req.user.id, 600); return await staffBot(req, String(req.body.q || '').slice(0, 300)); }));
S.get('/points', wrap(async req => ({
  me: (await one('SELECT coalesce(sum(points),0) total FROM provider_points WHERE tenant_id=? AND user_id=?', req.tenantId, req.user.id)).total,
  history: await all(`SELECT p.points, p.reason, p.created_at, t.ticket_no, t.id ticket_id FROM provider_points p LEFT JOIN tickets t ON t.id=p.ticket_id
    WHERE p.tenant_id=? AND p.user_id=? ORDER BY p.created_at DESC LIMIT 15`, req.tenantId, req.user.id),
  leaderboard: await all(`SELECT u.id, u.name, coalesce((SELECT sum(points) FROM provider_points p WHERE p.user_id=u.id AND p.tenant_id=u.tenant_id),0) points,
      (SELECT count(*) FROM tickets t WHERE t.closed_by=u.id AND t.status='closed') closed,
      (SELECT round(100.0*count(*) FILTER (WHERE t.closed_at<=t.due_at)/greatest(1,count(*))) FROM tickets t WHERE t.closed_by=u.id AND t.status='closed' AND t.due_at IS NOT NULL) on_time
    FROM users u WHERE u.tenant_id=? AND u.is_active=1 AND (u.role='provider' OR EXISTS (SELECT 1 FROM service_members m WHERE m.user_id=u.id))
    ORDER BY points DESC, closed DESC`, req.tenantId),
})));

// tickets
async function loadTicket(req) {
  const t = await one('SELECT * FROM tickets WHERE id=? AND tenant_id=?', req.params.id, req.tenantId);
  if (!t || !((await myServiceIds(req.user, req.tenantId)).includes(t.service_id) || t.escalated_to === req.user.id
    || (t.escalated_at && await one('SELECT 1 AS x FROM service_escalations e LEFT JOIN services s ON s.id=? WHERE e.user_id=? AND e.service_id IN (s.id, s.parent_id)', t.service_id, req.user.id)))) throw notFound();
  return t;
}
const actorOf = req => ({ type: 'user', id: req.user.id, name: req.user.name });
const ticketQuery = async (req) => {
  const sids = await myServiceIds(req.user, req.tenantId);
  // my services' tickets, plus any ticket escalated to me
  const esc = `t.escalated_to=? OR (t.escalated_at IS NOT NULL AND EXISTS (SELECT 1 FROM service_escalations e JOIN services sv ON sv.id=t.service_id WHERE e.user_id=? AND e.service_id IN (sv.id, sv.parent_id)))`;
  const w = [`t.tenant_id=?`, sids.length ? `(t.service_id IN (${sids.map(() => '?').join()}) OR ${esc})` : `(${esc})`], a = [req.tenantId, ...sids, req.user.id, req.user.id], q = req.query;
  // tickets waiting in a team's daily queue show only under "In queue" until the day they land
  w.push(q.status === 'queued' ? 't.queued=1' : 't.queued=0');
  if (q.status === 'reopen') w.push("t.status='closed' AND t.reopen_requested_at IS NOT NULL");
  else if (q.status === 'suggestions') w.push("t.kind='suggestion'");
  else if (q.status === 'overdue') { w.push("t.status IN ('open','in_progress') AND t.due_at<?"); a.push(now()); }
  else if (q.status === 'escalated') w.push("t.escalated_at IS NOT NULL AND t.status IN ('open','in_progress','hold')");
  else if (q.status && !['all', 'queued', 'reopen', 'suggestions'].includes(q.status)) { w.push('t.status=?'); a.push(q.status); }
  if (q.service) { w.push('t.service_id=?'); a.push(q.service); }
  if (q.internal === '0') w.push('t.is_internal=0');
  if (q.q) { w.push('(t.ticket_no ILIKE ? OR t.subject ILIKE ? OR r.name ILIKE ?)'); a.push(...Array(3).fill(`%${q.q}%`)); }
  return { sql: w.join(' AND '), args: a };
};
const LIST_SQL = `SELECT t.id,t.ticket_no,t.subject,t.status,t.priority,t.channel,t.is_internal,t.location,t.due_at,t.created_at,t.updated_at,t.closed_at,t.hold_due_at,t.hold_reason,
  t.escalated_at, t.affected_count, t.problem_label, t.queued, t.queue_day, t.lands_at, t.kind, t.reopen_requested_at, r.requestor_type, eu.name escalated_name, s.name service, s.code service_code, r.name requestor
  FROM tickets t JOIN services s ON s.id=t.service_id JOIN requestors r ON r.id=t.requestor_id LEFT JOIN users eu ON eu.id=t.escalated_to`;
S.get('/tickets', wrap(async req => {
  const { sql, args } = await ticketQuery(req);
  if (req.query.status === 'queued') return await all(`${LIST_SQL} WHERE ${sql} ORDER BY t.queue_day, t.created_at, t.id LIMIT 500`, ...args);
  return (await all(`${LIST_SQL} WHERE ${sql} ORDER BY CASE t.status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 0 WHEN 'hold' THEN 1 ELSE 2 END, t.due_at LIMIT 500`, ...args))
    .map(x => ({ ...x, overdue: ACTIVE.includes(x.status) && x.due_at < now() }));
}));
S.get('/tickets.csv', async (req, res, next) => { try {
  const { sql, args } = await ticketQuery(req);
  const rows = await all(`${LIST_SQL} WHERE ${sql} ORDER BY t.created_at DESC`, ...args);
  const cols = ['ticket_no', 'service', 'subject', 'status', 'priority', 'affected_count', 'channel', 'requestor', 'location', 'created_at', 'due_at', 'closed_at'];
  res.type('text/csv').attachment('tickets.csv').send([cols.join(','), ...rows.map(r => cols.map(c => `"${String(r[c] ?? '').replace(/"/g, '""')}"`).join(','))].join('\n'));
} catch (e) { next(e); } });
S.get('/tickets/:id', wrap(async req => {
  const t = await loadTicket(req);
  const tn = await tenantRow(t.tenant_id), cal = calendar(tn), n = now();
  return { ...t, form_data: JSON.parse(t.form_data), overdue: ACTIVE.includes(t.status) && t.due_at < n,
    sla_left_min: ACTIVE.includes(t.status) && t.due_at ? (n <= t.due_at ? workingBetween(cal, n, t.due_at) : -workingBetween(cal, t.due_at, n)) : null,
    hold_label: t.hold_reason ? holdReasons(tn).find(r => r.key === t.hold_reason)?.label || t.hold_reason : null,
    hold_over: t.status === 'hold' && t.hold_due_at && t.hold_due_at < n, hold_reasons: holdReasons(tn),
    escalated_name: t.escalated_to ? (await one('SELECT name FROM users WHERE id=?', t.escalated_to))?.name || null : null,
    service: await one('SELECT id,name,code,form_schema FROM services WHERE id=?', t.service_id),
    providers: await providersFor(req.tenantId, t.service_id),
    requestor: await one('SELECT * FROM requestors WHERE id=?', t.requestor_id),
    requestors: await all('SELECT id, name, contact, raised_at, is_first, event_id, photo_url FROM ticket_requestors WHERE ticket_id=? ORDER BY raised_at', t.id),
    requestor_history: await all('SELECT id,ticket_no,subject,status,created_at FROM tickets WHERE requestor_id=? AND id!=? ORDER BY created_at DESC LIMIT 5', t.requestor_id, t.id),
    events: await all('SELECT * FROM ticket_events WHERE ticket_id=? ORDER BY id', t.id),
    attachments: await all('SELECT * FROM attachments WHERE ticket_id=?', t.id),
    reminders: await all('SELECT id, remind_at, note, fired_at FROM ticket_reminders WHERE ticket_id=? AND user_id=? AND done_at IS NULL ORDER BY remind_at', t.id, req.user.id),
    tracking_url: await trackUrl(t), queue: t.status === 'open' ? await queueInfo(t) : null,
    reopen_request: t.reopen_requested_at && t.status === 'closed' ? await (async () => { const d = await reopenDeciders(t);
      return { at: t.reopen_requested_at, note: t.reopen_request_note, deciders: d.map(x => x.name), can_decide: isAdmin(req.user) || d.some(x => x.id === req.user.id) }; })() : null };
}));
S.post('/tickets', wrap(async req => {
  const b = req.body, channel = CHANNELS.includes(b.channel) && b.channel !== 'portal' ? b.channel : 'walk_in';
  const tn = await one('SELECT * FROM tenants WHERE id=?', req.tenantId);
  if (channel === 'internal') Object.assign(b, { name: req.user.name, email: req.user.email, phone: req.user.phone, requestor_type: 'staff' });
  return await createTicket(tn, b, { channel, actor: actorOf(req) });
}));
S.post('/tickets/:id/status', wrap(async req => {
  const t = await loadTicket(req), to = req.body.to;
  let note = req_(req.body.note, 'Please write a note'), meta = {};
  if (t.status === 'closed' && to === 'open') { await doReopen(t, actorOf(req), note); return { ok: true }; }
  assertTransition(t.status, to);
  const ts = now();
  await tx(async () => {
    // only if the status is still what we read: two clicks at once must not both close (and award points)
    if (to === 'hold') {
      const hr = holdReasons(await tenantRow(t.tenant_id)).find(r => r.key === req.body.hold_reason);
      if (!hr) throw bad('Pick a hold reason');
      const hdue = await dueFrom(t.tenant_id, ts, hr.hours * 60);
      stillAs(await run('UPDATE tickets SET status=?, hold_started_at=?, hold_reason=?, hold_due_at=?, hold_by=?, updated_at=? WHERE id=? AND status=?', to, ts, hr.key, hdue, req.user.id, ts, t.id, t.status));
      meta = { hold_reason: hr.label, hold_due_at: hdue };
    } else if (to === 'in_progress' || to === 'open') { // start work, or resume after a hold
      let held = 0, due = t.due_at; if (t.status === 'hold') ({ held, due } = await leaveHold(t, ts));
      stillAs(await run('UPDATE tickets SET status=?, held_minutes=held_minutes+?, due_at=?, hold_started_at=NULL, hold_reason=NULL, hold_due_at=NULL, updated_at=? WHERE id=? AND status=?', to, held, due, ts, t.id, t.status)); }
    else { let held = 0, due = t.due_at; if (t.status === 'hold') ({ held, due } = await leaveHold(t, ts));
      stillAs(await run('UPDATE tickets SET status=?, closed_at=?, closed_by=?, held_minutes=held_minutes+?, due_at=?, hold_started_at=NULL, hold_reason=NULL, hold_due_at=NULL, updated_at=? WHERE id=? AND status=?', to, ts, req.user.id, held, due, ts, t.id, t.status));
      if (to === 'closed' && due) {
        // share of the SLA window used: before due → 1 - remaining/target, after due → 1 + late/target
        const cal = await calOf(t.tenant_id), target = await targetHours(t.tenant_id, t.service_id, t.priority) * 60;
        const ratio = ts <= due ? 1 - workingBetween(cal, ts, due) / target : 1 + workingBetween(cal, due, ts) / target;
        const rule = closePoints(ratio); await award(t, req.user.id, rule.points, rule.reason); meta = { points: rule.points, sla_used_pct: Math.round(ratio * 100) };
      }
    }
    if (t.queued) await run('UPDATE tickets SET queued=0 WHERE id=?', t.id); // a provider took it early, before its day in the queue
    const ev = await addEvent(t, actorOf(req), 'status_changed', { from: t.status, to, body: note, internal: req.body.is_internal, meta });
    await saveFiles(t, ev, req.body.files, 'user');
  });
  if (!req.body.is_internal) {
    // after a hold, moving to "in progress" is a resume ("work resumed"); from open it is a fresh start ("work started")
    const key = to !== 'in_progress' ? 'status_' + to : t.status === 'hold' ? 'status_open' : 'status_in_progress';
    await notifyRequestors(t, key, await ticketVars(t, { note, actor_name: req.user.name,
      hold_reason: meta.hold_reason || '', resume_by: meta.hold_due_at ? fmtIST(meta.hold_due_at) : '' }));
  }
  const closedEarlier = to === 'closed' && req.body.close_earlier && t.location_key && t.problem_key ? await closeEarlier(t, req, note) : 0;
  return { ok: true, points: meta.points, closed_earlier: closedEarlier };
}));
S.post('/tickets/:id/notes', wrap(async req => {
  const t = await loadTicket(req), body = req_(req.body.body, 'Write a note');
  await tx(async () => { const ev = await addEvent(t, actorOf(req), 'note', { body, internal: req.body.is_internal }); await saveFiles(t, ev, req.body.files, 'user');
    await run('UPDATE tickets SET updated_at=? WHERE id=?', now(), t.id); });
  if (!req.body.is_internal) await notifyRequestors(t, 'note', await ticketVars(t, { note: body, actor_name: req.user.name }));
  return { ok: true };
}));
S.post('/tickets/:id/transfer', wrap(async req => {
  const t = await loadTicket(req), note = req_(req.body.note, 'Please write a note');
  if (![...ACTIVE, 'hold'].includes(t.status)) throw new HttpErr(409, 'BAD_TRANSITION', 'Only active or on-hold tickets can be transferred', { current: t.status });
  const ns = await one('SELECT * FROM services WHERE id=? AND tenant_id=? AND is_active=1', req.body.service_id, req.tenantId);
  if (!ns || ns.id === t.service_id) throw notFound();
  const old = await one('SELECT name FROM services WHERE id=?', t.service_id), oldProv = await providersFor(t.tenant_id, t.service_id);
  await tx(async () => { await run('UPDATE tickets SET service_id=?, escalated_at=NULL, escalated_to=NULL, updated_at=? WHERE id=?', ns.id, now(), t.id);
    await addEvent(t, actorOf(req), 'transferred', { from: old.name, to: ns.name, body: note }); });
  const tv = await ticketVars(t, { note, actor_name: req.user.name, from_service: old.name, to_service: ns.name });
  await notify(t, [...oldProv, ...(await providersFor(t.tenant_id, ns.id))].map(p => p.email), 'transferred', tv);
  await notifyRequestors(t, 'transferred_requestor', tv);
  return { ok: true };
}));
// A requestor asked to reopen: the provider who closed it (or an admin) accepts (it reopens, with a fresh target) or declines (it stays closed)
S.post('/tickets/:id/reopen-request', wrap(async req => {
  const t = await loadTicket(req), decision = req.body.decision, note = req_(req.body.note, 'Please write a note for the requester');
  if (!t.reopen_requested_at || t.status !== 'closed') throw new HttpErr(409, 'BAD_TRANSITION', 'There is no reopen request on this ticket');
  const deciders = await reopenDeciders(t);
  if (!isAdmin(req.user) && !deciders.some(x => x.id === req.user.id)) throw new HttpErr(403, 'FORBIDDEN', `Only ${deciders.map(x => x.name).join(' or ') || 'the provider who closed it'} or an admin can decide`);
  if (decision === 'accept') {
    await doReopen(t, actorOf(req), note, { penalty: true });
    await notifyRequestors(t, 'reopen_accepted', await ticketVars(t, { note, actor_name: req.user.name }));
    return { ok: true, status: 'open' };
  }
  if (decision !== 'decline') throw bad('Pick accept or decline');
  await tx(async () => { stillAs(await run('UPDATE tickets SET reopen_requested_at=NULL, reopen_request_note=NULL, updated_at=? WHERE id=? AND status=? AND reopen_requested_at IS NOT NULL', now(), t.id, 'closed'));
    await addEvent(t, actorOf(req), 'reopen_declined', { body: note }); });
  await notifyRequestors(t, 'reopen_declined', await ticketVars(t, { note, actor_name: req.user.name }));
  return { ok: true, status: 'closed' };
}));
// ---------- reminders: a provider asks to be reminded about a ticket later; the ticket itself does not change ----------
const REMIND_IN = { day: 1, '3days': 3, week: 7, month: 30 };
S.post('/tickets/:id/reminders', wrap(async req => {
  const t = await loadTicket(req), note = req_(req.body.note, 'Write what to remind you about').slice(0, 500), b = req.body;
  let at = REMIND_IN[b.in] ? new Date(Date.now() + REMIND_IN[b.in] * 864e5) : new Date(b.at || '');
  if (isNaN(at)) throw bad('Pick when to remind you');
  if (at.getTime() < Date.now() + 60e3) throw bad('Pick a time in the future');
  if (at.getTime() > Date.now() + 366 * 864e5) throw bad('Pick a time within a year');
  if ((await one('SELECT count(*)::int n FROM ticket_reminders WHERE user_id=? AND done_at IS NULL', req.user.id)).n >= 200) throw bad('You have too many reminders. Clear some first.');
  const id = uid();
  await insert('ticket_reminders', { id, tenant_id: t.tenant_id, ticket_id: t.id, user_id: req.user.id, remind_at: at.toISOString(), note, created_at: now() });
  return { ok: true, id, remind_at: at.toISOString() };
}));
const REM_SQL = `SELECT m.id, m.ticket_id, m.remind_at, m.note, m.fired_at, t.ticket_no, t.subject, t.status FROM ticket_reminders m JOIN tickets t ON t.id=m.ticket_id`;
S.get('/reminders', wrap(async req => {
  const rows = await all(`${REM_SQL} WHERE m.user_id=? AND m.tenant_id=? AND m.done_at IS NULL ORDER BY m.remind_at LIMIT 200`, req.user.id, req.tenantId);
  const n = now();
  return { due: rows.filter(r => r.remind_at <= n), upcoming: rows.filter(r => r.remind_at > n) };
}));
S.post('/reminders/:id/done', wrap(async req => {
  if (!(await run('UPDATE ticket_reminders SET done_at=? WHERE id=? AND user_id=? AND done_at IS NULL', now(), req.params.id, req.user.id)).changes) throw notFound();
  return { ok: true };
}));
S.post('/tickets/:id/priority', wrap(async req => {
  const t = await loadTicket(req), p = req.body.priority;
  if (!PRIORITIES.includes(p) || p === t.priority) throw bad('Pick a different priority');
  if (![...ACTIVE, 'hold'].includes(t.status)) throw new HttpErr(409, 'BAD_TRANSITION', 'Ticket is not active');
  const due = t.kind === 'suggestion' ? null : await dueFrom(t.tenant_id, t.lands_at || t.created_at, await targetHours(t.tenant_id, t.service_id, p) * 60 + t.held_minutes);
  await tx(async () => { await run('UPDATE tickets SET priority=?, priority_by_staff=1, due_at=?, updated_at=? WHERE id=?', p, due, now(), t.id); // reports joining later never change it
    await addEvent(t, actorOf(req), 'priority_changed', { from: t.priority, to: p, internal: true }); });
  return { ok: true };
}));
S.post('/tickets/:id/extend', role('super_admin', 'tenant_admin'), wrap(async req => {
  const t = await loadTicket(req), h = Number(req.body.hours), reason = req_(req.body.reason, 'Give a reason');
  if (!(h > 0)) throw bad('Hours must be positive');
  if (!t.due_at) throw bad('A suggestion has no due time to extend');
  const due = await dueFrom(t.tenant_id, t.due_at, h * 60);
  await tx(async () => { await run('UPDATE tickets SET due_at=?, updated_at=? WHERE id=?', due, now(), t.id);
    await addEvent(t, actorOf(req), 'due_extended', { from: t.due_at, to: due, body: reason, internal: true }); });
  return { ok: true };
}));

// attention, reports, audit, notifications
S.get('/attention', role('super_admin', 'tenant_admin'), wrap(async req => ({
  no_provider: await all(`SELECT s.id,s.name,s.code,(SELECT count(*) FROM tickets t WHERE t.service_id=s.id AND t.status IN ('open','in_progress','hold')) open_count FROM services s
    WHERE s.tenant_id=? AND s.is_active=1 AND NOT EXISTS (SELECT 1 FROM service_members m JOIN users u ON u.id=m.user_id WHERE m.service_id=s.id AND u.is_active=1)`, req.tenantId),
  overdue: await all(`${LIST_SQL} WHERE t.tenant_id=? AND t.status IN ('open','in_progress') AND t.due_at<? ORDER BY t.due_at`, req.tenantId, now()),
  escalated: await all(`${LIST_SQL} WHERE t.tenant_id=? AND t.escalated_at IS NOT NULL AND t.status IN ('open','in_progress','hold') ORDER BY t.escalated_at`, req.tenantId),
  stuck_hold: await all(`${LIST_SQL} WHERE t.tenant_id=? AND t.status='hold' AND t.hold_due_at<? ORDER BY t.hold_due_at`, req.tenantId, now()),
  reopen_requests: await all(`${LIST_SQL} WHERE t.tenant_id=? AND t.status='closed' AND t.reopen_requested_at IS NOT NULL ORDER BY t.reopen_requested_at`, req.tenantId),
  failed_mail: await all("SELECT * FROM notifications WHERE tenant_id=? AND status='failed' ORDER BY created_at DESC LIMIT 50", req.tenantId),
})));
S.post('/notifications/:id/resend', role('super_admin', 'tenant_admin'), wrap(async req => {
  await run("UPDATE notifications SET status='queued', attempts=0 WHERE id=? AND tenant_id=?", req.params.id, req.tenantId); queue.push(req.params.id); return { ok: true };
}));
S.get('/reports', wrap(async req => {
  // my services' tickets plus any escalated to me
  const sids = await myServiceIds(req.user, req.tenantId);
  const inS = sids.length ? `(service_id IN (${sids.map(() => '?').join()}) OR escalated_to=?)` : 'escalated_to=?', base = [req.tenantId, ...sids, req.user.id];
  const n = now(), tz = (await tenantRow(req.tenantId))?.timezone || 'Asia/Kolkata', ymd = /^\d{4}-\d{2}-\d{2}$/;
  let from = addH(n, -24 * (Number(req.query.days) || 30)), to = '9999';
  if (req.query.from || req.query.to) {
    if (!ymd.test(req.query.from || '') || !ymd.test(req.query.to || '')) throw bad('Pick both a From and a To date');
    if (req.query.from > req.query.to) throw bad('From must be on or before To');
    from = dateStart(tz, req.query.from); to = localDay(tz, dateStart(tz, req.query.to)).next;
  }
  return { range: { from, to: to === '9999' ? n : to },
    counts: await one(`SELECT count(*) FILTER (WHERE status='open' AND queued=0) open, count(*) FILTER (WHERE status='open' AND queued=1) queued, count(*) FILTER (WHERE status='in_progress') in_progress, count(*) FILTER (WHERE status='hold') hold, count(*) FILTER (WHERE status IN ('open','in_progress') AND due_at<?) overdue,
      count(*) FILTER (WHERE status='closed' AND closed_at>=? AND closed_at<?) closed_period, count(*) FILTER (WHERE created_at>=? AND created_at<?) created_period,
      round(avg(CASE WHEN status='closed' AND due_at IS NOT NULL AND closed_at>=? AND closed_at<? THEN extract(epoch FROM closed_at::timestamptz - created_at::timestamptz)/3600 - held_minutes/60.0 END),1) avg_hours,
      round(100.0*count(*) FILTER (WHERE status='closed' AND closed_at>=? AND closed_at<? AND closed_at<=due_at)/greatest(1,count(*) FILTER (WHERE status='closed' AND due_at IS NOT NULL AND closed_at>=? AND closed_at<?)),0) on_time_pct,
      count(*) FILTER (WHERE status='closed' AND reopen_requested_at IS NOT NULL)::int reopen_requests, count(*) FILTER (WHERE kind='suggestion' AND status IN ('open','in_progress','hold'))::int suggestions
      FROM tickets WHERE tenant_id=? AND ${inS}`, n, from, to, from, to, from, to, from, to, from, to, ...base),
    by_service: await all(`SELECT s.name, count(*)::int raised, count(*) FILTER (WHERE t.status='open') open, count(*) FILTER (WHERE t.status='in_progress') in_progress, count(*) FILTER (WHERE t.status='hold') hold, count(*) FILTER (WHERE t.status='closed') closed, count(*) FILTER (WHERE t.status='rejected') rejected,
      count(*) FILTER (WHERE t.status IN ('open','in_progress') AND t.due_at<?) overdue,
      CASE WHEN count(*) FILTER (WHERE t.status='closed' AND t.due_at IS NOT NULL)>0 THEN round(100.0*count(*) FILTER (WHERE t.status='closed' AND t.closed_at<=t.due_at)/count(*) FILTER (WHERE t.status='closed' AND t.due_at IS NOT NULL),0) END on_time_pct,
      count(*) FILTER (WHERE t.kind='suggestion')::int suggestions,
      round(avg(CASE WHEN t.status='closed' AND t.due_at IS NOT NULL THEN extract(epoch FROM t.closed_at::timestamptz - t.created_at::timestamptz)/3600 - t.held_minutes/60.0 END),1) avg_hours
      FROM tickets t JOIN services s ON s.id=t.service_id WHERE t.tenant_id=? AND ${inS} AND t.created_at>=? AND t.created_at<? GROUP BY s.name ORDER BY raised DESC, s.name`, n, ...base, from, to),
    // per campus-local day (not UTC): tickets raised, and tickets closed, on that day
    daily: await all(`SELECT to_char((created_at::timestamptz AT TIME ZONE ?)::date, 'YYYY-MM-DD') d, count(*)::int c FROM tickets WHERE tenant_id=? AND ${inS} AND created_at>=? AND created_at<? GROUP BY 1 ORDER BY 1`, tz, ...base, from, to),
    daily_closed: await all(`SELECT to_char((closed_at::timestamptz AT TIME ZONE ?)::date, 'YYYY-MM-DD') d, count(*)::int c FROM tickets WHERE tenant_id=? AND ${inS} AND status='closed' AND closed_at>=? AND closed_at<? GROUP BY 1 ORDER BY 1`, tz, ...base, from, to),
    days: { from: dayIn(tz, from), to: dayIn(tz, new Date(Math.min(Date.now(), new Date(to === '9999' ? n : to).getTime() - 1)).toISOString()) },
    extra: await one(`SELECT count(*) FILTER (WHERE reopen_count>0)::int reopened, count(*) FILTER (WHERE escalated_at IS NOT NULL OR EXISTS (SELECT 1 FROM ticket_events e WHERE e.ticket_id=tickets.id AND e.event_type='escalated'))::int escalated,
      count(*) FILTER (WHERE status='rejected')::int rejected FROM tickets WHERE tenant_id=? AND ${inS} AND created_at>=? AND created_at<?`, ...base, from, to),
    // people affected: every requestor of every ticket raised in the range, per service and place
    affected: (await one(`SELECT coalesce(sum(affected_count),0)::int n FROM tickets WHERE tenant_id=? AND ${inS} AND created_at>=? AND created_at<?`, ...base, from, to)).n,
    by_location: await all(`SELECT s.name service, t.location, count(*)::int tickets, sum(t.affected_count)::int affected FROM tickets t JOIN services s ON s.id=t.service_id
      WHERE t.tenant_id=? AND ${inS} AND t.created_at>=? AND t.created_at<? AND coalesce(t.location,'')<>'' GROUP BY s.name, t.location ORDER BY affected DESC, tickets DESC LIMIT 25`, ...base, from, to),
    by_priority: await all(`SELECT priority k, count(*) c FROM tickets WHERE tenant_id=? AND ${inS} AND created_at>=? AND created_at<? GROUP BY priority`, ...base, from, to),
    aging: await all(`SELECT CASE WHEN extract(epoch FROM ?::timestamptz - created_at::timestamptz)/86400<1 THEN '<1d' WHEN extract(epoch FROM ?::timestamptz - created_at::timestamptz)/86400<3 THEN '1-3d'
      WHEN extract(epoch FROM ?::timestamptz - created_at::timestamptz)/86400<7 THEN '3-7d' ELSE '7d+' END k, count(*) c FROM tickets WHERE tenant_id=? AND ${inS} AND status IN ('open','in_progress','hold') GROUP BY k`, n, n, n, ...base),
  };
}));
// duplicate merge mode: silent (join automatically) or confirm (ask "Same issue?" first); only the super admin changes it
S.get('/merge-mode', wrap(async () => ({ mode: mergeMode(), modes: MERGE_MODES })));
S.put('/merge-mode', role('super_admin'), wrap(async req => {
  if (!MERGE_MODES.includes(req.body.mode)) throw bad('Pick silent or confirm');
  await setSetting('merge_mode', req.body.mode); await audit(req, 'merge.mode', 'setting', 'merge_mode', { mode: req.body.mode }); return { mode: req.body.mode };
}));
S.get('/audit', role('super_admin', 'tenant_admin'), wrap(async req =>
  await all('SELECT a.*, u.name actor FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id WHERE a.tenant_id=? ORDER BY a.created_at DESC LIMIT 200', req.tenantId)));
// group-wide report (super admin; mounted before tenant scope via separate path)
// ---------- Email page: connection, events, test, delivery log ----------
const M = express.Router();
M.use(auth, role('super_admin', 'tenant_admin'));
const superOnly = role('super_admin');
const SAMPLE_CAMPUS = "St. Mary's Rehabilitation University";
const maskKey = k => k ? '•'.repeat(Math.max(0, Math.min(12, k.length - 4))) + k.slice(-4) : '';
M.get('/config', superOnly, wrap(async () => {
  const c = mailConfig(BASE);
  const stats = Object.fromEntries((await all("SELECT status, count(*) n FROM notifications WHERE created_at >= ? GROUP BY status", addH(now(), -24 * 7))).map(r => [r.status, r.n]));
  return { url: c.url, key_masked: maskKey(c.key), has_key: !!c.key, base: c.base, sending: c.sending, last_ok_at: c.last_ok_at, stats,
    vars: VARS, events: MAIL_EVENTS.map(e => ({ key: e.key, label: e.label, who: e.who, when: e.when, on: eventOn(c, e.key), vars: e.vars,
      ...templateFor(c, e.key), default_subject: e.subject, default_body: e.body, custom: !!c.templates[e.key] })) };
}));
M.get('/key', superOnly, wrap(async () => ({ key: mailConfig(BASE).key }))); // so the admin can paste it into the flow's Condition
M.put('/config', superOnly, wrap(async req => {
  const b = req.body, c = mailConfig(BASE);
  if (b.url !== undefined) {
    const u = String(b.url).trim();
    if (u && !/^https:\/\/\S+$/.test(u) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(u)) throw bad('The flow URL must start with https://');
    await setSetting('pa_url', u);
  }
  if (b.key) { if (String(b.key).length < 16) throw bad('Use a secret key of at least 16 characters'); await setSetting('pa_key', String(b.key).trim()); }
  if (b.base !== undefined) { const u = String(b.base).trim().replace(/\/+$/, ''); if (!/^https?:\/\/\S+$/.test(u)) throw bad('The public address must start with http:// or https://'); await setSetting('public_base_url', u); }
  if (b.sending !== undefined) await setSetting('mail_enabled', b.sending ? '1' : '0');
  if (b.events) await setSetting('mail_events', JSON.stringify({ ...c.events, ...Object.fromEntries(Object.entries(b.events).map(([k, v]) => [k, !!v])) }));
  await audit(req, 'mail.config', 'settings', null, { ...b, key: b.key ? '(changed)' : undefined }); return { ok: true };
}));
M.post('/test', superOnly, wrap(async req => {
  const to = String(req.body.to || '').trim(); if (!/^\S+@\S+\.\S+$/.test(to)) throw bad('Enter the email address to send the test to');
  const c = mailConfig(BASE), cfg = { ...c, url: req.body.url?.trim() || c.url, key: req.body.key?.trim() || c.key };
  // the same kind of buttons real emails carry, so they can be tried in Gmail, Outlook and Yahoo
  const subject = '[ONE Desk] Test email', body = `This is a test from ONE Desk.\nIf you can read this, the Power Automate connection works.\n**Now tap both buttons.** Each should open ONE Desk in your browser.\n`
    + `[[Sign in to ONE Desk|${c.base}/#/login]]\n[[Open the requestor guide|${c.base}/guide/requestor.html]]\nEvery button in ONE Desk emails opens ${c.base}`;
  const html = renderEmail({ subject, body, campus: 'Email setup' }), r = await postToFlow(cfg, { to, subject, html, text: toText(body) });
  await insert('notifications', { id: uid(), tenant_id: null, ticket_id: null, recipient: to, template_key: 'test', subject, body, html, status: r.ok ? 'sent' : 'failed',
    attempts: 1, last_error: r.ok ? null : `${r.status || 'network'}: ${r.hint}`, sent_at: r.ok ? now() : null, created_at: now() });
  if (r.ok) await setSetting('mail_last_ok_at', now());
  return r;
}));
// Save (or reset, when both are empty) one step's template.
M.put('/template/:key', superOnly, wrap(async req => {
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
  await setSetting('mail_templates', JSON.stringify(all));
  await audit(req, 'mail.template', 'template', e.key, { reset: !all[e.key] }); return { ok: true };
}));
// Preview a template (saved, or the unsaved text from the editor) with sample values.
M.post('/preview', superOnly, (req, res) => {
  const e = eventByKey(req.body.key); if (!e) return res.status(404).end();
  const t = { ...templateFor(mailConfig(BASE), e.key), ...(req.body.subject != null ? { subject: req.body.subject } : {}), ...(req.body.body != null ? { body: req.body.body } : {}) };
  const sv = sampleVars(base(), e.key), r = renderTemplate({ templates: { [e.key]: t } }, e.key, sv);
  res.json({ data: { subject: r.subject, html: renderEmail({ subject: r.subject, body: r.body, campus: SAMPLE_CAMPUS, blocks: sv }), unknown: unknownVars(t.subject + '\n' + t.body, e.vars) } });
});
M.get('/log', wrap(async req => {
  const w = [], a = [];
  if (req.user.role !== 'super_admin') { w.push('n.tenant_id=?'); a.push(req.user.tenant_id); }
  if (req.query.status && req.query.status !== 'all') { w.push('n.status=?'); a.push(req.query.status); }
  if (req.query.q) { w.push('(n.recipient ILIKE ? OR n.subject ILIKE ?)'); a.push(`%${req.query.q}%`, `%${req.query.q}%`); }
  return await all(`SELECT n.id, n.recipient, n.subject, n.template_key, n.status, n.attempts, n.last_error, n.created_at, n.sent_at, n.ticket_id, tn.code campus
    FROM notifications n LEFT JOIN tenants tn ON tn.id=n.tenant_id ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY n.created_at DESC LIMIT 200`, ...a);
}));
M.post('/resend', wrap(async req => {
  const ids = (req.body.ids || []).slice(0, 500), scope = req.user.role === 'super_admin' ? '' : ' AND tenant_id=?';
  let n = 0;
  for (const id of ids) {
    const r = await run(`UPDATE notifications SET status='queued', attempts=0, last_error=NULL WHERE id=? AND status IN ('failed','logged','skipped')${scope}`, id, ...(scope ? [req.user.tenant_id] : []));
    if (r.changes) { queue.push(id); n++; }
  }
  return { queued: n };
}));
app.use('/api/mail', M);

app.get('/api/group/report', auth, role('super_admin'), wrap(async () =>
  await all(`SELECT tn.name, tn.code, count(*) FILTER (WHERE t.status IN ('open','in_progress')) open, count(*) FILTER (WHERE t.status='hold') hold, count(*) FILTER (WHERE t.status='closed') closed, count(*) FILTER (WHERE t.status IN ('open','in_progress') AND t.due_at<?) overdue
    FROM tenants tn LEFT JOIN tickets t ON t.tenant_id=tn.id GROUP BY tn.id ORDER BY tn.name`, now())));

// Food & catering: rate a meal (feedback) or report a problem (ticket); kitchen dashboard; scheduled reports (food.js)
food({ app, P, S, wrap, bad, notFound, HttpErr, limit, tenantBySlug, createTicket, tenantRow, base, SECRET, getSettings, setSetting, providersFor,
  sendMail: async (tenant_id, to, key, subject, html, text) => { for (const r of [...new Set(to)]) { const id = uid();
    await insert('notifications', { id, tenant_id, recipient: r, template_key: key, subject, body: text, html, text_body: text, status: 'queued', created_at: now() }); queue.push(id); } } });
app.use('/api', S);

app.use('/api', (_q, _r, next) => next(notFound()));
app.use((e, _req, res, _next) => {
  if (e.code === '23505') e = new HttpErr(409, 'CONFLICT', 'That already exists'); // a unique index caught a race the checks above missed
  const status = e.status || 500; if (status === 500) console.error(e);
  res.status(status).json({ error: { code: (status !== 500 && e.code) || 'INTERNAL', message: status === 500 ? 'Something went wrong' : e.message, details: e.details } });
});

app.use('/desk', express.static(path.join(ROOT, 'public')));
app.use('/', express.static(path.join(ROOT, 'public'))); // also served at the root, e.g. https://stmarys-desk.supercxo.ai
// Super admins on every start (deploy):
//   OWNER (built in, sriram@smru.edu.in; OWNER_EMAIL in .env overrides it, empty turns it off) and SUPER_ADMIN_EMAIL from .env.
//   If such an account is not yet an active super admin, it is created (or made one) with a temporary password that is
//   emailed to it AND written to this server's log (pm2 logs), so it can sign in even when email is not working yet; the first
//   sign-in must choose a new password. An account that already is an active super admin is left alone.
//   SUPER_ADMIN_PASSWORD (optional) is used as SUPER_ADMIN_EMAIL's temporary password instead, applied once per email + password.
async function ensureSuperAdmin(email, envPw = '') {
  if (!/^\S+@\S+\.\S+$/.test(email)) return console.log(`"${email}" is not an email address; no super admin set up for it.`);
  if (envPw && envPw.length < 10) return console.log(`SUPER_ADMIN_PASSWORD is shorter than 10 characters; leave it out to have a temporary password generated for ${email}.`);
  const u = await one('SELECT * FROM users WHERE lower(email)=lower(?)', email), isSa = u?.role === 'super_admin' && u.is_active;
  const mark = crypto.createHmac('sha256', SECRET).update(`${email.toLowerCase()}\n${envPw}`).digest('hex');
  if (envPw ? getSettings().super_admin_env === mark : isSa)
    return console.log(`Super admin ${email}: already set up. To get a new temporary password (shown here and emailed): npm run add-super-admin -- ${email}`);
  const pw = envPw || tempPw();
  if (!u) await insert('users', { id: uid(), tenant_id: null, name: process.env.SUPER_ADMIN_NAME || 'Super admin', email, role: 'super_admin', password_hash: hashPw(pw), is_active: 1, must_change_pw: 1 });
  else await run("UPDATE users SET role='super_admin', tenant_id=NULL, password_hash=?, is_active=1, must_change_pw=1 WHERE id=?", hashPw(pw), u.id);
  if (envPw) await setSetting('super_admin_env', mark);
  const acct = await one('SELECT * FROM users WHERE lower(email)=lower(?)', email);
  await notify({ tenant_id: null }, [acct.email], u ? 'password_reset' : 'invite', await staffVars(acct, pw)).catch(e => console.error('super admin email', e.message));
  console.log(`Super admin ${email}: ${u ? 'temporary password set' : 'created'}; the sign-in details were emailed (see Email → Delivery log).${envPw ? '' : ` Temporary password: ${pw}`} They choose their own password at first sign-in.`);
}
const OWNER = String(process.env.OWNER_EMAIL ?? 'sriram@smru.edu.in').trim().toLowerCase();
{
  const envEmail = String(process.env.SUPER_ADMIN_EMAIL || '').trim(), envPw = String(process.env.SUPER_ADMIN_PASSWORD || '');
  if (OWNER && OWNER !== envEmail.toLowerCase()) await ensureSuperAdmin(OWNER);
  if (envEmail) await ensureSuperAdmin(envEmail, envPw);
  if (!OWNER && !envEmail && !await one('SELECT 1 FROM users LIMIT 1')) console.log('No users yet. Set SUPER_ADMIN_EMAIL in .env and restart: the super admin is created and their temporary password emailed.');
}
// ---------- start-up provisioning ----------
// provision/*.json (committed: campuses and services) and provision/*.private.json (git-ignored: staff and who serves what)
// are applied on every start. Each item is added once and remembered, so anything an admin later edits or removes in the
// app is left alone. Staff invites are held (Email → Delivery log → Resend) rather than sent automatically.
async function provision() {
  const dir = process.env.PROVISION_DIR || path.join(ROOT, 'provision');
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort((a, b) => a.includes('.private.') - b.includes('.private.') || a.localeCompare(b));
  const row = await one("SELECT value FROM app_settings WHERE key='provision_applied'");
  const applied = new Set(row ? JSON.parse(row.value) : []), before = applied.size;
  for (const f of files) {
    let spec; try { spec = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { console.error(`provision ${f}: unreadable (${e.message})`); continue; }
    const added = [], invites = [], step = async (key, label, fn) => { if (applied.has(key)) return;
      try { if (await fn() !== false) added.push(label); applied.add(key); } catch (e) { console.error(`provision ${f}: ${label}: ${e.message}`); } };
    // email connection (private files only): used only if this server has none yet, so the Email page stays in charge
    const m = spec.mail;
    if (m?.url && m?.key) await step('mail:connection', 'email connection', async () => {
      if (mailConfig(BASE).url) return false;
      if (!/^https:\/\/\S+$/.test(m.url) || String(m.key).length < 16) throw new Error('mail.url must be https and mail.key 16+ characters');
      await setSetting('pa_url', m.url); await setSetting('pa_key', String(m.key)); await setSetting('mail_enabled', m.sending === false ? '0' : '1');
    });
    if (m?.base) await step('mail:base', 'public address for email links', async () => {
      if (getSettings().public_base_url) return false;
      if (!/^https?:\/\/\S+$/.test(m.base)) throw new Error('mail.base must start with http(s)://');
      await setSetting('public_base_url', m.base.replace(/\/+$/, ''));
    });
    const code = String(spec.campus?.code || '').toUpperCase(); if (!code) continue;
    let tn = await one('SELECT * FROM tenants WHERE code=?', code);
    if (!tn) {
      const c = spec.campus;
      if (!c.name || !/^[a-z0-9-]{2,30}$/.test(c.slug || '') || await one('SELECT 1 FROM tenants WHERE slug=?', c.slug)) { console.error(`provision ${f}: campus ${code} is missing and its name/slug are unusable`); continue; }
      tn = await insert('tenants', { id: uid(), code, name: c.name, slug: c.slug, timezone: 'Asia/Kolkata', show_provider_contact: 1, reopen_window_days: 7, is_active: 1 });
      for (const [p, h] of Object.entries(DEFAULT_HOURS)) await insert('sla_policies', { id: uid(), tenant_id: tn.id, service_id: null, priority: p, target_hours: h });
      added.push(`campus ${code}`);
    }
    for (const s of spec.services || []) await step(`${code}:service:${s.code}`, `service ${s.code}`, async () => {
      if (!/^[A-Z0-9-]{2,12}$/.test(String(s.code)) || !s.name) throw new Error('code must be 2–12 capital letters or digits, and the name must be filled in');
      if (await one('SELECT 1 FROM services WHERE tenant_id=? AND code=?', tn.id, s.code)) return false;
      await insert('services', { id: uid(), tenant_id: tn.id, code: s.code, name: s.name, description: s.description || null,
        form_schema: JSON.stringify(cleanSchema(s.form_schema || {})), is_active: 1, sort_order: Number(s.sort_order) || 0, escalation_user_id: null });
    });
    for (const p of spec.people || []) await step(`person:${String(p.email).toLowerCase()}`, `staff ${p.email}`, async () => {
      const email = String(p.email).trim();
      if (!/^\S+@\S+\.\S+$/.test(email) || !p.name || await one('SELECT 1 FROM users WHERE lower(email)=lower(?)', email)) return false;
      const pw = tempPw(), u = await insert('users', { id: uid(), tenant_id: tn.id, name: String(p.name).trim(), email, phone: p.phone || null,
        role: 'provider', password_hash: hashPw(pw), is_active: 1, must_change_pw: 1 });
      invites.push([u, pw]);
    });
    const userId = async e => e && (await one("SELECT id FROM users WHERE lower(email)=lower(?) AND tenant_id=? AND is_active=1 AND role IN ('provider','tenant_admin')", e, tn.id))?.id;
    for (const [sc, a] of Object.entries(spec.assign || {})) {
      const svc = await one('SELECT * FROM services WHERE tenant_id=? AND code=?', tn.id, sc); if (!svc) continue;
      await step(`${code}:providers:${sc}`, `providers for ${sc}`, async () => {
        if (await one('SELECT 1 FROM service_members WHERE service_id=?', svc.id)) return false;
        const ids = [...new Set((await Promise.all((a.providers || []).slice(0, 2).map(userId))).filter(Boolean))];
        for (const id of ids) await insert('service_members', { id: uid(), tenant_id: tn.id, service_id: svc.id, user_id: id, created_at: now() });
        return ids.length > 0;
      });
      if (a.escalation) await step(`${code}:escalation:${sc}`, `escalation for ${sc}`, async () => {
        const id = await userId(a.escalation); if (svc.escalation_user_id || !id) return false;
        await run('UPDATE services SET escalation_user_id=? WHERE id=?', id, svc.id);
        await run('INSERT INTO service_escalations (service_id, user_id) VALUES (?, ?) ON CONFLICT DO NOTHING', svc.id, id);
      });
    }
    for (const [u, pw] of invites) await notify({ tenant_id: tn.id }, [u.email], 'invite', await staffVars(u, pw), { hold: true });
    if (added.length) {
      console.log(`provision ${f}: added ${added.join(', ')}`);
      await insert('audit_logs', { id: uid(), tenant_id: tn.id, actor_id: null, action: 'provision', entity: 'file', entity_id: f, meta: JSON.stringify({ added }), created_at: now() });
    }
  }
  if (applied.size !== before) await run("INSERT INTO app_settings (key, value) VALUES ('provision_applied', ?) ON CONFLICT (key) DO UPDATE SET value=excluded.value", JSON.stringify([...applied]));
}
await provision();

const server = app.listen(PORT, process.env.HOST, () => console.log(`ONE Desk on http://${process.env.HOST || 'localhost'}:${PORT}`));
// HEIC photos stored before uploads were converted: turn them into JPEG once, in the background
(async () => {
  for (const a of await all("SELECT * FROM attachments WHERE mime_type IN ('image/heic','image/heif') OR lower(file_name) LIKE '%.heic' OR lower(file_name) LIKE '%.heif'")) {
    try {
      const file = path.join(UPLOAD_DIR, a.storage_key); if (!fs.existsSync(file)) continue;
      const buf = fs.readFileSync(file), kind = kindOf(buf), base = a.file_name.replace(/\.[a-z0-9]{2,5}$/i, '');
      if (kind !== 'heic') { // named .heic but really another picture: just put the record right
        if (MIME[kind]) await run('UPDATE attachments SET mime_type=?, file_name=? WHERE id=?', MIME[kind], `${base}.${kind === 'jpeg' ? 'jpg' : kind}`, a.id);
        continue; }
      const jpg = await heicToJpeg(buf), key = crypto.randomBytes(18).toString('hex') + '.jpg';
      fs.writeFileSync(path.join(UPLOAD_DIR, key), jpg);
      await run('UPDATE attachments SET storage_key=?, mime_type=?, file_name=?, size_bytes=? WHERE id=?', key, 'image/jpeg', `${base}.jpg`, jpg.length, a.id);
      fs.rmSync(file); console.log(`photo ${a.file_name}: turned from HEIC into JPEG`);
    } catch (e) { console.error(`photo ${a.file_name}: ${e.message}`); }
  }
})().catch(e => console.error('photo conversion', e.message));
// pm2 stop / restart send SIGTERM: finish in-flight requests, then close the Postgres pool
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => {
  console.log(`${sig}: shutting down`);
  server.close(() => pool.end().finally(() => process.exit(0)));
  setTimeout(() => process.exit(1), 8000).unref();
});
