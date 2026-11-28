// Mail desk (#/c/mail): the shared mailboxes (reach@, apply@, hr@ …) handled inside ONE Desk, beside the ticket desk.
// Loaded only when MAIL_ENABLED=true (server.js imports this file then, and never otherwise).
//
// Kept apart from the desk, so the desk never notices:
//  • Every mail table lives in its own Postgres schema "mail". No desk table is altered; desk tables are only referenced.
//    Rollback: MAIL_ENABLED=false (this file is not even loaded), then if wanted: DROP SCHEMA mail CASCADE.
//  • A mail is its own work item, a mail thread (MAIL-1001), handled by the mailbox's nodal officers. A desk ticket is made
//    only when an officer presses Forward to service, through the desk's own createTicket (channel "mail"), so the desk
//    flow, its status mails and its reports stay exactly as they are.
//  • Same app, login, campuses, roles and email queue. Same single process: the jobs (reading new mail, sending replies,
//    the SLA minute tick, renewing the Graph subscription, catch-up) run on timers here, from a job table in Postgres.
//  • Microsoft Graph and the AI providers are called with fetch: no new packages.
import crypto from 'node:crypto';
import { pool, one, all, run, uid, now, tx, insert } from './db.js';
import * as L from './mail-logic.js';

const SCHEMA = `
CREATE SCHEMA IF NOT EXISTS mail;
CREATE SEQUENCE IF NOT EXISTS mail.thread_ref_seq START 1001;
CREATE TABLE IF NOT EXISTS mail.settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS mail.integrations (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('ai','storage','notify','lead_sink')),
  provider TEXT NOT NULL, name TEXT NOT NULL, config TEXT NOT NULL DEFAULT '{}', secret_enc TEXT, priority INT NOT NULL DEFAULT 1, active INT NOT NULL DEFAULT 0,
  last_test_at TEXT, last_test_result TEXT, created_at TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS mail.channels (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  address TEXT NOT NULL, display_name TEXT, signature TEXT, office_hours TEXT,
  mode TEXT NOT NULL DEFAULT 'off' CHECK (mode IN ('off','shadow','live')), ack_mode TEXT NOT NULL DEFAULT 'approve' CHECK (ack_mode IN ('approve','auto')),
  default_service_id TEXT REFERENCES public.services(id) ON DELETE SET NULL, graph_sub_id TEXT, sub_expires_at TEXT, last_synced_at TEXT, last_error TEXT,
  created_at TEXT, updated_at TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS mch_addr ON mail.channels (lower(address));
CREATE TABLE IF NOT EXISTS mail.user_roles (user_id TEXT PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('admin','manager')), created_at TEXT);
-- a mailbox's officers: any number of nodal officers (all get its mail and its reminders) and of escalation officers
CREATE TABLE IF NOT EXISTS mail.mailbox_officers (channel_id TEXT NOT NULL REFERENCES mail.channels(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE, role TEXT NOT NULL CHECK (role IN ('nodal','escalation')),
  backup_user_id TEXT REFERENCES public.users(id) ON DELETE SET NULL, created_at TEXT, PRIMARY KEY (channel_id, user_id, role));
CREATE INDEX IF NOT EXISTS mbo_u ON mail.mailbox_officers (user_id);
CREATE INDEX IF NOT EXISTS mbo_b ON mail.mailbox_officers (backup_user_id);
-- the first version kept two fixed nodal officers per mailbox: moved over once
DO $$ BEGIN IF to_regclass('mail.channel_officers') IS NOT NULL THEN
  INSERT INTO mail.mailbox_officers (channel_id, user_id, role, backup_user_id, created_at)
    SELECT channel_id, user_id, CASE WHEN role='escalation' THEN 'escalation' ELSE 'nodal' END, backup_user_id, created_at FROM mail.channel_officers ON CONFLICT DO NOTHING;
  DROP TABLE mail.channel_officers; END IF; END $$;
CREATE TABLE IF NOT EXISTS mail.channel_members (channel_id TEXT NOT NULL REFERENCES mail.channels(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE, role TEXT NOT NULL DEFAULT 'replier' CHECK (role IN ('viewer','replier','hr')),
  PRIMARY KEY (channel_id, user_id));
CREATE TABLE IF NOT EXISTS mail.officer_leave (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  from_day TEXT NOT NULL, to_day TEXT NOT NULL, created_at TEXT);
CREATE TABLE IF NOT EXISTS mail.routes (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE, category TEXT NOT NULL,
  service_id TEXT NOT NULL REFERENCES public.services(id) ON DELETE CASCADE, auto_forward INT NOT NULL DEFAULT 0, created_at TEXT, UNIQUE (tenant_id, category));
CREATE TABLE IF NOT EXISTS mail.rules (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  channel_id TEXT REFERENCES mail.channels(id) ON DELETE CASCADE, match TEXT NOT NULL CHECK (match IN ('sender','domain','subject_contains','header')),
  value TEXT NOT NULL, action TEXT NOT NULL CHECK (action IN ('noise','important','auto','skip_ai')), active INT NOT NULL DEFAULT 1, created_at TEXT);
CREATE TABLE IF NOT EXISTS mail.reply_templates (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('auto_ack','status','manual')),
  tenant_id TEXT REFERENCES public.tenants(id) ON DELETE CASCADE, channel_id TEXT REFERENCES mail.channels(id) ON DELETE CASCADE,
  category TEXT, thread_status TEXT, name TEXT NOT NULL, subject TEXT, body TEXT NOT NULL, active INT NOT NULL DEFAULT 1, created_at TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS mail.sla_policies (id TEXT PRIMARY KEY, name TEXT NOT NULL, channel_id TEXT REFERENCES mail.channels(id) ON DELETE CASCADE, lane TEXT,
  first_response_mins INT NOT NULL CHECK (first_response_mins > 0), warn_at_pct INT NOT NULL DEFAULT 75, escalate_at_pct INT NOT NULL DEFAULT 100,
  second_escalate_at_pct INT, business_hours_only INT NOT NULL DEFAULT 1, pause_on_hold INT NOT NULL DEFAULT 1, active INT NOT NULL DEFAULT 1, created_at TEXT);
CREATE TABLE IF NOT EXISTS mail.threads (id TEXT PRIMARY KEY, ref_no INT NOT NULL UNIQUE DEFAULT nextval('mail.thread_ref_seq'),
  channel_id TEXT NOT NULL REFERENCES mail.channels(id) ON DELETE CASCADE, conversation_id TEXT, subject TEXT, requester_email TEXT NOT NULL, requester_name TEXT,
  lane TEXT NOT NULL DEFAULT 'review' CHECK (lane IN ('important','needs_reply','auto','noise','review')), category TEXT, summary TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','hold','closed','rejected','forwarded')), owner_user_id TEXT,
  sla_policy_id TEXT REFERENCES mail.sla_policies(id) ON DELETE SET NULL, first_response_due_at TEXT, first_responded_at TEXT,
  paused_mins INT NOT NULL DEFAULT 0, paused_since TEXT,
  sla_state TEXT CHECK (sla_state IN ('on_track','warning','escalated','escalated_2','met','breached_met')), warned_at TEXT, escalated_at TEXT, escalated_2_at TEXT,
  desk_ticket_id TEXT UNIQUE REFERENCES public.tickets(id) ON DELETE SET NULL, forwarded_service_id TEXT REFERENCES public.services(id) ON DELETE SET NULL,
  forwarded_at TEXT, forwarded_by_user_id TEXT, closed_at TEXT, created_at TEXT, updated_at TEXT);
CREATE INDEX IF NOT EXISTS mth_c ON mail.threads (channel_id, lane, status);
CREATE INDEX IF NOT EXISTS mth_sla ON mail.threads (sla_state, first_response_due_at);
CREATE INDEX IF NOT EXISTS mth_conv ON mail.threads (channel_id, conversation_id);
CREATE INDEX IF NOT EXISTS mth_req ON mail.threads (lower(requester_email));
CREATE TABLE IF NOT EXISTS mail.inbound_emails (id TEXT PRIMARY KEY, channel_id TEXT NOT NULL REFERENCES mail.channels(id) ON DELETE CASCADE,
  thread_id TEXT REFERENCES mail.threads(id) ON DELETE CASCADE, provider_message_id TEXT NOT NULL UNIQUE, internet_message_id TEXT, conversation_id TEXT,
  from_email TEXT NOT NULL, from_name TEXT, to_list TEXT NOT NULL DEFAULT '[]', cc_list TEXT NOT NULL DEFAULT '[]', subject TEXT, body_text TEXT,
  has_attachments INT NOT NULL DEFAULT 0, headers TEXT NOT NULL DEFAULT '{}', received_at TEXT NOT NULL, ai_json TEXT, ai_provider TEXT, rule_ids TEXT,
  state TEXT NOT NULL DEFAULT 'received' CHECK (state IN ('received','filtered','classified','threaded','failed')), error TEXT, created_at TEXT);
CREATE INDEX IF NOT EXISTS min_t ON mail.inbound_emails (thread_id, received_at);
CREATE TABLE IF NOT EXISTS mail.outbound_emails (id TEXT PRIMARY KEY, channel_id TEXT NOT NULL REFERENCES mail.channels(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL REFERENCES mail.threads(id) ON DELETE CASCADE, reply_to_email_id TEXT REFERENCES mail.inbound_emails(id) ON DELETE SET NULL,
  origin TEXT NOT NULL CHECK (origin IN ('ui','auto_ack','status')), template_id TEXT REFERENCES mail.reply_templates(id) ON DELETE SET NULL,
  sent_by_user_id TEXT, to_list TEXT NOT NULL, cc_list TEXT NOT NULL DEFAULT '[]', subject TEXT, body_text TEXT NOT NULL, body_html TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending_approval' CHECK (state IN ('pending_approval','queued','sending','cancelled','sent','failed')),
  send_after TEXT, approved_by_user_id TEXT, approved_at TEXT, attempts INT NOT NULL DEFAULT 0, provider_message_id TEXT, error TEXT, sent_at TEXT, created_at TEXT);
CREATE INDEX IF NOT EXISTS mout_s ON mail.outbound_emails (state, send_after);
CREATE INDEX IF NOT EXISTS mout_t ON mail.outbound_emails (thread_id);
CREATE TABLE IF NOT EXISTS mail.sla_events (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES mail.threads(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('started','warned','escalated','escalated_2','paused','resumed','met','reassigned','forwarded')),
  notified_user_ids TEXT NOT NULL DEFAULT '[]', detail TEXT NOT NULL DEFAULT '{}', at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS mse_t ON mail.sla_events (thread_id, at);
CREATE TABLE IF NOT EXISTS mail.thread_notes (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES mail.threads(id) ON DELETE CASCADE,
  author_user_id TEXT, author_name TEXT, body TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS mail.jobs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}', dedupe_key TEXT UNIQUE,
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','done','failed')), run_after TEXT NOT NULL, attempts INT NOT NULL DEFAULT 0,
  last_error TEXT, created_at TEXT, finished_at TEXT);
CREATE INDEX IF NOT EXISTS mjob_q ON mail.jobs (state, run_after);
CREATE TABLE IF NOT EXISTS mail.ai_usage (day TEXT NOT NULL, provider TEXT NOT NULL, calls INT NOT NULL DEFAULT 0, tokens_in BIGINT NOT NULL DEFAULT 0,
  tokens_out BIGINT NOT NULL DEFAULT 0, failures INT NOT NULL DEFAULT 0, PRIMARY KEY (day, provider));
CREATE TABLE IF NOT EXISTS mail.audit_log (id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, tenant_id TEXT, user_id TEXT, action TEXT NOT NULL,
  entity TEXT NOT NULL, entity_id TEXT, detail TEXT NOT NULL DEFAULT '{}', at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS mau_e ON mail.audit_log (entity, entity_id);
-- the reply clock starts when the mail arrives, and again when a closed thread is opened by a new message
ALTER TABLE mail.threads ADD COLUMN IF NOT EXISTS sla_started_at TEXT;
-- the mail number both sides quote, per campus: SMRU-0001 (the first version showed MAIL-1001)
ALTER TABLE mail.threads ADD COLUMN IF NOT EXISTS ref TEXT;
UPDATE mail.threads SET ref='MAIL-L' || ref_no WHERE ref IS NULL; -- the first version's mail: the L keeps them apart from any campus's numbers
CREATE UNIQUE INDEX IF NOT EXISTS mth_ref ON mail.threads (upper(ref));
CREATE TABLE IF NOT EXISTS mail.ref_counters (tenant_id TEXT PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE, last INT NOT NULL);
-- a reply's effects wait until it has really gone (Undo leaves the thread as it was)
ALTER TABLE mail.outbound_emails ADD COLUMN IF NOT EXISTS close_after INT NOT NULL DEFAULT 0;
ALTER TABLE mail.outbound_emails ADD COLUMN IF NOT EXISTS started_at TEXT;
`;

const DEFAULT_ACK = `Dear {{first_name}},

Thank you for writing to {{mailbox_name}}, {{campus}}. We have received your message (Ref: {{ref}}).
Our team will get back to you {{eta}}.

To add details, simply reply to this mail.
This is an automated message.

Regards,
{{mailbox_name}}`;
// Default response targets for a new mailbox (the admin changes them on the mailbox's settings)
const DEFAULT_SLA = [{ lane: null, name: 'Needs reply', first_response_mins: 450 }, { lane: 'important', name: 'Important', first_response_mins: 240 }];
const NO_SLA_LANES = ['auto', 'noise']; // auto-handled and noise mail have no human response target

