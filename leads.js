// Leads: enquiries that come in on the campus WhatsApp bot, for tele-callers to call back.
// The WhatsApp bot (WATI, Interakt, AiSensy, Gupshup, Twilio, Meta's own WhatsApp Cloud API or any other) sends each lead
// to the campus's leads link with the campus's leads key. The lead lands on a tele-caller's "To call" list; the tele-caller
// calls, logs what happened and sets the next call. Old leads come in once from a spreadsheet (CSV) exported from the bot.
// A campus admin (or the super admin) switches Leads on, picks the tele-callers (desk providers), imports old leads and
// sees the reports. Tele-callers in no ticket team open straight on Leads and are not ranked in the desk's points.
// Self-contained: own tables, own routes; wired from server.js with one call.
import crypto from 'node:crypto';
import express from 'express';
import { pool, one, all, run, uid, now, tx } from './db.js';
import { calendar, addWorking, localDay, dateStart } from './sla.js';

await pool.query(`
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS leads_on INT DEFAULT 0;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS leads_key TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS leads_cfg TEXT;
CREATE TABLE IF NOT EXISTS lead_callers (tenant_id TEXT NOT NULL REFERENCES tenants(id), user_id TEXT NOT NULL REFERENCES users(id), created_at TEXT, PRIMARY KEY (tenant_id, user_id));
CREATE TABLE IF NOT EXISTS leads (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), lead_no INT NOT NULL,
  name TEXT, phone TEXT NOT NULL, email TEXT, course TEXT, city TEXT, message TEXT, source TEXT NOT NULL DEFAULT 'whatsapp', extra TEXT DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','trying','callback','interested','won','lost','invalid')),
  assigned_to TEXT REFERENCES users(id), assigned_at TEXT, due_at TEXT, next_call_at TEXT, attempts INT DEFAULT 0, first_call_at TEXT, last_call_at TEXT,
  last_message_at TEXT, unread INT DEFAULT 0, closed_at TEXT, closed_by TEXT, close_reason TEXT, created_at TEXT, updated_at TEXT, UNIQUE (tenant_id, lead_no));
CREATE INDEX IF NOT EXISTS leads_ph ON leads(tenant_id, phone);
CREATE INDEX IF NOT EXISTS leads_as ON leads(tenant_id, assigned_to, status);
CREATE INDEX IF NOT EXISTS leads_cr ON leads(tenant_id, created_at);
CREATE TABLE IF NOT EXISTS lead_events (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, lead_id TEXT NOT NULL REFERENCES leads(id),
  kind TEXT NOT NULL, outcome TEXT, body TEXT, actor_id TEXT, actor_name TEXT, ext_id TEXT, next_call_at TEXT, created_at TEXT);
CREATE INDEX IF NOT EXISTS le_l ON lead_events(lead_id, created_at);
CREATE INDEX IF NOT EXISTS le_t ON lead_events(tenant_id, kind, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS le_ext ON lead_events(tenant_id, ext_id) WHERE ext_id IS NOT NULL;
`);

export const LEAD_STATUS = { new: 'New', trying: 'Not reached yet', callback: 'Call back', interested: 'Interested', won: 'Converted', lost: 'Not interested', invalid: 'Wrong number' };
export const OUTCOMES = { no_answer: 'No answer / busy / switched off', callback: 'Asked to call back', interested: 'Interested', won: 'Converted (joined / paid)', lost: 'Not interested', invalid: 'Wrong number / not a lead' };
export const LOST_REASONS = ['Fees too high', 'Joined somewhere else', 'Course not offered', 'Only asking for information', 'Too far / location', 'Other'];
const OPEN = ['new', 'trying', 'callback', 'interested'], CLOSED = ['won', 'lost', 'invalid'];
const OPEN_SQL = `('new','trying','callback','interested')`;
const SOURCES = { whatsapp: 'WhatsApp', import: 'Imported', manual: 'Added by hand' };
const CFG = { first_call_min: 60, retry_min: 120, country_code: '91', app_secret: '' }; // first call within 60 working minutes; no answer: try again 2 working hours later
const MAX_BATCH = 500, MAX_IMPORT = 5000, MAX_CALLERS = 50, MAX_EXTRA = 30;
const cfgOf = tn => { try { return { ...CFG, ...JSON.parse(tn.leads_cfg || '{}') }; } catch { return { ...CFG }; } };
const str = (v, max) => String(v ?? '').trim().slice(0, max);
const json = v => { try { return JSON.parse(v || '{}') || {}; } catch { return {}; } };
const sha = v => crypto.createHash('sha256').update(String(v)).digest();
const sameKey = (a, b) => !!a && !!b && crypto.timingSafeEqual(sha(a), sha(b)); // equal-length digests: no length leak
export const leadRef = n => 'L' + String(n).padStart(4, '0');

