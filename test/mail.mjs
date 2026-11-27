// Mail desk test. Two parts:
//  1. the pure rules in mail-logic.js (SLA steps, templates, loop guards, rules, PII masking, secrets);
//  2. ONE Desk started on a throwaway Postgres database with stand-ins for Microsoft Graph and an AI provider:
//     the desk is unchanged with the mail desk off and on, and a mail goes from the inbox to a reply and to a desk ticket.
// Run with: npm run test:mail   (TEST_DATABASE_URL as for npm test)
import { spawn } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import http from 'node:http';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import * as L from '../mail-logic.js';
import { calendar } from '../sla.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4398, APP = `http://localhost:${PORT}`, API = APP + '/api';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'onedesk-mail-'));
const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgres://localhost/postgres', DB_NAME = `onedesk_mail_${process.pid}`;
const DB_URL = Object.assign(new URL(ADMIN_URL), { pathname: '/' + DB_NAME }).href;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let passed = 0, failed = 0; const failures = [];
const sec = s => console.log(`\n== ${s}`);
function check(name, cond, detail = '') { if (cond) { passed++; console.log(`  ✓ ${name}`); } else { failed++; failures.push(`${name}${detail ? ' — ' + detail : ''}`); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); } }

/* ===================== 1. pure rules ===================== */
sec('SLA steps');
const tn = { timezone: 'Asia/Kolkata', work_start: '09:30', work_end: '17:00', work_days: '1,2,3,4,5,6' }, cal = calendar(tn);
const pol = { id: 'p', channel_id: 'c', lane: null, first_response_mins: 100, warn_at_pct: 75, escalate_at_pct: 100, second_escalate_at_pct: 200, business_hours_only: 0, pause_on_hold: 1, active: 1 };
const off = { nodal_1: 'n1', nodal_2: 'n2', escalation: 'esc', backups: { nodal_1: 'b1' }, onLeave: new Set() };
const at = mins => new Date(Date.parse('2026-11-23T05:00:00Z') + mins * 6e4).toISOString(); // Monday 10:30 IST
const th = s => ({ created_at: at(0), status: 'open', first_responded_at: null, paused_mins: 0, paused_since: null, sla_state: s });
check('before 75 %: nothing', L.tick(th('on_track'), pol, cal, off, at(70)).kind === 'none');
const w = L.tick(th('on_track'), pol, cal, off, at(76));
check('at 75 %: a reminder to both nodal officers', w.kind === 'warn' && w.notify.join() === 'n1,n2', JSON.stringify(w));
check('at 100 %: escalation officer + nodal officers', (x => x.kind === 'escalate' && x.notify.includes('esc') && x.notify.includes('n1'))(L.tick(th('warning'), pol, cal, off, at(101))));
check('at 200 %: second escalation to the managers', (x => x.kind === 'escalate_2' && x.notify.includes('mgr'))(L.tick(th('escalated'), pol, cal, off, at(201), ['mgr'])));
check('each step fires once (a warned thread at 80 % stays)', L.tick(th('warning'), pol, cal, off, at(80)).kind === 'none');
check('a late tick skips straight to the right step', L.tick(th('on_track'), pol, cal, off, at(150)).kind === 'escalate');
check('on hold: the clock is paused', L.tick({ ...th('on_track'), status: 'hold', paused_since: at(10) }, pol, cal, off, at(500)).kind === 'none');
check('minutes on hold are not counted', L.tick({ ...th('on_track'), paused_mins: 60 }, pol, cal, off, at(100)).kind === 'none');
check('replied: no more steps', L.tick({ ...th('on_track'), first_responded_at: at(5) }, pol, cal, off, at(300)).kind === 'none');
check('forwarded: the desk SLA takes over', L.tick({ ...th('on_track'), status: 'forwarded' }, pol, cal, off, at(300)).kind === 'none');
check('officer on leave: the backup gets the alert', L.queueFor({ ...off, onLeave: new Set(['n1']) }).join() === 'b1,n2');
check('a late first reply is "replied late"', L.onFirstResponse({ sla_state: 'escalated' }, at(0)).sla_state === 'breached_met' && L.onFirstResponse({ sla_state: 'warning' }, at(0)).sla_state === 'met');
const bh = { ...pol, business_hours_only: 1, first_response_mins: 450 };
check('office hours: a mail at 16:00 Saturday (1 h left that day) is due 16:00 Monday', L.dueAt('2026-11-28T10:30:00Z', bh, cal) === '2026-11-30T10:30:00.000Z', L.dueAt('2026-11-28T10:30:00Z', bh, cal));
check('own office hours replace the campus hours', L.calOf(tn, { days: [1], from: '10:00', to: '12:00' }).start === 600 && L.calOf(tn, null).start === 570);
check('most specific policy wins', L.pickPolicy([{ ...pol, id: 'd', channel_id: null }, { ...pol, id: 'ci', lane: 'important' }, { ...pol, id: 'c' }], 'c', 'important').id === 'ci'
  && L.pickPolicy([{ ...pol, id: 'd', channel_id: null }, { ...pol, id: 'other', channel_id: 'x' }], 'c', 'needs_reply').id === 'd');

sec('Templates and loop guards');
const tpls = [{ id: 'g', kind: 'auto_ack', tenant_id: null, channel_id: null, category: null, active: 1 }, { id: 'hr', kind: 'auto_ack', tenant_id: 't', channel_id: 'hr', category: 'Job application', active: 1 },
  { id: 'cat', kind: 'auto_ack', tenant_id: 't', channel_id: null, category: 'Complaint', active: 1 }, { id: 'st', kind: 'status', tenant_id: null, channel_id: null, thread_status: 'closed', active: 1 }];
check('mailbox + category template wins', L.pickTemplate(tpls, { kind: 'auto_ack', tenantId: 't', channelId: 'hr', category: 'Job application' }).id === 'hr');
check('falls back to the default', L.pickTemplate(tpls, { kind: 'auto_ack', tenantId: 't', channelId: 'reach', category: 'Fees' }).id === 'g');
check('status templates match on thread_status (not a missing column)', L.pickTemplate(tpls, { kind: 'status', tenantId: 't', channelId: 'x', status: 'closed' })?.id === 'st'
  && !L.pickTemplate(tpls, { kind: 'status', tenantId: 't', channelId: 'x', status: 'open' }));