export async function mail(d) {
  const { app, S, wrap, bad, notFound, HttpErr, limit, tenantRow, base, sendMail, SECRET, createTicket } = d;
  await pool.query(SCHEMA);
  if (!(await one("SELECT 1 x FROM mail.reply_templates WHERE kind='auto_ack' AND tenant_id IS NULL AND channel_id IS NULL")))
    await insert('mail.reply_templates', { id: uid(), kind: 'auto_ack', name: 'Received (default)', subject: null, body: DEFAULT_ACK, active: 1, created_at: now(), updated_at: now() });

  const env = process.env, FAST = env.MAIL_TEST_FAST === '1';
  const KEY = L.keyFrom(env.INTEGRATIONS_KEY, SECRET);
  const GRAPH = (env.GRAPH_BASE || 'https://graph.microsoft.com/v1.0').replace(/\/$/, ''), LOGIN = (env.MS_LOGIN_BASE || 'https://login.microsoftonline.com').replace(/\/$/, '');
  const notifyUrl = () => env.MAIL_NOTIFY_URL || `${base()}/api/inbound/graph`;
  const str = (v, n) => String(v ?? '').trim().slice(0, n);
  const forbid = m => new HttpErr(403, 'FORBIDDEN', m || 'Only the mailbox admins can do this');
  const getSet = async k => (await one('SELECT value FROM mail.settings WHERE key=?', k))?.value ?? null;
  const putSet = (k, v) => run('INSERT INTO mail.settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value=excluded.value', k, v);
  const audit = (req, action, entity, entity_id, detail = {}) => insert('mail.audit_log', { tenant_id: req?.tenantId || null, user_id: req?.user?.id || null, action, entity, entity_id, detail: JSON.stringify(detail), at: now() }).catch(e => console.error('mail audit', e.message));
  const json = (s, d_) => { try { return JSON.parse(s); } catch { return d_; } };
  const today = tz => new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'Asia/Kolkata' }).format(new Date());

  /* ================= Microsoft Graph (fetch, app-only token) ================= */
  // The Microsoft 365 app: entered on Mail → Settings (sealed in mail.settings), else from .env. Kept in memory (one process).
  let ms = null, clientState = '';
  async function loadMs() {
    let saved = null; try { const v = await getSet('ms365'); saved = v ? L.unseal(KEY, v) : null; } catch (e) { console.error('mail: the saved Microsoft 365 details cannot be opened (INTEGRATIONS_KEY changed?)', e.message); }
    ms = saved?.tenantId && saved?.clientId && saved?.clientSecret ? { ...saved, source: 'app' }
      : env.MS_TENANT_ID && env.MS_CLIENT_ID && env.MS_CLIENT_SECRET ? { tenantId: env.MS_TENANT_ID, clientId: env.MS_CLIENT_ID, clientSecret: env.MS_CLIENT_SECRET, source: 'env' } : null;
    clientState = env.GRAPH_CLIENT_STATE || await getSet('graph_client_state') || '';
    if (!clientState) { clientState = crypto.randomBytes(24).toString('base64url'); await putSet('graph_client_state', clientState); } // checks that a notice really came from our subscription
    // the check value or the Microsoft 365 app changed: subscriptions made with the old ones are replaced on the next round
    const sig = crypto.createHash('sha256').update(`${clientState}|${ms?.tenantId || ''}|${ms?.clientId || ''}`).digest('hex');
    if ((await getSet('subs_made_with')) !== sig) { await run("UPDATE mail.channels SET sub_expires_at=NULL"); await putSet('subs_made_with', sig); }
    tok = null;
  }
  const graphReady = () => !!ms;
  let tok = null;
  async function token() {
    if (tok && tok.exp > Date.now() + 60e3) return tok.v;
    if (!graphReady()) throw new HttpErr(503, 'GRAPH_NOT_SET', 'Microsoft 365 is not connected yet: a super admin connects it on Mail → Settings');
    const r = await fetch(`${LOGIN}/${encodeURIComponent(ms.tenantId)}/oauth2/v2.0/token`, { method: 'POST', signal: AbortSignal.timeout(20000),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: ms.clientId, client_secret: ms.clientSecret, scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw new Error(`Microsoft sign-in failed: ${j.error_description || j.error || r.status}`);
    tok = { v: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 }; return tok.v;
  }
  async function graph(method, path, body, headers = {}) {
    let auth; try { auth = await token(); } catch (e) { e.notSent = true; throw e; } // failed before anything went to Microsoft
    const r = await fetch(GRAPH + path, { method, signal: AbortSignal.timeout(30000),
      headers: { authorization: 'Bearer ' + auth, ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    if (r.status === 401) tok = null;
    const text = await r.text(), j = text ? json(text, {}) : {};
    if (!r.ok) { const e = new Error(`Microsoft 365: ${j.error?.message || r.status}`); e.status = r.status; throw e; }
    return j;
  }
  const mbox = addr => `/users/${encodeURIComponent(addr)}`;

  /* ================= who may do what ================= */
  async function access(req) {
    const u = req.user, tid = req.tenantId, extra = await one('SELECT role FROM mail.user_roles WHERE user_id=?', u.id);
    const admin = u.role === 'super_admin' || extra?.role === 'admin';
    const manager = admin || u.role === 'tenant_admin' || extra?.role === 'manager';
    const chans = tid ? await all(`SELECT c.*,
        (SELECT string_agg(DISTINCT o.role, ',') FROM mail.mailbox_officers o WHERE o.channel_id=c.id AND (o.user_id=? OR o.backup_user_id=?)) my_roles,
        (SELECT m.role FROM mail.channel_members m WHERE m.channel_id=c.id AND m.user_id=?) member
      FROM mail.channels c WHERE c.tenant_id=? ORDER BY c.address`, u.id, u.id, u.id, tid) : [];
    // officers and members see only their own mailboxes, and only once they are live (shadow = sorting is being checked)
    const visible = manager ? chans : chans.filter(c => (c.my_roles || c.member) && c.mode === 'live');
    const setup = admin || u.role === 'tenant_admin'; // mailbox settings for the campus (Microsoft and AI keys: admins only)
    return { admin, manager, setup, chans: visible, ids: visible.map(c => c.id), role: admin ? 'admin' : manager ? 'manager' : visible.length ? 'officer' : null };
  }
  const canWork = (a, ch) => a.manager || !!ch.my_roles || ['replier', 'hr'].includes(ch.member);
  // a thread the person may open; anyone else gets 404 (not 403), so mailboxes are not revealed
  async function threadFor(req, ref, { work = false } = {}) {
    const a = await access(req), r = String(ref || '').trim().slice(0, 40);
    const t = !r ? null : /^\d+$/.test(r) ? await one('SELECT * FROM mail.threads WHERE ref_no=?', Number(r)) // links in alerts sent before mail numbers
      : await one('SELECT * FROM mail.threads WHERE upper(ref)=upper(?)', r); // SMRU-0001
    const ch = t && a.chans.find(c => c.id === t.channel_id);
    if (!ch) throw notFound();
    if (work && !canWork(a, ch)) throw forbid('You can read this mailbox but not reply from it');
    return { a, t, ch };
  }
  const needSetup = async req => { const a = await access(req); if (!req.tenantId) throw bad('Pick a campus first'); if (!a.setup) throw forbid(); return a; };
  const needAdmin = async req => { const a = await access(req); if (!a.admin) throw forbid('Only a super admin can manage the AI and Microsoft keys'); return a; };
  const channelIn = async (req, id) => { const c = await one('SELECT * FROM mail.channels WHERE id=? AND tenant_id=?', id, req.tenantId); if (!c) throw notFound(); return c; };

  /* ================= officers, leave, alerts ================= */
  async function officersOf(ch) {
    const rows = await all('SELECT role, user_id, backup_user_id FROM mail.mailbox_officers WHERE channel_id=? ORDER BY created_at', ch.id);
    const o = { nodal: [], escalation: [], backups: {} }; for (const r of rows) { o[r.role].push(r.user_id); if (r.backup_user_id) o.backups[`${r.role}:${r.user_id}`] = r.backup_user_id; }
    const ids = [...new Set(rows.flatMap(r => [r.user_id, r.backup_user_id]).filter(Boolean))], day = today((await tenantRow(ch.tenant_id))?.timezone);
    o.onLeave = new Set(ids.length ? (await all('SELECT user_id FROM mail.officer_leave WHERE user_id = ANY(?::text[]) AND from_day<=? AND to_day>=?', ids, day, day)).map(r => r.user_id) : []);
    // a deactivated officer (or backup) is treated as away
    if (ids.length) for (const r of await all('SELECT id FROM users WHERE id = ANY(?::text[]) AND is_active<>1', ids)) o.onLeave.add(r.id);
    return o;
  }
  const managersOf = async tid => { const m = await all("SELECT u.id FROM mail.user_roles r JOIN users u ON u.id=r.user_id WHERE r.role='manager' AND u.tenant_id=? AND u.is_active=1", tid);
    return (m.length ? m : await all("SELECT id FROM users WHERE tenant_id=? AND role='tenant_admin' AND is_active=1", tid)).map(r => r.id); };
  async function alert(tenantId, userIds, key, subject, lines, link) {
    const to = userIds.length ? (await all('SELECT email FROM users WHERE id = ANY(?::text[]) AND is_active=1', userIds)).map(r => r.email) : [];
    if (!to.length) return;
    const html = `<div style="font-family:Arial,sans-serif;font-size:15px;color:#1f2937;max-width:560px">${lines.map(l => `<p>${L.escHtml(l)}</p>`).join('')}`
      + `${link ? `<p><a href="${L.escHtml(link)}" style="display:inline-block;background:#1E4B8F;color:#fff;padding:10px 18px;border-radius:10px;text-decoration:none">Open the mail</a></p>` : ''}<p style="color:#6b7280;font-size:13px">ONE Desk · Mail</p></div>`;
    try { await sendMail(tenantId, to, key, subject, html, lines.join('\n\n') + (link ? `\n\n${link}` : '')); } catch (e) { console.error('mail alert', e.message); }
  }
  const threadLink = t => `${base()}/#/c/mail/t/${t.ref}`;

  /* ================= SLA ================= */
  const hoursOf = ch => json(ch.office_hours || 'null', null);
  const calFor = async ch => L.calOf(await tenantRow(ch.tenant_id), hoursOf(ch));
  const policiesOf = chId => all('SELECT * FROM mail.sla_policies WHERE active=1 AND (channel_id=? OR channel_id IS NULL)', chId);
  async function slaFor(ch, lane, createdIso) {
    if (NO_SLA_LANES.includes(lane)) return { sla_policy_id: null, first_response_due_at: null, sla_state: null };
    const p = L.pickPolicy(await policiesOf(ch.id), ch.id, lane); if (!p) return { sla_policy_id: null, first_response_due_at: null, sla_state: null };
    return { sla_policy_id: p.id, first_response_due_at: L.dueAt(createdIso, p, await calFor(ch)), sla_state: 'on_track' };
  }
  const slaEvent = (thread_id, kind, notified = [], detail = {}) => insert('mail.sla_events', { id: uid(), thread_id, kind, notified_user_ids: JSON.stringify(notified), detail: JSON.stringify(detail), at: now() });
  async function slaTick() {
    const rows = await all(`SELECT t.*, c.tenant_id, c.address, c.office_hours, c.display_name FROM mail.threads t JOIN mail.channels c ON c.id=t.channel_id
      JOIN tenants n ON n.id=c.tenant_id AND n.is_active=1
      WHERE c.mode='live' AND t.status IN ('open','in_progress','hold') AND t.first_responded_at IS NULL AND t.sla_policy_id IS NOT NULL
        AND coalesce(t.sla_state,'on_track') IN ('on_track','warning','escalated') ORDER BY t.first_response_due_at LIMIT 2000`);
    const pol = new Map(), ts = now();
    for (const t of rows) { try {
      if (!pol.has(t.sla_policy_id)) pol.set(t.sla_policy_id, await one('SELECT * FROM mail.sla_policies WHERE id=?', t.sla_policy_id));
      const ch = { id: t.channel_id, tenant_id: t.tenant_id, office_hours: t.office_hours }, p = pol.get(t.sla_policy_id);
      const act = L.tick(t, p, await calFor(ch), await officersOf(ch), ts, await managersOf(t.tenant_id));
      if (act.kind === 'none') continue;
      const col = { warn: 'warned_at', escalate: 'escalated_at', escalate_2: 'escalated_2_at' }[act.kind];
      const r = await run(`UPDATE mail.threads SET sla_state=?, ${col}=?, updated_at=? WHERE id=? AND coalesce(sla_state,'on_track')=? AND first_responded_at IS NULL`, act.state, ts, ts, t.id, t.sla_state || 'on_track');
      if (!r.changes) continue; // someone replied meanwhile
      await slaEvent(t.id, { warn: 'warned', escalate: 'escalated', escalate_2: 'escalated_2' }[act.kind], act.notify, { pct: Math.round(act.pct) });
      if (act.kind !== 'warn') emit('mail.escalated', t.id, { level: act.kind === 'escalate_2' ? 2 : 1 });
      const word = { warn: 'Reply soon', escalate: 'Escalated: no reply yet', escalate_2: 'Escalated again: still no reply' }[act.kind];
      await alert(t.tenant_id, act.notify, `mail_sla_${act.kind}`, `[${t.ref}] ${word}: ${t.subject || '(no subject)'}`,
        [`${word}. ${t.ref} in ${t.address}, from ${t.requester_name || t.requester_email}, has had no reply.`,
          `It was due by ${new Date(t.first_response_due_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })}.`, `Subject: ${t.subject || '(no subject)'}`], threadLink(t));
    } catch (e) { console.error('mail sla', t.id, e.message); } }
  }
  // hold pauses the clock: the minutes on hold are added up when the thread leaves hold
  async function setStatus(t, status, ts) {
    const ch = await one('SELECT * FROM mail.channels WHERE id=?', t.channel_id), p = t.sla_policy_id && await one('SELECT * FROM mail.sla_policies WHERE id=?', t.sla_policy_id);
    const extra = {};
    if (status === 'hold' && t.status !== 'hold' && p?.pause_on_hold) { extra.paused_since = ts; await slaEvent(t.id, 'paused'); } // with pause on hold off, the clock keeps running
    if (status !== 'hold' && t.status === 'hold' && t.paused_since) {
      extra.paused_mins = (t.paused_mins || 0) + (p ? L.elapsedMins(t.paused_since, ts, p, await calFor(ch)) : 0); extra.paused_since = null; if (p) await slaEvent(t.id, 'resumed');
    }
    if (['closed', 'rejected'].includes(status)) extra.closed_at = ts;
    if (ACTIVE.includes(status)) extra.closed_at = null;
    // opened again after Close/Reject: a fresh reply target from now (the closed days are not counted, nothing escalates at once)
    if (ACTIVE.includes(status) && ['closed', 'rejected'].includes(t.status)) {
      const pol = !NO_SLA_LANES.includes(t.lane) && L.pickPolicy(await policiesOf(ch.id), ch.id, t.lane);
      Object.assign(extra, { sla_started_at: ts, first_responded_at: null, paused_mins: 0, paused_since: null, warned_at: null, escalated_at: null, escalated_2_at: null,
        sla_policy_id: pol ? pol.id : null, first_response_due_at: pol ? L.dueAt(ts, pol, await calFor(ch)) : null, sla_state: pol ? 'on_track' : null });
      if (pol) await slaEvent(t.id, 'started', [], { reopened: true });
    }
    const sets = Object.keys(extra).map(k => `${k}=?`).join(', ');
    await run(`UPDATE mail.threads SET status=?, updated_at=?${sets ? ', ' + sets : ''} WHERE id=?`, status, ts, ...Object.values(extra), t.id);
    if (status === 'closed' && t.status !== 'closed') emit('mail.closed', t.id);
  }
  const ACTIVE = L.ACTIVE_THREAD;

  /* ================= AI with fallback (any OpenAI-compatible API) ================= */
  async function usage(provider, { tin = 0, tout = 0, fail = 0 } = {}) {
    await run(`INSERT INTO mail.ai_usage (day, provider, calls, tokens_in, tokens_out, failures) VALUES (?, ?, 1, ?, ?, ?)
      ON CONFLICT (day, provider) DO UPDATE SET calls=mail.ai_usage.calls+1, tokens_in=mail.ai_usage.tokens_in+excluded.tokens_in, tokens_out=mail.ai_usage.tokens_out+excluded.tokens_out, failures=mail.ai_usage.failures+excluded.failures`,
      now().slice(0, 10), provider, tin, tout, fail);
  }
  async function askAi(row, subject, text) {
    const cfg = json(row.config, {}), sec = L.unseal(KEY, row.secret_enc);
    if (!cfg.baseURL || !cfg.model || !sec.apiKey) throw new Error('Not set up: address, model and key are needed');
    const r = await fetch(String(cfg.baseURL).replace(/\/$/, '') + '/chat/completions', { method: 'POST', signal: AbortSignal.timeout(20000),
      headers: { authorization: 'Bearer ' + sec.apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ model: cfg.model, ...(cfg.reasoningEffort ? { reasoning_effort: cfg.reasoningEffort } : {}), ...(cfg.noTemperature ? {} : { temperature: 0 }),
        max_completion_tokens: 300, response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: L.MAIL_SYSTEM }, { role: 'user', content: `<mail>\nSubject: ${L.maskPII(subject)}\n${L.maskPII(text).slice(0, 1500)}\n</mail>` }] }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error?.message || `HTTP ${r.status}`);
    const reading = L.parseReading(j.choices?.[0]?.message?.content);
    if (!reading) throw new Error('The answer was not in the expected shape');
    return { reading, tin: j.usage?.prompt_tokens || 0, tout: j.usage?.completion_tokens || 0 };
  }
  async function readMail(subject, text) {
    for (const row of await all("SELECT * FROM mail.integrations WHERE kind='ai' AND active=1 ORDER BY priority, created_at")) {
      try { const o = await askAi(row, subject, text); await usage(row.name, o); return { reading: o.reading, provider: row.name }; }
      catch (e) { console.warn(`mail ai: ${row.name} failed, trying the next one:`, e.message); await usage(row.name, { fail: 1 }).catch(() => {}); }
    }
    return null; // every provider failed or none is set up: the rules decide, else Review
  }

  /* ================= reading new mail ================= */
  const SELECT = '$select=id,internetMessageId,conversationId,from,sender,toRecipients,ccRecipients,subject,body,receivedDateTime,hasAttachments,internetMessageHeaders';
  async function ingest(ch, messageId) {
    if (await one('SELECT 1 x FROM mail.inbound_emails WHERE provider_message_id=?', messageId)) return 'duplicate';
    const m = await graph('GET', `${mbox(ch.address)}/messages/${encodeURIComponent(messageId)}?${SELECT}`, null, { Prefer: 'outlook.body-content-type="text"' });
    const from = m.from?.emailAddress || m.sender?.emailAddress || {}, fromEmail = String(from.address || '').toLowerCase();
    if (!L.isEmail(fromEmail) || fromEmail === ch.address.toLowerCase()) return 'skipped'; // our own copy, or no sender
    const headers = Object.fromEntries((m.internetMessageHeaders || []).map(h => [h.name, h.value]));
    const text = L.cleanText(m.body?.content), subject = str(m.subject, 998), ts = now();
    const rules = L.applyRules(await all('SELECT * FROM mail.rules WHERE tenant_id=? AND (channel_id=? OR channel_id IS NULL)', ch.tenant_id, ch.id), { from_email: fromEmail, subject, headers });
    const ai = rules.skipAi ? null : await readMail(subject, text);
    const lane = rules.lane || L.laneFrom(ai?.reading);
    const refs = L.refsIn(subject, (await tenantRow(ch.tenant_id))?.code); // mail numbers of this campus quoted by the sender
    const res = await tx(async () => {
      await one('SELECT pg_advisory_xact_lock(hashtext(?)) x', `mail|${ch.id}|${m.conversationId || messageId}`); // two mails of one conversation at once still make one thread
      if (await one('SELECT 1 x FROM mail.inbound_emails WHERE provider_message_id=?', messageId)) return { dup: true };
      let t = (m.conversationId && await one('SELECT * FROM mail.threads WHERE channel_id=? AND conversation_id=? ORDER BY created_at DESC LIMIT 1', ch.id, m.conversationId))
        // a quoted number joins that mail only for someone already in it (anyone else quoting it starts their own)
        || (refs.length ? await one(`SELECT t.* FROM mail.threads t WHERE t.channel_id=? AND upper(t.ref) = ANY(?::text[]) AND (lower(t.requester_email)=?
             OR EXISTS (SELECT 1 FROM mail.inbound_emails i WHERE i.thread_id=t.id AND lower(i.from_email)=?)) ORDER BY t.created_at DESC LIMIT 1`, ch.id, refs, fromEmail, fromEmail) : null);
      let fresh = false;
      if (!t) {
        fresh = true;
        // the next number of the campus; one already taken (two campus codes that read the same, e.g. "SM-RU" and "SMRU") is skipped
        const tn = await tenantRow(ch.tenant_id); let ref = null;
        for (let i = 0; i < 50 && !ref; i++) { const n = await one(`INSERT INTO mail.ref_counters (tenant_id, last) VALUES (?, 1)
            ON CONFLICT (tenant_id) DO UPDATE SET last=mail.ref_counters.last+1 RETURNING last`, ch.tenant_id);
          const cand = L.refOf(tn.code, n.last); if (!(await one('SELECT 1 x FROM mail.threads WHERE upper(ref)=?', cand))) ref = cand; }
        if (!ref) throw new Error('No free mail number');
        t = await insert('mail.threads', { id: uid(), ref, channel_id: ch.id, conversation_id: m.conversationId || null, subject, requester_email: fromEmail, requester_name: str(from.name, 255) || null,
          lane, category: ai?.reading.category || null, summary: ai?.reading.summary || null, status: 'open', ...(await slaFor(ch, lane, ts)), created_at: ts, updated_at: ts });
        if (t.sla_policy_id) await slaEvent(t.id, 'started');
      } else if (['closed', 'rejected'].includes(t.status)) { // the sender wrote back: the thread opens again
        await setStatus(t, 'open', ts);
      } else await run('UPDATE mail.threads SET updated_at=? WHERE id=?', ts, t.id);
      const inb = await insert('mail.inbound_emails', { id: uid(), channel_id: ch.id, thread_id: t.id, provider_message_id: messageId, internet_message_id: m.internetMessageId || null,
        conversation_id: m.conversationId || null, from_email: fromEmail, from_name: str(from.name, 255) || null,
        to_list: JSON.stringify((m.toRecipients || []).map(r => r.emailAddress?.address).filter(Boolean)), cc_list: JSON.stringify((m.ccRecipients || []).map(r => r.emailAddress?.address).filter(Boolean)),
        subject, body_text: text, has_attachments: m.hasAttachments ? 1 : 0, headers: JSON.stringify(headers), received_at: m.receivedDateTime || ts,
        ai_json: ai ? JSON.stringify(ai.reading) : null, ai_provider: ai?.provider || null, rule_ids: JSON.stringify(rules.matched), state: 'threaded', created_at: ts });
      if (t.status === 'forwarded') await insert('mail.thread_notes', { id: uid(), thread_id: t.id, author_name: 'ONE Desk', body: 'The sender wrote again after this mail was forwarded. Their new message is below; the desk ticket is not changed.', created_at: ts });
      return { t: await one('SELECT * FROM mail.threads WHERE id=?', t.id), inb, fresh };
    });
    if (res.dup) return 'duplicate';
    if (ch.mode === 'live') {
      if (res.fresh) await draftAck(ch, res.t, res.inb, ai?.reading).catch(e => console.error('mail ack', e.message));
      if (res.fresh) emit('mail.received', res.t.id);
      graph('PATCH', `${mbox(ch.address)}/messages/${encodeURIComponent(messageId)}`, { categories: ['ONE ✓'] }).catch(e => console.warn('mail tag', e.message)); // seen in Outlook as handled by ONE Desk
      if (res.fresh && lane === 'important') await alert(ch.tenant_id, L.queueFor(await officersOf(ch)), 'mail_important', `[${res.t.ref}] Important mail: ${subject || '(no subject)'}`,
        [`An important mail reached ${ch.address} from ${res.t.requester_name || fromEmail}.`, ai?.reading.summary || subject].filter(Boolean), threadLink(res.t));
    }
    return res.fresh ? 'new' : 'appended';
  }
  async function draftAck(ch, t, inb, reading) {
    const tn = await tenantRow(ch.tenant_id), headers = json(inb.headers, {});
    const acks = await one(`SELECT count(*)::int n FROM mail.outbound_emails o JOIN mail.threads x ON x.id=o.thread_id WHERE o.origin='auto_ack' AND o.state<>'cancelled'
      AND lower(x.requester_email)=? AND o.created_at>?`, t.requester_email, new Date(Date.now() - 864e5).toISOString());
    const why = L.blockReason({ from_email: t.requester_email, headers, lane: t.lane, mode: ch.mode, killSwitch: (await getSet('auto_reply_paused')) === '1',
      ackedThisThread: !!(await one("SELECT 1 x FROM mail.outbound_emails WHERE thread_id=? AND origin='auto_ack'", t.id)), acksToSenderLast24h: acks.n });
    if (why) return null;
    const tpl = L.pickTemplate(await all("SELECT * FROM mail.reply_templates WHERE kind='auto_ack' AND active=1 AND (tenant_id=? OR tenant_id IS NULL) AND (channel_id=? OR channel_id IS NULL)", tn.id, ch.id),
      { kind: 'auto_ack', tenantId: tn.id, channelId: ch.id, category: t.category });
    if (!tpl) return null;
    const p = t.sla_policy_id && await one('SELECT first_response_mins m FROM mail.sla_policies WHERE id=?', t.sla_policy_id);
    const name = t.requester_name || reading?.name || '', vars = { first_name: (name.split(/\s+/)[0] || 'Sir/Madam'), name: name || 'Sir/Madam', ref: t.ref, campus: tn.name,
      team: ch.display_name || ch.address, mailbox_name: ch.display_name || ch.address, eta: L.eta(now(), await calFor(ch), p?.m || 450), post: reading?.post || '', subject: t.subject || '', status: 'received' };
    const body = L.render(tpl.body, vars);
    return insert('mail.outbound_emails', { id: uid(), channel_id: ch.id, thread_id: t.id, reply_to_email_id: inb.id, origin: 'auto_ack', template_id: tpl.id, to_list: JSON.stringify([t.requester_email]),
      subject: tpl.subject ? L.render(tpl.subject, vars) : null, body_text: body, body_html: L.textToHtml(body), ...L.initialOutbound(ch.ack_mode, now()), created_at: now() });
  }

  /* ================= sending replies (after the undo window) ================= */
  // what a reply does to its thread once it has really gone: the first reply stops the clock; "Send and close" closes it
  async function afterSent(o) {
    const t = await one('SELECT * FROM mail.threads WHERE id=?', o.thread_id); if (!t) return;
    const ts = now();
    if (o.origin === 'ui' && !t.first_responded_at) {
      const f = L.onFirstResponse(t, ts);
      const r = await run('UPDATE mail.threads SET first_responded_at=?, sla_state=CASE WHEN sla_state IS NULL THEN NULL ELSE ? END, updated_at=? WHERE id=? AND first_responded_at IS NULL', ts, f.sla_state, ts, t.id);
      if (r.changes && t.sla_policy_id) await slaEvent(t.id, 'met', [], { late: f.sla_state === 'breached_met' });
    }
    if (o.origin === 'ui') emit('mail.replied', t.id, { to: json(o.to_list, [])[0] || '' });
    if (o.close_after && ACTIVE.includes(t.status)) await setStatus(t, 'closed', ts);
  }
  const note = (thread_id, body) => insert('mail.thread_notes', { id: uid(), thread_id, author_name: 'ONE Desk', body, created_at: now() });
  let sending = false;
  async function sendDue() {
    if (sending) return; sending = true;
    try {
      const due = await tx(async () => {
        const rows = await all(`SELECT o.* FROM mail.outbound_emails o JOIN mail.channels c ON c.id=o.channel_id
          WHERE o.state='queued' AND o.send_after<=? AND c.mode='live' ORDER BY o.send_after LIMIT 10 FOR UPDATE OF o SKIP LOCKED`, now());
        if (rows.length) await run("UPDATE mail.outbound_emails SET state='sending', started_at=? WHERE id = ANY(?::text[])", now(), rows.map(r => r.id));
        return rows;
      });
      for (const o of due) {
        const ch = await one('SELECT * FROM mail.channels WHERE id=?', o.channel_id);
        try {
          const to = json(o.to_list, []).map(a => ({ emailAddress: { address: a } })), cc = json(o.cc_list, []).map(a => ({ emailAddress: { address: a } }));
          // an auto-reply says so, so other auto-responders do not answer it (Graph allows only X- headers)
          const auto = o.origin === 'auto_ack' ? { internetMessageHeaders: [{ name: 'X-Auto-Response-Suppress', value: 'All' }] } : {};
          const inb = o.reply_to_email_id && await one('SELECT provider_message_id FROM mail.inbound_emails WHERE id=?', o.reply_to_email_id);
          const t = await one('SELECT ref, subject FROM mail.threads WHERE id=?', o.thread_id);
          // the mail number in front of the subject, so the sender and the officers quote the same number: "RE: [SMRU-0001] Fees"
          const subject = o.subject ? L.subjectWith(t.ref, o.subject) : L.subjectWith(t.ref, t.subject, true);
          // the last step (send, or sendMail) is the one that delivers: if it fails without a clear "refused", the mail may have gone.
          // Earlier steps (making and filling the draft) never send anything, so they are simply tried again.
          const finalStep = fn => fn().catch(e => { if (!e.notSent && !(e.status >= 400 && e.status < 500)) e.unsure = true; throw e; });
          const fresh = () => finalStep(() => graph('POST', `${mbox(ch.address)}/sendMail`, { message: { subject, toRecipients: to, ccRecipients: cc, body: { contentType: 'HTML', content: o.body_html }, ...auto }, saveToSentItems: true }));
          if (inb) {
            // a reply in the same conversation (Outlook keeps it threaded), with our subject: draft → our text above the quoted mail → send
            let draft = null;
            const mk = msg => graph('POST', `${mbox(ch.address)}/messages/${encodeURIComponent(inb.provider_message_id)}/createReply`, { message: msg });
            try {
              try { draft = await mk({ toRecipients: to, ccRecipients: cc, ...auto }); }
              catch (e) { if (e.status !== 400 || !auto.internetMessageHeaders) throw e; draft = await mk({ toRecipients: to, ccRecipients: cc }); } // headers refused here: send without them
              const quoted = String(draft.body?.content || ''), content = /<body[^>]*>/i.test(quoted) ? quoted.replace(/<body[^>]*>/i, m => m + o.body_html + '<br>') : o.body_html + (quoted ? '<br>' + quoted : '');
              await graph('PATCH', `${mbox(ch.address)}/messages/${encodeURIComponent(draft.id)}`, { subject, toRecipients: to, ccRecipients: cc, body: { contentType: 'HTML', content } });
              await finalStep(() => graph('POST', `${mbox(ch.address)}/messages/${encodeURIComponent(draft.id)}/send`));
            } catch (e) {
              // never leave a draft quoting their mail in Outlook (if it was sent after all, it is in Sent Items and this finds nothing)
              if (draft?.id) await graph('DELETE', `${mbox(ch.address)}/messages/${encodeURIComponent(draft.id)}`).catch(() => {});
              if (e.status !== 404 || draft) throw e;
              await fresh(); // the mail was moved or deleted in Outlook: send it as a new mail instead
            }
          } else await fresh();
          await run("UPDATE mail.outbound_emails SET state='sent', sent_at=?, attempts=attempts+1, error=NULL WHERE id=?", now(), o.id);
          await afterSent(o);
        } catch (e) {
          // a timeout may have been delivered all the same: never retried (no duplicate mail); the officer checks Outlook's Sent Items
          const unsure = !!e.unsure; // only the delivering step, failing without a clear refusal (timeout, cut connection, 5xx)
          const final = unsure || o.attempts + 1 >= 4 || (e.status >= 400 && e.status < 500 && ![401, 408, 429].includes(e.status));
          const msg = unsure ? 'Microsoft 365 did not confirm it: it may or may not have gone. Check Sent Items in Outlook before sending again.' : String(e.message);
          await run(`UPDATE mail.outbound_emails SET state=?, attempts=attempts+1, error=?, send_after=? WHERE id=?`, final ? 'failed' : 'queued', msg.slice(0, 500),
            new Date(Date.now() + 60e3 * 2 ** o.attempts).toISOString(), o.id);
          if (final) await note(o.thread_id, `A ${o.origin === 'auto_ack' ? 'received-reply' : 'reply'} was not sent: ${msg.slice(0, 300)}`);
          console.error('mail send', o.id, e.message);
        }
      }
    } catch (e) { console.error('mail send loop', e.message); } finally { sending = false; }
  }
  // after a restart: a job left "running" runs again; a reply left "sending" may have gone, so it is reported, never sent twice
  async function recover(olderThanMs) {
    const cut = new Date(Date.now() - olderThanMs).toISOString();
    await run("UPDATE mail.jobs SET state='queued', run_after=? WHERE state='running' AND coalesce(run_after, created_at)<=?", now(), cut);
    for (const o of await all("SELECT id, thread_id FROM mail.outbound_emails WHERE state='sending' AND coalesce(started_at, created_at)<=?", cut)) {
      const r = await run("UPDATE mail.outbound_emails SET state='failed', error=? WHERE id=? AND state='sending'", 'The server restarted while this was being sent: it may or may not have gone. Check Sent Items in Outlook before sending again.', o.id);
      if (r.changes) await note(o.thread_id, 'A reply may not have been sent (the server restarted while sending). Check Sent Items in Outlook.');
    }
  }

  /* ================= jobs (in this process, from Postgres) ================= */
  const enqueue = (kind, payload, dedupe_key = null, delayMs = 0) => run(`INSERT INTO mail.jobs (id, kind, payload, dedupe_key, run_after, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (dedupe_key) DO NOTHING`,
    uid(), kind, JSON.stringify(payload), dedupe_key, new Date(Date.now() + delayMs).toISOString(), now());
  async function catchup(ch) { // anything a missed notification left behind (a restart, a network blip): read the inbox since the last sync
    const since = ch.last_synced_at || new Date(Date.now() - 864e5).toISOString(), started = now();
    let url = `${mbox(ch.address)}/mailFolders/inbox/messages?$select=id,receivedDateTime&$orderby=receivedDateTime asc&$top=50&$filter=${encodeURIComponent(`receivedDateTime ge ${since}`)}`;
    let last = null;
    for (let page = 0; url && page < 20; page++) {
      const r = await graph('GET', url);
      for (const m of r.value || []) { last = m.receivedDateTime || last;
        if (!(await one('SELECT 1 x FROM mail.inbound_emails WHERE provider_message_id=?', m.id))) await enqueue('ingest', { channel_id: ch.id, message_id: m.id }, `ingest:${m.id}`); }
      url = r['@odata.nextLink'] ? r['@odata.nextLink'].replace(GRAPH, '') : null;
    }
    // more than 1000 waiting: carry on from the last one read in the next round (nothing is skipped); otherwise up to now, with a little overlap
    const upTo = url && last ? last : new Date(Date.parse(started) - 5 * 60e3).toISOString();
    await run('UPDATE mail.channels SET last_synced_at=?, last_error=NULL WHERE id=?', upTo, ch.id);
    if (url && last) await run("UPDATE mail.jobs SET dedupe_key=NULL WHERE dedupe_key=?", `catchup:${ch.id}`).then(() => enqueue('catchup', { channel_id: ch.id }, `catchup:${ch.id}:more`, 1000));
  }
  async function runJob(j) {
    if (j.kind === 'plugin') return deliver(json(j.payload, {}));
    const p = json(j.payload, {}), ch = p.channel_id && await one('SELECT * FROM mail.channels WHERE id=?', p.channel_id);
    if (!ch || ch.mode === 'off') return;
    if (!(await tenantRow(ch.tenant_id))?.is_active) return; // a campus switched off: its mailboxes rest too
    if (j.kind === 'ingest') return ingest(ch, p.message_id);
    if (j.kind === 'catchup') return catchup(ch);
  }
  let busy = false;
  async function work() {
    if (busy) return; busy = true;
    try {
      for (let i = 0; i < 20; i++) {
        const j = await tx(async () => { const r = await one("SELECT * FROM mail.jobs WHERE state='queued' AND run_after<=? ORDER BY run_after LIMIT 1 FOR UPDATE SKIP LOCKED", now());
          if (r) await run("UPDATE mail.jobs SET state='running', attempts=attempts+1, run_after=? WHERE id=?", now(), r.id); return r; });
        if (!j) break;
        try { await runJob(j); await run("UPDATE mail.jobs SET state='done', finished_at=?, dedupe_key=NULL WHERE id=?", now(), j.id); }
        catch (e) { const final = j.attempts + 1 >= 5;
          await run('UPDATE mail.jobs SET state=?, last_error=?, run_after=?, finished_at=?, dedupe_key=? WHERE id=?', final ? 'failed' : 'queued', String(e.message).slice(0, 500),
            new Date(Date.now() + 30e3 * 2 ** j.attempts).toISOString(), final ? now() : null, final ? null : j.dedupe_key, j.id);
          if (j.kind === 'catchup' || final) await run('UPDATE mail.channels SET last_error=? WHERE id=?', String(e.message).slice(0, 300), json(j.payload, {}).channel_id);
          console.error('mail job', j.kind, e.message); }
      }
    } catch (e) { console.error('mail worker', e.message); } finally { busy = false; }
  }
  // Graph subscription per mailbox in shadow or live mode: made when switched on, renewed a day before it runs out
  const subbing = new Set(); // one subscription change per mailbox at a time (switching on and the background round could both make one)
  async function subscribe(ch) {
    if (!graphReady() || subbing.has(ch.id)) return;
    subbing.add(ch.id); try { await subscribeNow(await one('SELECT * FROM mail.channels WHERE id=?', ch.id) || ch); } finally { subbing.delete(ch.id); }
  }
  async function subscribeNow(ch) {
    const exp = new Date(Date.now() + 2.5 * 864e5).toISOString();
    try {
      if (ch.graph_sub_id) { try { await graph('PATCH', `/subscriptions/${encodeURIComponent(ch.graph_sub_id)}`, { expirationDateTime: exp });
        return run('UPDATE mail.channels SET sub_expires_at=?, last_error=NULL WHERE id=?', exp, ch.id); } catch (e) { console.warn('mail renew failed, making a new subscription', ch.address, e.message);
          await graph('DELETE', `/subscriptions/${encodeURIComponent(ch.graph_sub_id)}`).catch(() => {}); } }
      const s = await graph('POST', '/subscriptions', { changeType: 'created', notificationUrl: notifyUrl(), resource: `users/${ch.address}/mailFolders('inbox')/messages`,
        expirationDateTime: exp, clientState });
      await run('UPDATE mail.channels SET graph_sub_id=?, sub_expires_at=?, last_error=NULL WHERE id=?', s.id, s.expirationDateTime || exp, ch.id);
    } catch (e) { await run('UPDATE mail.channels SET last_error=? WHERE id=?', String(e.message).slice(0, 300), ch.id); console.error('mail subscribe', ch.address, e.message); }
  }
  async function unsubscribe(ch) {
    if (ch.graph_sub_id && graphReady()) await graph('DELETE', `/subscriptions/${encodeURIComponent(ch.graph_sub_id)}`).catch(e => console.warn('mail unsubscribe', e.message));
    await run('UPDATE mail.channels SET graph_sub_id=NULL, sub_expires_at=NULL WHERE id=?', ch.id);
  }
  async function housekeeping() {
    try {
      await recover(15 * 60e3);
      for (const ch of await all("SELECT c.* FROM mail.channels c JOIN tenants n ON n.id=c.tenant_id AND n.is_active=1 WHERE c.mode IN ('shadow','live')")) {
        if (!ch.sub_expires_at || Date.parse(ch.sub_expires_at) < Date.now() + 864e5) await subscribe(ch);
        if (graphReady()) await enqueue('catchup', { channel_id: ch.id }, `catchup:${ch.id}`);
      }
      await run("DELETE FROM mail.jobs WHERE state='done' AND finished_at<?", new Date(Date.now() - 7 * 864e5).toISOString());
    } catch (e) { console.error('mail housekeeping', e.message); }
  }
  const T = FAST ? { work: 300, sla: 1000, house: 3000 } : { work: 2000, sla: 60e3, house: 5 * 60e3 };
  const safe = fn => () => Promise.resolve().then(fn).catch(e => console.error('mail timer', e.message)); // a slip here never stops the server
  setInterval(safe(work), T.work).unref(); setInterval(safe(sendDue), FAST ? 300 : 2000).unref(); // replies never wait behind a long batch of new mail
  setInterval(() => slaTick().catch(e => console.error('mail sla tick', e.message)), T.sla).unref();
  setInterval(safe(housekeeping), T.house).unref(); setTimeout(safe(housekeeping), FAST ? 500 : 15e3).unref();

  /* ================= Graph notifications (no sign-in: checked by clientState) ================= */
  app.post('/api/inbound/graph', async (req, res) => {
    if (req.query.validationToken) return res.type('text/plain').send(String(req.query.validationToken)); // Graph checks the address when subscribing
    res.status(202).end(); // answer at once; the work happens in the job loop
    try {
      for (const n of Array.isArray(req.body?.value) ? req.body.value.slice(0, 200) : []) {
        if (!clientState || clientState !== (n.clientState || '')) { console.warn('mail webhook: clientState does not match, ignored'); continue; }
        const ch = await one("SELECT id FROM mail.channels WHERE graph_sub_id=? AND mode IN ('shadow','live')", String(n.subscriptionId || ''));
        const mid = n.resourceData?.id || /messages\/([^/]+)$/i.exec(n.resource || '')?.[1];
        if (ch && mid) await enqueue('ingest', { channel_id: ch.id, message_id: mid }, `ingest:${mid}`);
      }
      setImmediate(work);
    } catch (e) { console.error('mail webhook', e.message); }
  });

  /* ================= API: what I see ================= */
  S.get('/maildesk/me', wrap(async req => {
    const a = await access(req); if (!a.role) return { role: null };
    const ids = a.ids, mine = ids.length ? await one(`SELECT count(*)::int n FROM mail.threads WHERE channel_id = ANY(?::text[]) AND status IN ('open','in_progress','hold') AND lane<>'noise'`, ids) : { n: 0 };
    const confirm = ids.length ? await one("SELECT count(*)::int n FROM mail.outbound_emails WHERE channel_id = ANY(?::text[]) AND state='pending_approval'", ids) : { n: 0 };
    return { role: a.role, setup: a.setup, admin: a.admin, open: mine.n, confirm: confirm.n,
      channels: a.chans.map(c => ({ id: c.id, address: c.address, display_name: c.display_name, mode: c.mode, my_roles: c.my_roles ? c.my_roles.split(',') : [], member: c.member || null })) };
  }));
  const LIST = `SELECT t.*, c.address, c.display_name, c.mode,
      (SELECT o.role FROM mail.mailbox_officers o WHERE o.channel_id=t.channel_id AND (o.user_id=? OR o.backup_user_id=?) ORDER BY o.role DESC LIMIT 1) my_role,
      (SELECT body_text FROM mail.inbound_emails i WHERE i.thread_id=t.id ORDER BY received_at DESC LIMIT 1) last_text,
      (SELECT count(*)::int FROM mail.inbound_emails i WHERE i.thread_id=t.id) n_in
    FROM mail.threads t JOIN mail.channels c ON c.id=t.channel_id`;
  // one dashboard: the mail work of a nodal or escalation officer, in the desk's row shape (the desk dashboard merges it)
  S.get('/maildesk/my-work', wrap(async req => {
    const a = await access(req), mine = [];
    // on my Home: mailboxes where I am an available officer, or where I am covering for one on leave (a backup who is not covering only reads)
    for (const c of a.chans.filter(c => c.my_roles && c.mode === 'live')) { const o = await officersOf(c); if ([...L.queueFor(o), ...L.escalationFor(o)].includes(req.user.id)) mine.push(c.id); }
    if (!mine.length) return [];
    const rows = await all(`${LIST} WHERE t.channel_id = ANY(?::text[]) AND t.status IN ('open','in_progress','hold') AND t.lane NOT IN ('noise','auto') ORDER BY t.updated_at DESC LIMIT 300`, req.user.id, req.user.id, mine);
    return rows.map(L.toWorkItem).filter(Boolean);
  }));
  S.get('/maildesk/threads', wrap(async req => {
    const a = await access(req), q = req.query, where = ['t.channel_id = ANY(?::text[])'], args = [req.user.id, req.user.id];
    let ids = a.ids; if (q.channel) ids = ids.filter(x => x === q.channel);
    if (!ids.length) return { threads: [], counts: {} };
    args.push(ids);
    const status = String(q.status || 'active');
    if (status === 'active') where.push("t.status IN ('open','in_progress','hold')"); else if (L.THREAD_STATUSES.includes(status)) { where.push('t.status=?'); args.push(status); }
    if (L.LANES.includes(q.lane)) { where.push('t.lane=?'); args.push(q.lane); }
    if (q.mine === '1') { where.push('t.owner_user_id=?'); args.push(req.user.id); }
    if (q.q) { const s = `%${String(q.q).toLowerCase().slice(0, 100)}%`; where.push("(lower(coalesce(t.subject,'')) LIKE ? OR lower(t.requester_email) LIKE ? OR lower(coalesce(t.requester_name,'')) LIKE ? OR lower(t.ref) LIKE ?)"); args.push(s, s, s, s); }
    const rows = await all(`${LIST} WHERE ${where.join(' AND ')} ORDER BY CASE t.sla_state WHEN 'escalated_2' THEN 0 WHEN 'escalated' THEN 1 WHEN 'warning' THEN 2 ELSE 3 END,
      coalesce(t.first_response_due_at, '9'), t.updated_at DESC LIMIT 200`, ...args);
    const counts = Object.fromEntries((await all("SELECT lane, count(*)::int n FROM mail.threads WHERE channel_id = ANY(?::text[]) AND status IN ('open','in_progress','hold') GROUP BY lane", ids)).map(r => [r.lane, r.n]));
    return { threads: rows.map(({ last_text, ...t }) => ({ ...t, preview: String(last_text || '').slice(0, 160) })), counts };
  }));
  S.get('/maildesk/threads/:ref', wrap(async req => {
    const { a, t, ch } = await threadFor(req, req.params.ref);
    const inbound = await all('SELECT id, from_email, from_name, to_list, cc_list, subject, body_text, has_attachments, received_at, ai_json, ai_provider FROM mail.inbound_emails WHERE thread_id=? ORDER BY received_at', t.id);
    const outbound = await all(`SELECT o.id, o.origin, o.state, o.to_list, o.cc_list, o.subject, o.body_text, o.send_after, o.sent_at, o.created_at, o.error, u.name sent_by
      FROM mail.outbound_emails o LEFT JOIN users u ON u.id=coalesce(o.sent_by_user_id, o.approved_by_user_id) WHERE o.thread_id=? ORDER BY o.created_at`, t.id);
    const notes = await all('SELECT n.id, n.body, n.created_at, coalesce(u.name, n.author_name) author FROM mail.thread_notes n LEFT JOIN users u ON u.id=n.author_user_id WHERE n.thread_id=? ORDER BY n.created_at', t.id);
    const events = await all('SELECT kind, at, detail FROM mail.sla_events WHERE thread_id=? ORDER BY at', t.id);
    const owner = t.owner_user_id && await one('SELECT name FROM users WHERE id=?', t.owner_user_id);
    const desk = t.desk_ticket_id ? await one(`SELECT t.id, t.ticket_no, t.status, t.updated_at, s.name service FROM tickets t JOIN services s ON s.id=t.service_id WHERE t.id=?`, t.desk_ticket_id) : null;
    const route = t.category && await one('SELECT r.service_id, s.name FROM mail.routes r JOIN services s ON s.id=r.service_id WHERE r.tenant_id=? AND lower(r.category)=lower(?)', ch.tenant_id, t.category);
    const templates = await all("SELECT id, name, body FROM mail.reply_templates WHERE kind='manual' AND active=1 AND (tenant_id=? OR tenant_id IS NULL) AND (channel_id=? OR channel_id IS NULL) ORDER BY name", ch.tenant_id, ch.id);
    const others = await all(`SELECT ref, subject, status, created_at FROM mail.threads WHERE lower(requester_email)=lower(?) AND id<>? AND channel_id = ANY(?::text[]) ORDER BY created_at DESC LIMIT 5`, t.requester_email, t.id, a.ids);
    audit(req, 'view', 'thread', t.id);
    return { thread: { ...t, owner: owner?.name || null }, channel: { id: ch.id, address: ch.address, display_name: ch.display_name, mode: ch.mode, signature: ch.signature, default_service_id: ch.default_service_id },
      messages: [...inbound.map(m => ({ dir: 'in', ...m, to_list: json(m.to_list, []), cc_list: json(m.cc_list, []), ai: json(m.ai_json || 'null', null), ai_json: undefined, at: m.received_at })),
        ...outbound.map(m => ({ dir: 'out', ...m, to_list: json(m.to_list, []), cc_list: json(m.cc_list, []), at: m.sent_at || m.send_after || m.created_at }))].sort((x, y) => String(x.at).localeCompare(String(y.at))),
      notes, events, desk, suggested_service: route ? { id: route.service_id, name: route.name } : null, templates, others,
      can: { work: canWork(a, ch), forward: canWork(a, ch) && ACTIVE.includes(t.status), reply: canWork(a, ch) && ch.mode === 'live' && t.status !== 'forwarded' } };
  }));

  /* ================= API: working a thread ================= */
  S.post('/maildesk/threads/:ref/claim', wrap(async req => {
    const { t } = await threadFor(req, req.params.ref, { work: true });
    if (!ACTIVE.includes(t.status)) throw bad('This mail is no longer open');
    if (t.owner_user_id && t.owner_user_id !== req.user.id && req.body.take !== true) { const o = await one('SELECT name FROM users WHERE id=?', t.owner_user_id); throw new HttpErr(409, 'CLAIMED', `${o?.name || 'Someone'} is already on this mail`); }
    // only if nobody took it meanwhile (or it is taken over knowingly): two officers pressing Take it at once get one owner
    const r = await run(`UPDATE mail.threads SET owner_user_id=?, status=CASE WHEN status='open' THEN 'in_progress' ELSE status END, updated_at=?
      WHERE id=? AND status IN ('open','in_progress','hold') AND (owner_user_id IS NULL OR owner_user_id=? OR owner_user_id=?)`, req.user.id, now(), t.id, req.user.id, req.body.take === true ? t.owner_user_id : req.user.id);
    if (!r.changes) throw new HttpErr(409, 'CLAIMED', 'Someone else took this mail just now; open it again');
    if (t.owner_user_id && t.owner_user_id !== req.user.id) await slaEvent(t.id, 'reassigned', [req.user.id]);
    audit(req, 'claim', 'thread', t.id); return { ok: true };
  }));
  S.post('/maildesk/threads/:ref/reply', wrap(async req => {
    const { t, ch } = await threadFor(req, req.params.ref, { work: true });
    if (ch.mode !== 'live') throw bad('This mailbox is in shadow mode: nothing is sent from it yet');
    if (t.status === 'forwarded') throw bad('This mail was forwarded to a service; reply from the desk ticket');
    const text = str(req.body.body, 20000); if (!text) throw bad('Write the reply first');
    const cc = (Array.isArray(req.body.cc) ? req.body.cc : []).map(x => String(x).trim().toLowerCase()).filter(Boolean);
    if (cc.length > 10 || cc.some(x => !L.isEmail(x))) throw bad('Copy (cc): up to 10 valid email addresses');
    // To: the person who wrote in this thread (the sender, or someone else who wrote in it); never a typed-in address
    const to = req.body.to ? String(req.body.to).trim().toLowerCase() : t.requester_email.toLowerCase();
    const from = await one('SELECT id FROM mail.inbound_emails WHERE thread_id=? AND lower(from_email)=? ORDER BY received_at DESC LIMIT 1', t.id, to);
    if (!from && to !== t.requester_email.toLowerCase()) throw bad('A reply goes only to someone who wrote in this thread');
    limit('mail-reply:' + req.user.id, 120, 3600e3);
    const last = from || await one('SELECT id FROM mail.inbound_emails WHERE thread_id=? ORDER BY received_at DESC LIMIT 1', t.id), ts = now();
    // the thread changes only once the reply has gone (Undo leaves it as it was): the clock stops then, and "Send and close" closes it then
    const o = await insert('mail.outbound_emails', { id: uid(), channel_id: ch.id, thread_id: t.id, reply_to_email_id: last?.id || null, origin: 'ui', sent_by_user_id: req.user.id,
      to_list: JSON.stringify([to]), cc_list: JSON.stringify(cc), body_text: text, body_html: L.textToHtml(text, ch.signature), close_after: req.body.close === true ? 1 : 0,
      state: 'queued', send_after: new Date(Date.now() + L.UNDO_SECONDS * 1000).toISOString(), created_at: ts });
    await run(`UPDATE mail.threads SET owner_user_id=coalesce(owner_user_id, ?), status=CASE WHEN status='open' THEN 'in_progress' ELSE status END, updated_at=? WHERE id=?`, req.user.id, ts, t.id);
    audit(req, 'reply', 'thread', t.id, { outbound_id: o.id }); return { id: o.id, send_after: o.send_after, undo_seconds: L.UNDO_SECONDS };
  }));
  S.post('/maildesk/outbound/:id/cancel', wrap(async req => {
    const o = await one('SELECT * FROM mail.outbound_emails WHERE id=?', req.params.id); if (!o) throw notFound();
    const t = await one('SELECT ref FROM mail.threads WHERE id=?', o.thread_id); await threadFor(req, t.ref, { work: true });
    const r = await run("UPDATE mail.outbound_emails SET state='cancelled' WHERE id=? AND (state='pending_approval' OR (state='queued' AND send_after>?))", o.id, now());
    if (!r.changes) throw new HttpErr(409, 'ALREADY_SENT', 'Too late: this mail has already gone');
    audit(req, 'cancel', 'outbound', o.id); return { ok: true };
  }));
  S.post('/maildesk/threads/:ref/status', wrap(async req => {
    const { t } = await threadFor(req, req.params.ref, { work: true }), s = req.body.status;
    if (!['open', 'in_progress', 'hold', 'closed', 'rejected'].includes(s)) throw bad('Pick a status');
    if (t.status === 'forwarded') throw bad('This mail is a desk ticket now; change it there');
    await setStatus(t, s, now());
    const note = str(req.body.note, 2000); if (note) await insert('mail.thread_notes', { id: uid(), thread_id: t.id, author_user_id: req.user.id, body: `${{ open: 'Opened', in_progress: 'In progress', hold: 'On hold', closed: 'Closed', rejected: 'Rejected' }[s]}: ${note}`, created_at: now() });
    audit(req, 'status', 'thread', t.id, { from: t.status, to: s }); return { ok: true };
  }));
  S.post('/maildesk/threads/:ref/lane', wrap(async req => {
    const { t, ch } = await threadFor(req, req.params.ref, { work: true }), lane = req.body.lane;
    if (!L.LANES.includes(lane) || lane === 'review') throw bad('Pick a lane');
    const sla = t.first_responded_at ? {} : await slaFor(ch, lane, t.sla_started_at || t.created_at); // the clock still runs from when the mail arrived
    await run(`UPDATE mail.threads SET lane=?, updated_at=?${t.first_responded_at ? '' : ', sla_policy_id=?, first_response_due_at=?, sla_state=?'} WHERE id=?`, lane, now(),
      ...(t.first_responded_at ? [] : [sla.sla_policy_id, sla.first_response_due_at, sla.sla_state && t.sla_state && t.sla_state !== 'on_track' ? t.sla_state : sla.sla_state]), t.id);
    audit(req, 'lane', 'thread', t.id, { from: t.lane, to: lane }); return { ok: true };
  }));
  S.post('/maildesk/threads/:ref/notes', wrap(async req => {
    const { t } = await threadFor(req, req.params.ref, { work: true }), body = str(req.body.body, 4000); if (!body) throw bad('Write the note first');
    await insert('mail.thread_notes', { id: uid(), thread_id: t.id, author_user_id: req.user.id, body, created_at: now() });
    await run('UPDATE mail.threads SET updated_at=? WHERE id=?', now(), t.id); return { ok: true };
  }));
  // Forward to service: a normal desk ticket, made by the desk's own createTicket (the only link to desk code)
  S.post('/maildesk/threads/:ref/forward', wrap(async req => {
    const { t, ch } = await threadFor(req, req.params.ref, { work: true });
    if (t.status === 'forwarded' && t.desk_ticket_id) { const ex = await one('SELECT id, ticket_no FROM tickets WHERE id=?', t.desk_ticket_id); if (ex) return { ticket_id: ex.id, ticket_no: ex.ticket_no, again: true }; }
    if (!ACTIVE.includes(t.status)) throw bad('Only an open mail can be forwarded');
    const b = req.body || {}, tn = await tenantRow(ch.tenant_id), first = await one('SELECT body_text FROM mail.inbound_emails WHERE thread_id=? ORDER BY received_at LIMIT 1', t.id);
    const desc = `${str(b.description, 8000) || first?.body_text || ''}\n\n— Forwarded from ${ch.address}, ${t.ref}`;
    const fd = b.form_data && typeof b.form_data === 'object' && !Array.isArray(b.form_data) ? b.form_data : {};
    const tk = await createTicket(tn, { service_id: str(b.service_id, 64), location: str(b.location, 200) || undefined, form_data: fd, requestor_type: str(b.requestor_type, 20) || undefined /* the desk checks it */, name: str(b.name, 120) || t.requester_name || t.requester_email, email: t.requester_email,
      subject: str(b.subject, 200) || t.subject || '(no subject)', description: desc, idempotency_key: `mail:${t.id}`, merge: 'no' }, { channel: 'mail', actor: { type: 'user', id: req.user.id, name: req.user.name } });
    const ts = now();
    const r = await run(`UPDATE mail.threads SET status='forwarded', desk_ticket_id=?, forwarded_service_id=?, forwarded_at=?, forwarded_by_user_id=?, updated_at=? WHERE id=? AND desk_ticket_id IS NULL`,
      tk.id, tk.service_id, ts, req.user.id, ts, t.id);
    if (r.changes) { emit('mail.forwarded', t.id, { ticket_no: tk.ticket_no }); await slaEvent(t.id, 'forwarded', [], { ticket_no: tk.ticket_no }); await insert('mail.thread_notes', { id: uid(), thread_id: t.id, author_user_id: req.user.id, body: `Forwarded to the desk as ticket #${tk.ticket_no}.`, created_at: ts }); }
    audit(req, 'forward', 'thread', t.id, { ticket_id: tk.id, ticket_no: tk.ticket_no }); return { ticket_id: tk.id, ticket_no: tk.ticket_no };
  }));

  /* ================= API: Confirm queue (auto-replies waiting for a click) ================= */
  S.get('/maildesk/confirm', wrap(async req => {
    const a = await access(req), ids = a.chans.filter(c => canWork(a, c)).map(c => c.id); if (!ids.length) return [];
    return all(`SELECT o.id, o.body_text, o.created_at, o.to_list, t.ref, t.subject, t.requester_name, t.requester_email, t.lane, c.address,
        (SELECT body_text FROM mail.inbound_emails i WHERE i.id=o.reply_to_email_id) their_text
      FROM mail.outbound_emails o JOIN mail.threads t ON t.id=o.thread_id JOIN mail.channels c ON c.id=o.channel_id
      WHERE o.channel_id = ANY(?::text[]) AND o.state='pending_approval' ORDER BY o.created_at LIMIT 200`, ids)
      .then(r => r.map(x => ({ ...x, to_list: json(x.to_list, []), stale: Date.parse(x.created_at) < Date.now() - 864e5 })));
  }));
  async function confirmOne(req, id, body) {
    const o = await one('SELECT * FROM mail.outbound_emails WHERE id=?', id); if (!o) throw notFound();
    const t = await one('SELECT ref FROM mail.threads WHERE id=?', o.thread_id), { ch } = await threadFor(req, t.ref, { work: true });
    if (ch.mode !== 'live') throw bad('This mailbox is not live');
    const text = body != null ? str(body, 20000) : null; if (body != null && !text) throw bad('The reply is empty');
    const r = await run(`UPDATE mail.outbound_emails SET state='queued', approved_by_user_id=?, approved_at=?, send_after=?${text ? ', body_text=?, body_html=?' : ''} WHERE id=? AND state='pending_approval'`,
      req.user.id, now(), new Date(Date.now() + L.UNDO_SECONDS * 1000).toISOString(), ...(text ? [text, L.textToHtml(text)] : []), o.id);
    if (r.changes) audit(req, 'confirm', 'outbound', o.id, { edited: !!text }); return !!r.changes;
  }
  S.post('/maildesk/outbound/:id/confirm', wrap(async req => { if (!(await confirmOne(req, req.params.id, req.body.body))) throw new HttpErr(409, 'GONE', 'Already confirmed or cancelled'); return { ok: true }; }));
  S.post('/maildesk/confirm-bulk', wrap(async req => {
    const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).slice(0, 200).map(String); let n = 0;
    const skipped = [];
    for (const id of ids) { try { if (await confirmOne(req, id)) n++; else skipped.push({ id, why: 'Already confirmed or cancelled' }); } catch (e) { skipped.push({ id, why: e.status === 404 ? 'Not found' : e.message }); } }
    return { confirmed: n, skipped }; // one that cannot go does not stop the others
  }));

  /* ================= API: settings ================= */
  const pubChannel = async c => ({ ...c, office_hours: hoursOf(c), graph_sub_id: undefined,
    officers: await all('SELECT o.role, o.user_id, u.name, u.is_active, o.backup_user_id, b.name backup_name FROM mail.mailbox_officers o JOIN users u ON u.id=o.user_id LEFT JOIN users b ON b.id=o.backup_user_id WHERE o.channel_id=?', c.id),
    members: await all('SELECT m.user_id, m.role, u.name FROM mail.channel_members m JOIN users u ON u.id=m.user_id WHERE m.channel_id=?', c.id),
    sla: await all('SELECT id, name, lane, first_response_mins, warn_at_pct, escalate_at_pct, second_escalate_at_pct, business_hours_only, pause_on_hold FROM mail.sla_policies WHERE channel_id=? ORDER BY lane NULLS FIRST', c.id),
    subscribed: !!c.graph_sub_id });
  S.get('/maildesk/settings', wrap(async req => {
    const a = await needSetup(req), tid = req.tenantId;
    const chans = await all('SELECT * FROM mail.channels WHERE tenant_id=? ORDER BY address', tid);
    return { admin: a.admin, graph: { ready: graphReady(), notify_url: notifyUrl() }, auto_reply_paused: (await getSet('auto_reply_paused')) === '1',
      channels: await Promise.all(chans.map(pubChannel)),
      people: await all("SELECT id, name, email, role FROM users WHERE tenant_id=? AND is_active=1 ORDER BY name", tid),
      services: await all('SELECT id, name FROM services WHERE tenant_id=? AND is_active=1 ORDER BY sort_order, name', tid),
      leave: await all('SELECT l.id, l.user_id, u.name, l.from_day, l.to_day FROM mail.officer_leave l JOIN users u ON u.id=l.user_id WHERE u.tenant_id=? AND l.to_day>=? ORDER BY l.from_day', tid, today((await tenantRow(tid))?.timezone)),
      templates: await all('SELECT id, kind, channel_id, category, thread_status, name, subject, body, active, tenant_id FROM mail.reply_templates WHERE tenant_id=? OR tenant_id IS NULL ORDER BY kind, name', tid),
      rules: await all('SELECT id, channel_id, match, value, action, active FROM mail.rules WHERE tenant_id=? ORDER BY created_at', tid),
      routes: await all('SELECT r.id, r.category, r.service_id, s.name service, r.auto_forward FROM mail.routes r JOIN services s ON s.id=r.service_id WHERE r.tenant_id=? ORDER BY r.category', tid),
      roles: await all("SELECT r.user_id, r.role, u.name FROM mail.user_roles r JOIN users u ON u.id=r.user_id WHERE u.tenant_id=?", tid),
      integrations: a.admin ? (await all('SELECT id, kind, provider, name, config, priority, active, last_test_at, last_test_result, secret_enc IS NOT NULL has_key FROM mail.integrations WHERE kind=\'ai\' ORDER BY priority')).map(i => ({ ...i, config: json(i.config, {}) })) : [],
      jobs: await one("SELECT count(*) FILTER (WHERE state='queued')::int queued, count(*) FILTER (WHERE state='failed')::int failed FROM mail.jobs"),
      ai_today: await all('SELECT provider, calls, failures, tokens_in, tokens_out FROM mail.ai_usage WHERE day=?', now().slice(0, 10)) };
  }));
  const chFields = (b, partial) => {
    const f = {};
    if (!partial || 'address' in b) { const a = str(b.address, 320).toLowerCase(); if (!L.isEmail(a)) throw bad('Mailbox address: a valid email, e.g. reach@smru.edu.in'); f.address = a; }
    if ('display_name' in b) f.display_name = str(b.display_name, 120) || null;
    if ('signature' in b) f.signature = str(b.signature, 1000) || null;
    if ('office_hours' in b) { const h = b.office_hours; if (h && !L.validHours(h)) throw bad('Office hours: pick the days, and a start before the end'); f.office_hours = h ? JSON.stringify({ days: h.days, from: h.from, to: h.to }) : null; }
    if ('mode' in b) { if (!L.MODES.includes(b.mode)) throw bad('Mode: off, shadow or live'); f.mode = b.mode; }
    if ('ack_mode' in b) { if (!['approve', 'auto'].includes(b.ack_mode)) throw bad('Auto-reply: approve or auto'); f.ack_mode = b.ack_mode; }
    if ('default_service_id' in b) f.default_service_id = b.default_service_id || null;
    return f;
  };
  S.post('/maildesk/channels', wrap(async req => {
    await needSetup(req); const f = chFields(req.body, false), ts = now();
    // the Microsoft app can read every mailbox of the organisation: only a super admin decides which ones ONE Desk opens
    if (!(await access(req)).admin) throw forbid('Only a super admin can add a mailbox');
    if (f.default_service_id && !(await one('SELECT 1 x FROM services WHERE id=? AND tenant_id=?', f.default_service_id, req.tenantId))) throw bad('Pick a service of this campus');
    if (await one('SELECT 1 x FROM mail.channels WHERE lower(address)=?', f.address)) throw new HttpErr(409, 'EXISTS', 'This mailbox is already set up');
    f.mode = 'off'; // a new mailbox starts off; switch to shadow for a week, then live
    const c = await tx(async () => { const c = await insert('mail.channels', { id: uid(), tenant_id: req.tenantId, ...f, created_at: ts, updated_at: ts });
      for (const p of DEFAULT_SLA) await insert('mail.sla_policies', { id: uid(), channel_id: c.id, name: p.name, lane: p.lane, first_response_mins: p.first_response_mins, warn_at_pct: 75, escalate_at_pct: 100, second_escalate_at_pct: 200, business_hours_only: 1, pause_on_hold: 1, active: 1, created_at: ts });
      return c; });
    audit(req, 'setting_change', 'channel', c.id, { created: f.address }); return pubChannel(c);
  }));
  S.patch('/maildesk/channels/:id', wrap(async req => {
    await needSetup(req); const c = await channelIn(req, req.params.id), f = chFields(req.body, true);
    if (!Object.keys(f).length) throw bad('Nothing to change');
    if (f.address === c.address) delete f.address;
    if (f.address && !(await access(req)).admin) throw forbid('Only a super admin can change a mailbox address');
    if (f.address && (f.mode || c.mode) !== 'off') throw bad('Switch the mailbox off before changing its address');
    if (f.address && await one('SELECT 1 x FROM mail.channels WHERE lower(address)=? AND id<>?', f.address, c.id)) throw new HttpErr(409, 'EXISTS', 'This mailbox is already set up');
    if (f.default_service_id && !(await one('SELECT 1 x FROM services WHERE id=? AND tenant_id=?', f.default_service_id, req.tenantId))) throw bad('Pick a service of this campus');
    if (f.mode === 'live' && !(await one("SELECT 1 x FROM mail.mailbox_officers WHERE channel_id=? AND role='nodal'", c.id))) throw bad('Add at least one nodal officer before going live');
    await run(`UPDATE mail.channels SET ${Object.keys(f).map(k => `${k}=?`).join(', ')}, updated_at=? WHERE id=?`, ...Object.values(f), now(), c.id);
    const n = await one('SELECT * FROM mail.channels WHERE id=?', c.id);
    if (f.mode && f.mode !== c.mode) {
      if (f.mode === 'off') await unsubscribe(n);
      else if (c.mode === 'off') { await run('UPDATE mail.channels SET last_synced_at=? WHERE id=?', now(), n.id); await subscribe({ ...n, graph_sub_id: null }); } // from now on: mail that came while it was off stays in Outlook
      if (c.mode === 'live') { // leaving live: replies still in their undo window or waiting are not sent, and each thread says so
        for (const o of await all("SELECT id, thread_id FROM mail.outbound_emails WHERE channel_id=? AND state IN ('queued','pending_approval')", c.id)) {
          await run("UPDATE mail.outbound_emails SET state='cancelled', error=? WHERE id=?", 'The mailbox was switched out of live mode before this was sent', o.id);
          await note(o.thread_id, 'A reply was not sent: the mailbox was switched out of live mode before it went.'); }
      }
    }
    // going live: mail read during the shadow week was answered in Outlook, so it is kept but closed, not dropped on the officers' Home
    // (a later message in such a conversation opens its thread again)
    if (f.mode === 'live' && c.mode !== 'live') await run(`UPDATE mail.threads SET status='closed', closed_at=?, updated_at=?, sla_state=CASE WHEN sla_state IS NULL THEN NULL ELSE 'met' END
      WHERE channel_id=? AND status IN ('open','in_progress','hold')`, now(), now(), c.id);
    audit(req, 'setting_change', 'channel', c.id, f); return pubChannel(await one('SELECT * FROM mail.channels WHERE id=?', c.id));
  }));
  S.put('/maildesk/channels/:id/officers', wrap(async req => {
    await needSetup(req); const c = await channelIn(req, req.params.id), b = req.body || {};
    // active staff of the campus, plus anyone already on this mailbox (a deactivated officer stays until removed: their backup covers)
    const people = new Set([...(await all('SELECT id FROM users WHERE tenant_id=? AND is_active=1', req.tenantId)).map(r => r.id),
      ...(await all('SELECT o.user_id id FROM mail.mailbox_officers o JOIN users u ON u.id=o.user_id WHERE o.channel_id=? AND u.tenant_id=? UNION SELECT o.backup_user_id FROM mail.mailbox_officers o JOIN users u ON u.id=o.backup_user_id WHERE o.channel_id=? AND u.tenant_id=?', c.id, req.tenantId, c.id, req.tenantId)).map(r => r.id)]);
    // { officers: [{ user_id, role: 'nodal' | 'escalation', backup_user_id }] }: any number of each; at least one nodal officer
    const list = (Array.isArray(b.officers) ? b.officers : []).filter(o => o && o.user_id).map(o => ({ user_id: String(o.user_id), role: o.role, backup_user_id: o.backup_user_id ? String(o.backup_user_id) : null }));
    if (list.length > 50) throw bad('At most 50 officers on one mailbox');
    if (list.some(o => !L.OFFICER_ROLES.includes(o.role))) throw bad('Each officer is a nodal officer or an escalation officer');
    if (list.some(o => !people.has(o.user_id) || (o.backup_user_id && !people.has(o.backup_user_id)))) throw bad('Officers and backups must be active staff of this campus');
    if (list.some(o => o.backup_user_id === o.user_id)) throw bad('A person cannot be their own backup');
    if (new Set(list.map(o => `${o.role}|${o.user_id}`)).size !== list.length) throw bad('The same person is listed twice in one role');
    if (!list.some(o => o.role === 'nodal')) throw bad('Add at least one nodal officer');
    await tx(async () => { await run('DELETE FROM mail.mailbox_officers WHERE channel_id=?', c.id);
      for (const o of list) await insert('mail.mailbox_officers', { channel_id: c.id, ...o, created_at: now() });
      // mail taken by someone no longer on this mailbox goes back to the officers (they could not open it any more)
      await run(`UPDATE mail.threads t SET owner_user_id=NULL, updated_at=? WHERE t.channel_id=? AND t.owner_user_id IS NOT NULL AND t.status IN ('open','in_progress','hold')
        AND NOT EXISTS (SELECT 1 FROM mail.mailbox_officers o WHERE o.channel_id=t.channel_id AND (o.user_id=t.owner_user_id OR o.backup_user_id=t.owner_user_id))
        AND NOT EXISTS (SELECT 1 FROM mail.channel_members m WHERE m.channel_id=t.channel_id AND m.user_id=t.owner_user_id)
        AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id=t.owner_user_id AND u.role IN ('super_admin','tenant_admin'))`, now(), c.id); });
    audit(req, 'setting_change', 'channel_officers', c.id, b); return pubChannel(c);
  }));
  S.put('/maildesk/channels/:id/members', wrap(async req => {
    await needSetup(req); const c = await channelIn(req, req.params.id), list = Array.isArray(req.body.members) ? req.body.members.slice(0, 50) : [];
    const people = new Set((await all('SELECT id FROM users WHERE tenant_id=? AND is_active=1', req.tenantId)).map(r => r.id));
    if (list.some(m => !people.has(m.user_id) || !['viewer', 'replier', 'hr'].includes(m.role))) throw bad('Members must be staff of this campus, as viewer, replier or hr');
    await tx(async () => { await run('DELETE FROM mail.channel_members WHERE channel_id=?', c.id); for (const m of list) await insert('mail.channel_members', { channel_id: c.id, user_id: m.user_id, role: m.role }); });
    audit(req, 'setting_change', 'channel_members', c.id, { n: list.length }); return pubChannel(c);
  }));
  S.put('/maildesk/channels/:id/sla', wrap(async req => {
    await needSetup(req); const c = await channelIn(req, req.params.id), list = Array.isArray(req.body.policies) ? req.body.policies : [];
    const n = (v, lo, hi, m) => { const x = Number(v); if (!Number.isInteger(x) || x < lo || x > hi) throw bad(m); return x; };
    const rows = list.map(p => ({ lane: p.lane || null, name: str(p.name, 120) || (p.lane ? L.LANE_NAMES[p.lane] : 'Default'), first_response_mins: n(p.first_response_mins, 5, 20000, 'Reply within: 5 minutes to 20000'),
      warn_at_pct: n(p.warn_at_pct ?? 75, 10, 99, 'Reminder at: 10 to 99 %'), escalate_at_pct: n(p.escalate_at_pct ?? 100, 50, 500, 'Escalate at: 50 to 500 %'),
      second_escalate_at_pct: p.second_escalate_at_pct ? n(p.second_escalate_at_pct, 101, 1000, 'Second escalation: 101 to 1000 %') : null,
      business_hours_only: p.business_hours_only === false ? 0 : 1, pause_on_hold: p.pause_on_hold === false ? 0 : 1 }));
    if (rows.some(p => p.lane && !L.LANES.includes(p.lane))) throw bad('Unknown lane');
    if (new Set(rows.map(p => p.lane)).size !== rows.length) throw bad('One target per lane');
    await tx(async () => { await run('UPDATE mail.sla_policies SET active=0 WHERE channel_id=?', c.id);
      for (const p of rows) await insert('mail.sla_policies', { id: uid(), channel_id: c.id, ...p, active: 1, created_at: now() }); }); // old ones stay for the threads that use them
    audit(req, 'setting_change', 'sla', c.id, { n: rows.length }); return pubChannel(c);
  }));
  S.post('/maildesk/channels/:id/test', wrap(async req => {
    await needSetup(req); const c = await channelIn(req, req.params.id);
    try { const r = await graph('GET', `${mbox(c.address)}/mailFolders/inbox?$select=displayName,totalItemCount,unreadItemCount`);
      return { ok: true, message: `Connected: Inbox has ${r.totalItemCount ?? '?'} mails (${r.unreadItemCount ?? '?'} unread)` }; }
    catch (e) { return { ok: false, message: e.message }; }
  }));
  S.post('/maildesk/channels/:id/sync', wrap(async req => { await needSetup(req); const c = await channelIn(req, req.params.id); if (c.mode === 'off') throw bad('Switch the mailbox to shadow or live first');
    await enqueue('catchup', { channel_id: c.id }, `catchup:${c.id}`); setImmediate(work); return { ok: true }; }));
  S.delete('/maildesk/channels/:id', wrap(async req => {
    await needSetup(req); if (!(await access(req)).admin) throw forbid('Only a super admin can delete a mailbox');
    const c = await channelIn(req, req.params.id);
    if (c.mode !== 'off') throw bad('Switch the mailbox off before deleting it');
    // only while it has no mail at all, checked in the same statement (mail arriving meanwhile is never deleted with it)
    const r = await run('DELETE FROM mail.channels c WHERE c.id=? AND NOT EXISTS (SELECT 1 FROM mail.threads t WHERE t.channel_id=c.id) AND NOT EXISTS (SELECT 1 FROM mail.inbound_emails i WHERE i.channel_id=c.id)', c.id);
    if (!r.changes) throw new HttpErr(409, 'IN_USE', 'This mailbox has mail, so it stays (switched off) to keep that history');
    await unsubscribe(c).catch(() => {}); audit(req, 'setting_change', 'channel', c.id, { deleted: c.address }); return { ok: true };
  }));
  S.post('/maildesk/leave', wrap(async req => {
    await needSetup(req); const b = req.body, d = /^\d{4}-\d{2}-\d{2}$/;
    if (!(await one('SELECT 1 x FROM users WHERE id=? AND tenant_id=?', b.user_id, req.tenantId))) throw bad('Pick a person of this campus');
    if (!d.test(b.from_day || '') || !d.test(b.to_day || '') || b.from_day > b.to_day) throw bad('Leave: a start date on or before the end date');
    return insert('mail.officer_leave', { id: uid(), user_id: b.user_id, from_day: b.from_day, to_day: b.to_day, created_at: now() });
  }));
  S.delete('/maildesk/leave/:id', wrap(async req => { await needSetup(req);
    await run('DELETE FROM mail.officer_leave l USING users u WHERE l.id=? AND u.id=l.user_id AND u.tenant_id=?', req.params.id, req.tenantId); return { ok: true }; }));
  // templates: auto_ack (the "we received it" reply), status, manual (quick answers in the reply box)
  const tplFields = async (req, b, partial) => {
    const f = {};
    if (!partial || 'kind' in b) { if (!['auto_ack', 'status', 'manual'].includes(b.kind)) throw bad('Kind: auto_ack, status or manual'); f.kind = b.kind; }
    if (!partial || 'name' in b) { f.name = str(b.name, 120); if (!f.name) throw bad('Template name required'); }
    if (!partial || 'body' in b) { f.body = str(b.body, 8000); if (!f.body) throw bad('Template text required');
      const unknown = [...f.body.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map(m => m[1]).filter(k => !L.TEMPLATE_VARS.includes(k));
      if (unknown.length) throw bad(`Unknown fill-in: {{${unknown[0]}}}. Use: ${L.TEMPLATE_VARS.map(v => `{{${v}}}`).join(', ')}`); }
    if ('subject' in b) f.subject = str(b.subject, 255) || null;
    if ('category' in b) f.category = str(b.category, 80) || null;
    if ('thread_status' in b) f.thread_status = b.thread_status || null;
    if ('channel_id' in b) { f.channel_id = b.channel_id || null; if (f.channel_id) await channelIn(req, f.channel_id); }
    if ('active' in b) f.active = b.active ? 1 : 0;
    return f;
  };
  S.post('/maildesk/templates', wrap(async req => { await needSetup(req); const f = await tplFields(req, req.body, false);
    const t = await insert('mail.reply_templates', { id: uid(), tenant_id: req.tenantId, active: 1, ...f, created_at: now(), updated_at: now() }); audit(req, 'setting_change', 'template', t.id); return t; }));
  const tplIn = async (req, id, a) => { const t = await one('SELECT * FROM mail.reply_templates WHERE id=?', id);
    if (!t || (t.tenant_id && t.tenant_id !== req.tenantId) || (!t.tenant_id && !a.admin)) throw notFound(); return t; }; // the default template: super admin only
  S.patch('/maildesk/templates/:id', wrap(async req => { const a = await needSetup(req), t = await tplIn(req, req.params.id, a), f = await tplFields(req, req.body, true);
    if (!Object.keys(f).length) throw bad('Nothing to change');
    await run(`UPDATE mail.reply_templates SET ${Object.keys(f).map(k => `${k}=?`).join(', ')}, updated_at=? WHERE id=?`, ...Object.values(f), now(), t.id); audit(req, 'setting_change', 'template', t.id); return { ok: true }; }));
  S.delete('/maildesk/templates/:id', wrap(async req => { const a = await needSetup(req), t = await tplIn(req, req.params.id, a);
    await run('UPDATE mail.outbound_emails SET template_id=NULL WHERE template_id=?', t.id); await run('DELETE FROM mail.reply_templates WHERE id=?', t.id); audit(req, 'setting_change', 'template', t.id, { deleted: true }); return { ok: true }; }));
  S.post('/maildesk/rules', wrap(async req => { await needSetup(req); const b = req.body;
    if (!['sender', 'domain', 'subject_contains', 'header'].includes(b.match) || !['noise', 'important', 'auto', 'skip_ai'].includes(b.action)) throw bad('Pick what to match and what to do');
    const value = str(b.value, 255); if (!value) throw bad('What to match is required'); if (b.channel_id) await channelIn(req, b.channel_id);
    const r = await insert('mail.rules', { id: uid(), tenant_id: req.tenantId, channel_id: b.channel_id || null, match: b.match, value, action: b.action, active: 1, created_at: now() }); audit(req, 'setting_change', 'rule', r.id); return r; }));
  S.delete('/maildesk/rules/:id', wrap(async req => { await needSetup(req); await run('DELETE FROM mail.rules WHERE id=? AND tenant_id=?', req.params.id, req.tenantId); audit(req, 'setting_change', 'rule', req.params.id, { deleted: true }); return { ok: true }; }));
  S.post('/maildesk/routes', wrap(async req => { await needSetup(req); const b = req.body, category = str(b.category, 80);
    if (!category) throw bad('Category required'); if (!(await one('SELECT 1 x FROM services WHERE id=? AND tenant_id=?', b.service_id, req.tenantId))) throw bad('Pick a service of this campus');
    await run(`INSERT INTO mail.routes (id, tenant_id, category, service_id, auto_forward, created_at) VALUES (?, ?, ?, ?, 0, ?) ON CONFLICT (tenant_id, category) DO UPDATE SET service_id=excluded.service_id`, uid(), req.tenantId, category, b.service_id, now());
    audit(req, 'setting_change', 'route', category); return { ok: true }; })); // auto_forward stays off: the AI only suggests, an officer forwards
  S.delete('/maildesk/routes/:id', wrap(async req => { await needSetup(req); await run('DELETE FROM mail.routes WHERE id=? AND tenant_id=?', req.params.id, req.tenantId); return { ok: true }; }));
  S.put('/maildesk/roles', wrap(async req => { await needSetup(req); const b = req.body;
    const u = await one('SELECT id, role FROM users WHERE id=? AND tenant_id=?', b.user_id, req.tenantId); if (!u) throw bad('Pick a person of this campus');
    if (b.role === null || b.role === '') await run('DELETE FROM mail.user_roles WHERE user_id=?', u.id);
    else { if (b.role !== 'manager') throw bad('A campus can add mail managers only'); await run('INSERT INTO mail.user_roles (user_id, role, created_at) VALUES (?, ?, ?) ON CONFLICT (user_id) DO UPDATE SET role=excluded.role', u.id, b.role, now()); }
    audit(req, 'setting_change', 'user_role', u.id, { role: b.role || null }); return { ok: true }; }));
  S.put('/maildesk/switches', wrap(async req => { await needAdmin(req); await putSet('auto_reply_paused', req.body.auto_reply_paused ? '1' : '0');
    audit(req, 'setting_change', 'switch', 'auto_reply_paused', { on: !!req.body.auto_reply_paused }); return { ok: true }; }));
  // AI providers (keys sealed with AES-256-GCM; a key is never sent back)
  const aiFields = (b, partial) => {
    const f = {};
    if (!partial || 'name' in b) { f.name = str(b.name, 120); if (!f.name) throw bad('Name required'); }
    if (!partial || 'baseURL' in b || 'model' in b || 'reasoningEffort' in b || 'noTemperature' in b) {
      const u = str(b.baseURL, 300); if (!/^https?:\/\/\S+$/.test(u)) throw bad('API address, e.g. https://api.openai.com/v1'); const m = str(b.model, 120); if (!m) throw bad('Model required');
      f.config = JSON.stringify({ baseURL: u, model: m, reasoningEffort: str(b.reasoningEffort, 20) || undefined, noTemperature: !!b.noTemperature }); }
    if ('priority' in b) { f.priority = Number(b.priority); if (!Number.isInteger(f.priority) || f.priority < 1 || f.priority > 99) throw bad('Order: 1 to 99'); }
    if ('active' in b) f.active = b.active ? 1 : 0;
    if (b.apiKey) f.secret_enc = L.seal(KEY, { apiKey: String(b.apiKey).trim() });
    return f;
  };
  S.post('/maildesk/integrations', wrap(async req => { await needAdmin(req); const f = aiFields(req.body, false);
    const r = await insert('mail.integrations', { id: uid(), kind: 'ai', provider: 'openai-compatible', priority: 1, active: 0, ...f, created_at: now(), updated_at: now() });
    audit(req, 'key_replace', 'integration', r.id, { name: r.name }); return { id: r.id }; }));
  S.patch('/maildesk/integrations/:id', wrap(async req => { await needAdmin(req); const i = await one('SELECT * FROM mail.integrations WHERE id=?', req.params.id); if (!i) throw notFound();
    const f = aiFields({ ...json(i.config, {}), ...req.body }, true); if (!('baseURL' in req.body || 'model' in req.body || 'reasoningEffort' in req.body || 'noTemperature' in req.body)) delete f.config;
    if (!Object.keys(f).length) throw bad('Nothing to change');
    await run(`UPDATE mail.integrations SET ${Object.keys(f).map(k => `${k}=?`).join(', ')}, updated_at=? WHERE id=?`, ...Object.values(f), now(), i.id);
    audit(req, f.secret_enc ? 'key_replace' : 'setting_change', 'integration', i.id); return { ok: true }; }));
  S.delete('/maildesk/integrations/:id', wrap(async req => { await needAdmin(req); await run('DELETE FROM mail.integrations WHERE id=?', req.params.id); audit(req, 'setting_change', 'integration', req.params.id, { deleted: true }); return { ok: true }; }));
  S.post('/maildesk/integrations/:id/test', wrap(async req => { await needAdmin(req); const i = await one('SELECT * FROM mail.integrations WHERE id=?', req.params.id); if (!i) throw notFound();
    let msg; try { const o = await askAi(i, 'Test', 'Hello, what are the B.Tech fees for 2027?'); msg = `Works: sorted the test mail as ${L.LANE_NAMES[o.reading.lane]} (${o.reading.category})`; }
    catch (e) { msg = `Failed: ${e.message}`; }
    await run('UPDATE mail.integrations SET last_test_at=?, last_test_result=? WHERE id=?', now(), msg.slice(0, 255), i.id); return { ok: msg.startsWith('Works'), message: msg }; }));

  /* ================= Connected apps: any API you buy gets the mail events (Settings, super admin) ================= */
  // e.g. a WhatsApp or SMS provider told of escalations, a CRM or lead sheet told of every new admissions mail.
  // Each app: an address, its key (sealed), the events, one campus or all, and the body: ONE Desk's standard JSON or the
  // app's own format with fill-ins. Every call is signed (X-OneDesk-Signature), sent from the job loop and retried.
  const EVENTS = L.PLUGIN_EVENTS;
  async function emit(event, threadId, extra = {}) {
    try {
      const apps = (await all("SELECT id, config FROM mail.integrations WHERE kind='notify' AND provider='webhook' AND active=1")).map(a => ({ ...a, cfg: json(a.config, {}) }))
        .filter(a => (a.cfg.events || []).includes(event)); if (!apps.length) return;
      const t = await one(`SELECT t.*, c.address, c.display_name, c.tenant_id, n.code campus_code, n.name campus FROM mail.threads t
        JOIN mail.channels c ON c.id=t.channel_id JOIN tenants n ON n.id=c.tenant_id WHERE t.id=?`, threadId); if (!t) return;
      const vars = L.pluginVars(event, t, extra, threadLink(t));
      for (const a of apps) if (!a.cfg.tenant_id || a.cfg.tenant_id === t.tenant_id) await enqueue('plugin', { integration_id: a.id, vars });
      setImmediate(safe(work));
    } catch (e) { console.error('mail app event', event, e.message); } // an app problem never stops the mail work
  }
  const appUrlOk = u => { try { const x = new URL(u); if (env.MAIL_ALLOW_HTTP_APPS === '1') return /^https?:$/.test(x.protocol);
      return x.protocol === 'https:' && !/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|\[?::1\]?$|\[?f[cd])/i.test(x.hostname); } catch { return false; } };
  async function deliver({ integration_id, vars }, { test = false } = {}) {
    const a = await one("SELECT * FROM mail.integrations WHERE id=? AND kind='notify'", integration_id); if (!a || (!a.active && !test)) return 'skipped';
    const cfg = json(a.config, {}), sec = L.unseal(KEY, a.secret_enc), { body, type } = L.pluginBody(cfg, vars), ts = String(Math.floor(Date.now() / 1000));
    if (!appUrlOk(cfg.url)) throw new Error('The app address must be https:// on the internet');
    const headers = { 'content-type': type, 'user-agent': 'ONE-Desk-Mail', 'x-onedesk-event': vars.event, 'x-onedesk-timestamp': ts,
      'x-onedesk-signature': 'sha256=' + crypto.createHmac('sha256', sec.signing || '').update(`${ts}.${body}`).digest('hex') };
    if (sec.auth_value) headers[(cfg.auth_header || 'Authorization').toLowerCase()] = sec.auth_value;
    let msg, okk = false;
    try {
      const r = await fetch(cfg.url, { method: cfg.method === 'PUT' ? 'PUT' : 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(15000) });
      const txt = (await r.text().catch(() => '')).slice(0, 200); okk = r.status >= 200 && r.status < 300;
      msg = `${okk ? 'Delivered' : 'Refused'} ${vars.event}${vars.ref ? ' ' + vars.ref : ''}: HTTP ${r.status}${okk ? '' : ` ${txt}`}`;
    } catch (e) { msg = `Not delivered ${vars.event}: ${e.name === 'TimeoutError' ? 'no answer in 15 s' : e.message}`; }
    await run('UPDATE mail.integrations SET last_test_at=?, last_test_result=? WHERE id=?', now(), msg.slice(0, 255), a.id);
    if (!okk) throw new Error(msg); // the job loop tries again later (5 times in all)
    return msg;
  }
  const appFields = (b, cur = {}) => {
    const f = { ...cur };
    if ('name' in b) f.name = str(b.name, 120);
    if ('url' in b) f.url = str(b.url, 1000);
    if ('method' in b) f.method = b.method === 'PUT' ? 'PUT' : 'POST';
    if ('events' in b) f.events = (Array.isArray(b.events) ? b.events : []).filter(x => EVENTS[x]);
    if ('tenant_id' in b) f.tenant_id = b.tenant_id || null;
    if ('format' in b) f.format = b.format === 'template' ? 'template' : 'standard';
    if ('content_type' in b) f.content_type = ['json', 'form', 'text'].includes(b.content_type) ? b.content_type : 'json';
    if ('template' in b) f.template = String(b.template ?? '').slice(0, 8000);
    if ('auth_header' in b) f.auth_header = str(b.auth_header, 60) || 'Authorization';
    if (!f.name) throw bad('Name the app, e.g. "WhatsApp alerts"');
    if (!appUrlOk(f.url)) throw bad('The app address must start with https:// and be on the internet');
    if (!f.events?.length) throw bad('Pick at least one event');
    if (!/^[A-Za-z0-9-]{1,60}$/.test(f.auth_header || 'Authorization')) throw bad('Key header: letters, numbers and - only, e.g. Authorization or X-Api-Key');
    if (f.format === 'template') { if (!f.template.trim()) throw bad('Write the body the app expects, with fill-ins like {{ref}}');
      const unknown = [...f.template.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map(m => m[1]).filter(k => !L.PLUGIN_VARS.includes(k));
      if (unknown.length) throw bad(`Unknown fill-in {{${unknown[0]}}}. Use: ${L.PLUGIN_VARS.map(v => `{{${v}}}`).join(' ')}`);
      if (f.content_type === 'json') { try { JSON.parse(L.pluginBody(f, L.pluginVars('mail.received', L.SAMPLE_THREAD, {}, 'https://x')).body); } catch { throw bad('The body is not valid JSON once filled in: keep each {{fill-in}} inside quotes'); } } }
    return f;
  };
  const appOut = a => { const c = json(a.config, {}); return { id: a.id, name: a.name, active: !!a.active, ...c, has_key: !!L.unseal(KEY, a.secret_enc).auth_value, last_at: a.last_test_at, last_result: a.last_test_result }; };
  S.get('/maildesk/apps', wrap(async req => { await needAdmin(req);
    return { apps: (await all("SELECT * FROM mail.integrations WHERE kind='notify' AND provider='webhook' ORDER BY created_at")).map(appOut), events: EVENTS, fill_ins: L.PLUGIN_VARS,
      campuses: await all('SELECT id, code, name FROM tenants ORDER BY name'), sample: L.pluginBody({ format: 'standard' }, L.pluginVars('mail.received', L.SAMPLE_THREAD, {}, `${base()}/#/c/mail/t/SMRU-0001`)).body }; }));
  S.post('/maildesk/apps', wrap(async req => { await needAdmin(req); const f = appFields(req.body || {}), signing = crypto.randomBytes(32).toString('hex');
    if (f.tenant_id && !(await tenantRow(f.tenant_id))) throw bad('Pick a campus');
    const { name, ...config } = f;
    const a = await insert('mail.integrations', { id: uid(), kind: 'notify', provider: 'webhook', name, config: JSON.stringify(config), secret_enc: L.seal(KEY, { signing, auth_value: str(req.body.auth_value, 2000) || null }),
      priority: 1, active: req.body.active === false ? 0 : 1, created_at: now(), updated_at: now() });
    audit(req, 'key_replace', 'app', a.id, { name, url: f.url, events: f.events }); return { ...appOut(a), signing_secret: signing }; })); // the signing secret is shown once here
  S.patch('/maildesk/apps/:id', wrap(async req => { await needAdmin(req); const a = await one("SELECT * FROM mail.integrations WHERE id=? AND kind='notify'", req.params.id); if (!a) throw notFound();
    const f = appFields(req.body || {}, { name: a.name, ...json(a.config, {}) }), { name, ...config } = f, sec = L.unseal(KEY, a.secret_enc);
    if (f.tenant_id && !(await tenantRow(f.tenant_id))) throw bad('Pick a campus');
    if ('auth_value' in req.body && req.body.auth_value !== undefined) sec.auth_value = str(req.body.auth_value, 2000) || null; // "" removes the key
    let signing = null; if (req.body.new_signing_secret === true) { sec.signing = signing = crypto.randomBytes(32).toString('hex'); }
    await run('UPDATE mail.integrations SET name=?, config=?, secret_enc=?, active=?, updated_at=? WHERE id=?', name, JSON.stringify(config), L.seal(KEY, sec), 'active' in req.body ? (req.body.active ? 1 : 0) : a.active, now(), a.id);
    audit(req, 'auth_value' in req.body || signing ? 'key_replace' : 'setting_change', 'app', a.id, { name });
    return { ...appOut(await one('SELECT * FROM mail.integrations WHERE id=?', a.id)), ...(signing ? { signing_secret: signing } : {}) }; }));
  S.delete('/maildesk/apps/:id', wrap(async req => { await needAdmin(req);
    await run("DELETE FROM mail.integrations WHERE id=? AND kind='notify'", req.params.id); await run("UPDATE mail.jobs SET state='failed', last_error='The app was deleted' WHERE kind='plugin' AND state='queued' AND payload LIKE ?", `%${req.params.id}%`);
    audit(req, 'setting_change', 'app', req.params.id, { deleted: true }); return { ok: true }; }));
  S.post('/maildesk/apps/:id/test', wrap(async req => { await needAdmin(req); const a = await one("SELECT id FROM mail.integrations WHERE id=? AND kind='notify'", req.params.id); if (!a) throw notFound();
    try { const m = await deliver({ integration_id: a.id, vars: { ...L.pluginVars(req.body?.event || 'mail.received', L.SAMPLE_THREAD, { test: true }, `${base()}/#/c/mail/t/SMRU-0001`) } }, { test: true }); return { ok: true, message: m + ' (a test with sample values)' }; }
    catch (e) { return { ok: false, message: e.message }; } }));

  /* ================= Connections (super admin, on screen): Microsoft 365 and OneDrive ================= */
  // OneDrive: one account's OneDrive (e.g. hr@) holds the resumes and CVs, in one folder; files are read through ONE Desk, never shared publicly
  const drive = async () => { const v = await getSet('onedrive'); return v ? json(v, null) : null; };
  const drivePath = (d, rel) => `${mbox(d.account)}/drive/root:/${[d.folder, ...String(rel || '').split('/')].filter(Boolean).map(encodeURIComponent).join('/')}`;
  async function ensureFolder(d) {
    try { return await graph('GET', `${drivePath(d)}?$select=id,name,webUrl`); } catch (e) { if (e.status !== 404) throw e; }
    let parent = `${mbox(d.account)}/drive/root`, made = null;
    for (const part of d.folder.split('/').filter(Boolean)) {
      try { made = await graph('POST', `${parent}/children`, { name: part, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }); }
      catch (e) { if (e.status !== 409) throw e; made = await graph('GET', `${parent}:/${encodeURIComponent(part)}?$select=id`).catch(() => graph('GET', `${parent}/children?$filter=name eq '${part.replace(/'/g, "''")}'`).then(r => r.value?.[0])); }
      parent = `${mbox(d.account)}/drive/items/${made.id}`;
    }
    return made;
  }
  // put a file in the folder (small files; resumes are well under 4 MB): returns its OneDrive item id
  async function storePut(rel, buf, mime) {
    const d = await drive(); if (!d?.account) throw new HttpErr(503, 'DRIVE_NOT_SET', 'OneDrive is not connected yet: a super admin connects it on Mail → Settings');
    const r = await fetch(`${GRAPH}${drivePath(d, rel)}:/content?@microsoft.graph.conflictBehavior=rename`, { method: 'PUT', signal: AbortSignal.timeout(60000),
      headers: { authorization: 'Bearer ' + await token(), 'content-type': mime || 'application/octet-stream' }, body: buf });
    const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error(`OneDrive: ${j.error?.message || r.status}`), { status: r.status });
    return { externalId: j.id, path: `${d.folder}/${rel}`, size: j.size };
  }
  const storeRemove = id => drive().then(d => graph('DELETE', `${mbox(d.account)}/drive/items/${encodeURIComponent(id)}`));
  const msOut = async () => { const t = json(await getSet('ms365_test') || 'null', null);
    return { connected: !!ms, source: ms?.source || null, tenant_id: ms?.tenantId || '', client_id: ms?.clientId || '', has_secret: !!ms?.clientSecret, notify_url: notifyUrl(), last_test: t }; };
  const driveOut = async () => { const d = await drive(); return d ? { connected: !!d.account, account: d.account, folder: d.folder, web_url: d.web_url || null, last_test: d.last_test || null } : { connected: false }; };
  S.get('/maildesk/connections', wrap(async req => { await needAdmin(req); return { ms365: await msOut(), onedrive: await driveOut(), permissions: {
    mail: ['Mail.ReadWrite', 'Mail.Send'], onedrive: ['Files.ReadWrite.All'] } }; }));
  const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  S.put('/maildesk/connections/ms365', wrap(async req => {
    await needAdmin(req); const b = req.body || {}, cur = ms?.source === 'app' ? ms : {};
    const tenantId = str(b.tenant_id, 64), clientId = str(b.client_id, 64), clientSecret = str(b.client_secret, 400) || cur.clientSecret;
    if (!GUID.test(tenantId)) throw bad('Directory (tenant) ID: the 36-character ID on the app\'s Overview page in Entra');
    if (!GUID.test(clientId)) throw bad('Application (client) ID: the 36-character ID on the app\'s Overview page in Entra');
    if (!clientSecret) throw bad('Client secret: the Value of a secret under Certificates & secrets (not its Secret ID)');
    await putSet('ms365', L.seal(KEY, { tenantId, clientId, clientSecret })); await run("DELETE FROM mail.settings WHERE key='ms365_test'"); await loadMs();
    audit(req, 'key_replace', 'connection', 'ms365', { tenant_id: tenantId, client_id: clientId }); return msOut();
  }));
  S.delete('/maildesk/connections/ms365', wrap(async req => { await needAdmin(req);
    await run("DELETE FROM mail.settings WHERE key IN ('ms365','ms365_test')"); await loadMs(); audit(req, 'setting_change', 'connection', 'ms365', { disconnected: true }); return msOut(); }));
  S.post('/maildesk/connections/ms365/test', wrap(async req => {
    await needAdmin(req); const steps = [];
    try { tok = null; await token(); steps.push({ ok: true, text: 'Signed in to Microsoft 365 with the app' }); }
    catch (e) { steps.push({ ok: false, text: e.message }); }
    const box = str(req.body?.mailbox, 320).toLowerCase() || (await one('SELECT address FROM mail.channels WHERE tenant_id=? ORDER BY created_at LIMIT 1', req.tenantId))?.address;
    if (steps[0].ok && box) {
      try { const r = await graph('GET', `${mbox(box)}/mailFolders/inbox?$select=totalItemCount,unreadItemCount`); steps.push({ ok: true, text: `Read the inbox of ${box}: ${r.totalItemCount ?? '?'} mails (Mail.ReadWrite works)` }); }
      catch (e) { steps.push({ ok: false, text: `${box}: ${e.status === 403 ? 'access denied. Add Mail.ReadWrite and Mail.Send (Application) and click Grant admin consent; if mail access is limited to some mailboxes, include this one' : e.status === 404 ? 'no such mailbox in this Microsoft 365' : e.message}` }); }
    }
    const res = { ok: steps.every(x => x.ok), steps, at: now() }; await putSet('ms365_test', JSON.stringify(res)); return res;
  }));
  S.put('/maildesk/connections/onedrive', wrap(async req => {
    await needAdmin(req); const b = req.body || {}, account = str(b.account, 320).toLowerCase(), folder = str(b.folder, 200).replace(/^\/+|\/+$/g, '') || 'Resumes';
    if (!L.isEmail(account)) throw bad('OneDrive account: the email of the account whose OneDrive keeps the files, e.g. hr@smru.edu.in');
    if (/[\\:*?"<>|#%]|\.\./.test(folder)) throw bad('Folder: letters, numbers, spaces and / only');
    await putSet('onedrive', JSON.stringify({ account, folder })); audit(req, 'setting_change', 'connection', 'onedrive', { account, folder }); return driveOut();
  }));
  S.delete('/maildesk/connections/onedrive', wrap(async req => { await needAdmin(req); await run("DELETE FROM mail.settings WHERE key='onedrive'"); audit(req, 'setting_change', 'connection', 'onedrive', { disconnected: true }); return driveOut(); }));
  S.post('/maildesk/connections/onedrive/test', wrap(async req => {
    await needAdmin(req); const d = await drive(); if (!d?.account) throw bad('Save the OneDrive account first'); const steps = [];
    const step = async (text, fn, why) => { if (steps.some(x => !x.ok)) return; try { const r = await fn(); steps.push({ ok: true, text: typeof text === 'function' ? text(r) : text }); return r; }
      catch (e) { steps.push({ ok: false, text: why(e) }); } };
    const denied = e => e.status === 403 || e.status === 401 ? 'access denied. Add Files.ReadWrite.All (Application) to the app and click Grant admin consent' : e.message;
    await step(r => `Opened the OneDrive of ${d.account}${r?.quota?.remaining ? ` (${Math.round(r.quota.remaining / 1073741824)} GB free)` : ''}`, () => graph('GET', `${mbox(d.account)}/drive?$select=id,quota`),
      e => e.status === 404 ? `${d.account} has no OneDrive yet: sign in once at office.com with that account, or check the address` : denied(e));
    const f = await step(`Folder "${d.folder}" is ready`, () => ensureFolder(d), denied);
    const put = await step('Saved a test file', () => storePut('.onedesk-test.txt', Buffer.from(`ONE Desk test ${now()}`), 'text/plain'), denied);
    await step('Removed the test file', () => storeRemove(put.externalId), denied);
    const res = { ok: steps.every(x => x.ok), steps, at: now() };
    await putSet('onedrive', JSON.stringify({ ...d, web_url: f?.webUrl || d.web_url || null, last_test: res })); return res;
  }));
  void storePut; // used by the HR resumes step next

  await loadMs(); await recover(0); // one process: anything left running or sending is from before this start
  console.log('Mail desk on (MAIL_ENABLED=true)' + (graphReady() ? ` · Microsoft 365 connected (${ms.source === 'env' ? '.env' : 'Mail → Settings'})` : ': Microsoft 365 not connected yet (Mail → Settings → Connections)'));
}