// ---------- phone numbers: digits with the country code, e.g. 919876543210 ----------
export const normPhone = (v, cc = '91') => {
  let d = String(v ?? '').replace(/^\s*whatsapp:/i, '').replace(/[^\d+]/g, '');
  if (d.startsWith('+')) d = d.slice(1); else if (d.startsWith('00')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0') && cc) d = cc + d.slice(1); // 09876543210
  else if (d.length === 10 && cc) d = cc + d; // 9876543210
  d = d.replace(/\D/g, '');
  return /^\d{8,15}$/.test(d) ? d : null;
};
export const phoneText = p => !p ? '' : /^91\d{10}$/.test(p) ? `+91 ${p.slice(2, 7)} ${p.slice(7)}` : '+' + p;

// ---------- reading what a bot sends: any JSON (or form) with a phone number, plus Meta's WhatsApp Cloud API format ----------
const nk = k => String(k).toLowerCase().replace(/[^a-z0-9]/g, '');
const ALIAS = {
  phone: ['phone', 'phonenumber', 'mobile', 'mobilenumber', 'mobileno', 'phoneno', 'contactnumber', 'contactno', 'whatsapp', 'whatsappnumber', 'whatsappno', 'waid', 'wanumber', 'from', 'msisdn', 'number', 'senderphone', 'customerphone', 'userphone', 'cellphone', 'contact'],
  name: ['name', 'fullname', 'contactname', 'customername', 'profilename', 'sendername', 'username', 'studentname', 'leadname', 'displayname', 'pushname'],
  first: ['firstname', 'fname'], last: ['lastname', 'lname', 'surname'],
  message: ['message', 'text', 'body', 'msg', 'lastmessage', 'query', 'enquiry', 'inquiry', 'question', 'comments', 'comment', 'requirement', 'messagetext', 'content', 'firstmessage'],
  course: ['course', 'program', 'programme', 'interestedin', 'interest', 'coursename', 'branch', 'stream', 'department', 'specialization', 'specialisation'],
  email: ['email', 'emailid', 'emailaddress', 'mail'],
  city: ['city', 'location', 'place', 'town', 'district', 'address'],
  id: ['messageid', 'msgid', 'wamid', 'messagesid', 'smsmessagesid', 'payloadid', 'eventid', 'submissionid', 'leadid', 'id'],
  at: ['createdat', 'timestamp', 'time', 'date', 'receivedat', 'created', 'datetime', 'submittedat', 'createdon', 'receivedon', 'lastmessageat', 'receivedatutc', 'createdatutc'],
};
const USED = new Set(Object.values(ALIAS).flat());
const NOISE = new Set(['object', 'entry', 'event', 'eventtype', 'type', 'direction', 'channel', 'status', 'statusstring', 'campus', 'slug', 'tenant', 'accountsid', 'apiversion', 'numsegments', 'nummedia', 'smsstatus',
  'to', 'tonumber', 'waba', 'wabaid', 'businessnumber', 'conversationid', 'ticketid', 'owner', 'avatarurl', 'assignedid', 'operatorname', 'operatoremail', 'sourceid', 'sourceurl', 'replycontextid',
  'whatsappmessageid', 'app', 'version', 'source', 'countrycode', 'dialcode', 'isbot', 'isowner']);
const LISTS = ['customparams', 'customfields', 'attributes', 'answers', 'fields', 'params', 'variables', 'formdata', 'responses'];
const scalar = v => ['string', 'number', 'boolean'].includes(typeof v);
const SECRETISH = /key|token|secret|signature|password|passwd|auth/;
// Every answer the bot sent, as one flat list, shallow first. A nested answer is also kept under its parent's name
// (customer.id → "customerid", message.id → "messageid"), and a nested plain "id" counts only that way, so a contact's id is
// never taken for a message's id. Lists of {name, value} (custom fields, form answers) become answers of their own.
function flatten(o) {
  const flat = new Map(), put = (n, key, v, own) => { if (n && !flat.has(n) && v != null && String(v).trim() !== '') flat.set(n, { key, value: v, own }); };
  const inner = v => scalar(v.body) ? v.body : scalar(v.text) ? v.text : scalar(v.value) ? v.value : null;
  let level = [[o, '']];
  for (let depth = 0; depth < 4 && level.length; depth++) { const next = [];
    for (const [obj, parent] of level) for (const [k, v] of Object.entries(obj)) { const n = nk(k); if (v == null || !n) continue;
      if (scalar(v)) { if (!parent || n !== 'id') put(n, String(k), v, true); if (parent) put(parent + n, String(k), v, false); continue; }
      if (Array.isArray(v)) { if (LISTS.includes(n)) for (const x of v) if (x && typeof x === 'object') { const kk = x.name ?? x.key ?? x.question ?? x.label ?? x.field ?? x.title, vv = x.value ?? x.answer ?? x.response;
        if (scalar(kk) && scalar(vv)) put(nk(kk), String(kk), vv, true); } continue; }
      if (typeof v === 'object') { const i = inner(v); if (i != null && (!parent || n !== 'id')) put(n, String(k), i, true); next.push([v, n]); } }
    level = next; }
  return flat;
}
// a time from a bot or a spreadsheet: epoch seconds or ms, ISO, or Indian day-first "28/11/2026 14:05" / "28-11-2026 2:05 pm"
export function parseAt(v) {
  if (v == null || v === '') return null; let t = null;
  if (typeof v === 'number' || /^\d{9,13}$/.test(String(v).trim())) { const n = Number(v); t = n < 1e12 ? n * 1000 : n; }
  else { const s = String(v).trim(), m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})(?:[ ,T]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]\.?m\.?)?)?$/i);
    if (m) { let [, d, mo, y, h = '0', mi = '0', se = '0', ap] = m; y = y.length === 2 ? '20' + y : y; let hh = +h; if (ap) { const pm = /^p/i.test(ap); if (pm && hh < 12) hh += 12; if (!pm && hh === 12) hh = 0; }
      t = Date.UTC(+y, +mo - 1, +d, hh, +mi, +se) - 330 * 6e4; } // read as India time
    else t = Date.parse(s); }
  if (!Number.isFinite(t) || t < Date.UTC(2000, 0, 1) || t > Date.now() + 864e5) return null;
  return new Date(Math.min(t, Date.now())).toISOString();
}
export function parseItem(o) {
  const flat = flatten(o || {}), get = list => { for (const a of list) { const e = flat.get(a); if (e && String(e.value).trim() !== '') return String(e.value).trim(); } return ''; };
  const name = get(ALIAS.name) || [get(ALIAS.first), get(ALIAS.last)].filter(Boolean).join(' ');
  const message = get(ALIAS.message), seen = new Set([message, name].filter(Boolean)); // the same words twice (a nested copy of the message) are not an answer of their own
  const extra = {}; for (const [n, e] of flat) { if (!e.own || USED.has(n) || NOISE.has(n) || SECRETISH.test(n) || seen.has(String(e.value).trim()) || Object.keys(extra).length >= MAX_EXTRA) continue; extra[str(e.key, 60)] = str(e.value, 300); }
  return { phone: get(ALIAS.phone), name: str(name, 80), message: str(message, 2000), course: str(get(ALIAS.course), 120), email: str(get(ALIAS.email), 120).toLowerCase(),
    city: str(get(ALIAS.city), 120), id: str(get(ALIAS.id), 120), at: parseAt(get(ALIAS.at)), extra };
}
const isMeta = b => !!b && typeof b === 'object' && (b.object === 'whatsapp_business_account' || (Array.isArray(b.entry) && Array.isArray(b.entry[0]?.changes)));
const metaText = m => m.text?.body || m.button?.text || m.interactive?.button_reply?.title || [m.interactive?.list_reply?.title, m.interactive?.list_reply?.description].filter(Boolean).join(' – ')
  || m.image?.caption || m.video?.caption || m.document?.caption || (m.location ? [m.location.name, m.location.address].filter(Boolean).join(', ') || 'Shared a location' : '')
  || (m.reaction ? m.reaction.emoji : '') || (m.interactive?.nfm_reply ? 'Filled in the form' : '') || `[${m.type || 'message'}]`;
function metaItems(body) {
  const out = [];
  for (const e of body.entry || []) for (const c of e.changes || []) { const v = c.value || {}, names = Object.fromEntries((v.contacts || []).map(x => [x.wa_id, x.profile?.name || '']));
    for (const m of v.messages || []) { let form = {}; try { form = JSON.parse(m.interactive?.nfm_reply?.response_json || '{}'); delete form.flow_token; } catch { form = {}; } // WhatsApp Flows: the form's answers
      out.push(parseItem({ ...form, from: m.from, profile_name: names[m.from] || '', message: metaText(m), message_id: m.id, timestamp: m.timestamp })); } }
  return out;
}
export function itemsOf(body) {
  if (!body || typeof body !== 'object') return [];
  if (isMeta(body)) return metaItems(body);
  const arr = Array.isArray(body) ? body : Array.isArray(body.leads) ? body.leads : Array.isArray(body.data) ? body.data : [body];
  return arr.filter(x => x && typeof x === 'object' && !Array.isArray(x)).map(parseItem);
}
// CSV from a bot's export (or Excel "Save as CSV"): commas, semicolons or tabs, quoted cells, first row = headings
export function parseCsv(text) {
  text = String(text || '').replace(/^﻿/, ''); const first = text.split(/\r?\n/, 1)[0] || '';
  const sep = [',', ';', '\t'].map(s => [s, first.split(s).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) { const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; continue; }
    if (c === '"' && cell === '') q = true; else if (c === sep) { row.push(cell); cell = ''; } else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; } else cell += c; }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  const head = (rows.shift() || []).map(h => h.trim());
  return { head, rows: rows.filter(r => r.some(x => x.trim() !== '')).map(r => Object.fromEntries(head.map((h, i) => [h || `Column ${i + 1}`, (r[i] ?? '').trim()]))) };
}