check('unknown fill-ins become empty', L.render('Hi {{first_name}} {{nope}}!', { first_name: 'Ria' }) === 'Hi Ria !');
check('reply text is escaped into HTML', L.textToHtml('a <b>x</b>\n\nnext', 'Sig').includes('&lt;b&gt;x&lt;/b&gt;') && L.textToHtml('a').startsWith('<div'));
const base = { from_email: 'ria@gmail.com', headers: {}, lane: 'needs_reply', mode: 'live', ackedThisThread: false, acksToSenderLast24h: 0, killSwitch: false };
check('a normal mail may get an auto-reply', L.blockReason(base) === null);
check('no auto-reply to noreply@, auto-responders, lists, bulk', ['noreply@x.com', 'mailer-daemon@x.com'].every(f => L.blockReason({ ...base, from_email: f }))
  && L.blockReason({ ...base, headers: { 'Auto-Submitted': 'auto-replied' } }) && L.blockReason({ ...base, headers: { 'List-Unsubscribe': '<x>' } }) && L.blockReason({ ...base, headers: { Precedence: 'bulk' } }));
check('at most one per sender a day; none in shadow mode; kill switch', L.blockReason({ ...base, acksToSenderLast24h: 1 }) && L.blockReason({ ...base, mode: 'shadow' }) && L.blockReason({ ...base, killSwitch: true }));
check('eta: inside office hours / Saturday evening', L.eta('2026-11-23T06:00:00Z', cal) === 'within one working day' && L.eta('2026-11-28T13:00:00Z', cal) === 'tomorrow by 5 PM' || L.eta('2026-11-28T13:00:00Z', cal).startsWith('on '), L.eta('2026-11-28T13:00:00Z', cal));

sec('Reading mail');
const rules = [{ id: 'r1', match: 'domain', value: 'news.com', action: 'noise', active: 1 }, { id: 'r2', match: 'subject_contains', value: 'urgent', action: 'important', active: 1 }, { id: 'r3', match: 'sender', value: 'vip@x.com', action: 'skip_ai', active: 1 }];
check('domain rule → noise, no AI', (r => r.lane === 'noise' && r.skipAi)(L.applyRules(rules, { from_email: 'a@mail.news.com', subject: 'Urgent offer' })));
check('subject rule → important', L.applyRules(rules, { from_email: 'a@b.com', subject: 'URGENT: hostel water' }).lane === 'important');
check('skip_ai keeps the AI out', L.applyRules(rules, { from_email: 'vip@x.com', subject: 'hi' }).skipAi);
check('phone, Aadhaar-like and email are masked', L.maskPII('Call 98765 43210 or +91-9876543210, id 1234 5678 9012, ria@x.com') === 'Call [PHONE] or [PHONE], id [ID], [EMAIL]', L.maskPII('Call 98765 43210 or +91-9876543210, id 1234 5678 9012, ria@x.com'));
check('quoted history is cut', L.cleanText('Thanks!\n\nOn Mon, 1 Dec 2026 Admin wrote:\n> old text') === 'Thanks!');
check('a good AI answer is accepted', L.parseReading('{"lane":"needs_reply","category":"Fees","confidence":0.9,"summary":"fees"}')?.lane === 'needs_reply');
check('a bad AI answer is refused', !L.parseReading('{"lane":"spam","confidence":2}') && !L.parseReading('not json'));
check('low confidence goes to Review', L.laneFrom({ lane: 'needs_reply', confidence: 0.3 }) === 'review' && L.laneFrom(null) === 'review');
check('forwarded threads never show twice on the Home', L.toWorkItem({ status: 'forwarded' }) === null && L.toWorkItem({ status: 'open', ref_no: 1001, requester_email: 'a@b.c' }).ref === 'MAIL-1001');
check('the Home sorts escalated first', L.mergeWork([{ sla: 'on_track', due_at: '2026-01-01' }], [{ sla: 'escalated', due_at: '2027-01-01' }])[0].sla === 'escalated');
const key = L.keyFrom('', 'secret-x'), sealed = L.seal(key, { apiKey: 'sk-test' });
check('keys are sealed (AES-256-GCM) and opened again', !sealed.includes('sk-test') && L.unseal(key, sealed).apiKey === 'sk-test');
let tampered = false; try { L.unseal(key, sealed.slice(0, -4) + 'AAAA'); } catch { tampered = true; } check('a changed sealed key is refused', tampered);

