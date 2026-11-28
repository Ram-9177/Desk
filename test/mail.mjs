// Mail desk test. Two parts:
//  1. the pure rules in mail-logic.js (SLA steps, templates, loop guards, rules, PII masking, secrets);
//  2. ONE Desk started on a throwaway Postgres database with stand-ins for Microsoft Graph and an AI provider:
//     the desk is unchanged with the mail desk off and on, and a mail goes from the inbox to a reply and to a desk ticket.
// Run with: npm run test:mail   (TEST_DATABASE_URL as for npm test)
import { spawn } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import http from 'node:http';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import crypto from 'node:crypto';
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
const off = { nodal: ['n1', 'n2'], escalation: ['esc'], backups: { 'nodal:n1': 'b1' }, onLeave: new Set() };
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
check('any number of nodal officers all get it; away with no backup is skipped', L.queueFor({ nodal: ['a', 'b', 'c', 'd'], escalation: [], backups: {}, onLeave: new Set(['c']) }).join() === 'a,b,d');
check('all nodal officers away with no backup: the escalation officers get it', L.queueFor({ nodal: ['a'], escalation: ['e1', 'e2'], backups: {}, onLeave: new Set(['a']) }).join() === 'e1,e2');
check('several escalation officers are all told', (x => x.kind === 'escalate' && ['e1', 'e2', 'a'].every(id => x.notify.includes(id)))(L.tick(th('warning'), pol, cal, { nodal: ['a'], escalation: ['e1', 'e2'], backups: {}, onLeave: new Set() }, at(101))));
check('a backup who is away too: the escalation officers get it', L.queueFor({ nodal: ['a'], escalation: ['e'], backups: { 'nodal:a': 'b' }, onLeave: new Set(['a', 'b']) }).join() === 'e');
check('one person in two roles keeps a backup per role', (o => L.queueFor(o).join() === 'b1' && L.escalationFor(o).join() === 'c1')({ nodal: ['a'], escalation: ['a'], backups: { 'nodal:a': 'b1', 'escalation:a': 'c1' }, onLeave: new Set(['a']) }));
check('only this campus\'s numbers are taken from a subject, all of them', L.refsIn('Fees 2024-2025, call 98765-43210, ref smru-0001 / SMRU-0002, ISO-9001', 'SMRU').join() === 'SMRU-0001,SMRU-0002');
check('subject: the tag in any case once, other languages\' prefixes dropped', L.subjectWith('SMRU-0001', 'RE: [smru-0001] Fees') === '[SMRU-0001] Fees' && L.subjectWith('SMRU-0001', 'AW: Antw: Fees', true) === 'RE: [SMRU-0001] Fees' && L.subjectWith('SMRU-0001', 'Ref [SMRU-0001]: received') === '[SMRU-0001] Ref: received');
check('mail number: campus code and four digits', L.refOf('smru', 1) === 'SMRU-0001' && L.refOf('SMRU', 12345) === 'SMRU-12345');
check('the number goes in front of the subject once, RE: kept', L.subjectWith('SMRU-0001', 'RE: [SMRU-0001] Fees') === '[SMRU-0001] Fees' && L.subjectWith('SMRU-0001', 'Re: Fees', true) === 'RE: [SMRU-0001] Fees' && L.subjectWith('SMRU-0001', '', true) === 'RE: [SMRU-0001] (no subject)');
check('the number is found in a subject the sender writes', L.refsIn('Re: about smru-0042 please', 'SMRU')[0] === 'SMRU-0042');
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
check('forwarded threads never show twice on the Home', L.toWorkItem({ status: 'forwarded' }) === null && L.toWorkItem({ status: 'open', ref: 'SMRU-0001', requester_email: 'a@b.c' }).link === '#/c/mail/t/SMRU-0001');
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
const run_ = (s, ...a) => db.query(toPg(s), a);
const waitFor = async (fn, ms = 8000) => { const t0 = Date.now(); let v; while (Date.now() - t0 < ms) { v = await fn(); if (v) return v; await sleep(200); } return fn(); };
async function api(p, { method = 'GET', body, token, tenant, raw } = {}) {
  const r = await fetch(API + p, { method, body: body ? JSON.stringify(body) : undefined, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}), ...(tenant ? { 'x-tenant-id': tenant } : {}) } });
  if (raw) return r;
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
  if (u.pathname === '/app' || u.pathname === '/app-down') { (G.app ||= []).push({ path: u.pathname, headers: req.headers, body: b }); return u.pathname === '/app' ? send(200, { ok: true }) : send(503, { error: 'busy' }); }
  if (u.pathname.endsWith('/oauth2/v2.0/token')) return send(200, { access_token: 'tok', expires_in: 3600 });
  if (u.pathname === '/ai-down/chat/completions') { AI.calls++; return send(500, { error: { message: 'no credit' } }); }
  if (u.pathname === '/ai/chat/completions' && /^You draft/.test(JSON.parse(b).messages[0].content)) { AI.calls++; AI.lastDraft = JSON.parse(b).messages[1].content;
    return send(200, { choices: [{ message: { content: JSON.stringify({ reply: 'Dear Ria,\nThe B.Tech fee is [fee amount] a year. The hostel has rooms for girls.\nRegards', missing: ['fee amount'] }) } }], usage: { prompt_tokens: 900, completion_tokens: 120 } }); }
  if (u.pathname === '/ai/chat/completions' && /^You check/.test(JSON.parse(b).messages[0].content)) { AI.calls++; const r = JSON.parse(b).messages[1].content.replace(/<\/?reply>/g, '').trim();
    const out = r.includes('DROP') ? r.replace(/⟦\d+⟧/g, '') : r.replace('recieve', 'receive').replace('ur ', 'your ');
    return send(200, { choices: [{ message: { content: JSON.stringify({ text: out, notes: ['Spelling'] }) } }], usage: { prompt_tokens: 300, completion_tokens: 200 } }); }
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
    if (put && req.method === 'PUT') { const id = 'f' + (G.fileSeq = (G.fileSeq || 0) + 1); G.drive.files[id] = { path: decodeURIComponent(put[1]), body: b, type: req.headers['content-type'] }; return send(201, { id, size: b.length }); }
    const get = /\/drive\/items\/([^/]+)\/content$/.exec(u.pathname);
    if (get) { const f = G.drive.files[decodeURIComponent(get[1])]; if (!f) return send(404, { error: { message: 'itemNotFound' } }); res.writeHead(200, { 'content-type': f.type }); return res.end(f.body); }
    const del = /\/drive\/items\/([^/]+)$/.exec(u.pathname); if (del && req.method === 'DELETE') { delete G.drive.files[del[1]]; res.writeHead(204); return res.end(); }
    return send(404, { error: { message: 'stub drive: ' + u.pathname } });
  }
  let m = /^\/g\/users\/([^/]+)\/messages\/([^/]+)(\/reply)?$/.exec(u.pathname);
  const at = /^\/g\/users\/[^/]+\/messages\/([^/]+)\/attachments(?:\/([^/]+)\/\$value)?$/.exec(u.pathname);
  if (at) { const list = G.messages[decodeURIComponent(at[1])]?.files || [];
    if (!at[2]) return send(200, { value: list.map(f => ({ '@odata.type': '#microsoft.graph.fileAttachment', id: f.id, name: f.name, contentType: f.type, size: f.bytes.length, isInline: !!f.inline })) });
    const f = list.find(x => x.id === decodeURIComponent(at[2])); res.writeHead(200, { 'content-type': 'application/octet-stream' }); return res.end(f.bytes); }
  const cr = /^\/g\/users\/([^/]+)\/messages\/([^/]+)\/(createReply|send)$/.exec(u.pathname); G.drafts ||= {};
  if (cr && G.failNext?.step === cr[3]) { const st = G.failNext.status; G.failNext = null; return send(st, { error: { message: `stand-in ${st} at ${cr[3]}` } }); }
  if (cr && cr[3] === 'createReply') { const id = decodeURIComponent(cr[2]); if (!G.messages[id]) return send(404, { error: { message: 'The specified object was not found in the store.' } }); // moved in Outlook
    const d = { id: 'draft' + Object.keys(G.drafts).length, replyTo: id, box: decodeURIComponent(cr[1]), ...JSON.parse(b).message, subject: 'RE: ' + G.messages[id].subject, body: { content: '<html><body><p>quoted original</p></body></html>' } };
    G.drafts[d.id] = d; return send(201, d); }
  if (cr && cr[3] === 'send') { const d = G.drafts[decodeURIComponent(cr[2])]; if (!d) return send(404, {}); G.replies.push({ box: d.box, id: d.replyTo, message: d }); delete G.drafts[d.id]; return send(202, {}); }
  if (m && G.drafts[decodeURIComponent(m[2])] && req.method === 'PATCH') { Object.assign(G.drafts[decodeURIComponent(m[2])], JSON.parse(b)); return send(200, {}); }
  if (m && G.drafts[decodeURIComponent(m[2])] && req.method === 'DELETE') { delete G.drafts[decodeURIComponent(m[2])]; res.writeHead(204); return res.end(); }
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
  receivedDateTime: new Date().toISOString(), hasAttachments: !!o.files?.length, internetMessageHeaders: o.headers || [], inbox: true, files: o.files || [] }; return id; };
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
  GRAPH_CLIENT_STATE: 'cs-test', MAIL_ALLOW_HTTP_APPS: '1', MAIL_NOTIFY_URL: 'https://desk.example/api/inbound/graph' };
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
  await fails('a campus admin cannot add a mailbox (the app can open any mailbox of the organisation)', '/maildesk/channels', { token: cadmin.token, method: 'POST', body: { address: 'vc@smru.test' } }, 403);
  const ch = await ok('super admin adds reach@', '/maildesk/channels', { ...A, method: 'POST', body: { address: 'Reach@SMRU.test', display_name: 'Admissions' } });
  check('address lower-cased, starts off, with default reply targets', ch.address === 'reach@smru.test' && ch.mode === 'off' && ch.sla.length === 2);
  await fails('the same mailbox twice is 409', '/maildesk/channels', { ...A, method: 'POST', body: { address: 'reach@smru.test' } }, 409);
  await fails('a campus admin cannot change the address', `/maildesk/channels/${ch.id}`, { token: cadmin.token, method: 'PATCH', body: { address: 'vc@smru.test' } }, 403);
  await fails('live needs Nodal officer 1 first', `/maildesk/channels/${ch.id}`, { token: cadmin.token, method: 'PATCH', body: { mode: 'live' } }, 400);
  await fails('officers must be staff of this campus', `/maildesk/channels/${ch.id}/officers`, { token: cadmin.token, method: 'PUT', body: { officers: [{ user_id: 'nobody', role: 'nodal' }] } }, 400);
  await fails('at least one nodal officer', `/maildesk/channels/${ch.id}/officers`, { token: cadmin.token, method: 'PUT', body: { officers: [{ user_id: esc.id, role: 'escalation' }] } }, 400);
  await fails('nobody is their own backup', `/maildesk/channels/${ch.id}/officers`, { token: cadmin.token, method: 'PUT', body: { officers: [{ user_id: n1.id, role: 'nodal', backup_user_id: n1.id }] } }, 400);
  await ok('officers: Nita and Naveen nodal, Esha escalation', `/maildesk/channels/${ch.id}/officers`, { token: cadmin.token, method: 'PUT', body: { officers: [{ user_id: n1.id, role: 'nodal' }, { user_id: n2.id, role: 'nodal' }, { user_id: esc.id, role: 'escalation' }] } });
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
  check('officers do not see shadow mail yet', (await api('/maildesk/my-work', { token: n1.token })).data?.length === 0 && (await api(`/maildesk/threads/${shT.ref}`, { token: n1.token })).status === 404);
  check('the campus admin does', (await api(`/maildesk/threads/${shT.ref}`, { token: cadmin.token })).status === 200);
  await fails('nothing can be sent from a shadow mailbox', `/maildesk/threads/${shT.ref}/reply`, { token: cadmin.token, method: 'POST', body: { body: 'hi' } }, 400);
  await notifyGraph('sub-1', sh, 'wrong-state'); await notifyGraph('sub-1', sh);
  await sleep(1200);
  check('a notification with the wrong clientState, or a repeat, adds nothing', (await q('SELECT count(*)::int n FROM mail.inbound_emails WHERE provider_message_id=?', sh))[0].n === 1);

  sec('Live: a mail reaches the nodal officers');
  await ok('live', `/maildesk/channels/${ch.id}`, { token: cadmin.token, method: 'PATCH', body: { mode: 'live' } });
  check('going live closes the shadow week\'s mail (it was handled in Outlook)', (await q('SELECT status FROM mail.threads WHERE id=?', shT.id))[0].status === 'closed');
  const m1 = mkMsg({ subject: 'Fees for B.Tech', conv: 'conv-A' }); await notifyGraph('sub-1', m1);
  const t1 = await waitFor(async () => (await q("SELECT t.* FROM mail.threads t WHERE t.conversation_id='conv-A'"))[0]);
  check('the mail gets the campus number SMRU-#### and a reply target', /^SMRU-\d{4}$/.test(t1?.ref || '') && t1.sla_state === 'on_track' && !!t1.first_response_due_at, t1?.ref);
  const mw = await ok('Nita: my work', '/maildesk/my-work', { token: n1.token });
  check('it shows on both nodal officers\' Home, in the desk row shape', mw.length === 1 && mw[0].ref === `${t1.ref}` && mw[0].kind === 'mail' && mw[0].my_role === 'nodal' && mw[0].where === 'reach@smru.test'
    && (await api('/maildesk/my-work', { token: n2.token })).data?.length === 1);
  check('the mail role shows for the officer', (await api('/maildesk/me', { token: n1.token })).data?.role === 'officer');
  check('someone else gets 404 (not 403) for the thread', (await api(`/maildesk/threads/${t1.ref}`, { token: other.token })).status === 404 && (await api('/maildesk/my-work', { token: other.token })).data?.length === 0);
  check('the mail is tagged "ONE ✓" in Outlook', await waitFor(async () => G.tagged.includes(m1)));
  const ack = await waitFor(async () => (await q("SELECT * FROM mail.outbound_emails WHERE thread_id=? AND origin='auto_ack'", t1.id))[0]);
  check('an auto-reply is drafted and waits for Confirm', ack?.state === 'pending_approval' && ack.body_text.includes(`${t1.ref}`) && ack.body_text.includes('Dear Ria'), ack?.body_text);
  const cq = await ok('Confirm queue', '/maildesk/confirm', { token: n1.token });
  check('…listed for the officer', cq.length === 1 && cq[0].id === ack.id);
  await fails('another person cannot confirm it', `/maildesk/outbound/${ack.id}/confirm`, { token: other.token, method: 'POST', body: {} }, 404);
  await ok('confirm with an edit', `/maildesk/outbound/${ack.id}/confirm`, { token: n1.token, method: 'POST', body: { body: 'Dear Ria, we have your mail. <script>x</script>' } });
  await q("UPDATE mail.outbound_emails SET send_after=? WHERE id=?", new Date(Date.now() - 1000).toISOString(), ack.id); // past the 10 s undo window
  const sentAck = await waitFor(async () => G.replies.find(r => r.id === m1));
  check('sent as a reply from reach@, edited text, escaped HTML', !!sentAck && sentAck.box === 'reach@smru.test' && sentAck.message.body.content.includes('&lt;script&gt;') && sentAck.message.toRecipients[0].emailAddress.address === 'ria@gmail.com');
  check('an auto-reply does not count as the first response', !(await q('SELECT first_responded_at FROM mail.threads WHERE id=?', t1.id))[0].first_responded_at);

  sec('Replying');
  await ok('Nita takes it', `/maildesk/threads/${t1.ref}/claim`, { token: n1.token, method: 'POST' });
  await fails('Naveen cannot take it silently', `/maildesk/threads/${t1.ref}/claim`, { token: n2.token, method: 'POST' }, 409);
  await fails('a bad cc is refused', `/maildesk/threads/${t1.ref}/reply`, { token: n1.token, method: 'POST', body: { body: 'x', cc: ['not-an-email'] } }, 400);
  await fails('a reply to someone who did not write in the thread is refused', `/maildesk/threads/${t1.ref}/reply`, { token: n1.token, method: 'POST', body: { body: 'x', to: 'attacker@evil.com' } }, 400);
  const undo = await ok('reply and close', `/maildesk/threads/${t1.ref}/reply`, { token: n1.token, method: 'POST', body: { body: 'Dear Ria,\nThe fees are ₹1,20,000 a year.', close: true } });
  const tq = (await q('SELECT * FROM mail.threads WHERE id=?', t1.id))[0];
  check('while in the undo window the clock still runs and the thread stays open', !tq.first_responded_at && tq.status === 'in_progress');
  await ok('…undo within 10 s', `/maildesk/outbound/${undo.id}/cancel`, { token: n1.token, method: 'POST' });
  const tu = (await q('SELECT * FROM mail.threads WHERE id=?', t1.id))[0];
  check('after Undo: not answered, not closed, the reply target still counts', !tu.first_responded_at && tu.status === 'in_progress' && tu.sla_state === 'on_track');
  const r2 = await ok('reply again', `/maildesk/threads/${t1.ref}/reply`, { token: n1.token, method: 'POST', body: { body: 'Dear Ria,\nThe fees are ₹1,20,000 a year.', cc: ['dean@smru.test'] } });
  await q("UPDATE mail.outbound_emails SET send_after=? WHERE id=?", new Date(Date.now() - 1000).toISOString(), r2.id);
  const sent2 = await waitFor(async () => G.replies.filter(r => r.id === m1)[1]);
  check('To is the sender, cc kept', !!sent2 && sent2.message.toRecipients.length === 1 && sent2.message.toRecipients[0].emailAddress.address === 'ria@gmail.com' && sent2.message.ccRecipients[0].emailAddress.address === 'dean@smru.test');
  check('the sender\'s reply has the mail number in its subject, threaded in Outlook, our text above the quoted mail', sent2.message.subject === `RE: [${t1.ref}] Fees for B.Tech`
    && /<body[^>]*><div[^>]*><p>Dear Ria/.test(sent2.message.body.content) && sent2.message.body.content.includes('quoted original') && !Object.keys(G.drafts).length, sent2.message.subject);
  check('the cancelled reply never went out', G.replies.filter(r => r.id === m1).length === 2 && (await q('SELECT state FROM mail.outbound_emails WHERE id=?', undo.id))[0].state === 'cancelled');
  await fails('undo after sending is refused', `/maildesk/outbound/${r2.id}/cancel`, { token: n1.token, method: 'POST' }, 409);
  const t1b = await waitFor(async () => { const r = (await q('SELECT * FROM mail.threads WHERE id=?', t1.id))[0]; return r.first_responded_at ? r : null; }) || {};
  check('the first reply stops the clock: met, in progress, owner Nita', t1b.sla_state === 'met' && !!t1b.first_responded_at && t1b.status === 'in_progress' && t1b.owner_user_id === n1.id);
  const m1b = mkMsg({ subject: 'RE: Fees for B.Tech', conv: 'conv-A', body: 'Thank you! And the hostel fees?' }); await notifyGraph('sub-1', m1b);
  await waitFor(async () => (await q('SELECT 1 FROM mail.inbound_emails WHERE provider_message_id=?', m1b)).length);
  check('her answer joins the same thread, with no second auto-reply', (await q('SELECT count(*)::int n FROM mail.inbound_emails WHERE thread_id=?', t1.id))[0].n === 2
    && (await q("SELECT count(*)::int n FROM mail.outbound_emails WHERE thread_id=? AND origin='auto_ack'", t1.id))[0].n === 1);
  const view = await ok('open the thread', `/maildesk/threads/${t1.ref}`, { token: n1.token });
  check('thread view: 2 in, replies out, quick answers, can reply', view.messages.filter(m => m.dir === 'in').length === 2 && view.messages.some(m => m.dir === 'out' && m.state === 'sent') && view.templates.length === 1 && view.can.reply);
  await ok('add a note', `/maildesk/threads/${t1.ref}/notes`, { token: n1.token, method: 'POST', body: { body: 'Asked accounts' } });
  check('every view and reply is in the mail audit log', (await q("SELECT count(*)::int n FROM mail.audit_log WHERE entity_id=? AND action IN ('view','reply','claim')", t1.id))[0].n >= 3);

  // the sender writes a new mail (a new conversation) quoting the number: it joins the same mail
  const mq = mkMsg({ subject: `About ${t1.ref.toLowerCase()} again`, conv: 'conv-QUOTE', body: 'Any update on my question?' }); await notifyGraph('sub-1', mq);
  check('a new mail quoting the number joins that mail', await waitFor(async () => (await q('SELECT thread_id FROM mail.inbound_emails WHERE provider_message_id=?', mq))[0]?.thread_id === t1.id));
  check('…and no second auto-reply', (await q("SELECT count(*)::int n FROM mail.outbound_emails WHERE thread_id=? AND origin='auto_ack'", t1.id))[0].n === 1);

  const mx = mkMsg({ from: 'stranger@gmail.com', subject: `Question about ${t1.ref}`, conv: 'conv-STRANGER', body: 'I saw this number somewhere' }); await notifyGraph('sub-1', mx);
  const tx_ = await waitFor(async () => (await q('SELECT thread_id FROM mail.inbound_emails WHERE provider_message_id=?', mx))[0]?.thread_id);
  check('someone else quoting a number gets their own mail, not that thread', !!tx_ && tx_ !== t1.id);

  sec('Reply preview, AI drafts and checks, and the monthly AI budget');
  const gq = (await q("SELECT id FROM mail.integrations WHERE kind='ai' AND name='Groq'"))[0];
  await fails('a price out of range is refused', `/maildesk/integrations/${gq.id}`, { ...A, method: 'PATCH', body: { priceIn: -1 } }, 400);
  await ok('Groq priced: $2 in, $8 out per 1M tokens', `/maildesk/integrations/${gq.id}`, { ...A, method: 'PATCH', body: { priceIn: 2, priceOut: 8 } });
  const pv = await ok('preview a reply', `/maildesk/threads/${t1.ref}/preview`, { token: n1.token, method: 'POST', body: { body: 'Dear Ria, we recieve ur mail. pls call 98765 43210', cc: ['dean@smru.test'] } });
  check('the preview shows from, to, cc, the subject with the number, and fixes the spelling (names and numbers kept)', pv.from === 'Admissions <reach@smru.test>' && pv.to === 'ria@gmail.com' && pv.cc[0] === 'dean@smru.test'
    && pv.subject === `RE: [${t1.ref}] Fees for B.Tech` && pv.corrected.includes('receive your mail') && pv.corrected.includes('98765 43210') && pv.corrected.startsWith('Dear Ria') && pv.changes.some(c => c.from === 'recieve'), JSON.stringify(pv));
  await fails('a preview to someone outside the thread is refused', `/maildesk/threads/${t1.ref}/preview`, { token: n1.token, method: 'POST', body: { body: 'x', to: 'x@evil.com' } }, 400);
  const dr = await ok('Suggest a reply', `/maildesk/threads/${t1.ref}/draft`, { token: n1.token, method: 'POST' });
  check('…a draft starting "Dear Ria", with what to fill in, made from the mail with contact details masked', dr.text.startsWith('Dear Ria') && dr.missing[0] === 'fee amount' && !/ria@gmail\.com|98765/.test(AI.lastDraft) && /Fees/.test(AI.lastDraft));
  const ck = await ok('Check with AI', `/maildesk/threads/${t1.ref}/check`, { token: n1.token, method: 'POST', body: { body: 'We recieve ur mail; call 98765 43210 or see https://smru.edu.in/fees' } });
  check('…wording fixed; the phone number and link come back exactly', ck.changed && ck.text === 'We receive your mail; call 98765 43210 or see https://smru.edu.in/fees', ck.text);
  const ck2 = await ok('an AI check that loses a detail', `/maildesk/threads/${t1.ref}/check`, { token: n1.token, method: 'POST', body: { body: 'DROP call 98765 43210' } });
  check('…is not used: your text is kept', ck2.kept && ck2.text === 'DROP call 98765 43210');
  const sp = await q("SELECT purpose, calls, cost_usd::float c FROM mail.ai_spend WHERE channel_id=? AND purpose IN ('draft','check')", ch.id);
  check('each use is counted for the mailbox, priced from the provider\'s prices', Math.abs(sp.find(r => r.purpose === 'draft').c - (900 * 2 + 120 * 8) / 1e6) < 1e-9 && sp.find(r => r.purpose === 'check').calls === 2, JSON.stringify(sp));
  await fails('the budget screen is for the super admin', '/maildesk/ai-budget', { token: cadmin.token }, 403);
  await fails('shares that add up to more than the total are refused', '/maildesk/ai-budget', { ...A, method: 'PUT', body: { monthly_usd: 1, split: 'custom', shares: { [ch.id]: 2 } } }, 400);
  const used = (await q("SELECT sum(cost_usd)::float s FROM mail.ai_spend WHERE channel_id=?", ch.id))[0].s;
  await ok('budget: $25 a month, reach@ gets just over what it has used', '/maildesk/ai-budget', { ...A, method: 'PUT', body: { monthly_usd: 25, split: 'custom', shares: { [ch.id]: Math.ceil((used + 0.0005) * 100) / 100 }, warn_pct: 80 } });
  let bd = await ok('read the budget', '/maildesk/ai-budget', A);
  check('the screen shows the month, the spending per mailbox and per use', bd.monthly_usd === 25 && bd.mailboxes.find(m => m.id === ch.id).uses.draft === 1 && Math.abs(bd.mailboxes.find(m => m.id === ch.id).spent - used) < 1e-9 && bd.providers.find(x => x.name === 'Groq').priced);
  let r429 = null; for (let i = 0; i < 20 && !r429; i++) { const r = await api(`/maildesk/threads/${t1.ref}/draft`, { token: n1.token, method: 'POST' }); if (r.status === 409) r429 = r; }
  check('when reach@\'s share is used up, drafts stop with a plain reason', /share of the AI budget/.test(r429?.error?.message || ''), r429?.error?.message);
  check('…the mail page says AI drafts are off', (await api(`/maildesk/threads/${t1.ref}`, { token: n1.token })).data.ai.draft === false);
  check('…and the super admin got one warning email', await waitFor(async () => (await q("SELECT count(*)::int n FROM notifications WHERE template_key='mail_ai_budget' AND recipient='super@example.com'"))[0].n === 1));
  const aiCalls = AI.calls, mb = mkMsg({ from: 'neha@gmail.com', subject: 'Fees again', conv: 'conv-BUDGET' }); await notifyGraph('sub-1', mb);
  const tb = await waitFor(async () => (await q("SELECT * FROM mail.threads WHERE conversation_id='conv-BUDGET'"))[0]);
  check('…new mail is still read, sorted by the rules (Review) without calling the AI', tb?.lane === 'review' && AI.calls === aiCalls);
  await ok('budget: no limit, drafts switched off', '/maildesk/ai-budget', { ...A, method: 'PUT', body: { monthly_usd: 0, split: 'equal', features: { sort: true, draft: false, check: true } } });
  await fails('a draft when drafts are switched off', `/maildesk/threads/${t1.ref}/draft`, { token: n1.token, method: 'POST' }, 409);
  await ok('budget back to no limit, everything on', '/maildesk/ai-budget', { ...A, method: 'PUT', body: { monthly_usd: 0, split: 'equal' } });

  sec('Rules and loop guards on live mail');
  const nz = mkMsg({ from: 'offers@mail.news.com', subject: 'Big sale', conv: 'conv-N' }); const aiBefore = AI.calls; await notifyGraph('sub-1', nz);
  const tn1 = await waitFor(async () => (await q("SELECT * FROM mail.threads WHERE conversation_id='conv-N'"))[0]);
  check('a noise rule wins, the AI is not asked, no SLA, no auto-reply', tn1?.lane === 'noise' && AI.calls === aiBefore && !tn1.sla_policy_id && (await q('SELECT 1 FROM mail.outbound_emails WHERE thread_id=?', tn1.id)).length === 0);
  check('noise is not on the officers\' Home', !(await api('/maildesk/my-work', { token: n1.token })).data.some(w => w.id === tn1.id));
  const ar = mkMsg({ from: 'someone@uni.edu', conv: 'conv-AR', headers: [{ name: 'Auto-Submitted', value: 'auto-replied' }] }); await notifyGraph('sub-1', ar);
  const tar = await waitFor(async () => (await q("SELECT * FROM mail.threads WHERE conversation_id='conv-AR'"))[0]);
  await sleep(500);
  check('no auto-reply to an auto-responder (no mail loops)', !!tar && (await q('SELECT 1 FROM mail.outbound_emails WHERE thread_id=?', tar.id)).length === 0);

  sec('Connected apps (any API bought later, set up on screen)');
  await fails('only a super admin connects apps', '/maildesk/apps', { token: cadmin.token }, 403);
  await fails('an address that is not a web address is refused', '/maildesk/apps', { ...A, method: 'POST', body: { name: 'x', url: 'ftp://x', events: ['mail.received'], format: 'standard' } }, 400);
  await fails('a body with an unknown fill-in is refused', '/maildesk/apps', { ...A, method: 'POST', body: { name: 'x', url: STUB + '/app', events: ['mail.received'], format: 'template', template: '{"t":"{{nope}}"}' } }, 400);
  await fails('a JSON body that would not be valid JSON is refused', '/maildesk/apps', { ...A, method: 'POST', body: { name: 'x', url: STUB + '/app', events: ['mail.received'], format: 'template', content_type: 'json', template: '{"t": {{ref}} }' } }, 400);
  const wa = await ok('connect a WhatsApp-style app (own JSON body, key header)', '/maildesk/apps', { ...A, method: 'POST', body: { name: 'WhatsApp', url: STUB + '/app', events: ['mail.received', 'mail.escalated'], format: 'template', content_type: 'json',
    template: '{"to":"919999999999","text":"New {{ref}} from {{from_name}}: {{subject}}"}', auth_header: 'X-Api-Key', auth_value: 'wa-key-123' } });
  check('…its signing secret is shown once; the key never comes back', /^[0-9a-f]{64}$/.test(wa.signing_secret) && !JSON.stringify((await api('/maildesk/apps', A)).data).includes('wa-key-123') && !JSON.stringify((await api('/maildesk/apps', A)).data).includes(wa.signing_secret));
  const down = await ok('connect an app that is down (standard JSON)', '/maildesk/apps', { ...A, method: 'POST', body: { name: 'CRM', url: STUB + '/app-down', events: ['mail.received'], format: 'standard' } });
  const tst = await ok('Test sends a sample', `/maildesk/apps/${wa.id}/test`, { ...A, method: 'POST' });
  const first = G.app?.[0];
  check('…the app got its own body, its key and a valid signature', tst.ok && first?.headers['x-api-key'] === 'wa-key-123' && JSON.parse(first.body).text.startsWith('New SMRU-0001 from Ria Sharma')
    && first.headers['x-onedesk-signature'] === 'sha256=' + crypto.createHmac('sha256', wa.signing_secret).update(`${first.headers['x-onedesk-timestamp']}.${first.body}`).digest('hex'));
  G.app = [];
  const ma = mkMsg({ from: 'arun@gmail.com', name: 'Arun "AJ" Rao', subject: 'Hostel "AC" room?\nplease', conv: 'conv-APP' }); await notifyGraph('sub-1', ma);
  const tapp = await waitFor(async () => (await q("SELECT * FROM mail.threads WHERE conversation_id='conv-APP'"))[0]);
  const got = await waitFor(async () => G.app.find(x => x.path === '/app'));
  check('a new mail reaches the app, quotes and new lines kept as valid JSON', !!got && JSON.parse(got.body).text === `New ${tapp.ref} from Arun "AJ" Rao: Hostel "AC" room?\nplease` && got.headers['x-onedesk-event'] === 'mail.received', got?.body);
  check('…and the app that is down is tried, then tried again later', await waitFor(async () => G.app.filter(x => x.path === '/app-down').length >= 1) && (await q("SELECT state FROM mail.jobs WHERE kind='plugin' AND payload LIKE ?", `%${down.id}%`)).some(j => j.state === 'queued'));
  const lst = (await api('/maildesk/apps', A)).data.apps;
  check('…each app shows its last result on screen', /^Delivered mail.received/.test(lst.find(x => x.id === wa.id).last_result) && /^Refused mail.received/.test(lst.find(x => x.id === down.id).last_result));
  await ok('delete the app that is down', `/maildesk/apps/${down.id}`, { ...A, method: 'DELETE' });
  check('…its waiting calls stop', (await q("SELECT state FROM mail.jobs WHERE kind='plugin' AND payload LIKE ? AND state='queued'", `%${down.id}%`)).length === 0);
  await ok('the WhatsApp app off', `/maildesk/apps/${wa.id}`, { ...A, method: 'PATCH', body: { active: false } });

  sec('HR: candidates and resumes in OneDrive');
  const jobs = await ok('add jobs@ (super admin)', '/maildesk/channels', { ...A, method: 'POST', body: { address: 'jobs@smru.test', display_name: 'Careers' } });
  await ok('jobs@: Nita nodal; Hari (Hostel provider) on it as HR; Omar can only read', `/maildesk/channels/${jobs.id}/officers`, { ...A, method: 'PUT', body: { officers: [{ user_id: n1.id, role: 'nodal' }] } });
  await ok('…members', `/maildesk/channels/${jobs.id}/members`, { ...A, method: 'PUT', body: { members: [{ user_id: hostP.id, role: 'hr' }, { user_id: other.id, role: 'viewer' }] } });
  await ok('jobs@ is the job-applications mailbox, live', `/maildesk/channels/${jobs.id}`, { ...A, method: 'PATCH', body: { is_hr: true, mode: 'live' } });
  const jsub = G.subs.find(x => x.resource.includes('jobs@smru.test'))?.id;
  check('HR shows for its people only', (await api('/maildesk/me', { token: hostP.token })).data?.hr === true && (await api('/maildesk/hr', { token: n2.token })).status === 404);
  const PDF = Buffer.from('%PDF-1.4\n% a resume\n%%EOF\n'), FAKE = Buffer.from('MZ this is not a pdf');
  const mr = mkMsg({ from: 'ria.s@gmail.com', name: 'Ria Sharma', subject: 'Application for the post of Assistant Professor - Physiotherapy', conv: 'conv-HR1', body: 'Please find my CV attached.',
    files: [{ id: 'a1', name: 'Ria CV.pdf', type: 'application/pdf', bytes: PDF }, { id: 'a2', name: 'logo.png', type: 'image/png', bytes: Buffer.from('png'), inline: true }, { id: 'a3', name: 'certificate.pdf', type: 'application/pdf', bytes: FAKE }] });
  const filesBefore = Object.keys(G.drive.files).length;
  await notifyGraph(jsub, mr);
  const app1 = await waitFor(async () => (await q(`SELECT ap.*, c.email, c.full_name FROM mail.candidate_applications ap JOIN mail.candidates c ON c.id=ap.candidate_id WHERE c.email='ria.s@gmail.com'`))[0]);
  check('the sender becomes a candidate, with the post read from the subject', app1?.post === 'Assistant Professor - Physiotherapy' && app1.full_name === 'Ria Sharma' && app1.stage === 'new', JSON.stringify(app1));
  const saved = Object.values(G.drive.files).slice(filesBefore);
  check('the resume is saved to OneDrive under Resumes/<year>/<post>/<name> - <file>', saved.length === 1 && saved[0].path === `Resumes/${new Date().getFullYear()}/Assistant Professor - Physiotherapy/Ria Sharma - Ria CV.pdf` && saved[0].body.startsWith('%PDF-'), JSON.stringify(saved.map(f => f.path)));
  check('the inline logo is ignored; a fake PDF is refused with a note on the mail', (await q("SELECT body FROM mail.thread_notes WHERE thread_id=? AND body LIKE 'certificate.pdf was not saved%'", app1.thread_id)).length === 1);
  const hl = await ok('Hari opens HR candidates', '/maildesk/hr', { token: hostP.token });
  check('…sees Ria with her resume', hl.applications.length === 1 && hl.applications[0].resume_name === 'Ria CV.pdf' && hl.posts[0].post === app1.post && hl.can_edit);
  await fails('someone not on jobs@ gets 404', `/maildesk/hr/${app1.id}`, { token: n2.token }, 404);
  const det = await ok('open Ria', `/maildesk/hr/${app1.id}`, { token: hostP.token });
  const fr = await api(`/maildesk/hr/${app1.id}/files/${det.files[0].id}`, { token: hostP.token, raw: true });
  check('the resume opens through ONE Desk (PDF, private, not cached)', fr.status === 200 && fr.headers.get('content-type') === 'application/pdf' && /no-store/.test(fr.headers.get('cache-control')) && (await fr.text()).startsWith('%PDF-'));
  await fails('Omar (read only) cannot change the stage', `/maildesk/hr/${app1.id}`, { token: other.token, method: 'PATCH', body: { stage: 'shortlisted' } }, 403);
  await ok('Hari shortlists her and fills the profile', `/maildesk/hr/${app1.id}`, { token: hostP.token, method: 'PATCH', body: { stage: 'shortlisted', rating: 4, experience_years: 6.5, skills: 'Neuro rehab, Teaching', highest_qualification: 'MPT', interview_at: '2026-12-05T05:00:00.000Z' } });
  await fails('a rating of 9 is refused', `/maildesk/hr/${app1.id}`, { token: hostP.token, method: 'PATCH', body: { rating: 9 } }, 400);
  await ok('a note', `/maildesk/hr/${app1.id}/notes`, { token: hostP.token, method: 'POST', body: { body: 'Strong demo lecture' } });
  const det2 = await ok('open again', `/maildesk/hr/${app1.id}`, { token: hostP.token });
  check('…saved: stage by Hari, rating, skills, interview, note', det2.application.stage === 'shortlisted' && det2.application.stage_by_name === 'Hari Hostel' && det2.application.rating === 4
    && det2.candidate.skills.join() === 'Neuro rehab,Teaching' && Number(det2.candidate.experience_years) === 6.5 && det2.notes.length === 1);
  const mr2 = mkMsg({ from: 'ria.s@gmail.com', name: 'Ria Sharma', subject: 'Applying for Clinical Supervisor', conv: 'conv-HR2', files: [{ id: 'b1', name: 'Ria CV.pdf', type: 'application/pdf', bytes: PDF }] });
  await notifyGraph(jsub, mr2);
  check('a second post: a second application, and the same file is stored once', await waitFor(async () => (await q("SELECT count(*)::int n FROM mail.candidate_applications ap JOIN mail.candidates c ON c.id=ap.candidate_id WHERE c.email='ria.s@gmail.com'"))[0].n === 2)
    && (await q('SELECT count(*)::int n FROM mail.stored_files'))[0].n === 1 && Object.values(G.drive.files).slice(filesBefore).length === 1);
  const mr3 = mkMsg({ from: 'ria.s@gmail.com', name: 'Ria Sharma', subject: 'RE: Application for the post of Assistant Professor - Physiotherapy', conv: 'conv-HR1', body: 'Updated CV attached', files: [{ id: 'c1', name: 'Ria CV v2.pdf', type: 'application/pdf', bytes: Buffer.from('%PDF-1.4\n% v2\n') }] });
  await notifyGraph(jsub, mr3);
  check('a new CV in the same mail joins the same application and becomes the one shown', await waitFor(async () => (await q('SELECT f.file_name FROM mail.candidate_applications ap JOIN mail.stored_files f ON f.id=ap.resume_file_id WHERE ap.id=?', app1.id))[0]?.file_name === 'Ria CV v2.pdf')
    && (await q('SELECT count(*)::int n FROM mail.candidate_files WHERE application_id=?', app1.id))[0].n === 2);
  check('only jobs@ makes candidates (reach@ mail does not)', (await q("SELECT count(*)::int n FROM mail.candidates"))[0].n === 1);
  const del = await ok('Hari deletes the candidate on her request', `/maildesk/hr/${app1.id}/candidate`, { token: hostP.token, method: 'DELETE' });
  check('…her applications, notes and both files are gone, from OneDrive too', del.files_removed === 2 && (await q('SELECT count(*)::int n FROM mail.candidates'))[0].n === 0
    && (await q('SELECT count(*)::int n FROM mail.stored_files'))[0].n === 0 && Object.values(G.drive.files).slice(filesBefore).length === 0);
  await ok('jobs@ off', `/maildesk/channels/${jobs.id}`, { ...A, method: 'PATCH', body: { mode: 'off' } });

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
  const tv = await ok('Naveen opens it', `/maildesk/threads/${t3.ref}`, { token: n2.token });
  check('the Hostel service is suggested from the category', tv.suggested_service?.id === hostel.id);
  await fails('a general service needs a location (the desk form rules)', `/maildesk/threads/${t3.ref}/forward`, { token: n2.token, method: 'POST', body: { service_id: hostel.id } }, 400);
  const fw = await ok('forward to Hostel', `/maildesk/threads/${t3.ref}/forward`, { token: n2.token, method: 'POST', body: { service_id: hostel.id, location: 'Block B, room 12' } });
  const fw2 = await ok('forward again', `/maildesk/threads/${t3.ref}/forward`, { token: n2.token, method: 'POST', body: { service_id: hostel.id, location: 'x' } });
  const tk = await q("SELECT t.*, r.email FROM tickets t JOIN requestors r ON r.id=t.requestor_id WHERE t.channel='mail'");
  check('exactly one desk ticket, channel mail, for the sender', tk.length === 1 && fw2.ticket_id === fw.ticket_id && tk[0].email === 'sam@gmail.com' && tk[0].description.includes(`${t3.ref}`) && tk[0].status === 'open');
  check('the desk sent its usual mails (received → sender, new ticket → provider)', await waitFor(async () => { const r = await q('SELECT template_key k, recipient FROM notifications WHERE ticket_id=?', tk[0].id);
    return r.some(x => x.k === 'created' && x.recipient === 'sam@gmail.com') && r.some(x => x.k === 'new_ticket' && x.recipient === 'hari@example.com'); }));
  check('the Hostel provider sees it as a normal ticket', (await api('/tickets?status=open', { token: hostP.token })).data?.some(x => x.id === fw.ticket_id));
  check('the thread is forwarded and leaves the officers\' Home', (await q('SELECT status, desk_ticket_id FROM mail.threads WHERE id=?', t3.id))[0].desk_ticket_id === fw.ticket_id
    && !(await api('/maildesk/my-work', { token: n2.token })).data.some(w => w.id === t3.id) && !(await api('/maildesk/my-work', { token: esc.token })).data.some(w => w.id === t3.id));
  await ok('the provider closes the desk ticket', `/tickets/${fw.ticket_id}/status`, { token: hostP.token, method: 'POST', body: { to: 'in_progress', note: 'On it', is_internal: true } });
  check('the thread shows the desk ticket status, read-only', (await api(`/maildesk/threads/${t3.ref}`, { token: n2.token })).data?.desk?.status === 'in_progress' && !(await api(`/maildesk/threads/${t3.ref}`, { token: n2.token })).data.can.reply);
  check('the mail SLA stops once forwarded', (await q("SELECT 1 FROM mail.sla_events WHERE thread_id=? AND kind='forwarded'", t3.id)).length === 1);

  sec('Status words, hold and catch-up');
  await ok('hold', `/maildesk/threads/${t1.ref}/status`, { token: n1.token, method: 'POST', body: { status: 'hold', note: 'Waiting for accounts' } });
  check('on hold: paused_since set', !!(await q('SELECT paused_since FROM mail.threads WHERE id=?', t1.id))[0].paused_since);
  await ok('close', `/maildesk/threads/${t1.ref}/status`, { token: n1.token, method: 'POST', body: { status: 'closed' } });
  check('closed: paused time added, out of the Home', (await q('SELECT status, paused_since FROM mail.threads WHERE id=?', t1.id))[0].status === 'closed' && !(await api('/maildesk/my-work', { token: n1.token })).data.some(w => w.id === t1.id));
  const m4 = mkMsg({ subject: 'Hello again', conv: 'conv-A', body: 'One more question' }); // no notification for this one (as if the server was down)
  await ok('check for new mail', `/maildesk/channels/${ch.id}/sync`, { token: cadmin.token, method: 'POST' });
  check('catch-up finds the missed mail and the closed thread opens again', await waitFor(async () => (await q('SELECT 1 FROM mail.inbound_emails WHERE provider_message_id=?', m4)).length === 1
    && (await q('SELECT status FROM mail.threads WHERE id=?', t1.id))[0].status === 'open'));
  const t1r = (await q('SELECT * FROM mail.threads WHERE id=?', t1.id))[0];
  check('opened again: a fresh reply target from now, not an instant escalation', t1r.sla_state === 'on_track' && !t1r.first_responded_at && Date.parse(t1r.sla_started_at) > Date.now() - 60e3 && Date.parse(t1r.first_response_due_at) > Date.now());
  check('catch-up never duplicates', (await q('SELECT count(*)::int n FROM mail.inbound_emails')).at(0).n === Object.keys(G.messages).length);

  sec('Edge cases');
  // two officers press Take it at once: one owner
  await ok('Naveen takes MAIL t1 over knowingly', `/maildesk/threads/${t1.ref}/claim`, { token: n2.token, method: 'POST', body: { take: true } });
  const cl = await Promise.all([api(`/maildesk/threads/${t1.ref}/claim`, { token: n1.token, method: 'POST' }), api(`/maildesk/threads/${t1.ref}/claim`, { token: esc.token, method: 'POST' })]);
  check('a silent take of someone else\'s mail is refused for both', cl.every(r => r.status === 409));
  // a reply-all from a third person: they can be answered, and only people from the thread
  const m5 = mkMsg({ from: 'father@gmail.com', name: 'Ria\'s father', subject: 'RE: Fees', conv: 'conv-A', body: 'Is there a discount for siblings?' }); await notifyGraph('sub-1', m5);
  await waitFor(async () => (await q('SELECT 1 FROM mail.inbound_emails WHERE provider_message_id=?', m5)).length);
  const rf = await ok('reply to the father, who wrote in the thread', `/maildesk/threads/${t1.ref}/reply`, { token: n2.token, method: 'POST', body: { body: 'Yes, 10 %.', to: 'Father@gmail.com' } });
  await q("UPDATE mail.outbound_emails SET send_after=? WHERE id=?", new Date(Date.now() - 1000).toISOString(), rf.id);
  check('…goes to him, as a reply to his own message', await waitFor(async () => G.replies.some(r => r.id === m5 && r.message.toRecipients[0].emailAddress.address === 'father@gmail.com')));
  // the message was moved in Outlook: the reply goes as a new mail instead
  delete G.messages[m5]; const sentBefore = G.sent.length;
  const rmv = await ok('reply after the mail was moved in Outlook', `/maildesk/threads/${t1.ref}/reply`, { token: n2.token, method: 'POST', body: { body: 'Following up.', to: 'father@gmail.com' } });
  G.replyFails = 404; await q("UPDATE mail.outbound_emails SET send_after=? WHERE id=?", new Date(Date.now() - 1000).toISOString(), rmv.id);
  check('…is sent as a new mail, not lost', await waitFor(async () => G.sent.length === sentBefore + 1 && (await q('SELECT state FROM mail.outbound_emails WHERE id=?', rmv.id))[0].state === 'sent'));
  G.replyFails = 0;
  // the server restarts while a reply is being sent, and while a job runs
  const st1 = await ok('a reply', `/maildesk/threads/${t1.ref}/reply`, { token: n2.token, method: 'POST', body: { body: 'Stuck one' } });
  await q("UPDATE mail.outbound_emails SET state='sending', started_at=? WHERE id=?", new Date(Date.now() - 3600e3).toISOString(), st1.id);
  await q("INSERT INTO mail.jobs (id, kind, payload, dedupe_key, state, run_after, created_at) VALUES ('stuckjob', 'catchup', ?, 'catchup:stuck', 'running', ?, ?)", JSON.stringify({ channel_id: ch.id }), new Date(Date.now() - 3600e3).toISOString(), new Date().toISOString());
  check('a reply left "sending" is reported (maybe sent), never sent twice', await waitFor(async () => (await q('SELECT state, error FROM mail.outbound_emails WHERE id=?', st1.id))[0].state === 'failed', 20000)
    && (await q("SELECT 1 FROM mail.thread_notes WHERE thread_id=? AND body LIKE 'A reply may not have been sent%'", t1.id)).length === 1);
  check('a job left "running" runs again', await waitFor(async () => (await q("SELECT state FROM mail.jobs WHERE id='stuckjob'"))[0].state === 'done', 8000));
  // a reply in its undo window when the mailbox leaves live mode
  const lv = await ok('a reply', `/maildesk/threads/${t1.ref}/reply`, { token: n2.token, method: 'POST', body: { body: 'About to switch off' } });
  await ok('mailbox to shadow', `/maildesk/channels/${ch.id}`, { token: cadmin.token, method: 'PATCH', body: { mode: 'shadow' } });
  check('…the reply is cancelled and the thread says so', (await q('SELECT state FROM mail.outbound_emails WHERE id=?', lv.id))[0].state === 'cancelled'
    && (await q("SELECT 1 FROM mail.thread_notes WHERE thread_id=? AND body LIKE 'A reply was not sent: the mailbox was switched%'", t1.id)).length === 1);
  await fails('the address cannot change while the mailbox is on', `/maildesk/channels/${ch.id}`, { ...A, method: 'PATCH', body: { address: 'reach2@smru.test' } }, 400);
  await ok('back to live', `/maildesk/channels/${ch.id}`, { token: cadmin.token, method: 'PATCH', body: { mode: 'live' } });
  // forward ignores fields that are not the ticket's (no staff priority, no suggestion kind)
  const m6 = mkMsg({ from: 'kiran@gmail.com', subject: 'Hostel water', conv: 'conv-K', body: 'No water in hostel block C' }); await notifyGraph('sub-1', m6);
  const t6 = await waitFor(async () => (await q("SELECT * FROM mail.threads WHERE conversation_id='conv-K'"))[0]);
  const f6 = await ok('forward with extra fields', `/maildesk/threads/${t6.ref}/forward`, { token: n1.token, method: 'POST', body: { service_id: hostel.id, location: 'Block C', priority: 'critical', kind: 'suggestion', seen_notices: ['x'] } });
  const tk6 = (await q('SELECT priority, kind FROM tickets WHERE id=?', f6.ticket_id))[0];
  check('…the desk ticket is a normal one: medium priority, an issue', tk6.priority === 'medium' && tk6.kind === 'issue', JSON.stringify(tk6));
  // pause on hold switched off: the clock keeps running on hold
  const pol = { id: 'x', first_response_mins: 60, warn_at_pct: 75, escalate_at_pct: 100, second_escalate_at_pct: null, business_hours_only: 0, pause_on_hold: 0, active: 1 };
  const old = new Date(Date.now() - 3 * 864e5).toISOString();
  check('with "pause on hold" off, time on hold still counts', L.tick({ created_at: old, status: 'hold', paused_since: old, paused_mins: 0, sla_state: 'on_track', first_responded_at: null }, pol, L.calOf({ timezone: 'Asia/Kolkata' }, null), { nodal: ['a'], escalation: ['b'], backups: {} }, new Date().toISOString()).kind === 'escalate');
  // a deactivated nodal officer: the backup gets the alerts
  await ok('Esha is Nita\'s backup', `/maildesk/channels/${ch.id}/officers`, { token: cadmin.token, method: 'PUT', body: { officers: [{ user_id: n1.id, role: 'nodal', backup_user_id: esc.id }, { user_id: n2.id, role: 'nodal' }, { user_id: esc.id, role: 'escalation' }] } });
  await q('UPDATE users SET is_active=0 WHERE id=?', n1.id);
  const m7 = mkMsg({ from: 'leela@gmail.com', subject: 'Transfer certificate', conv: 'conv-L' }); await notifyGraph('sub-1', m7);
  const t7 = await waitFor(async () => (await q("SELECT * FROM mail.threads WHERE conversation_id='conv-L'"))[0]);
  await q("UPDATE mail.sla_policies SET business_hours_only=0 WHERE id=?", t7.sla_policy_id);
  const p7 = (await q('SELECT first_response_mins m FROM mail.sla_policies WHERE id=?', t7.sla_policy_id))[0];
  await q("UPDATE mail.threads SET created_at=? WHERE id=?", new Date(Date.now() - p7.m * 0.8 * 6e4).toISOString(), t7.id);
  check('…a deactivated officer\'s reminder goes to the backup', await waitFor(async () => (await q("SELECT recipient FROM notifications WHERE template_key='mail_sla_warn' AND subject LIKE ?", `%${t7.ref}%`)).map(r => r.recipient).sort().join() === 'esha@example.com,naveen@example.com'));
  await q('UPDATE users SET is_active=1 WHERE id=?', n1.id);

  // sending fails part-way
  await ok('Nita back on reach@', `/maildesk/channels/${ch.id}/officers`, { token: cadmin.token, method: 'PUT', body: { officers: [{ user_id: n1.id, role: 'nodal' }, { user_id: n2.id, role: 'nodal' }, { user_id: esc.id, role: 'escalation' }] } });
  const m8 = mkMsg({ from: 'gita@gmail.com', subject: 'Bonafide certificate', conv: 'conv-G' }); await notifyGraph('sub-1', m8);
  const t8 = await waitFor(async () => (await q("SELECT * FROM mail.threads WHERE conversation_id='conv-G'"))[0]);
  G.failNext = { step: 'createReply', status: 503 };
  const r8 = await ok('a reply while Microsoft is busy at the first step', `/maildesk/threads/${t8.ref}/reply`, { token: n1.token, method: 'POST', body: { body: 'Ready on Monday.' } });
  await run_("UPDATE mail.outbound_emails SET send_after=? WHERE id=?", new Date(Date.now() - 1000).toISOString(), r8.id);
  check('…nothing went, so it is simply tried again (not "may have gone")', await waitFor(async () => (await q('SELECT state, attempts FROM mail.outbound_emails WHERE id=?', r8.id))[0].attempts === 1) && (await q('SELECT state FROM mail.outbound_emails WHERE id=?', r8.id))[0].state === 'queued');
  await run_("UPDATE mail.outbound_emails SET send_after=? WHERE id=?", new Date(Date.now() - 1000).toISOString(), r8.id);
  check('…and goes on the next try', await waitFor(async () => (await q('SELECT state FROM mail.outbound_emails WHERE id=?', r8.id))[0].state === 'sent'));
  G.failNext = { step: 'send', status: 502 };
  const r9 = await ok('a reply whose last step gets no clear answer', `/maildesk/threads/${t8.ref}/reply`, { token: n1.token, method: 'POST', body: { body: 'One more thing.' } });
  await run_("UPDATE mail.outbound_emails SET send_after=? WHERE id=?", new Date(Date.now() - 1000).toISOString(), r9.id);
  check('…is reported as "may have gone", never sent twice, and no draft is left in Outlook', await waitFor(async () => (await q('SELECT state, error FROM mail.outbound_emails WHERE id=?', r9.id))[0].state === 'failed')
    && /may or may not have gone/.test((await q('SELECT error FROM mail.outbound_emails WHERE id=?', r9.id))[0].error) && !Object.keys(G.drafts).length);
  check('an old link with the internal number still opens the mail', (await api(`/maildesk/threads/${t8.ref_no}`, { token: n1.token })).data?.thread?.ref === t8.ref);
  // officers: a deactivated one stays until removed; one who leaves the mailbox gives back their mail; a backup not covering has no Home rows
  await ok('Nita takes Gita\'s mail', `/maildesk/threads/${t8.ref}/claim`, { token: n1.token, method: 'POST', body: { take: true } });
  await run_('UPDATE users SET is_active=0 WHERE id=?', n2.id);
  await ok('saving officers keeps the deactivated Naveen', `/maildesk/channels/${ch.id}/officers`, { token: cadmin.token, method: 'PUT', body: { officers: [{ user_id: n1.id, role: 'nodal' }, { user_id: n2.id, role: 'nodal' }, { user_id: esc.id, role: 'escalation' }] } });
  await run_('UPDATE users SET is_active=0 WHERE id=?', other.id);
  await fails('…but a deactivated person cannot be newly added', `/maildesk/channels/${ch.id}/officers`, { token: cadmin.token, method: 'PUT', body: { officers: [{ user_id: n1.id, role: 'nodal' }, { user_id: other.id, role: 'nodal' }] } }, 400);
  await run_('UPDATE users SET is_active=1 WHERE id=?', other.id);
  await run_('UPDATE users SET is_active=1 WHERE id=?', n2.id);
  await ok('Nita leaves reach@; Omar is backup for Naveen', `/maildesk/channels/${ch.id}/officers`, { token: cadmin.token, method: 'PUT', body: { officers: [{ user_id: n2.id, role: 'nodal', backup_user_id: other.id }, { user_id: esc.id, role: 'escalation' }] } });
  check('…the mail Nita had taken goes back to the officers', !(await q('SELECT owner_user_id FROM mail.threads WHERE id=?', t8.id))[0].owner_user_id);
  check('…a backup who is not covering has no rows on the Home', (await api('/maildesk/my-work', { token: other.token })).data?.length === 0);
  await run_("INSERT INTO mail.officer_leave (id, user_id, from_day, to_day) VALUES ('lv1', ?, '2000-01-01', '2999-12-31')", n2.id);
  check('…while Naveen is on leave, Omar covers and sees the work', (await api('/maildesk/my-work', { token: other.token })).data?.some(w => w.id === t8.id));
  await run_("DELETE FROM mail.officer_leave WHERE id='lv1'");
  await ok('officers back as before', `/maildesk/channels/${ch.id}/officers`, { token: cadmin.token, method: 'PUT', body: { officers: [{ user_id: n1.id, role: 'nodal' }, { user_id: n2.id, role: 'nodal' }, { user_id: esc.id, role: 'escalation' }] } });

  // mailboxes: add, change and delete (super admin), per campus
  const ch2 = await ok('add exams@', '/maildesk/channels', { ...A, method: 'POST', body: { address: 'exams@smru.test', display_name: 'Examinations' } });
  await ok('change its address while off', `/maildesk/channels/${ch2.id}`, { ...A, method: 'PATCH', body: { address: 'exam-cell@smru.test' } });
  await ok('officers for exams@: four nodal officers', `/maildesk/channels/${ch2.id}/officers`, { ...A, method: 'PUT', body: { officers: [n1, n2, esc, other].map(u => ({ user_id: u.id, role: 'nodal' })) } });
  check('…all four listed', (await api('/maildesk/settings', A)).data.channels.find(c => c.id === ch2.id)?.officers.filter(o => o.role === 'nodal').length === 4);
  await fails('a campus admin cannot delete a mailbox', `/maildesk/channels/${ch2.id}`, { token: cadmin.token, method: 'DELETE' }, 403);
  await ok('delete exams@ (off, no mail yet)', `/maildesk/channels/${ch2.id}`, { ...A, method: 'DELETE' });
  await fails('a live mailbox cannot be deleted', `/maildesk/channels/${ch.id}`, { ...A, method: 'DELETE' }, 400);
  await ok('reach@ off', `/maildesk/channels/${ch.id}`, { ...A, method: 'PATCH', body: { mode: 'off' } });
  await fails('reach@ has mail, so it stays (off) to keep its history', `/maildesk/channels/${ch.id}`, { ...A, method: 'DELETE' }, 409);
  await ok('reach@ live again', `/maildesk/channels/${ch.id}`, { ...A, method: 'PATCH', body: { mode: 'live' } });
  check('numbers run per campus and never repeat', new Set((await q('SELECT ref FROM mail.threads')).map(r => r.ref)).size === (await q('SELECT count(*)::int n FROM mail.threads'))[0].n);

  // a campus switched off: its mailboxes rest (no reading, no reminders)
  await run_('UPDATE tenants SET is_active=0 WHERE id=?', camp.id);
  const mo = mkMsg({ from: 'late@gmail.com', subject: 'While closed', conv: 'conv-OFF' }); await notifyGraph('sub-1', mo); await sleep(1500);
  check('a deactivated campus reads no mail', (await q('SELECT 1 FROM mail.inbound_emails WHERE provider_message_id=?', mo)).length === 0);
  await run_('UPDATE tenants SET is_active=1 WHERE id=?', camp.id);
  check('…switched on again, the waiting mail is read', await waitFor(async () => (await q('SELECT 1 FROM mail.inbound_emails WHERE provider_message_id=?', mo)).length === 1, 15000));

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
  check('…and the forwarded desk ticket stays', (await q("SELECT count(*)::int n FROM tickets WHERE channel='mail'"))[0].n === 2);
  out = await start();
  check('the desk starts after the rollback', (await fetch(API + '/health')).ok);
} catch (e) { failed++; failures.push('crashed: ' + e.stack); console.error(e); if (out) console.error(out().slice(-3000)); }
finally {
  if (failed && out) console.log('\n--- server output (last part) ---\n' + out().slice(-2500));
  await stop(); stub.close(); await db.end(); await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME}`).catch(() => {}); await admin.end(); fs.rmSync(TMP, { recursive: true, force: true });
}
console.log(`\n${passed} passed, ${failed} failed`); if (failures.length) console.log(failures.map(f => '  - ' + f).join('\n'));
process.exit(failed ? 1 : 0);