// ---------- the leads engine ----------
const dueFrom = (tn, iso, minutes) => { try { return addWorking(calendar(tn), iso, minutes); } catch { return new Date(Date.parse(iso) + minutes * 6e4).toISOString(); } };
export const lateOf = (l, t = now()) => l.status === 'new' ? !!l.due_at && l.due_at < t : OPEN.includes(l.status) && !!l.next_call_at && l.next_call_at < new Date(Date.parse(t) - 3600e3).toISOString();
// the tele-caller with the fewest open leads (then the one who got a lead longest ago)
async function pickCaller(tid, except = []) {
  return await one(`SELECT u.id, u.name FROM lead_callers c JOIN users u ON u.id=c.user_id AND u.is_active=1 AND u.role='provider' AND u.tenant_id=c.tenant_id
    WHERE c.tenant_id=? AND NOT (u.id = ANY(?::text[]))
    ORDER BY (SELECT count(*) FROM leads l WHERE l.tenant_id=c.tenant_id AND l.assigned_to=u.id AND l.status IN ${OPEN_SQL}),
      (SELECT max(assigned_at) FROM leads l WHERE l.tenant_id=c.tenant_id AND l.assigned_to=u.id) NULLS FIRST, u.name LIMIT 1`, tid, except);
}
const event = (l, kind, f = {}) => run('INSERT INTO lead_events (id, tenant_id, lead_id, kind, outcome, body, actor_id, actor_name, ext_id, next_call_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
  uid(), l.tenant_id, l.id, kind, f.outcome || null, f.body || null, f.actor?.id || null, f.actor?.name || null, f.ext || null, f.next || null, f.at || now());
// one lead from the bot, an import or a tele-caller: the same phone number is the same person (their open lead gets the message)
export async function intake(tn, it, { source = 'whatsapp', caller, actor } = {}) {
  const cfg = cfgOf(tn), phone = normPhone(it.phone, cfg.country_code);
  if (!phone) return { result: 'skipped', why: it.phone ? `"${str(it.phone, 30)}" is not a phone number` : 'no phone number' };
  return await tx(async () => {
    await one('SELECT pg_advisory_xact_lock(hashtext(?))', 'leads:' + tn.id); // one intake at a time per campus: no twin leads, no twin numbers
    const ext = it.id ? `${source}:${it.id}` : null, t = now(), when = source === 'import' && it.at ? it.at : t;
    if (ext && await one('SELECT 1 FROM lead_events WHERE tenant_id=? AND ext_id=?', tn.id, ext)) return { result: 'duplicate' }; // the bot sent the same message twice
    const ex = await one(`SELECT * FROM leads WHERE tenant_id=? AND phone=? ORDER BY (status IN ${OPEN_SQL}) DESC, created_at DESC LIMIT 1`, tn.id, phone);
    if (ex) {
      const fill = {}; for (const k of ['name', 'email', 'course', 'city']) if (!ex[k] && it[k]) fill[k] = it[k];
      const extra = { ...json(ex.extra) }; for (const [k, v] of Object.entries(it.extra || {})) if (Object.keys(extra).length < MAX_EXTRA || k in extra) extra[k] = v;
      const reopen = ['lost', 'invalid'].includes(ex.status) && source !== 'import'; // they wrote again: worth another call
      let to = ex.assigned_to;
      if (reopen && to && !(await one("SELECT 1 FROM lead_callers c JOIN users u ON u.id=c.user_id AND u.is_active=1 WHERE c.tenant_id=? AND c.user_id=?", tn.id, to))) to = (caller !== undefined ? caller : await pickCaller(tn.id))?.id || null;
      await run(`UPDATE leads SET name=?, email=?, course=?, city=?, extra=?, message=coalesce(nullif(message,''), ?), last_message_at=greatest(coalesce(last_message_at,''), ?), unread=?, updated_at=?
        ${reopen ? ", status='new', due_at=?, next_call_at=NULL, closed_at=NULL, closed_by=NULL, close_reason=NULL, assigned_to=?, assigned_at=coalesce(?, assigned_at)" : ''} WHERE id=?`,
        fill.name ?? ex.name, fill.email ?? ex.email, fill.course ?? ex.course, fill.city ?? ex.city, JSON.stringify(extra), it.message || null, when, source === 'whatsapp' ? 1 : ex.unread, t,
        ...(reopen ? [dueFrom(tn, t, cfg.first_call_min), to, to && to !== ex.assigned_to ? t : null] : []), ex.id);
      await event(ex, 'message', { body: it.message || ({ import: 'Imported again', manual: 'Added again by hand' })[source] || 'Wrote again on WhatsApp', ext, at: when, actor, outcome: source });
      if (reopen) await event(ex, 'reopened', { body: `Wrote again after being closed as "${LEAD_STATUS[ex.status]}"` });
      return { result: reopen ? 'reopened' : source === 'import' ? 'merged' : 'added', lead: await one('SELECT * FROM leads WHERE id=?', ex.id) };
    }
    const no = (await one('SELECT coalesce(max(lead_no),0)+1 n FROM leads WHERE tenant_id=?', tn.id)).n, c = caller !== undefined ? caller : await pickCaller(tn.id);
    const l = { id: uid(), tenant_id: tn.id, lead_no: no, name: it.name || null, phone, email: it.email || null, course: it.course || null, city: it.city || null, message: it.message || null, source,
      extra: JSON.stringify(it.extra || {}), status: 'new', assigned_to: c?.id || null, assigned_at: c ? t : null, due_at: dueFrom(tn, t, cfg.first_call_min), last_message_at: source === 'manual' ? null : when,
      unread: 0, created_at: when, updated_at: t };
    await run(`INSERT INTO leads (${Object.keys(l).join(',')}) VALUES (${Object.keys(l).map(() => '?').join(',')})`, ...Object.values(l));
    await event(l, 'created', { body: it.message || null, ext, at: when, actor, outcome: source });
    if (c) await event(l, 'assigned', { body: `Given to ${c.name}` });
    return { result: 'created', lead: l };
  });
}
// a tele-caller left (removed from Leads, deactivated, no longer a provider): their open leads go to the others
async function moveLeadsOf(tid, userId, why) {
  const rows = await all(`SELECT * FROM leads WHERE tenant_id=? AND assigned_to=? AND status IN ${OPEN_SQL}`, tid, userId);
  const left = (await one('SELECT name FROM users WHERE id=?', userId))?.name || 'a tele-caller';
  for (const l of rows) { const c = await pickCaller(tid, [userId]);
    await run('UPDATE leads SET assigned_to=?, assigned_at=?, updated_at=? WHERE id=?', c?.id || null, c ? now() : null, now(), l.id);
    await event(l, 'assigned', { body: c ? `Moved from ${left} to ${c.name} (${why})` : `${left} is no longer a tele-caller (${why}); waiting for someone to take it` }); }
  return rows.length;
}
export async function dropCaller(userId, why = 'no longer a tele-caller') {
  await run('DELETE FROM lead_callers WHERE user_id=?', userId);
  for (const r of await all(`SELECT DISTINCT tenant_id FROM leads WHERE assigned_to=? AND status IN ${OPEN_SQL}`, userId)) await moveLeadsOf(r.tenant_id, userId, why);
}