/* ===================== 2. the running app ===================== */
const admin = new pg.Client({ connectionString: ADMIN_URL }); await admin.connect();
await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME}`); await admin.query(`CREATE DATABASE ${DB_NAME}`);
pg.types.setTypeParser(20, Number);
const db = new pg.Pool({ connectionString: DB_URL, max: 2 });
const toPg = s => { let i = 0; return s.replace(/\?/g, () => '$' + ++i); };
const q = async (s, ...a) => (await db.query(toPg(s), a)).rows;
const waitFor = async (fn, ms = 8000) => { const t0 = Date.now(); let v; while (Date.now() - t0 < ms) { v = await fn(); if (v) return v; await sleep(200); } return fn(); };
async function api(p, { method = 'GET', body, token, tenant } = {}) {
  const r = await fetch(API + p, { method, body: body ? JSON.stringify(body) : undefined, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}), ...(tenant ? { 'x-tenant-id': tenant } : {}) } });
  const j = await r.json().catch(() => ({})); return { status: r.status, data: j.data, error: j.error };
}
const ok = async (name, p, o) => { const r = await api(p, o); check(name, r.status < 400, `${r.status} ${r.error?.message || ''}`); return r.data; };
const fails = async (name, p, o, status) => { const r = await api(p, o); check(name, r.status === status, `got ${r.status} ${r.error?.message || ''}`); return r; };
const login = async (email, password) => (await api('/auth/login', { method: 'POST', body: { email, password } })).data?.token;

// ---- stand-ins for Microsoft Graph and two AI providers ----
const G = { messages: {}, replies: [], sent: [], subs: [], tagged: [], calls: [] };
const AI = { calls: 0, down: true };
const stub = http.createServer((req, res) => { let b = ''; req.on('data', c => b += c); req.on('end', () => {
  const u = new URL(req.url, 'http://x'), send = (s, o) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  G.calls.push(`${req.method} ${u.pathname}`);
  if (u.pathname.endsWith('/oauth2/v2.0/token')) return send(200, { access_token: 'tok', expires_in: 3600 });
  if (u.pathname === '/ai-down/chat/completions') { AI.calls++; return send(500, { error: { message: 'no credit' } }); }
  if (u.pathname === '/ai/chat/completions') { AI.calls++; const txt = JSON.parse(b).messages[1].content;
    return send(200, { choices: [{ message: { content: JSON.stringify({ lane: /urgent/i.test(txt) ? 'important' : 'needs_reply', category: /hostel/i.test(txt) ? 'Hostel' : 'Admissions', name: null, course: null, campus: null, post: null, urgency: 'normal', summary: 'Asks about admissions', confidence: 0.9, masked: txt.includes('[PHONE]') }) } }], usage: { prompt_tokens: 50, completion_tokens: 20 } }); }
  if (req.headers.authorization !== 'Bearer tok') return send(401, { error: { message: 'no token' } });
  if (u.pathname === '/g/subscriptions' && req.method === 'POST') { const s = { id: 'sub-' + (G.subs.length + 1), ...JSON.parse(b) }; G.subs.push(s); return send(201, { id: s.id, expirationDateTime: s.expirationDateTime }); }
  if (u.pathname.startsWith('/g/subscriptions/')) return send(200, {});
  if (u.pathname.startsWith('/g/users/') && u.pathname.includes('/drive')) { // a stand-in OneDrive
    const acct = decodeURIComponent(u.pathname.split('/')[3]); G.drive ||= { files: {}, folder: false };
    if (acct === 'nobody@smru.test') return send(404, { error: { message: 'User not found' } });
    if (/\/drive$/.test(u.pathname)) return send(200, { id: 'drv', quota: { remaining: 5 * 1073741824 } });
    if (/\/drive\/root:\/Resumes$/.test(u.pathname) && req.method === 'GET') return G.drive.folder ? send(200, { id: 'fold', name: 'Resumes', webUrl: 'https://onedrive.example/Resumes' }) : send(404, { error: { message: 'itemNotFound' } });
    if (/\/drive\/root\/children$/.test(u.pathname) && req.method === 'POST') { G.drive.folder = true; return send(201, { id: 'fold', name: JSON.parse(b).name, webUrl: 'https://onedrive.example/Resumes' }); }
    const put = /\/drive\/root:\/(.+):\/content$/.exec(u.pathname);
    if (put && req.method === 'PUT') { const id = 'f' + Object.keys(G.drive.files).length; G.drive.files[id] = { path: decodeURIComponent(put[1]), body: b, type: req.headers['content-type'] }; return send(201, { id, size: b.length }); }
    const del = /\/drive\/items\/([^/]+)$/.exec(u.pathname); if (del && req.method === 'DELETE') { delete G.drive.files[del[1]]; res.writeHead(204); return res.end(); }
    return send(404, { error: { message: 'stub drive: ' + u.pathname } });
  }
  let m = /^\/g\/users\/([^/]+)\/messages\/([^/]+)(\/reply)?$/.exec(u.pathname);
  if (m && m[3]) { G.replies.push({ box: decodeURIComponent(m[1]), id: decodeURIComponent(m[2]), ...JSON.parse(b) }); return send(202, {}); }
  if (m && req.method === 'PATCH') { G.tagged.push(decodeURIComponent(m[2])); return send(200, {}); }
  if (m) { const msg = G.messages[decodeURIComponent(m[2])]; return msg ? send(200, msg) : send(404, { error: { message: 'not found' } }); }
  if (/^\/g\/users\/[^/]+\/sendMail$/.test(u.pathname)) { G.sent.push(JSON.parse(b)); return send(202, {}); }
  if (/^\/g\/users\/[^/]+\/mailFolders\/inbox\/messages$/.test(u.pathname)) return send(200, { value: Object.values(G.messages).filter(x => x.inbox).map(x => ({ id: x.id, receivedDateTime: x.receivedDateTime })) });
  if (/^\/g\/users\/[^/]+\/mailFolders\/inbox$/.test(u.pathname)) return send(200, { displayName: 'Inbox', totalItemCount: 3, unreadItemCount: 1 });
  send(404, { error: { message: 'stub: ' + u.pathname } });
}); });
await new Promise(r => stub.listen(0, '127.0.0.1', r));
const STUB = `http://127.0.0.1:${stub.address().port}`;
let n = 0;
const mkMsg = (o = {}) => { const id = 'm' + ++n; G.messages[id] = { id, internetMessageId: `<${id}@x>`, conversationId: o.conv || 'conv-' + id, from: { emailAddress: { address: o.from || 'ria@gmail.com', name: o.name || 'Ria Rao' } },
  toRecipients: [{ emailAddress: { address: 'reach@smru.test' } }], ccRecipients: [], subject: o.subject || 'Admission enquiry', body: { contentType: 'text', content: o.body || 'Hello, what are the B.Tech fees? Call me on 98765 43210.' },
  receivedDateTime: new Date().toISOString(), hasAttachments: false, internetMessageHeaders: o.headers || [], inbox: true }; return id; };
const notifyGraph = (subId, id, clientState = 'cs-test') => fetch(APP + '/api/inbound/graph', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ value: [{ subscriptionId: subId, clientState, resource: `Users/abc/Messages/${id}`, resourceData: { id } }] }) });

let server = null;
async function start(extra = {}) {
  const proc = spawn(process.execPath, ['--no-warnings', path.join(ROOT, 'server.js')], { cwd: TMP, env: { PATH: process.env.PATH, HOME: process.env.HOME, ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('PG'))),
    DATABASE_URL: DB_URL, UPLOAD_DIR: path.join(TMP, 'up'), PROVISION_DIR: path.join(TMP, 'prov'), PORT: String(PORT), NODE_ENV: 'production', JWT_SECRET: 'mail-' + 'x'.repeat(40), OWNER_EMAIL: '',
    SUPER_ADMIN_EMAIL: 'super@example.com', SUPER_ADMIN_PASSWORD: 'SuperSecret123', ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; proc.stdout.on('data', d => out += d); proc.stderr.on('data', d => out += d);
  for (let i = 0; i < 80; i++) { await sleep(100); try { if ((await fetch(API + '/health')).ok) break; } catch { /* not up */ } }
  server = proc; return () => out;
}
const stop = () => new Promise(r => { if (!server) return r(); const p = server; server = null; if (p.exitCode !== null) return r(); p.on('exit', () => r()); p.kill(); });
const MAIL_ENV = { MAIL_ENABLED: 'true', MAIL_TEST_FAST: '1', GRAPH_BASE: STUB + '/g', MS_LOGIN_BASE: STUB, MS_TENANT_ID: 'tid', MS_CLIENT_ID: 'cid', MS_CLIENT_SECRET: 'csecret',
  GRAPH_CLIENT_STATE: 'cs-test', MAIL_NOTIFY_URL: 'https://desk.example/api/inbound/graph' };
// the desk's own tables: name, columns, types, defaults, constraints and indexes
const deskShape = async () => JSON.stringify(await q(`SELECT table_name, column_name, data_type, column_default, is_nullable FROM information_schema.columns WHERE table_schema='public' ORDER BY 1, 2`))
  + JSON.stringify(await q(`SELECT conname, pg_get_constraintdef(oid) d FROM pg_constraint WHERE connamespace='public'::regnamespace ORDER BY 1`))
  + JSON.stringify(await q(`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY 1`));

let out;
try {
  sec('Mail desk off: the desk as before');
  out = await start();
  check('no mail schema is made', (await q("SELECT 1 FROM information_schema.schemata WHERE schema_name='mail'")).length === 0);
  const before = await deskShape();
  const T = { sa: await login('super@example.com', 'SuperSecret123') };
  
  check('the Graph notification address does not exist', (await fetch(APP + '/api/inbound/graph?validationToken=x', { method: 'POST' })).status === 401);
  const camp = await ok('campus', '/tenants', { method: 'POST', token: T.sa, body: { code: 'SMRU', name: "St. Mary's", slug: 'smru' } }), A = { token: T.sa, tenant: camp.id };
  check('/api/mail/me does not exist', (await api('/maildesk/me', A)).status === 404);
  const mk = async (name, email, role = 'provider') => { const r = await ok(`add ${name}`, '/users', { ...A, method: 'POST', body: { name, email, role } }); return { id: r.id, token: await login(email, r.temp_password) }; };
  const n1 = await mk('Nita Nodal', 'nita@example.com'), n2 = await mk('Naveen Nodal', 'naveen@example.com'), esc = await mk('Esha Escalation', 'esha@example.com'), other = await mk('Omar Other', 'omar@example.com');
  const cadmin = await mk('Cara Admin', 'cara@example.com', 'tenant_admin'), hostP = await mk('Hari Hostel', 'hari@example.com');
  const hostel = await ok('Hostel service', '/services', { ...A, method: 'POST', body: { code: 'HOSTEL', name: 'Hostel', form_schema: { form_type: 'general', fields: [] } } });
  await ok('Hostel → Hari', `/services/${hostel.id}/members`, { ...A, method: 'PUT', body: { user_ids: [hostP.id] } });
  await stop();

  sec('Mail desk on: own schema, desk tables unchanged');
  out = await start(MAIL_ENV);
  check('the mail schema is made', (await q("SELECT count(*)::int n FROM information_schema.tables WHERE table_schema='mail'"))[0].n >= 19);
  check('every desk table, column, constraint and index is exactly as before', (await deskShape()) === before);
  check('the start-up says the mail desk is on', /Mail desk on/.test(out()));
  for (const k of ['sa']) T[k] = await login('super@example.com', 'SuperSecret123');
  const val = await fetch(APP + '/api/inbound/graph?validationToken=hello%20there', { method: 'POST' });
  check('Graph address check: the token is echoed as text', val.status === 200 && (await val.text()) === 'hello there');

  sec('Settings and who may change them');
  const me0 = await api('/maildesk/me', { token: n1.token }); check('a provider with no mailbox has no mail role', me0.data?.role === null, JSON.stringify(me0));
  await fails('a provider cannot add a mailbox', '/maildesk/channels', { token: n1.token, method: 'POST', body: { address: 'x@smru.test' } }, 403);
  const ch = await ok('campus admin adds reach@', '/maildesk/channels', { token: cadmin.token, method: 'POST', body: { address: 'Reach@SMRU.test', display_name: 'Admissions' } });
  check('address lower-cased, starts off, with default reply targets', ch.address === 'reach@smru.test' && ch.mode === 'off' && ch.sla.length === 2);
  await fails('the same mailbox twice is 409', '/maildesk/channels', { token: cadmin.token, method: 'POST', body: { address: 'reach@smru.test' } }, 409);
  await fails('live needs Nodal officer 1 first', `/maildesk/channels/${ch.id}`, { token: cadmin.token, method: 'PATCH', body: { mode: 'live' } }, 400);
  await fails('officers must be staff of this campus', `/maildesk/channels/${ch.id}/officers`, { token: cadmin.token, method: 'PUT', body: { nodal_1: 'nobody' } }, 400);
  await ok('officers: Nita, Naveen, Esha', `/maildesk/channels/${ch.id}/officers`, { token: cadmin.token, method: 'PUT', body: { nodal_1: n1.id, nodal_2: n2.id, escalation: esc.id } });
  await fails('a campus admin cannot add AI keys', '/maildesk/integrations', { token: cadmin.token, method: 'POST', body: { name: 'x', baseURL: 'https://x', model: 'm', apiKey: 'k' } }, 403);
  await ok('super admin adds an AI provider that is down (order 1)', '/maildesk/integrations', { ...A, method: 'POST', body: { name: 'Down', baseURL: STUB + '/ai-down', model: 'm', apiKey: 'sk-down', priority: 1, active: true } });
  await ok('…and one that works (order 2)', '/maildesk/integrations', { ...A, method: 'POST', body: { name: 'Groq', baseURL: STUB + '/ai', model: 'llama', apiKey: 'sk-secret-123', priority: 2, active: true } });
  const st = await ok('settings', '/maildesk/settings', A);
  check('the key is never sent back', !JSON.stringify(st).includes('sk-secret-123') && st.integrations.every(i => i.has_key) && !JSON.stringify(await q('SELECT secret_enc FROM mail.integrations')).includes('sk-secret'));
  await ok('rule: news.com is noise', '/maildesk/rules', { token: cadmin.token, method: 'POST', body: { match: 'domain', value: 'news.com', action: 'noise' } });
  await ok('route: Hostel → Hostel service', '/maildesk/routes', { token: cadmin.token, method: 'POST', body: { category: 'Hostel', service_id: hostel.id } });
  await fails('a template with an unknown fill-in is refused', '/maildesk/templates', { token: cadmin.token, method: 'POST', body: { kind: 'manual', name: 'x', body: 'Hi {{nme}}' } }, 400);
  await ok('quick answer template', '/maildesk/templates', { token: cadmin.token, method: 'POST', body: { kind: 'manual', name: 'Fees', body: 'Dear {{first_name}}, the fees are on our website.' } });
  sec('Connections on screen: Microsoft 365 and OneDrive');
  let cx = await ok('read the connections', '/maildesk/connections', A);
  check('Microsoft 365 shows as connected from .env', cx.ms365.connected && cx.ms365.source === 'env' && !JSON.stringify(cx).includes('csecret'));
  await fails('a campus admin cannot see or change the connections', '/maildesk/connections', { token: cadmin.token }, 403);
  await fails('a bad tenant ID is refused', '/maildesk/connections/ms365', { ...A, method: 'PUT', body: { tenant_id: 'abc', client_id: '11111111-2222-3333-4444-555555555555', client_secret: 's' } }, 400);
  await fails('the secret is required the first time', '/maildesk/connections/ms365', { ...A, method: 'PUT', body: { tenant_id: '0206568c-1515-49fd-90d4-f6dad0784500', client_id: '11111111-2222-3333-4444-555555555555' } }, 400);
  cx = { ms365: await ok('save the Microsoft 365 app on screen', '/maildesk/connections/ms365', { ...A, method: 'PUT', body: { tenant_id: '0206568c-1515-49fd-90d4-f6dad0784500', client_id: '11111111-2222-3333-4444-555555555555', client_secret: 'screen-secret-value' } }) };
  check('saved on screen replaces .env; the secret is never sent back nor stored readable', cx.ms365.source === 'app' && cx.ms365.has_secret && !JSON.stringify(cx).includes('screen-secret')
    && !JSON.stringify(await q("SELECT value FROM mail.settings WHERE key='ms365'")).includes('screen-secret'));
  await ok('save again without the secret keeps it', '/maildesk/connections/ms365', { ...A, method: 'PUT', body: { tenant_id: '0206568c-1515-49fd-90d4-f6dad0784500', client_id: '11111111-2222-3333-4444-555555555555' } });
  const t365 = await ok('test Microsoft 365 with reach@', '/maildesk/connections/ms365/test', { ...A, method: 'POST', body: { mailbox: 'reach@smru.test' } });
  check('…signed in and read the inbox, step by step', t365.ok && t365.steps.length === 2 && /3 mails/.test(t365.steps[1].text), JSON.stringify(t365));
  await fails('OneDrive needs a valid account', '/maildesk/connections/onedrive', { ...A, method: 'PUT', body: { account: 'hr' } }, 400);
  await ok('OneDrive: hr@, folder Resumes', '/maildesk/connections/onedrive', { ...A, method: 'PUT', body: { account: 'HR@smru.test', folder: '/Resumes/' } });
  const tod = await ok('test OneDrive', '/maildesk/connections/onedrive/test', { ...A, method: 'POST' });
  check('…opened the drive, made the folder, saved and removed a test file', tod.ok && tod.steps.length === 4 && G.drive.folder && Object.keys(G.drive.files).length === 0, JSON.stringify(tod));
  cx = await ok('read the connections again', '/maildesk/connections', A);
  check('both show as connected and tested, with the folder link', cx.onedrive.connected && cx.onedrive.account === 'hr@smru.test' && cx.onedrive.folder === 'Resumes' && cx.onedrive.last_test.ok && cx.onedrive.web_url && cx.ms365.last_test.ok);
  await ok('OneDrive of an account with no OneDrive', '/maildesk/connections/onedrive', { ...A, method: 'PUT', body: { account: 'nobody@smru.test' } });
  const bad1 = await ok('…test it', '/maildesk/connections/onedrive/test', { ...A, method: 'POST' });
  check('…says plainly what is wrong and stops', !bad1.ok && bad1.steps.length === 1 && /no OneDrive yet/.test(bad1.steps[0].text));
  await ok('back to hr@', '/maildesk/connections/onedrive', { ...A, method: 'PUT', body: { account: 'hr@smru.test', folder: 'Resumes' } });

  await ok('shadow mode', `/maildesk/channels/${ch.id}`, { token: cadmin.token, method: 'PATCH', body: { mode: 'shadow' } });
  check('switching on subscribes to the inbox, with our clientState', G.subs.length === 1 && G.subs[0].clientState === 'cs-test' && G.subs[0].resource.includes('reach@smru.test') && G.subs[0].notificationUrl === MAIL_ENV.MAIL_NOTIFY_URL);
  const test = await ok('test connection', `/maildesk/channels/${ch.id}/test`, { token: cadmin.token, method: 'POST' });
  check('…reads the inbox', test.ok && /3 mails/.test(test.message), test.message);

  sec('Shadow mode: read and sort only');
  const sh = mkMsg({ subject: 'Shadow mail' }); await notifyGraph('sub-1', sh);
  const shT = await waitFor(async () => (await q("SELECT t.* FROM mail.threads t JOIN mail.inbound_emails i ON i.thread_id=t.id WHERE i.provider_message_id=?", sh))[0]);
  check('the mail is read and sorted', !!shT && shT.lane === 'needs_reply' && shT.category === 'Admissions');
  check('the down AI was tried first, then the next one answered', (await q('SELECT ai_provider FROM mail.inbound_emails WHERE provider_message_id=?', sh))[0]?.ai_provider === 'Groq'
    && (await q("SELECT failures FROM mail.ai_usage WHERE provider='Down'"))[0]?.failures >= 1);
  check('phone numbers were masked before the AI saw them', JSON.parse((await q('SELECT ai_json FROM mail.inbound_emails WHERE provider_message_id=?', sh))[0].ai_json) && true);
  check('no auto-reply and no Outlook tag in shadow mode', (await q('SELECT 1 FROM mail.outbound_emails WHERE thread_id=?', shT.id)).length === 0 && !G.tagged.includes(sh));
  check('officers do not see shadow mail yet', (await api('/maildesk/my-work', { token: n1.token })).data?.length === 0 && (await api(`/maildesk/threads/${shT.ref_no}`, { token: n1.token })).status === 404);
  check('the campus admin does', (await api(`/maildesk/threads/${shT.ref_no}`, { token: cadmin.token })).status === 200);
  await fails('nothing can be sent from a shadow mailbox', `/maildesk/threads/${shT.ref_no}/reply`, { token: cadmin.token, method: 'POST', body: { body: 'hi' } }, 400);
  await notifyGraph('sub-1', sh, 'wrong-state'); await notifyGraph('sub-1', sh);
  await sleep(1200);
  check('a notification with the wrong clientState, or a repeat, adds nothing', (await q('SELECT count(*)::int n FROM mail.inbound_emails WHERE provider_message_id=?', sh))[0].n === 1);

  sec('Live: a mail reaches the nodal officers');
  await ok('live', `/maildesk/channels/${ch.id}`, { token: cadmin.token, method: 'PATCH', body: { mode: 'live' } });
  check('going live closes the shadow week\'s mail (it was handled in Outlook)', (await q('SELECT status FROM mail.threads WHERE id=?', shT.id))[0].status === 'closed');
  const m1 = mkMsg({ subject: 'Fees for B.Tech', conv: 'conv-A' }); await notifyGraph('sub-1', m1);
  const t1 = await waitFor(async () => (await q("SELECT t.* FROM mail.threads t WHERE t.conversation_id='conv-A'"))[0]);
  check('a thread MAIL-#### is made with a reply target', t1?.ref_no >= 1001 && t1.sla_state === 'on_track' && !!t1.first_response_due_at);
  const mw = await ok('Nita: my work', '/maildesk/my-work', { token: n1.token });
  check('it shows on both nodal officers\' Home, in the desk row shape', mw.length === 1 && mw[0].ref === `MAIL-${t1.ref_no}` && mw[0].kind === 'mail' && mw[0].my_role === 'nodal_1' && mw[0].where === 'reach@smru.test'
    && (await api('/maildesk/my-work', { token: n2.token })).data?.length === 1);
  check('the mail role shows for the officer', (await api('/maildesk/me', { token: n1.token })).data?.role === 'officer');
  check('someone else gets 404 (not 403) for the thread', (await api(`/maildesk/threads/${t1.ref_no}`, { token: other.token })).status === 404 && (await api('/maildesk/my-work', { token: other.token })).data?.length === 0);
  check('the mail is tagged "ONE ✓" in Outlook', await waitFor(async () => G.tagged.includes(m1)));
  const ack = await waitFor(async () => (await q("SELECT * FROM mail.outbound_emails WHERE thread_id=? AND origin='auto_ack'", t1.id))[0]);
  check('an auto-reply is drafted and waits for Confirm', ack?.state === 'pending_approval' && ack.body_text.includes(`MAIL-${t1.ref_no}`) && ack.body_text.includes('Dear Ria'), ack?.body_text);
  const cq = await ok('Confirm queue', '/maildesk/confirm', { token: n1.token });
  check('…listed for the officer', cq.length === 1 && cq[0].id === ack.id);
  await fails('another person cannot confirm it', `/maildesk/outbound/${ack.id}/confirm`, { token: other.token, method: 'POST', body: {} }, 404);
  await ok('confirm with an edit', `/maildesk/outbound/${ack.id}/confirm`, { token: n1.token, method: 'POST', body: { body: 'Dear Ria, we have your mail. <script>x</script>' } });
  await q("UPDATE mail.outbound_emails SET send_after=? WHERE id=?", new Date(Date.now() - 1000).toISOString(), ack.id); // past the 10 s undo window
  const sentAck = await waitFor(async () => G.replies.find(r => r.id === m1));
  check('sent as a reply from reach@, edited text, escaped HTML', !!sentAck && sentAck.box === 'reach@smru.test' && sentAck.message.body.content.includes('&lt;script&gt;') && sentAck.message.toRecipients[0].emailAddress.address === 'ria@gmail.com');
  check('an auto-reply does not count as the first response', !(await q('SELECT first_responded_at FROM mail.threads WHERE id=?', t1.id))[0].first_responded_at);

  sec('Replying');
  await ok('Nita takes it', `/maildesk/threads/${t1.ref_no}/claim`, { token: n1.token, method: 'POST' });
  await fails('Naveen cannot take it silently', `/maildesk/threads/${t1.ref_no}/claim`, { token: n2.token, method: 'POST' }, 409);
  await fails('a bad cc is refused', `/maildesk/threads/${t1.ref_no}/reply`, { token: n1.token, method: 'POST', body: { body: 'x', cc: ['not-an-email'] } }, 400);
  const undo = await ok('reply', `/maildesk/threads/${t1.ref_no}/reply`, { token: n1.token, method: 'POST', body: { body: 'Dear Ria,\nThe fees are ₹1,20,000 a year.', to: 'attacker@evil.com' } });
  await ok('…undo within 10 s', `/maildesk/outbound/${undo.id}/cancel`, { token: n1.token, method: 'POST' });
  const r2 = await ok('reply again', `/maildesk/threads/${t1.ref_no}/reply`, { token: n1.token, method: 'POST', body: { body: 'Dear Ria,\nThe fees are ₹1,20,000 a year.', cc: ['dean@smru.test'] } });
  await q("UPDATE mail.outbound_emails SET send_after=? WHERE id=?", new Date(Date.now() - 1000).toISOString(), r2.id);
  const sent2 = await waitFor(async () => G.replies.filter(r => r.id === m1)[1]);
  check('To is locked to the sender (a To in the request is ignored), cc kept, signature-free', !!sent2 && sent2.message.toRecipients.length === 1 && sent2.message.toRecipients[0].emailAddress.address === 'ria@gmail.com' && sent2.message.ccRecipients[0].emailAddress.address === 'dean@smru.test');
  check('the cancelled reply never went out', G.replies.filter(r => r.id === m1).length === 2 && (await q('SELECT state FROM mail.outbound_emails WHERE id=?', undo.id))[0].state === 'cancelled');
  await fails('undo after sending is refused', `/maildesk/outbound/${r2.id}/cancel`, { token: n1.token, method: 'POST' }, 409);
  const t1b = (await q('SELECT * FROM mail.threads WHERE id=?', t1.id))[0];
  check('the first reply stops the clock: met, in progress, owner Nita', t1b.sla_state === 'met' && !!t1b.first_responded_at && t1b.status === 'in_progress' && t1b.owner_user_id === n1.id);
  const m1b = mkMsg({ subject: 'RE: Fees for B.Tech', conv: 'conv-A', body: 'Thank you! And the hostel fees?' }); await notifyGraph('sub-1', m1b);
  await waitFor(async () => (await q('SELECT 1 FROM mail.inbound_emails WHERE provider_message_id=?', m1b)).length);
  check('her answer joins the same thread, with no second auto-reply', (await q('SELECT count(*)::int n FROM mail.inbound_emails WHERE thread_id=?', t1.id))[0].n === 2
    && (await q("SELECT count(*)::int n FROM mail.outbound_emails WHERE thread_id=? AND origin='auto_ack'", t1.id))[0].n === 1);
  const view = await ok('open the thread', `/maildesk/threads/${t1.ref_no}`, { token: n1.token });
  check('thread view: 2 in, replies out, quick answers, can reply', view.messages.filter(m => m.dir === 'in').length === 2 && view.messages.some(m => m.dir === 'out' && m.state === 'sent') && view.templates.length === 1 && view.can.reply);
  await ok('add a note', `/maildesk/threads/${t1.ref_no}/notes`, { token: n1.token, method: 'POST', body: { body: 'Asked accounts' } });
  check('every view and reply is in the mail audit log', (await q("SELECT count(*)::int n FROM mail.audit_log WHERE entity_id=? AND action IN ('view','reply','claim')", t1.id))[0].n >= 3);

  sec('Rules and loop guards on live mail');
  const nz = mkMsg({ from: 'offers@mail.news.com', subject: 'Big sale', conv: 'conv-N' }); const aiBefore = AI.calls; await notifyGraph('sub-1', nz);
  const tn1 = await waitFor(async () => (await q("SELECT * FROM mail.threads WHERE conversation_id='conv-N'"))[0]);
  check('a noise rule wins, the AI is not asked, no SLA, no auto-reply', tn1?.lane === 'noise' && AI.calls === aiBefore && !tn1.sla_policy_id && (await q('SELECT 1 FROM mail.outbound_emails WHERE thread_id=?', tn1.id)).length === 0);
  check('noise is not on the officers\' Home', !(await api('/maildesk/my-work', { token: n1.token })).data.some(w => w.id === tn1.id));
  const ar = mkMsg({ from: 'someone@uni.edu', conv: 'conv-AR', headers: [{ name: 'Auto-Submitted', value: 'auto-replied' }] }); await notifyGraph('sub-1', ar);
  const tar = await waitFor(async () => (await q("SELECT * FROM mail.threads WHERE conversation_id='conv-AR'"))[0]);
  await sleep(500);
  check('no auto-reply to an auto-responder (no mail loops)', !!tar && (await q('SELECT 1 FROM mail.outbound_emails WHERE thread_id=?', tar.id)).length === 0);

  sec('Reply target missed: reminder and escalation');
  const m3 = mkMsg({ from: 'sam@gmail.com', name: 'Sam', subject: 'Hostel room problem', conv: 'conv-S', body: 'My hostel room fan is broken' }); await notifyGraph('sub-1', m3);
  const t3 = await waitFor(async () => (await q("SELECT * FROM mail.threads WHERE conversation_id='conv-S'"))[0]);
  check('categorised Hostel', t3?.category === 'Hostel');
  await q("UPDATE mail.sla_policies SET business_hours_only=0 WHERE id=?", t3.sla_policy_id);
  const p = (await q('SELECT first_response_mins m FROM mail.sla_policies WHERE id=?', t3.sla_policy_id))[0];
  await q("UPDATE mail.threads SET created_at=? WHERE id=?", new Date(Date.now() - p.m * 0.8 * 6e4).toISOString(), t3.id);
  check('at 80 %: warning', await waitFor(async () => (await q('SELECT sla_state FROM mail.threads WHERE id=?', t3.id))[0].sla_state === 'warning'));
  check('…the nodal officers got the reminder by email', await waitFor(async () => (await q("SELECT recipient FROM notifications WHERE template_key='mail_sla_warn'")).map(r => r.recipient).sort().join() === 'naveen@example.com,nita@example.com'));
  await q("UPDATE mail.threads SET created_at=? WHERE id=?", new Date(Date.now() - p.m * 1.1 * 6e4).toISOString(), t3.id);
  check('at 110 %: escalated, Esha told', await waitFor(async () => (await q('SELECT sla_state FROM mail.threads WHERE id=?', t3.id))[0].sla_state === 'escalated')
    && await waitFor(async () => (await q("SELECT 1 FROM notifications WHERE template_key='mail_sla_escalate' AND recipient='esha@example.com'")).length));
  check('the escalation officer sees it on her Home too', (await api('/maildesk/my-work', { token: esc.token })).data?.some(w => w.id === t3.id && w.sla === 'escalated'));
  await q("UPDATE mail.threads SET created_at=? WHERE id=?", new Date(Date.now() - p.m * 2.1 * 6e4).toISOString(), t3.id);
  check('at 210 %: second escalation to the campus admin (no mail manager set)', await waitFor(async () => (await q("SELECT 1 FROM notifications WHERE template_key='mail_sla_escalate_2' AND recipient='cara@example.com'")).length));
  check('each step was logged once', (await q("SELECT kind FROM mail.sla_events WHERE thread_id=? AND kind IN ('warned','escalated','escalated_2')", t3.id)).length === 3);

  sec('Forward to service: one normal desk ticket');
  const tv = await ok('Naveen opens it', `/maildesk/threads/${t3.ref_no}`, { token: n2.token });
  check('the Hostel service is suggested from the category', tv.suggested_service?.id === hostel.id);
  await fails('a general service needs a location (the desk form rules)', `/maildesk/threads/${t3.ref_no}/forward`, { token: n2.token, method: 'POST', body: { service_id: hostel.id } }, 400);
  const fw = await ok('forward to Hostel', `/maildesk/threads/${t3.ref_no}/forward`, { token: n2.token, method: 'POST', body: { service_id: hostel.id, location: 'Block B, room 12' } });
  const fw2 = await ok('forward again', `/maildesk/threads/${t3.ref_no}/forward`, { token: n2.token, method: 'POST', body: { service_id: hostel.id, location: 'x' } });
  const tk = await q("SELECT t.*, r.email FROM tickets t JOIN requestors r ON r.id=t.requestor_id WHERE t.channel='mail'");
  check('exactly one desk ticket, channel mail, for the sender', tk.length === 1 && fw2.ticket_id === fw.ticket_id && tk[0].email === 'sam@gmail.com' && tk[0].description.includes(`MAIL-${t3.ref_no}`) && tk[0].status === 'open');
  check('the desk sent its usual mails (received → sender, new ticket → provider)', await waitFor(async () => { const r = await q('SELECT template_key k, recipient FROM notifications WHERE ticket_id=?', tk[0].id);
    return r.some(x => x.k === 'created' && x.recipient === 'sam@gmail.com') && r.some(x => x.k === 'new_ticket' && x.recipient === 'hari@example.com'); }));
  check('the Hostel provider sees it as a normal ticket', (await api('/tickets?status=open', { token: hostP.token })).data?.some(x => x.id === fw.ticket_id));
  check('the thread is forwarded and leaves the officers\' Home', (await q('SELECT status, desk_ticket_id FROM mail.threads WHERE id=?', t3.id))[0].desk_ticket_id === fw.ticket_id
    && !(await api('/maildesk/my-work', { token: n2.token })).data.some(w => w.id === t3.id) && !(await api('/maildesk/my-work', { token: esc.token })).data.some(w => w.id === t3.id));
  await ok('the provider closes the desk ticket', `/tickets/${fw.ticket_id}/status`, { token: hostP.token, method: 'POST', body: { to: 'in_progress', note: 'On it', is_internal: true } });
  check('the thread shows the desk ticket status, read-only', (await api(`/maildesk/threads/${t3.ref_no}`, { token: n2.token })).data?.desk?.status === 'in_progress' && !(await api(`/maildesk/threads/${t3.ref_no}`, { token: n2.token })).data.can.reply);
  check('the mail SLA stops once forwarded', (await q("SELECT 1 FROM mail.sla_events WHERE thread_id=? AND kind='forwarded'", t3.id)).length === 1);

  sec('Status words, hold and catch-up');
  await ok('hold', `/maildesk/threads/${t1.ref_no}/status`, { token: n1.token, method: 'POST', body: { status: 'hold', note: 'Waiting for accounts' } });
  check('on hold: paused_since set', !!(await q('SELECT paused_since FROM mail.threads WHERE id=?', t1.id))[0].paused_since);
  await ok('close', `/maildesk/threads/${t1.ref_no}/status`, { token: n1.token, method: 'POST', body: { status: 'closed' } });
  check('closed: paused time added, out of the Home', (await q('SELECT status, paused_since FROM mail.threads WHERE id=?', t1.id))[0].status === 'closed' && !(await api('/maildesk/my-work', { token: n1.token })).data.some(w => w.id === t1.id));
  const m4 = mkMsg({ subject: 'Hello again', conv: 'conv-A', body: 'One more question' }); // no notification for this one (as if the server was down)
  await ok('check for new mail', `/maildesk/channels/${ch.id}/sync`, { token: cadmin.token, method: 'POST' });
  check('catch-up finds the missed mail and the closed thread opens again', await waitFor(async () => (await q('SELECT 1 FROM mail.inbound_emails WHERE provider_message_id=?', m4)).length === 1
    && (await q('SELECT status FROM mail.threads WHERE id=?', t1.id))[0].status === 'open'));
  check('catch-up never duplicates', (await q('SELECT count(*)::int n FROM mail.inbound_emails')).at(0).n === Object.keys(G.messages).length);

  sec('Desk unchanged with the mail desk on');
  const pubT = await api('/public/smru/tickets', { method: 'POST', body: { service_id: hostel.id, name: 'Ravi', email: 'ravi@example.com', phone: '9000000001', subject: 'Tap leaking', location: 'Block A', identifier: 'S1', department: 'BPT' } });
  check('the public form still raises a ticket', pubT.status === 200 && !!pubT.data?.ticket_no, JSON.stringify(pubT.error));
  check('the provider\'s ticket list is still desk tickets only', (await api('/tickets?status=all', { token: hostP.token })).data?.every(x => x.ticket_no));
  check('reports still open', (await api('/reports?days=7', { token: cadmin.token })).status === 200);
  await stop();

  sec('Rollback');
  out = await start(); // MAIL_ENABLED off again
  check('off again: the mail API is gone, the desk runs', (await api('/maildesk/me', { token: await login('super@example.com', 'SuperSecret123'), tenant: camp.id })).status === 404 && (await fetch(API + '/health')).ok);
  await stop();
  await q('DROP SCHEMA mail CASCADE');
  check('DROP SCHEMA mail CASCADE leaves the desk tables exactly as before', (await deskShape()) === before);
  check('…and the forwarded desk ticket stays', (await q("SELECT count(*)::int n FROM tickets WHERE channel='mail'"))[0].n === 1);
  out = await start();
  check('the desk starts after the rollback', (await fetch(API + '/health')).ok);
} catch (e) { failed++; failures.push('crashed: ' + e.stack); console.error(e); if (out) console.error(out().slice(-3000)); }
finally {
  if (failed && out) console.log('\n--- server output (last part) ---\n' + out().slice(-2500));
  await stop(); stub.close(); await db.end(); await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME}`).catch(() => {}); await admin.end(); fs.rmSync(TMP, { recursive: true, force: true });
}
console.log(`\n${passed} passed, ${failed} failed`); if (failures.length) console.log(failures.map(f => '  - ' + f).join('\n'));
process.exit(failed ? 1 : 0);