export function leads(d) {
  const { app, S, wrap, bad, notFound, HttpErr, limit, tenantRow, base } = d;
  const forbid = (m = 'Only the tele-callers and campus admins can do this') => new HttpErr(403, 'FORBIDDEN', m);
  const linkOf = tn => `${base()}/api/leads/in/${tn.slug}`;
  const newKey = () => crypto.randomBytes(24).toString('base64url');

  // ---------- who may do what ----------
  async function access(req) {
    const u = req.user, tid = req.tenantId; if (!tid) return { tenant: null };
    const tn = await tenantRow(tid), admin = u.role !== 'provider';
    const caller = u.role === 'provider' && !!(await one('SELECT 1 FROM lead_callers WHERE tenant_id=? AND user_id=?', tid, u.id));
    return { tenant: tn, admin, caller, on: !!tn?.leads_on, use: !!tn?.leads_on && (admin || caller) };
  }
  const need = async req => { const a = await access(req); if (!a.tenant) throw bad('Pick a campus first'); if (!a.use) throw forbid(a.admin ? 'Switch Leads on first (Leads → Set up)' : undefined); return a; };
  const needAdmin = async req => { const a = await access(req); if (!a.tenant) throw bad('Pick a campus first'); if (!a.admin) throw forbid('Only campus admins can do this'); return a; };
  const namesOf = async ids => { ids = [...new Set(ids.filter(Boolean))]; return ids.length ? Object.fromEntries((await all('SELECT id, name FROM users WHERE id = ANY(?::text[])', ids)).map(u => [u.id, u.name])) : {}; };
  const pub = (l, names = {}, t = now()) => ({ id: l.id, no: l.lead_no, ref: leadRef(l.lead_no), name: l.name || '', phone: l.phone, phone_text: phoneText(l.phone), email: l.email || '', course: l.course || '', city: l.city || '',
    message: l.message || '', source: l.source, source_text: SOURCES[l.source] || l.source, extra: json(l.extra), status: l.status, status_text: LEAD_STATUS[l.status], open: OPEN.includes(l.status),
    assigned_to: l.assigned_to, caller: names[l.assigned_to] || null, due_at: l.due_at, next_call_at: l.next_call_at, attempts: l.attempts || 0, first_call_at: l.first_call_at, last_call_at: l.last_call_at,
    last_message_at: l.last_message_at, unread: !!l.unread, created_at: l.created_at, closed_at: l.closed_at, close_reason: l.close_reason, late: lateOf(l, t) });
  // a lead this person may see: admins every lead on the campus; a tele-caller their own and the ones nobody has yet
  const leadFor = async (req, a) => { const l = await one('SELECT * FROM leads WHERE id=? AND tenant_id=?', req.params.id, req.tenantId); if (!l) throw notFound();
    if (!a.admin && l.assigned_to && l.assigned_to !== req.user.id) throw forbid('This lead is with another tele-caller'); return l; };
  const isoIn = (v, what) => { const t = Date.parse(v); if (!Number.isFinite(t)) throw bad(`Pick ${what}`); if (t < Date.now() - 5 * 6e4) throw bad('The next call must be in the future'); if (t > Date.now() + 366 * 864e5) throw bad('Pick a time within a year'); return new Date(t).toISOString(); };
  const dayStr = (tz, d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'Asia/Kolkata' }).format(d);
  const range = (tn, q, days = 30) => { const tz = tn.timezone || 'Asia/Kolkata', today = dayStr(tz), ok = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
    const to = ok(q.to) ? q.to : today, from = ok(q.from) ? q.from : dayStr(tz, new Date(Date.parse(dateStart(tz, to)) - (days - 1) * 864e5 + 12 * 3600e3));
    if (from > to) throw bad('The start date is after the end date');
    return { from, to, start: dateStart(tz, from), end: localDay(tz, dateStart(tz, to)).next, tz }; };

  // ================= the leads link: the WhatsApp bot sends leads here =================
  const keyOf = req => String(req.get('x-leads-key') || (req.get('authorization') || '').replace(/^Bearer\s+/i, '') || req.query.key || '');
  const inTenant = slug => one('SELECT * FROM tenants WHERE slug=? AND is_active=1', String(slug || '').toLowerCase()).catch(() => null);
  // Meta checks the address when it is saved ("Verify and save"): hub.verify_token must be the leads key; the challenge goes back as it came
  app.get('/api/leads/in/:slug', async (req, res, next) => { try {
    const tn = await inTenant(req.params.slug), token = String(req.query['hub.verify_token'] ?? req.query.hub?.verify_token ?? keyOf(req));
    if (!tn || !sameKey(token, tn.leads_key)) return res.status(403).type('text/plain').send('Wrong or missing leads key');
    const ch = req.query['hub.challenge'] ?? req.query.hub?.challenge;
    if (ch != null) return res.type('text/plain').send(String(ch).slice(0, 200));
    res.json({ data: { ok: true, campus: tn.name, on: !!tn.leads_on } });
  } catch (e) { next(e); } });
  app.post('/api/leads/in/:slug', express.urlencoded({ extended: false, limit: '1mb' }), wrap(async req => {
    limit('leadsin-ip:' + req.ip, 6000);
    const tn = await inTenant(req.params.slug); if (!tn) throw notFound();
    if (!sameKey(keyOf(req), tn.leads_key)) throw new HttpErr(401, 'UNAUTHORIZED', 'Wrong or missing leads key');
    if (!tn.leads_on) throw new HttpErr(403, 'OFF', 'Leads are switched off for this campus');
    const cfg = cfgOf(tn);
    if (cfg.app_secret && isMeta(req.body)) { // Meta signs each delivery with the app secret
      const sig = String(req.get('x-hub-signature-256') || ''), want = 'sha256=' + crypto.createHmac('sha256', cfg.app_secret).update(req.rawBody || '').digest('hex');
      if (!sameKey(sig, want)) throw new HttpErr(401, 'UNAUTHORIZED', 'The X-Hub-Signature-256 does not match the app secret'); }
    const items = itemsOf(req.body); if (items.length > MAX_BATCH) throw bad(`Send at most ${MAX_BATCH} leads at a time`);
    if (req.query.dry) return { dry: true, leads: items.map(it => ({ ...it, phone: normPhone(it.phone, cfg.country_code), phone_text: phoneText(normPhone(it.phone, cfg.country_code)) })) };
    limit('leadsin:' + tn.id, 20000);
    const res = []; for (const it of items) res.push(await intake(tn, it, { source: 'whatsapp' }));
    const count = k => res.filter(r => r.result === k).length;
    return { received: items.length, created: count('created'), added: count('added') + count('reopened'), duplicate: count('duplicate'), skipped: count('skipped'),
      results: res.map(r => ({ result: r.result, lead: r.lead ? leadRef(r.lead.lead_no) : undefined, why: r.why })) };
  }));

  // ================= the desk (signed in) =================
  S.get('/leads/access', wrap(async req => { const a = await access(req);
    // tele-callers with no ticket team open straight on Leads; anyone in a desk team still sees their team's tickets
    const desk = req.user.role !== 'provider' || !a.caller || !a.on || !!(await one('SELECT 1 FROM service_members WHERE user_id=? LIMIT 1', req.user.id));
    const mine = a.use ? (await one(`SELECT count(*) FILTER (WHERE status='new' OR next_call_at < ?)::int due, count(*) FILTER (WHERE unread=1)::int unread FROM leads WHERE tenant_id=? AND status IN ${OPEN_SQL} AND ${a.admin ? 'true' : 'assigned_to=?'}`,
      now(), req.tenantId, ...(a.admin ? [] : [req.user.id]))) : null;
    return { on: !!a.on, admin: !!a.admin, caller: !!a.caller, use: !!a.use, setup: !!a.admin, desk, due: mine?.due || 0, unread: mine?.unread || 0 }; }));

  // ---------- set up (campus admins) ----------
  S.get('/leads/setup', wrap(async req => { const a = await needAdmin(req), tn = a.tenant, cfg = cfgOf(tn);
    const team = new Set((await all('SELECT DISTINCT user_id FROM service_members WHERE tenant_id=?', tn.id)).map(r => r.user_id));
    const counts = await one(`SELECT count(*) FILTER (WHERE status IN ${OPEN_SQL})::int open, count(*) FILTER (WHERE status IN ${OPEN_SQL} AND assigned_to IS NULL)::int unassigned, count(*)::int total FROM leads WHERE tenant_id=?`, tn.id);
    return { on: !!tn.leads_on, link: linkOf(tn), key: tn.leads_key || null, callers: (await all('SELECT user_id FROM lead_callers WHERE tenant_id=?', tn.id)).map(r => r.user_id),
      providers: (await all("SELECT id, name, email FROM users WHERE tenant_id=? AND role='provider' AND is_active=1 ORDER BY name", tn.id)).map(p => ({ ...p, team: team.has(p.id) })),
      cfg: { first_call_min: cfg.first_call_min, retry_min: cfg.retry_min, country_code: cfg.country_code, has_app_secret: !!cfg.app_secret }, counts, max_callers: MAX_CALLERS }; }));
  S.put('/leads/setup', wrap(async req => { const a = await needAdmin(req), tn = a.tenant, b = req.body, cfg = cfgOf(tn);
    const ids = b.callers === undefined ? null : [...new Set((Array.isArray(b.callers) ? b.callers : []).map(String))];
    if (ids) { if (ids.length > MAX_CALLERS) throw bad(`Pick at most ${MAX_CALLERS} tele-callers`);
      const ok = await all("SELECT id FROM users WHERE tenant_id=? AND role='provider' AND is_active=1 AND id = ANY(?::text[])", tn.id, ids);
      if (ok.length !== ids.length) throw bad('Tele-callers must be active service providers on this campus'); }
    const on = b.on === undefined ? !!tn.leads_on : !!b.on;
    if (on && !(ids ?? (await all('SELECT user_id FROM lead_callers WHERE tenant_id=?', tn.id))).length) throw bad('Pick at least one tele-caller');
    const num = (v, lo, hi, what) => { if (v === undefined || v === '') return undefined; const n = Math.round(Number(v)); if (!Number.isFinite(n) || n < lo || n > hi) throw bad(`${what}: ${lo} to ${hi} minutes`); return n; };
    const next = { ...cfg };
    const f1 = num(b.first_call_min, 5, 2880, 'First call within'), f2 = num(b.retry_min, 10, 2880, 'Try again after');
    if (f1 !== undefined) next.first_call_min = f1; if (f2 !== undefined) next.retry_min = f2;
    if (b.country_code !== undefined) { const cc = String(b.country_code).replace(/\D/g, ''); if (!/^\d{1,4}$/.test(cc)) throw bad('Country code: 1 to 4 digits, e.g. 91'); next.country_code = cc; }
    if (b.app_secret !== undefined && b.app_secret !== null) next.app_secret = str(b.app_secret, 200);
    await run('UPDATE tenants SET leads_on=?, leads_cfg=?, leads_key=coalesce(leads_key, ?) WHERE id=?', on ? 1 : 0, JSON.stringify(next), newKey(), tn.id);
    let moved = 0;
    if (ids) { const before = (await all('SELECT user_id FROM lead_callers WHERE tenant_id=?', tn.id)).map(r => r.user_id);
      await run('DELETE FROM lead_callers WHERE tenant_id=? AND NOT (user_id = ANY(?::text[]))', tn.id, ids);
      for (const id of ids) await run('INSERT INTO lead_callers (tenant_id, user_id, created_at) VALUES (?,?,?) ON CONFLICT DO NOTHING', tn.id, id, now());
      for (const gone of before.filter(x => !ids.includes(x))) moved += await moveLeadsOf(tn.id, gone, 'removed from the tele-callers'); }
    return { on, moved }; }));
  S.post('/leads/setup/key', wrap(async req => { const a = await needAdmin(req), key = newKey();
    await run('UPDATE tenants SET leads_key=? WHERE id=?', key, a.tenant.id); return { key }; }));
  // try a sample from the bot: what ONE Desk reads from it (nothing is saved)
  S.post('/leads/parse', wrap(async req => { const a = await needAdmin(req), cfg = cfgOf(a.tenant);
    let body = req.body.sample; if (typeof body === 'string') { try { body = JSON.parse(body); } catch { throw bad('That is not JSON. Paste exactly what your bot sends, starting with { or ['); } }
    const items = itemsOf(body).slice(0, 50);
    return { leads: items.map(it => { const p = normPhone(it.phone, cfg.country_code); return { ...it, phone: p, phone_text: phoneText(p), ok: !!p }; }) }; }));
  // old leads from a spreadsheet (CSV): the same reading as the bot's; the same number joins its lead; all or nothing
  S.post('/leads/import', wrap(async req => { const a = await needAdmin(req), tn = a.tenant;
    if (!tn.leads_on) throw bad('Switch Leads on first');
    const csv = String(req.body.csv || ''); if (!csv.trim()) throw bad('Choose a CSV file first'); if (csv.length > 8e6) throw bad('The file is too big (8 MB at most). Split it into parts.');
    const { head, rows } = parseCsv(csv); if (!rows.length) throw bad('The file has no rows under the headings');
    if (rows.length > MAX_IMPORT) throw bad(`At most ${MAX_IMPORT} rows at a time. Split the file into parts.`);
    const items = rows.map(r => parseItem(r)); if (!items.some(it => normPhone(it.phone, cfgOf(tn).country_code))) throw bad(`No phone numbers found. Name the column with the number "Phone" (the headings found: ${head.slice(0, 8).join(', ')}).`);
    const spread = req.body.mode !== 'pool';
    const callers = spread ? await all(`SELECT u.id, u.name, (SELECT count(*)::int FROM leads l WHERE l.tenant_id=c.tenant_id AND l.assigned_to=u.id AND l.status IN ${OPEN_SQL}) n
      FROM lead_callers c JOIN users u ON u.id=c.user_id AND u.is_active=1 AND u.role='provider' WHERE c.tenant_id=? ORDER BY u.name`, tn.id) : [];
    const out = { rows: rows.length, created: 0, merged: 0, duplicate: 0, skipped: 0, skipped_rows: [] }, actor = { id: req.user.id, name: req.user.name };
    await tx(async () => { for (let i = 0; i < items.length; i++) {
      const c = callers.length ? callers.reduce((m, x) => x.n < m.n ? x : m) : null;
      const r = await intake(tn, items[i], { source: 'import', caller: c, actor });
      if (r.result === 'created' && c) c.n++;
      if (r.result === 'skipped') { out.skipped++; if (out.skipped_rows.length < 20) out.skipped_rows.push({ row: i + 2, why: r.why }); }
      else out[r.result === 'created' ? 'created' : r.result === 'duplicate' ? 'duplicate' : 'merged']++; } });
    return out; }));
  // leads nobody has (no tele-caller when they came in, or kept in the pool): shared out now
  S.post('/leads/spread', wrap(async req => { const a = await needAdmin(req); if (!a.on) throw bad('Switch Leads on first');
    const rows = await all(`SELECT * FROM leads WHERE tenant_id=? AND assigned_to IS NULL AND status IN ${OPEN_SQL} ORDER BY created_at`, a.tenant.id); let n = 0;
    for (const l of rows) { const c = await pickCaller(a.tenant.id); if (!c) break; await run('UPDATE leads SET assigned_to=?, assigned_at=?, updated_at=? WHERE id=? AND assigned_to IS NULL', c.id, now(), now(), l.id); await event(l, 'assigned', { body: `Given to ${c.name}`, actor: req.user }); n++; }
    if (rows.length && !n) throw bad('Pick tele-callers first (Set up)');
    return { given: n }; }));

  // ---------- the lists ----------
  S.get('/leads', wrap(async req => { const a = await need(req), tn = a.tenant, q = req.query, t = now(), view = q.view === 'all' ? 'all' : 'tocall';
    const callerF = a.admin ? String(q.caller || '') : '', mineSql = a.admin ? (callerF === 'none' ? 'assigned_to IS NULL' : callerF ? 'assigned_to=?' : 'true') : '(assigned_to=? OR assigned_to IS NULL)';
    const mineArgs = a.admin ? (callerF && callerF !== 'none' ? [callerF] : []) : [req.user.id];
    if (view === 'tocall') {
      const end = localDay(tn.timezone || 'Asia/Kolkata').next;
      const rows = await all(`SELECT * FROM leads WHERE tenant_id=? AND status IN ${OPEN_SQL} AND ${mineSql} AND assigned_to IS NOT NULL AND (status='new' OR next_call_at IS NULL OR next_call_at < ?) ORDER BY created_at LIMIT 500`, tn.id, ...mineArgs, end);
      const pool_ = await all(`SELECT * FROM leads WHERE tenant_id=? AND status IN ${OPEN_SQL} AND assigned_to IS NULL ORDER BY created_at LIMIT 100`, tn.id);
      const later = await one(`SELECT count(*)::int n, min(next_call_at) next FROM leads WHERE tenant_id=? AND status IN ${OPEN_SQL} AND ${mineSql} AND assigned_to IS NOT NULL AND status<>'new' AND next_call_at >= ?`, tn.id, ...mineArgs, end);
      const names = await namesOf(rows.map(r => r.assigned_to)), list = rows.map(r => pub(r, names, t));
      const rank = l => l.late ? 0 : l.status === 'new' ? 1 : l.next_call_at <= t ? 2 : 3, when = l => l.status === 'new' ? l.due_at : l.next_call_at;
      list.sort((x, y) => rank(x) - rank(y) || String(when(x)).localeCompare(String(when(y))));
      const cut = new Date(Date.now() - 3600e3).toISOString(); // the counts cover every lead for today, not only the first 500 shown (the same rules as lateOf)
      const counts = await one(`SELECT count(*) FILTER (WHERE (status='new' AND due_at < ?) OR (status<>'new' AND next_call_at < ?))::int late, count(*) FILTER (WHERE status='new')::int new,
        count(*) FILTER (WHERE status<>'new' AND next_call_at >= ? AND next_call_at <= ?)::int due, count(*) FILTER (WHERE status<>'new' AND next_call_at > ?)::int today, count(*)::int total
        FROM leads WHERE tenant_id=? AND status IN ${OPEN_SQL} AND ${mineSql} AND assigned_to IS NOT NULL AND (status='new' OR next_call_at IS NULL OR next_call_at < ?)`, t, cut, cut, t, t, tn.id, ...mineArgs, end);
      return { view, rows: list, pool: callerF && callerF !== 'none' ? [] : pool_.map(r => pub(r, {}, t)), later: later.n, later_next: later.next, counts };
    }
    const where = [`tenant_id=?`, mineSql], args = [tn.id, ...mineArgs];
    const st = String(q.status || '');
    if (st === 'open') where.push(`status IN ${OPEN_SQL}`);
    else if (st === 'closed') where.push(`status NOT IN ${OPEN_SQL}`);
    else if (st === 'late') { where.push(`status IN ${OPEN_SQL} AND ((status='new' AND due_at < ?) OR (status<>'new' AND next_call_at < ?))`); args.push(t, new Date(Date.now() - 3600e3).toISOString()); } // the same rule as lateOf
    else if (LEAD_STATUS[st]) { where.push('status=?'); args.push(st); }
    if (SOURCES[q.source]) { where.push('source=?'); args.push(q.source); }
    const s = str(q.q, 80);
    if (/^l\s*\d{1,6}$/i.test(s)) { where.push('lead_no=?'); args.push(Number(s.replace(/\D/g, ''))); } // "L0042": that lead only
    else if (s) { const digits = s.replace(/\D/g, ''), no = /^\d{1,6}$/.test(s) ? Number(s) : null, like = `%${s.replace(/[%_\\]/g, m => '\\' + m)}%`;
      where.push(`(name ILIKE ? OR course ILIKE ? OR city ILIKE ? OR email ILIKE ?${digits.length >= 4 ? ' OR phone LIKE ?' : ''}${no ? ' OR lead_no=?' : ''})`);
      args.push(like, like, like, like, ...(digits.length >= 4 ? [`%${digits}%`] : []), ...(no ? [no] : [])); }
    if (q.from || q.to) { const r = range(tn, q); where.push('created_at >= ? AND created_at < ?'); args.push(r.start, r.end); }
    const total = (await one(`SELECT count(*)::int n FROM leads WHERE ${where.join(' AND ')}`, ...args)).n, off = Math.max(0, Math.floor(Number(q.offset) || 0));
    const rows = await all(`SELECT * FROM leads WHERE ${where.join(' AND ')} ORDER BY created_at DESC, lead_no DESC LIMIT 50 OFFSET ?`, ...args, off);
    const names = await namesOf(rows.map(r => r.assigned_to));
    return { view, total, offset: off, rows: rows.map(r => pub(r, names, t)) };
  }));
  S.get('/leads/:id', wrap(async req => { const a = await need(req), l = await leadFor(req, a);
    if (l.unread && l.assigned_to === req.user.id) { await run('UPDATE leads SET unread=0 WHERE id=?', l.id); l.unread = 0; }
    const events = await all('SELECT kind, outcome, body, actor_name, next_call_at, created_at FROM lead_events WHERE lead_id=? ORDER BY created_at, id', l.id);
    const callers = a.admin ? await all("SELECT u.id, u.name FROM lead_callers c JOIN users u ON u.id=c.user_id AND u.is_active=1 WHERE c.tenant_id=? ORDER BY u.name", req.tenantId) : [];
    return { lead: pub(l, await namesOf([l.assigned_to])), events, callers, outcomes: OUTCOMES, lost_reasons: LOST_REASONS, retry_min: cfgOf(a.tenant).retry_min,
      can: { assign: a.admin, take: !l.assigned_to && a.caller, log: a.admin || l.assigned_to === req.user.id || !l.assigned_to } }; }));
  // what happened on a call; the status and the next call follow from it
  S.post('/leads/:id/call', wrap(async req => { const a = await need(req), l = await leadFor(req, a), b = req.body, oc = String(b.outcome || ''), t = now();
    if (!OUTCOMES[oc]) throw bad('Pick what happened on the call');
    const note = str(b.note, 1000), reason = oc === 'lost' ? str(b.reason, 80) : '';
    let next = null;
    if (oc === 'no_answer') next = b.next_call_at ? isoIn(b.next_call_at, 'when to try again') : dueFrom(a.tenant, t, cfgOf(a.tenant).retry_min);
    if (oc === 'callback' || oc === 'interested') { if (!b.next_call_at) throw bad(oc === 'callback' ? 'Pick when to call back' : 'Pick when to follow up'); next = isoIn(b.next_call_at, 'the next call'); }
    const status = oc === 'no_answer' ? (['callback', 'interested'].includes(l.status) ? l.status : 'trying') : oc, closing = CLOSED.includes(status);
    const take = !l.assigned_to && !a.admin; // a tele-caller who calls a lead from the pool takes it
    await run(`UPDATE leads SET status=?, next_call_at=?, attempts=attempts+1, first_call_at=coalesce(first_call_at, ?), last_call_at=?, unread=0, updated_at=?,
      closed_at=?, closed_by=?, close_reason=?, assigned_to=coalesce(assigned_to, ?), assigned_at=coalesce(assigned_at, ?) WHERE id=?`,
      status, closing ? null : next, t, t, t, closing ? t : null, closing ? req.user.id : null, closing ? (reason || (oc === 'invalid' ? note : '') || null) : null, take ? req.user.id : null, take ? t : null, l.id);
    await event(l, 'call', { outcome: oc, body: [reason, note].filter(Boolean).join(' · ') || null, actor: req.user, next: closing ? null : next });
    const nl = await one('SELECT * FROM leads WHERE id=?', l.id); return pub(nl, await namesOf([nl.assigned_to])); }));
  S.post('/leads/:id/note', wrap(async req => { const a = await need(req), l = await leadFor(req, a), note = str(req.body.note, 1000); if (!note) throw bad('Write the note first');
    await event(l, 'note', { body: note, actor: req.user }); await run('UPDATE leads SET updated_at=? WHERE id=?', now(), l.id); return { ok: true }; }));
  // details learnt on the call (name, course, email, city)
  S.patch('/leads/:id', wrap(async req => { const a = await need(req), l = await leadFor(req, a), b = req.body, f = {};
    for (const [k, max] of [['name', 80], ['course', 120], ['email', 120], ['city', 120]]) if (b[k] !== undefined) f[k] = str(b[k], max) || null;
    if (f.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email)) throw bad('That email does not look right'); if (!Object.keys(f).length) throw bad('Nothing to change');
    await run(`UPDATE leads SET ${Object.keys(f).map(k => `${k}=?`).join(', ')}, updated_at=? WHERE id=?`, ...Object.values(f), now(), l.id);
    await event(l, 'edited', { body: Object.entries(f).map(([k, v]) => `${k[0].toUpperCase() + k.slice(1)}: ${v || '—'}`).join(' · '), actor: req.user });
    const nl = await one('SELECT * FROM leads WHERE id=?', l.id); return pub(nl, await namesOf([nl.assigned_to])); }));
  // admins give a lead to a tele-caller (or back to the pool); a tele-caller takes one from the pool
  S.post('/leads/:id/assign', wrap(async req => { const a = await need(req), l = await leadFor(req, a), to = req.body.user_id === 'me' ? req.user.id : req.body.user_id ? String(req.body.user_id) : null;
    if (!a.admin && (to !== req.user.id || l.assigned_to)) throw forbid('Only campus admins can move leads between tele-callers');
    const u = to ? await one("SELECT u.id, u.name FROM lead_callers c JOIN users u ON u.id=c.user_id AND u.is_active=1 WHERE c.tenant_id=? AND c.user_id=?", req.tenantId, to) : null;
    if (to && !u) throw bad('Pick one of the tele-callers'); if (to === l.assigned_to) return { ok: true };
    const r = await run(`UPDATE leads SET assigned_to=?, assigned_at=?, updated_at=? WHERE id=? ${a.admin ? '' : 'AND assigned_to IS NULL'}`, to, to ? now() : null, now(), l.id);
    if (!r.changes) throw new HttpErr(409, 'CONFLICT', 'Someone else took this lead just now');
    await event(l, 'assigned', { body: u ? (u.id === req.user.id && !a.admin ? `${u.name} took it` : `Given to ${u.name}`) : 'Back to the pool (nobody has it)', actor: req.user }); return { ok: true }; }));
  // a lead from a phone call or a walk-in, typed in by a tele-caller or an admin
  S.post('/leads', wrap(async req => { const a = await need(req), b = req.body;
    const it = { phone: str(b.phone, 30), name: str(b.name, 80), course: str(b.course, 120), message: str(b.message, 2000), email: str(b.email, 120).toLowerCase(), city: str(b.city, 120), extra: {} };
    if (!normPhone(it.phone, cfgOf(a.tenant).country_code)) throw bad('Enter the phone number (10 digits, or with the country code)');
    if (it.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(it.email)) throw bad('That email does not look right');
    const me = a.caller ? { id: req.user.id, name: req.user.name } : undefined;
    const r = await intake(a.tenant, it, { source: 'manual', caller: me, actor: req.user });
    return { result: r.result, lead: pub(r.lead, await namesOf([r.lead.assigned_to])) }; }));

  // ---------- reports ----------
  S.get('/leads-report', wrap(async req => { const a = await need(req), tn = a.tenant, r = range(tn, req.query), t = now();
    const mine = a.admin ? '' : ' AND assigned_to=?', mineArg = a.admin ? [] : [req.user.id];
    const L = await all(`SELECT id, status, source, course, assigned_to, created_at, first_call_at, due_at, closed_at, close_reason FROM leads WHERE tenant_id=? AND created_at>=? AND created_at<?${mine}`, tn.id, r.start, r.end, ...mineArg);
    const C = await all(`SELECT actor_id, outcome, created_at FROM lead_events WHERE tenant_id=? AND kind='call' AND created_at>=? AND created_at<?${a.admin ? '' : ' AND actor_id=?'}`, tn.id, r.start, r.end, ...mineArg);
    const O = (await all(`SELECT * FROM leads WHERE tenant_id=? AND status IN ${OPEN_SQL}${mine}`, tn.id, ...mineArg));
    const by = (arr, f) => arr.reduce((m, x) => { const k = f(x); m[k] = (m[k] || 0) + 1; return m; }, {});
    const pct = (n, d) => d ? Math.round(n / d * 100) : null;
    const fresh = L.filter(l => l.source !== 'import'), called = fresh.filter(l => l.first_call_at), mins = called.map(l => (Date.parse(l.first_call_at) - Date.parse(l.created_at)) / 6e4).sort((x, y) => x - y);
    const won = L.filter(l => l.status === 'won').length;
    const dayOf = iso => dayStr(r.tz, new Date(iso)), days = []; for (let d = r.from, i = 0; d <= r.to && i < 400; i++) { days.push(d); d = dayStr(r.tz, new Date(Date.parse(dateStart(r.tz, d)) + 36 * 3600e3)); }
    const rec = by(L, l => dayOf(l.created_at)), wonD = by(L.filter(l => l.status === 'won' && l.closed_at), l => dayOf(l.closed_at));
    const people = a.admin ? await all("SELECT u.id, u.name, (c.user_id IS NOT NULL) caller FROM users u LEFT JOIN lead_callers c ON c.user_id=u.id AND c.tenant_id=u.tenant_id WHERE u.tenant_id=? AND (c.user_id IS NOT NULL OR u.id = ANY(?::text[]))",
      tn.id, [...new Set([...L.map(l => l.assigned_to), ...C.map(c => c.actor_id), ...O.map(o => o.assigned_to)].filter(Boolean))]) : [{ id: req.user.id, name: req.user.name, caller: true }];
    const callers = people.map(p => { const mineL = L.filter(l => l.assigned_to === p.id), calls = C.filter(c => c.actor_id === p.id), w = mineL.filter(l => l.status === 'won').length;
      return { id: p.id, name: p.name, caller: !!p.caller, leads: mineL.length, calls: calls.length, reached: calls.filter(c => c.outcome !== 'no_answer').length, won: w, conv_pct: pct(w, mineL.length),
        open: O.filter(o => o.assigned_to === p.id).length, late: O.filter(o => o.assigned_to === p.id && lateOf(o, t)).length }; }).sort((x, y) => y.won - x.won || y.calls - x.calls || x.name.localeCompare(y.name));
    const courses = Object.entries(by(L, l => l.course || 'Not given')).map(([course, n]) => ({ course, leads: n, won: L.filter(l => (l.course || 'Not given') === course && l.status === 'won').length })).sort((x, y) => y.leads - x.leads).slice(0, 15);
    return { from: r.from, to: r.to, scope: a.admin ? 'campus' : 'mine',
      received: L.length, by_source: by(L, l => l.source), status: by(L, l => l.status), won, conv_pct: pct(won, L.length),
      first_call: { called: called.length, of: fresh.length, median_min: mins.length ? Math.round(mins[Math.floor((mins.length - 1) / 2)]) : null, on_time_pct: pct(called.filter(l => l.first_call_at <= l.due_at).length, called.length),
        target_min: cfgOf(tn).first_call_min, waiting: fresh.filter(l => !l.first_call_at && OPEN.includes(l.status)).length },
      calls: C.length, outcomes: by(C, c => c.outcome), open_now: O.length, late_now: O.filter(o => lateOf(o, t)).length, unassigned: a.admin ? O.filter(o => !o.assigned_to).length : 0,
      days: days.map(d => ({ day: d, received: rec[d] || 0, won: wonD[d] || 0 })), callers, courses,
      lost_reasons: Object.entries(by(L.filter(l => l.status === 'lost'), l => l.close_reason || 'No reason given')).map(([reason, n]) => ({ reason, n })).sort((x, y) => y.n - x.n) }; }));
  // every lead in the period as a spreadsheet
  S.get('/leads.csv', async (req, res, next) => { try { const a = await need(req), tn = a.tenant, r = range(tn, req.query, 90);
    const rows = await all(`SELECT * FROM leads WHERE tenant_id=? AND created_at>=? AND created_at<?${a.admin ? '' : ' AND assigned_to=?'} ORDER BY lead_no`, tn.id, r.start, r.end, ...(a.admin ? [] : [req.user.id]));
    const names = await namesOf(rows.map(x => x.assigned_to)), tz = tn.timezone || 'Asia/Kolkata';
    const q = v => { const s = String(v ?? ''); return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/^([=+\-@])/, "'$1").replace(/"/g, '""')}"` : s; };
    const ist = iso => iso ? new Date(iso).toLocaleString('en-IN', { timeZone: tz }) : '';
    const head = ['Lead', 'Received', 'Name', 'Phone', 'Course', 'City', 'Email', 'Source', 'Status', 'Tele-caller', 'Calls', 'First call', 'Last call', 'Next call', 'Closed', 'Reason', 'First message', 'Other answers'];
    const lines = rows.map(l => [leadRef(l.lead_no), ist(l.created_at), l.name, phoneText(l.phone).replace(/^\+/, ''), // "91 98765 43210": stays text in Excel, no formula guard needed l.course, l.city, l.email, SOURCES[l.source] || l.source, LEAD_STATUS[l.status], names[l.assigned_to] || '', l.attempts,
      ist(l.first_call_at), ist(l.last_call_at), ist(l.next_call_at), ist(l.closed_at), l.close_reason, l.message, Object.entries(json(l.extra)).map(([k, v]) => `${k}: ${v}`).join('; ')].map(q).join(','));
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="leads-${r.from}-to-${r.to}.csv"` }).send('﻿' + [head.join(','), ...lines].join('\r\n'));
  } catch (e) { next(e); } });
}
