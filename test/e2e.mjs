// End-to-end test. Starts ONE Desk on a throwaway Postgres database (created and dropped here; set TEST_DATABASE_URL
// to a server you can CREATE DATABASE on, default postgres://localhost/postgres) and a temp uploads folder (no email flow connected, so
// nothing is sent), runs every role's flow through the API, then loads each screen in headless Chrome
// when one is installed. Run with: npm test
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import http from 'node:http';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import pg from 'pg';
import jpeg from 'jpeg-js';
import { polish, SHORT } from '../polish.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4397, APP = `http://localhost:${PORT}`, API = APP + '/api';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'onedesk-e2e-'));
const UPLOADS = path.join(TMP, 'uploads');
const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgres://localhost/postgres', DB_NAME = `onedesk_e2e_${process.pid}`;
const DB_URL = Object.assign(new URL(ADMIN_URL), { pathname: '/' + DB_NAME }).href;
const admin = new pg.Client({ connectionString: ADMIN_URL }); await admin.connect();
await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME}`); await admin.query(`CREATE DATABASE ${DB_NAME}`);
pg.types.setTypeParser(20, Number);
const testDb = new pg.Pool({ connectionString: DB_URL, max: 2 });
const ENV = { NODE_ENV: 'production', JWT_SECRET: 'e2e-' + 'x'.repeat(40), OWNER_EMAIL: '' }; // the built-in owner is tested on its own below
const SUPER = { email: 'super@example.com', password: 'SuperSecret123' };
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const sleep = ms => new Promise(r => setTimeout(r, ms));
// A real zip (stored, not compressed), as Word and Excel files are inside: [[name, text], …]
const zipOf = files => { const parts = [], dir = []; let at = 0;
  for (const [name, text] of files) { const n = Buffer.from(name), d = Buffer.from(text), crc = zlib.crc32(d), h = Buffer.alloc(30), c = Buffer.alloc(46);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt32LE(crc, 14); h.writeUInt32LE(d.length, 18); h.writeUInt32LE(d.length, 22); h.writeUInt16LE(n.length, 26);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt32LE(crc, 16); c.writeUInt32LE(d.length, 20); c.writeUInt32LE(d.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(at, 42);
    parts.push(h, n, d); dir.push(c, n); at += 30 + n.length + d.length; }
  const cd = Buffer.concat(dir), e = Buffer.alloc(22); e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(files.length, 8); e.writeUInt16LE(files.length, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(at, 16);
  return 'data:application/octet-stream;base64,' + Buffer.concat([...parts, cd, e]).toString('base64'); };
const officeTypes = main => `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/main" ContentType="${main}"/></Types>`;
const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml', XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml';
const docxOf = (extra = [], type = DOCX_TYPE) => zipOf([['[Content_Types].xml', officeTypes(type)], ['_rels/.rels', '<Relationships/>'], ['word/document.xml', '<w:document/>'], ...extra]);
const xlsxOf = (extra = []) => zipOf([['[Content_Types].xml', officeTypes(XLSX_TYPE)], ['xl/workbook.xml', '<workbook/>'], ...extra]);
const HEIC_FILE = path.join(ROOT, 'test/fixtures/photo.heic'); // a real HEIC photo, as phone cameras save them

// ---------- tiny harness ----------
let passed = 0, failed = 0, section = ''; const failures = [];
const sec = s => { section = s; console.log(`\n== ${s}`); };
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(`${section}: ${name}${detail ? ' — ' + detail : ''}`); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
async function api(p, { method = 'GET', body, token, tenant, raw, nokey } = {}) {
  // A requester opens their ticket with its key (the link in every email about it). The checks act as that person, so the
  // key is added here for the ticket's own pages; a check that wants to come without it says nokey.
  const pub = !nokey && /^\/public\/([a-z0-9-]+)\/tickets\/([A-Za-z0-9-]+)(\/notes|\/reopen)?$/.exec(p);
  if (pub && !(body && 'k' in body)) { const k = (await q('SELECT t.tracking_token k FROM tickets t JOIN tenants n ON n.id=t.tenant_id WHERE n.slug=? AND t.ticket_no=?', pub[1], /^\d+$/.test(pub[2]) ? pub[2].padStart(4, '0') : pub[2].toUpperCase()))[0]?.k;
    if (k && pub[3]) body = { ...body, k }; else if (k) p += '?k=' + encodeURIComponent(k); }
  const r = await fetch(API + p, { method, body: body ? JSON.stringify(body) : undefined,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}), ...(tenant ? { 'x-tenant-id': tenant } : {}) } });
  if (raw) return r;
  const j = await r.json().catch(() => ({})); return { status: r.status, data: j.data, error: j.error };
}
// expect success; returns data
const ok = async (name, p, opts) => { const r = await api(p, opts); check(name, r.status < 400, `${r.status} ${r.error?.message || ''}`); return r.data; };
// expect a specific failure
const fails = async (name, p, opts, status, msg) => { const r = await api(p, opts);
  const good = r.status === status && (!msg || (r.error?.message || '').toLowerCase().includes(msg.toLowerCase()));
  check(name, good, `got ${r.status} ${r.error?.message || JSON.stringify(r.data) || ''}`); return r; };
const login = async (email, password) => (await api('/auth/login', { method: 'POST', body: { email, password } })).data?.token;
const toPg = sql => { let i = 0; return sql.replace(/\?/g, () => '$' + ++i); };
const q = async (sql, ...a) => (await testDb.query(toPg(sql), a)).rows;
const run = (sql, ...a) => testDb.query(toPg(sql), a);
const mailsFor = no => q(`SELECT template_key k, recipient, status, subject, last_error FROM notifications WHERE subject LIKE ? ORDER BY created_at`, `%[${no}]%`);
const waitFor = async (fn, ms = 4000) => { const t0 = Date.now(); let v; while (Date.now() - t0 < ms) { v = await fn(); if (v) return v; await sleep(250); } return fn(); };

// ---------- server control ----------
const pgEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('PG'))); // libpq-style settings (PGUSER, PGPASSWORD …)
let server = null;
async function start(extra = {}, { expectExit } = {}) {
  const proc = spawn(process.execPath, ['--no-warnings', path.join(ROOT, 'server.js')],
    { cwd: TMP, env: { PATH: process.env.PATH, HOME: process.env.HOME, USER: process.env.USER, ...pgEnv, DATABASE_URL: DB_URL, UPLOAD_DIR: UPLOADS, PROVISION_DIR: path.join(TMP, 'provision'), PORT: String(PORT), ...ENV, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; proc.stdout.on('data', d => out += d); proc.stderr.on('data', d => out += d);
  if (expectExit) return { code: await new Promise(r => proc.on('exit', r)), out };
  for (let i = 0; i < 60; i++) { await sleep(100); try { if ((await fetch(API + '/health')).ok) break; } catch { /* not up yet */ } }
  server = proc; return { out: () => out };
}
const stop = () => new Promise(r => { if (!server) return r(); const p = server; server = null; if (p.exitCode !== null || p.signalCode) return r(); p.on('exit', () => r()); p.kill(); });

// ---------- a stand-in for the Power Automate flow ----------
const flow = { key: 'test-secret-key-0123456789abcdef', received: [] };
const flowServer = http.createServer((req, res) => { let b = ''; req.on('data', c => b += c); req.on('end', () => {
  if (req.method === 'GET' && req.url.startsWith('/url?')) { // like Gmail's google.com/url?q=… : the link travels encoded, then a redirect opens it
    res.writeHead(302, { location: new URL(req.url, 'http://x').searchParams.get('q') }); return res.end(); }
  if (req.headers['x-desk-key'] !== flow.key) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"error":"bad key"}'); }
  flow.received.push(JSON.parse(b)); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); }); });
await new Promise(r => flowServer.listen(0, '127.0.0.1', r));
const FLOW_URL = `http://localhost:${flowServer.address().port}/flow`;
const GMAIL = href => `http://localhost:${flowServer.address().port}/url?q=${encodeURIComponent(href)}&source=gmail`;
// A stand-in device voice for the guide: each sentence takes 40 ms, and it refuses ('not-allowed') like a browser that wants
// a tap first. ?tts=ok stands for arriving from the app with a tap (Chrome counts that); a real tap on the page counts too.
const FAKE_TTS = `(() => {
  const allowed = () => /[?&]tts=ok/.test(location.search) || navigator.userActivation?.hasBeenActive;
  let cur = null, timer = 0; const queue = []; window.__said = [];
  const say = () => { cur = queue.shift(); if (!cur) { synth.speaking = false; return; } synth.speaking = true; const u = cur;
    timer = setTimeout(() => { u.onstart?.({}); window.__said.push({ t: u.text, at: location.hash, sub: document.querySelector('.card:not([hidden]) .subtitle .t')?.textContent || '' });
      timer = setTimeout(() => { cur = null; u.onend?.({}); if (!cur) say(); }, 30); }, 10); }; // onend may already have started the next one
  const synth = { speaking: false, pending: false, paused: false, getVoices: () => [{ name: 'Stand-in Natural English', lang: 'en-IN', localService: false }, ...(/[?&]te=none/.test(location.search) ? [] : [{ name: 'Stand-in Telugu', lang: 'te-IN', localService: false }])],
    speak(u) { if (!u.text) return; if (!allowed()) { setTimeout(() => u.onerror?.({ error: 'not-allowed' }), 5); return; } queue.push(u); if (!cur) say(); },
    cancel() { queue.length = 0; clearTimeout(timer); const u = cur; cur = null; synth.speaking = false; if (u) setTimeout(() => u.onerror?.({ error: 'interrupted' }), 0); },
    pause() {}, resume() {}, addEventListener() {}, removeEventListener() {} };
  Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
  window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } }; })();`;

const T = {}, ids = {}; // tokens and ids shared across sections
try {
  // ======================= A. start-up =======================
  sec('Start-up and first run');
  const guard = await start({ JWT_SECRET: '' }, { expectExit: true });
  check('production refuses to start without JWT_SECRET', guard.code === 1 && /JWT_SECRET/.test(guard.out), `exit ${guard.code}`);
  let s = await start();
  check('empty database: no users, server explains what to set', /No users yet/.test(s.out()) && !(await login(SUPER.email, SUPER.password)));
  check('public campus list is empty', (await api('/public')).data?.length === 0);
  await stop(); s = await start({ SUPER_ADMIN_EMAIL: SUPER.email, SUPER_ADMIN_PASSWORD: SUPER.password });
  check('super admin created from SUPER_ADMIN_* on first start', /created/.test(s.out()));
  const saRow = (await q('SELECT must_change_pw m FROM users WHERE email=?', SUPER.email))[0], saMail = await q("SELECT 1 FROM notifications WHERE template_key='invite' AND recipient=?", SUPER.email);
  check('…as a temporary password: sign-in details emailed, new password asked at first sign-in', saRow?.m === 1 && saMail.length === 1);
  await q('UPDATE users SET must_change_pw=0 WHERE email=?', SUPER.email); // (the rest of the run uses this password as the own one)
  T.sa = await login(SUPER.email, SUPER.password); check('super admin can sign in', !!T.sa);
  const ver = await (await fetch(API + '/version')).json(), head = execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  check('/api/version: running commit = checked-out commit, no restart needed', ver.commit === head && ver.on_disk === head && ver.restart_needed === false && !!ver.started_at, JSON.stringify(ver));
  check('root serves the app', /<title>ONE Desk/.test(await (await fetch(APP + '/')).text()));
  check('/desk/ also serves the app', (await fetch(APP + '/desk/')).status === 200);
  check('API without a sign-in is refused', (await api('/nope')).status === 401);

  // ======================= B. super admin: campuses, people, services, rules =======================
  sec('Super admin sets up campuses');
  const me = await ok('GET /me', '/me', { token: T.sa });
  check('super admin has no campus yet', me.user.role === 'super_admin' && me.tenants.length === 0);
  await fails('tenant-scoped call without a campus is refused', '/tickets', { token: T.sa }, 400, 'Pick a tenant');
  const alpha = await ok('create campus ALPHA', '/tenants', { method: 'POST', token: T.sa, body: { code: 'alpha', name: 'Alpha Campus', slug: 'Alpha' } });
  check('code upper-cased and slug lower-cased', alpha.code === 'ALPHA' && alpha.slug === 'alpha');
  await fails('duplicate campus code is 409', '/tenants', { method: 'POST', token: T.sa, body: { code: 'ALPHA', name: 'Again', slug: 'again' } }, 409);
  await fails('bad slug is 400', '/tenants', { method: 'POST', token: T.sa, body: { code: 'GAMMA', name: 'G', slug: 'has space' } }, 400);
  const beta = await ok('create campus BETA', '/tenants', { method: 'POST', token: T.sa, body: { code: 'BETA', name: 'Beta Campus', slug: 'beta' } });
  ids.alpha = alpha.id; ids.beta = beta.id;
  const A = { token: T.sa, tenant: alpha.id }, Bt = { token: T.sa, tenant: beta.id };
  check('unknown API route is 404', (await api('/nope', A)).status === 404);
  const mkUser = async (t, name, email, role) => { const r = await ok(`add ${role} ${name}`, '/users', { ...t, method: 'POST', body: { name, email, role } }); return { id: r.id, email, temp: r.temp_password, name }; };
  const asha = await mkUser(A, 'Asha Admin', 'asha@example.com', 'tenant_admin');
  const pavan = await mkUser(A, 'Pavan Provider', 'pavan@example.com', 'provider');
  const lata = await mkUser(A, 'Lata Lead', 'lata@example.com', 'provider');
  const bina = await mkUser(Bt, 'Bina Admin', 'bina@example.com', 'tenant_admin');
  check('temporary passwords are issued', [asha, pavan, lata, bina].every(u => u.temp?.length >= 8));
  await fails('duplicate staff email is 409', '/users', { ...A, method: 'POST', body: { name: 'Dup', email: 'pavan@example.com', role: 'provider' } }, 409);
  check('invite emails were queued', (await q("SELECT count(*) n FROM notifications WHERE template_key='invite' AND recipient<>?", SUPER.email))[0].n === 4);
  const welcome = (await q("SELECT subject, body FROM notifications WHERE template_key='invite' AND recipient='pavan@example.com'"))[0];
  check('welcome email has role, services, sign-in link and password', /Welcome/.test(welcome.subject) && welcome.body.includes('Service provider') && welcome.body.includes('Not assigned yet')
    && welcome.body.includes('pavan@example.com') && welcome.body.includes(pavan.temp) && welcome.body.includes('/#/login'));
  const inviteTo = async to => (await q("SELECT html, text_body FROM notifications WHERE template_key='invite' AND recipient=?", to))[0];
  check('every welcome email links the provider guide', (await inviteTo('pavan@example.com')).html.includes('https://claude.ai/artifact/XwZ2wYi78wQ7t8PcCMpHhv')
    && (await inviteTo('asha@example.com')).html.includes('Open the provider guide') && (await inviteTo('pavan@example.com')).text_body.includes('https://claude.ai/artifact/XwZ2wYi78wQ7t8PcCMpHhv'));
  const gp = await fetch(APP + '/guide/requestor.html');
  check('the app serves only the requestor guide (/guide/ opens it; no staff guides)', gp.ok && (await gp.text()).includes("key: 'requestor'") && (await fetch(APP + '/guide/provider.html')).status === 404
    && (await fetch(APP + '/guide/admin.html')).status === 404 && (await (await fetch(APP + '/guide/')).text()).includes('requestor.html') && (await fetch(APP + '/guide/img/r1-portal.jpg')).ok);

  sec('Services and form types');
  const mkSvc = async (t, body) => ok(`create service ${body.code}`, '/services', { ...t, method: 'POST', body });
  const elec = await mkSvc(A, { code: 'ELEC', name: 'Electrical', description: 'Power, fans, lights', escalation_user_id: lata.id,
    form_schema: { icon: 'bolt', form_type: 'location', lists: { block: ['Main block', 'Hostel block'] }, fields: [{ key: 'issue', label: 'Issue', type: 'select', required: true, options: ['Fan', 'Light', 'Switch'] }] } });
  const exam = await mkSvc(A, { code: 'EXAM', name: 'Examinations', form_schema: { icon: 'book', form_type: 'student', fields: [{ label: 'What do you need?', type: 'select', required: true, options: ['Hall ticket', 'Results'] }] } });
  const hostel = await mkSvc(A, { code: 'HOSTEL', name: 'Hostel', form_schema: { form_type: 'both', fields: [] } });
  const trans = await mkSvc(A, { code: 'TRANS', name: 'Transport', form_schema: { form_type: 'general', fields: [] } });
  const gen = await mkSvc(Bt, { code: 'GEN', name: 'General help', form_schema: { form_type: 'general', fields: [] } });
  ids.elec = elec.id; ids.exam = exam.id; ids.hostel = hostel.id; ids.trans = trans.id; ids.gen = gen.id;
  await fails('duplicate service code is 409', '/services', { ...A, method: 'POST', body: { code: 'ELEC', name: 'Again' } }, 409);
  await fails('a dropdown with one choice is rejected', '/services', { ...A, method: 'POST', body: { code: 'BADQ', name: 'x', form_schema: { fields: [{ label: 'Pick', type: 'select', options: ['only'] }] } } }, 400, 'two choices');
  await fails('reserved question keys are rejected', '/services', { ...A, method: 'POST', body: { code: 'BADK', name: 'x', form_schema: { fields: [{ key: 'loc_block', label: 'Block', type: 'short_text' }] } } }, 400, 'reserved');
  await fails('escalation person must belong to this campus', '/services', { ...A, method: 'POST', body: { code: 'BADE', name: 'x', escalation_user_id: bina.id } }, 400);
  await ok('ELEC → Pavan', `/services/${elec.id}/members`, { ...A, method: 'PUT', body: { user_ids: [pavan.id] } });
  await ok('EXAM → Lata', `/services/${exam.id}/members`, { ...A, method: 'PUT', body: { user_ids: [lata.id] } });
  await ok('HOSTEL → Asha (an admin can be a provider)', `/services/${hostel.id}/members`, { ...A, method: 'PUT', body: { user_ids: [asha.id] } });
  await ok('GEN (Beta) → Bina', `/services/${gen.id}/members`, { ...Bt, method: 'PUT', body: { user_ids: [bina.id] } });
  await ok('any number of providers can serve one team', `/services/${elec.id}/members`, { ...A, method: 'PUT', body: { user_ids: [pavan.id, lata.id, asha.id] } });
  await ok('back to Pavan alone', `/services/${elec.id}/members`, { ...A, method: 'PUT', body: { user_ids: [pavan.id] } });
  await fails('a provider from another campus is rejected', `/services/${elec.id}/members`, { ...A, method: 'PUT', body: { user_ids: [bina.id] } }, 404);
  const svcs = await ok('list services', '/services', A);
  check('service list shows members, form type and escalation person', svcs.find(x => x.code === 'ELEC')?.members[0]?.name === 'Pavan Provider' && svcs.find(x => x.code === 'ELEC')?.form_schema.form_type === 'location' && svcs.find(x => x.code === 'ELEC')?.escalation_user?.name === 'Lata Lead');
  const pub = await ok('public campus page', '/public/alpha');
  check('portal lists active services without provider names (shown after raising)', pub.services.length === 4 && !('providers' in pub.services.find(x => x.code === 'ELEC')));

  sec('SLA and escalation rules');
  await fails('end before start is rejected', '/sla', { ...A, method: 'PUT', body: { work_start: '17:00', work_end: '09:00', work_days: [1], hold_reasons: [{ label: 'x', hours: 1 }] } }, 400);
  await ok('save SLA: 9–5, Mon–Sat, escalate after 0 days', '/sla', { ...A, method: 'PUT', body: { work_start: '09:00', work_end: '17:00', work_days: [1, 2, 3, 4, 5, 6],
    targets: { critical: 3, high: 5, medium: 8, low: 24 }, hold_reasons: [{ key: 'parts', label: 'Waiting for parts', hours: 16 }, { label: 'Waiting for exam cell', hours: 4 }], escalate_after_days: 0, escalate_holds: true } });
  const sla = await ok('read SLA', '/sla', A);
  check('SLA saved as sent', sla.targets.critical === 3 && sla.hold_reasons.length === 2 && sla.hold_reasons[1].key === 'waiting_for_exam_cell' && sla.escalate_after_days === 0 && sla.escalate_holds === true);

  // ======================= C. requestor =======================
  sec('Requestor raises tickets');
  let phoneNo = 9000000100; // a different phone per request, so requestors are not matched to each other by phone
  const raise = (slug, body) => api(`/public/${slug}/tickets`, { method: 'POST', body: { phone: String(phoneNo++), description: 'Details of the problem', identifier: 'ID-1', department: 'General', ...body } });
  const elecBody = (n, email, extra = {}) => ({ service_id: elec.id, name: n, email, subject: `Ticket from ${n}`, description: 'Something is broken.',
    form_data: { loc_block: 'Main block', loc_floor: '2nd floor', loc_room: n === 'Ria' ? 'Room 214' : `Room ${n}`, issue: 'Fan' }, ...extra }); // own room each: same-day reports of one spot merge
  let r = await raise('alpha', { ...elecBody('Ria', ''), phone: '9000000001' });
  check('email is required', r.status === 400 && /email/i.test(r.error.message), r.error?.message);
  r = await raise('alpha', { ...elecBody('Spam', 'spam@example.com'), website: 'http://spam' });
  check('honeypot rejects bots', r.status === 400);
  r = await raise('alpha', { ...elecBody('Ph', 'ph@example.com'), phone: '' });
  check('public form: phone is required', r.status === 400 && /phone/i.test(r.error.message), r.error?.message);
  r = await raise('alpha', { ...elecBody('Id', 'id@example.com', { requestor_type: 'faculty' }), identifier: '' });
  check('public form: the ID question is required for everyone', r.status === 400 && /faculty ID/.test(r.error.message), r.error?.message);
  r = await raise('alpha', { service_id: exam.id, name: 'Sam', email: 's1@example.com', subject: 'Hall ticket', form_data: { what_do_you_need: 'Hall ticket' } });
  check('student service needs Branch, Student ID, Department', r.status === 400 && /Student ID/.test(Object.values(r.error.details || {}).join(' ')), JSON.stringify(r.error));
  r = await raise('alpha', elecBody('Ria', 'r1@example.com', { form_data: { loc_block: 'Main block', loc_floor: 'Mezzanine', loc_room: '1', issue: 'Fan' } }));
  check('floor must be one of the campus list', r.status === 400, r.error?.message);
  r = await raise('alpha', { ...elecBody('Ria', 'r1@example.com'), idempotency_key: 'idem-1', files: [{ name: 'fan.png', type: 'image/png', source: 'camera', data: PNG }] });
  check('ticket 0001 raised with a camera photo', r.status === 200 && r.data.ticket_no === '0001', JSON.stringify(r.error || r.data));
  const t1 = r.data;
  r = await raise('alpha', { ...elecBody('Ria', 'r1@example.com'), idempotency_key: 'idem-1' });
  check('double submit returns the same ticket', r.data?.ticket_no === '0001');
  r = await raise('alpha', { ...elecBody('Bad', 'r9@example.com'), files: [{ name: 'notes.txt', type: 'text/plain', data: 'data:text/plain;base64,aGk=' }] });
  check('only images and PDFs are accepted', r.status === 400);
  r = await raise('alpha', { ...elecBody('Five', 'five@example.com'), files: Array.from({ length: 5 }, (_, i) => ({ name: `p${i}.png`, type: 'image/png', source: 'gallery', data: PNG })) });
  check('at most 4 photos per ticket', r.status === 400 && /at most 4/.test(r.error.message), r.error?.message);
  r = await raise('alpha', { service_id: exam.id, name: 'Sam', email: 's1@example.com', subject: 'Hall ticket missing', form_data: { stu_branch: 'BPT', stu_id: '23BPT014', stu_dept: 'Physio', what_do_you_need: 'Hall ticket' } });
  check('student ticket 0002 raised', r.data?.ticket_no === '0002', r.error?.message);
  r = await raise('alpha', { service_id: trans.id, name: 'Tom', email: 't1@example.com', subject: 'Bus late' });
  check('general service needs a location', r.status === 400 && /location/i.test(r.error.message));
  r = await raise('alpha', { service_id: trans.id, name: 'Tom', email: 't1@example.com', subject: 'Bus late', location: 'Gate 2' });
  check('general ticket 0003 raised', r.data?.ticket_no === '0003');
  r = await raise('beta', { service_id: gen.id, name: 'Ben', email: 'b1@example.com', subject: 'Beta ticket', location: 'Office' });
  check('each campus numbers from 0001', r.data?.ticket_no === '0001');
  const p1 = await ok('the requester opens ticket 0001 (with its key)', `/public/alpha/tickets/1`);
  check('ticket page shows provider, location and the stamped photo', p1.providers[0].name === 'Pavan Provider' && p1.location === 'Main block · 2nd floor · Room 214' && p1.events[0].files?.length === 1 && !!p1.events[0].files[0].stamped_at);
  const img = await fetch(`${APP}/api/files/${p1.events[0].files[0].storage_key}`);
  check('photo is served', img.status === 200 && img.headers.get('content-type')?.includes('image/png'));
  check('student answers saved on the requestor', (await q("SELECT r.identifier, r.department, r.requestor_type FROM tickets t JOIN requestors r ON r.id=t.requestor_id WHERE t.ticket_no='0002' AND t.tenant_id=?", alpha.id))[0]?.identifier === '23BPT014');
  await fails('unknown number is 404', '/public/alpha/tickets/0099', {}, 404);
  // --- a ticket opens with its key (the link in the email), or with its number and the email it was raised with ---
  const key1 = (await q("SELECT tracking_token k FROM tickets WHERE ticket_no='0001' AND tenant_id=?", alpha.id))[0].k;
  await fails('the number alone opens nothing (numbers run 0001, 0002…: anyone could read anyone’s ticket)', '/public/alpha/tickets/0001', { nokey: true }, 404);
  await fails('…nor does a wrong key', '/public/alpha/tickets/0001?k=wrong-key', {}, 404);
  await fails('…a note cannot be added without the key', '/public/alpha/tickets/0001/notes', { method: 'POST', nokey: true, body: { body: 'from a stranger' } }, 404);
  await fails('…nor a reopen asked for', '/public/alpha/tickets/0001/reopen', { method: 'POST', nokey: true, body: { reason: 'from a stranger' } }, 404);
  check('with the key from the email link it opens', (await api(`/public/alpha/tickets/0001?k=${key1}`)).data?.ticket_no === '0001');
  // Track ticket: the number says where the ticket stands; the full ticket opens only from a link sent to the email on it
  const stt = (await api('/public/alpha/tickets/1/status')).data;
  check('the number alone shows where the ticket stands: status, team, target; nothing anybody typed', stt?.ticket_no === '0001' && stt.status === 'open' && stt.service === 'Electrical' && !!stt.due_at
    && !/Ria|r1@example|Room 214|Ticket from|Something is broken/.test(JSON.stringify(stt)), JSON.stringify(stt));
  await fails('…a number that does not exist says so', '/public/alpha/tickets/0099/status', {}, 404);
  const lk = email => api('/public/alpha/tickets/0001/link', { method: 'POST', body: { email } }), linkMails = () => q("SELECT recipient, text_body FROM notifications WHERE template_key='ticket_link' ORDER BY created_at");
  const l1 = await lk('  R1@Example.com '), l2 = await lk('someone.else@example.com'), l3 = await api('/public/alpha/tickets/0099/link', { method: 'POST', body: { email: 'r1@example.com' } });
  const lm = await waitFor(async () => { const m = await linkMails(); return m.length ? m : null; });
  check('typing the email on the ticket sends the link to that address: the key never comes back to the browser', l1.status === 200 && !('k' in l1.data) && !JSON.stringify(l1.data).includes(key1)
    && lm?.length === 1 && lm[0].recipient === 'r1@example.com' && lm[0].text_body.includes(`/#/d/alpha/t/0001?k=${key1}`), JSON.stringify([l1.data, lm?.map(m => m.recipient)]));
  check('…another email, or a number that does not exist, get the very same answer and no email', l2.status === 200 && l3.status === 200 && l2.data.message === l1.data.message && l3.data.message === l1.data.message && (await linkMails()).length === 1);
  await lk('r1@example.com'); await lk('r1@example.com'); await lk('r1@example.com'); await lk('r1@example.com'); await sleep(600);
  check('…and at most 3 links an hour go to one address (nobody’s inbox can be flooded)', (await linkMails()).length === 3, String((await linkMails()).length));
  const oldWay = await api('/public/alpha/tickets/0001/open', { method: 'POST', body: { email: 'r1@example.com' } });
  check('the old way in (number + email answering the key) is gone', oldWay.status >= 400 && !JSON.stringify(oldWay).includes(key1), String(oldWay.status));
  await fails('an oddly shaped key reads like any wrong key', '/public/alpha/tickets/0001?k=%00', {}, 404);
  await fails('a file that is not a file answers plainly (it used to answer 500)', '/public/beta/tickets/0001/notes', { method: 'POST', body: { body: 'x', files: [null] } }, 400, 'photos');
  const tif = 'data:image/tiff;base64,' + Buffer.from('II*\0<script>alert(1)</script>' + 'x'.repeat(40), 'latin1').toString('base64');
  await fails('a file that only starts like a TIFF is not taken (it was kept and offered as “evil.html”)', '/public/beta/tickets/0001/notes', { method: 'POST', body: { body: 'see file', files: [{ name: 'evil.html', data: tif }] } }, 400, 'photos');
  await ok('a photo sent under a misleading name', '/public/beta/tickets/0001/notes', { method: 'POST', body: { body: 'photo of the gate', files: [{ name: 'invoice.pdf.exe', type: 'image/png', source: 'gallery', data: PNG }] } });
  check('…is kept under a name that ends the way the file really is', (await q("SELECT file_name FROM attachments WHERE ticket_id=(SELECT id FROM tickets WHERE ticket_no='0001' AND tenant_id=?) ORDER BY created_at DESC LIMIT 1", beta.id))[0].file_name === 'invoice.pdf.png');
  await fails('a ticket number with odd characters is simply not found (it used to answer 500)', '/public/alpha/tickets/%00?k=x', {}, 404);
  const pn = await ok('requestor adds a note', '/public/alpha/tickets/0001/notes', { method: 'POST', body: { body: 'It sparks when switched on.' } });
  check('note appears on the public timeline', pn.events.some(e => e.event_type === 'note'));
  await fails('an open ticket cannot be reopened', '/public/alpha/tickets/0001/reopen', { method: 'POST', body: { reason: 'x' } }, 409);
  const m1 = await mailsFor('0001');
  check('emails: received → requestor, new ticket → provider, note → provider', ['created', 'new_ticket', 'requestor_note'].every(k => m1.some(m => m.k === k)) && m1.find(m => m.k === 'new_ticket').recipient === 'pavan@example.com');
  check('with no flow connected, emails are logged, not sent', !!(await waitFor(async () => (await mailsFor('0001')).every(m => m.status === 'logged'))), JSON.stringify((await mailsFor('0001')).map(m => m.status)));

  // ======================= D. provider =======================
  sec('Provider signs in');
  let tok = await login(pavan.email, pavan.temp); check('temporary password works', !!tok);
  check('must set a new password first', (await api('/me', { token: tok })).data.user.must_change_pw === 1);
  await fails('first change needs the temporary password', '/me/password', { token: tok, method: 'POST', body: { password: 'Pavan2026ok' } }, 400, 'Temporary');
  await fails('weak password rejected', '/me/password', { token: tok, method: 'POST', body: { current: pavan.temp, password: 'abcdefgh' } }, 400);
  await ok('sets own password', '/me/password', { token: tok, method: 'POST', body: { current: pavan.temp, password: 'Pavan2026ok' } });
  const pwMail = (await q("SELECT subject, body FROM notifications WHERE template_key='password_changed' AND recipient='pavan@example.com'"))[0];
  check('new sign-in details are emailed after the change', !!pwMail && pwMail.body.includes('Pavan2026ok') && pwMail.body.includes('pavan@example.com') && pwMail.body.includes('/#/login'));
  T.pavan = await login(pavan.email, 'Pavan2026ok'); check('new password works', !!T.pavan);
  check('old temporary password no longer works', !(await login(pavan.email, pavan.temp)));
  await fails('later changes need the current password', '/me/password', { token: T.pavan, method: 'POST', body: { password: 'Another2026' } }, 400, 'current');
  for (const [u, pw] of [[lata, 'Lata2026ok'], [asha, 'Asha2026ok'], [bina, 'Bina2026ok']]) { const t0 = await login(u.email, u.temp); await api('/me/password', { token: t0, method: 'POST', body: { current: u.temp, password: pw } }); T[u.name.split(' ')[0].toLowerCase()] = await login(u.email, pw); }
  check('all staff signed in', !!T.lata && !!T.asha && !!T.bina);

  sec('Provider works tickets');
  const mine = await ok('Pavan’s queue', '/tickets?status=all', { token: T.pavan });
  check('provider sees only his service’s tickets', mine.length === 1 && mine[0].ticket_no === '0001');
  ids.t1 = mine[0].id; ids.t2 = (await q("SELECT id FROM tickets WHERE ticket_no='0002' AND tenant_id=?", alpha.id))[0].id;
  await fails('cannot open another service’s ticket', `/tickets/${ids.t2}`, { token: T.pavan }, 404);
  const d1 = await ok('open ticket 0001', `/tickets/${ids.t1}`, { token: T.pavan });
  check('workspace has details, requestor, providers, SLA minutes', d1.form_data.issue === 'Fan' && d1.requestor.email === 'r1@example.com' && d1.providers[0].id === pavan.id && typeof d1.sla_left_min === 'number' && d1.attachments.length === 1);
  const act = (id, body, token = T.pavan) => api(`/tickets/${id}/status`, { method: 'POST', token, body });
  r = await act(ids.t1, { to: 'in_progress', note: 'On it' });
  check('start work → in progress, requestor told', r.status === 200 && (await api('/public/alpha/tickets/0001')).data.status === 'in_progress' && (await mailsFor('0001')).some(m => m.k === 'status_in_progress'), r.error?.message);
  check('status change needs a note', (await act(ids.t1, { to: 'hold' })).status === 400);
  check('hold needs a reason', (await act(ids.t1, { to: 'hold', note: 'wait' })).status === 400);
  check('invalid transition is 409', (await act(ids.t1, { to: 'open', note: 'x' })).status === 409);
  r = await act(ids.t1, { to: 'hold', note: 'Motor ordered', hold_reason: 'parts' }); check('put on hold', r.status === 200, r.error?.message);
  const ph = (await api('/public/alpha/tickets/0001')).data;
  check('requestor sees the hold reason and resume time', ph.status === 'hold' && ph.hold_label === 'Waiting for parts' && !!ph.hold_due_at);
  r = await act(ids.t1, { to: 'in_progress', note: 'Motor arrived' });
  check('resumed → in progress, “work resumed” email', r.status === 200 && (await api('/public/alpha/tickets/0001')).data.status === 'in_progress' && (await mailsFor('0001')).some(m => m.k === 'status_open'), r.error?.message);
  const dueBefore = (await api(`/tickets/${ids.t1}`, { token: T.pavan })).data.due_at;
  await ok('priority → critical', `/tickets/${ids.t1}/priority`, { token: T.pavan, method: 'POST', body: { priority: 'critical' } });
  check('due time moved earlier', (await api(`/tickets/${ids.t1}`, { token: T.pavan })).data.due_at < dueBefore);
  await ok('internal note', `/tickets/${ids.t1}/notes`, { token: T.pavan, method: 'POST', body: { body: 'Secret: check the wiring', is_internal: true } });
  await ok('public note', `/tickets/${ids.t1}/notes`, { token: T.pavan, method: 'POST', body: { body: 'Electrician visits at 3 pm' } });
  const pe = (await api('/public/alpha/tickets/0001')).data.events;
  check('internal note hidden from the requestor, public note shown', !pe.some(e => /Secret/.test(e.body || '')) && pe.some(e => /3 pm/.test(e.body || '')));
  await fails('extend due is admin-only', `/tickets/${ids.t1}/extend`, { token: T.pavan, method: 'POST', body: { hours: 2, reason: 'x' } }, 403);
  const dueA = (await api(`/tickets/${ids.t1}`, { token: T.asha })).data.due_at;
  await ok('admin extends the due time', `/tickets/${ids.t1}/extend`, { token: T.asha, method: 'POST', body: { hours: 2, reason: 'Parts delayed' } });
  check('due time moved later', (await api(`/tickets/${ids.t1}`, { token: T.asha })).data.due_at > dueA);
  await ok('transfer 0001 to Hostel', `/tickets/${ids.t1}/transfer`, { token: T.pavan, method: 'POST', body: { service_id: hostel.id, note: 'Hostel wiring' } });
  await fails('after transfer the old provider no longer sees it', `/tickets/${ids.t1}`, { token: T.pavan }, 404);
  check('hostel provider (Asha) sees it', (await api(`/tickets/${ids.t1}`, { token: T.asha })).status === 200);
  check('transfer emails: old + new providers and the requestor', (await mailsFor('0001')).some(m => m.k === 'transferred' && m.recipient === 'pavan@example.com') && (await mailsFor('0001')).some(m => m.k === 'transferred' && m.recipient === 'asha@example.com') && (await mailsFor('0001')).some(m => m.k === 'transferred_requestor'));
  await ok('admin transfers it back to Electrical', `/tickets/${ids.t1}/transfer`, { token: T.asha, method: 'POST', body: { service_id: elec.id, note: 'Back to Electrical' } });
  r = await act(ids.t1, { to: 'closed', note: 'Fan motor replaced', files: [{ name: 'proof.png', type: 'image/png', source: 'camera', data: PNG }] });
  check('closed fast: +10 points', r.status === 200 && r.data.points === 10, JSON.stringify(r.data || r.error));
  check('points total 10', (await api('/points', { token: T.pavan })).data.me === 10);
  check('close email has the reopen offer', /reopen/i.test((await mailsFor('0001')).find(m => m.k === 'status_closed')?.subject + (await q("SELECT body FROM notifications WHERE template_key='status_closed' AND subject LIKE '%[0001]%'"))[0]?.body));
  check('closed → hold is refused', (await act(ids.t1, { to: 'hold', note: 'x', hold_reason: 'parts' })).status === 409);
  const rp = await ok('requestor asks to reopen within the window', '/public/alpha/tickets/0001/reopen', { method: 'POST', body: { reason: 'Noisy again' } });
  check('a reopen is a request: still closed, waiting for the provider who closed it', rp.status === 'closed' && !!rp.reopen_request && /Pavan/.test(rp.reopen_request.with) && rp.events.some(e => e.event_type === 'reopen_requested'));
  check('asking twice is refused', (await api('/public/alpha/tickets/0001/reopen', { method: 'POST', body: { reason: 'Again' } })).status === 409);
  check('the provider who closed it is emailed to accept or decline', (await mailsFor('0001')).some(m => m.k === 'reopen_requested' && m.recipient === 'pavan@example.com'));
  check('it shows in their Reopen requests list', (await api('/tickets?status=reopen', { token: T.pavan })).data.some(t => t.ticket_no === '0001') && (await api('/reports?days=7', { token: T.pavan })).data.counts.reopen_requests === 1);
  await ok('they talk first: the provider replies with a note', `/tickets/${ids.t1}/notes`, { token: T.pavan, method: 'POST', body: { body: 'Is it the regulator or the motor?' } });
  await ok('the requester answers on the ticket page', '/public/alpha/tickets/0001/notes', { method: 'POST', body: { body: 'The motor hums.' } });
  check('the note conversation is on the closed ticket', (await api('/public/alpha/tickets/0001')).data.events.filter(e => e.event_type === 'note').length >= 2);
  const dWho = (await api(`/tickets/${ids.t1}`, { token: T.pavan })).data.reopen_request;
  check('the ticket page tells the closer they decide', dWho?.can_decide === true && dWho.note === 'Noisy again');
  check('decline needs a note', (await api(`/tickets/${ids.t1}/reopen-request`, { token: T.pavan, method: 'POST', body: { decision: 'accept' } })).status === 400);
  await ok('the closer accepts', `/tickets/${ids.t1}/reopen-request`, { token: T.pavan, method: 'POST', body: { decision: 'accept', note: 'Sending the electrician again' } });
  const rp2 = (await api('/public/alpha/tickets/0001')).data;
  check('ticket is open again, request cleared', rp2.status === 'open' && rp2.reopen_count === 1 && !rp2.reopen_request);
  check('reopen costs the closer 5 points', (await api('/points', { token: T.pavan })).data.me === 5);
  check('providers emailed about the reopen, the requester told it was accepted', (await mailsFor('0001')).some(m => m.k === 'reopened' && m.recipient === 'pavan@example.com') && (await mailsFor('0001')).some(m => m.k === 'reopen_accepted' && m.recipient === 'r1@example.com'));
  r = await raise('alpha', elecBody('Raj', 'r4@example.com')); ids.t4 = (await q("SELECT id FROM tickets WHERE ticket_no='0004' AND tenant_id=?", alpha.id))[0].id;
  r = await act(ids.t4, { to: 'rejected', note: 'Duplicate of 0001' }); check('reject with reason', r.status === 200);
  check('requestor sees rejected and cannot reopen', (await api('/public/alpha/tickets/0004')).data.status === 'rejected' && (await api('/public/alpha/tickets/0004/reopen', { method: 'POST', body: { reason: 'x' } })).status === 409);
  r = await raise('alpha', elecBody('Rao', 'r5@example.com')); ids.t5 = (await q("SELECT id FROM tickets WHERE ticket_no='0005' AND tenant_id=?", alpha.id))[0].id;
  await act(ids.t5, { to: 'hold', note: 'Waiting', hold_reason: 'parts' });
  await run('UPDATE tickets SET hold_due_at=? WHERE id=?', new Date(Date.now() - 3600e3).toISOString(), ids.t5);
  await act(ids.t5, { to: 'in_progress', note: 'Resumed late' });
  check('hold past its limit costs 3 points', (await api('/points', { token: T.pavan })).data.me === 2);
  await run('UPDATE tickets SET due_at=? WHERE id=?', new Date(Date.now() - 7 * 864e5).toISOString(), ids.t5);
  r = await act(ids.t5, { to: 'closed', note: 'Done, very late' });
  check('closing very late: −5 points', r.data?.points === -5 && (await api('/points', { token: T.pavan })).data.me === -3, JSON.stringify(r.data));
  const hist = (await api('/points', { token: T.pavan })).data.history.map(h => h.points);
  check('points history recorded', hist.length === 4);
  const wi = await ok('walk-in ticket on behalf of a requestor', '/tickets', { token: T.pavan, method: 'POST', body: { channel: 'walk_in', service_id: elec.id, name: 'Walk In', email: 'w1@example.com', subject: 'Walked in', form_data: { loc_block: 'Main block', loc_floor: 'Ground floor', loc_room: 'Lobby', issue: 'Light' } } });
  check('walk-in recorded with its channel', wi.channel === 'walk_in' && wi.ticket_no === '0006');
  await fails('walk-in also needs the requestor’s email', '/tickets', { token: T.pavan, method: 'POST', body: { channel: 'walk_in', service_id: elec.id, name: 'No Mail', subject: 'x', form_data: { loc_block: 'a', loc_floor: 'Ground floor', loc_room: 'b', issue: 'Fan' } } }, 400);
  const it = await ok('internal ticket to another service', '/tickets', { token: T.pavan, method: 'POST', body: { channel: 'internal', service_id: trans.id, subject: 'Need a van for the generator', description: 'Tomorrow 10 am' } });
  check('internal ticket uses the staff member as requestor', it.is_internal === 1 && (await q('SELECT r.email FROM tickets t JOIN requestors r ON r.id=t.requestor_id WHERE t.id=?', it.id))[0].email === 'pavan@example.com');
  const csv = await api('/tickets.csv?status=all', { token: T.asha, raw: true });
  check('CSV export', csv.headers.get('content-type')?.includes('text/csv') && (await csv.text()).startsWith('ticket_no,'));

  // ======================= E. escalation =======================
  sec('Escalation');
  r = await raise('alpha', elecBody('Esc', 'r6@example.com')); const noA = r.data.ticket_no; ids.tA = (await q('SELECT id FROM tickets WHERE ticket_no=? AND tenant_id=?', noA, alpha.id))[0].id;
  r = await raise('alpha', elecBody('Esh', 'r7@example.com')); const noB = r.data.ticket_no; ids.tB = (await q('SELECT id FROM tickets WHERE ticket_no=? AND tenant_id=?', noB, alpha.id))[0].id;
  await act(ids.tB, { to: 'hold', note: 'Waiting', hold_reason: 'parts' });
  check('Lata does not see them before escalation', !(await api('/tickets?status=all', { token: T.lata })).data.some(t => [noA, noB].includes(t.ticket_no)));
  const past = new Date(Date.now() - 2 * 3600e3).toISOString();
  await run('UPDATE tickets SET due_at=? WHERE id=?', past, ids.tA); await run('UPDATE tickets SET hold_due_at=? WHERE id=?', past, ids.tB);
  await ok('rule: escalate 1 day after the target', '/sla', { ...A, method: 'PUT', body: { ...sla, work_days: sla.work_days, escalate_after_days: 1 } });
  await stop(); await start(); await sleep(4500); // the escalation check runs a few seconds after start
  check('2 hours overdue with a 1-day rule: not escalated', (await q('SELECT escalated_at FROM tickets WHERE id IN (?,?)', ids.tA, ids.tB)).every(t => !t.escalated_at));
  // a campus with no campus admin and no escalation person: escalation goes to the super admin
  const gamma = await ok('create campus GAMMA with no campus admin', '/tenants', { method: 'POST', token: T.sa, body: { code: 'GAMMA', name: 'Gamma Campus', slug: 'gamma' } });
  const G = { token: T.sa, tenant: gamma.id };
  const gu = await ok('add a provider', '/users', { ...G, method: 'POST', body: { name: 'Gita Provider', email: 'gita@example.com', role: 'provider' } });
  const gs = await ok('add a service without an escalation person', '/services', { ...G, method: 'POST', body: { code: 'GHELP', name: 'Help', form_schema: { form_type: 'general', fields: [] } } });
  await ok('assign the provider', `/services/${gs.id}/members`, { ...G, method: 'PUT', body: { user_ids: [gu.id] } });
  r = await raise('gamma', { service_id: gs.id, name: 'Gus', email: 'g1@example.com', subject: 'Need help', location: 'Office' });
  const idG = (await q('SELECT id FROM tickets WHERE tenant_id=? AND ticket_no=?', gamma.id, r.data.ticket_no))[0].id;
  await run('UPDATE tickets SET due_at=? WHERE id=?', past, idG);
  await ok('rule: escalate as soon as the target is missed', '/sla', { ...A, method: 'PUT', body: { ...sla, escalate_after_days: 0 } });
  await stop(); await start(); await sleep(4500);
  const esc = await q('SELECT escalated_at, escalated_to FROM tickets WHERE id IN (?,?)', ids.tA, ids.tB);
  check('overdue ticket and overdue hold both escalated to Lata', esc.every(t => t.escalated_at && t.escalated_to === lata.id));
  const superId = (await q("SELECT id FROM users WHERE role='super_admin'"))[0].id, eg = (await q('SELECT escalated_to FROM tickets WHERE id=?', idG))[0];
  check('no escalation person and no campus admin: escalated to the super admin', eg.escalated_to === superId);
  check('super admin is emailed and sees it as escalated', (await q("SELECT count(*) n FROM notifications WHERE template_key='escalated' AND recipient=?", SUPER.email))[0].n >= 1
    && (await api('/tickets?status=escalated', { token: T.sa, tenant: gamma.id })).data.some(t => t.id === idG));
  const lq = await ok('Lata’s Escalated tab', '/tickets?status=escalated', { token: T.lata });
  check('escalated tickets appear in her queue, marked', lq.length === 2 && lq.every(t => t.escalated_name === 'Lata Lead'));
  const ld = await ok('Lata opens the escalated ticket', `/tickets/${ids.tA}`, { token: T.lata });
  check('workspace shows the escalation and the timeline entry', ld.escalated_name === 'Lata Lead' && ld.events.some(e => e.event_type === 'escalated'));
  check('Lata’s home tiles count it', (await api('/reports?days=7', { token: T.lata })).data.counts.open >= 1);
  const mA = await mailsFor(noA);
  check('escalation emails: only the escalation person (not the provider), and the requestor acknowledgement', mA.some(m => m.k === 'escalated' && m.recipient === 'lata@example.com') && !mA.some(m => m.k === 'escalated' && m.recipient === 'pavan@example.com') && mA.some(m => m.k === 'escalated_requestor' && m.recipient === 'r6@example.com'));
  check('requestor timeline says who it went to', (await api(`/public/alpha/tickets/${noA}`)).data.events.some(e => e.event_type === 'escalated' && e.to_value === 'Lata Lead'));
  r = await act(ids.tA, { to: 'closed', note: 'Fixed by the lead' }, T.lata); check('escalation person can close it', r.status === 200);
  await ok('requestor asks to reopen it', `/public/alpha/tickets/${noA}/reopen`, { method: 'POST', body: { reason: 'Still broken' } });
  check('only the provider who closed it (or an admin) decides', (await api(`/tickets/${ids.tA}/reopen-request`, { token: T.pavan, method: 'POST', body: { decision: 'accept', note: 'x' } })).status === 403);
  await ok('the lead who closed it declines first', `/tickets/${ids.tA}/reopen-request`, { token: T.lata, method: 'POST', body: { decision: 'decline', note: 'Please check the switch first' } });
  const dec = (await api(`/public/alpha/tickets/${noA}`)).data;
  check('declined: stays closed, the requester sees why and is emailed', dec.status === 'closed' && !dec.reopen_request && dec.events.some(e => e.event_type === 'reopen_declined' && /switch/.test(e.body)) && (await mailsFor(noA)).some(m => m.k === 'reopen_declined'));
  await ok('the requester asks again', `/public/alpha/tickets/${noA}/reopen`, { method: 'POST', body: { reason: 'Checked the switch, still broken' } });
  await ok('this time the lead accepts', `/tickets/${ids.tA}/reopen-request`, { token: T.lata, method: 'POST', body: { decision: 'accept', note: 'Reopening' } });
  check('reopen clears the escalation', !(await q('SELECT escalated_at FROM tickets WHERE id=?', ids.tA))[0].escalated_at);
  await run('UPDATE tickets SET due_at=? WHERE id=?', past, wi.id); // make the walk-in ticket overdue
  const att = await ok('attention list', '/attention', { token: T.asha });
  check('attention: no-provider service, escalated and overdue lists', att.no_provider.some(s => s.code === 'TRANS') && att.escalated.some(t => t.ticket_no === noB) && att.overdue.length >= 1);

  // ======================= F. emails =======================
  sec('Email connection, delivery, templates');
  T.sa = await login(SUPER.email, SUPER.password);
  const cfg0 = await ok('super admin reads mail config', '/mail/config', { token: T.sa });
  check('27 email steps listed, none connected yet', cfg0.events.length === 27 && !cfg0.url);
  await fails('campus admin cannot read the connection', '/mail/config', { token: T.asha }, 403);
  await fails('flow URL must be https', '/mail/config', { token: T.sa, method: 'PUT', body: { url: 'ftp://x' } }, 400);
  await fails('short key rejected', '/mail/config', { token: T.sa, method: 'PUT', body: { key: 'short' } }, 400);
  const tst = await ok('test send with a wrong key', '/mail/test', { token: T.sa, method: 'POST', body: { to: 'me@example.com', url: FLOW_URL, key: 'wrong-key-000000000000' } });
  check('reports the key mismatch', tst.ok === false && tst.status === 401 && /key/i.test(tst.hint));
  await ok('connect the flow', '/mail/config', { token: T.sa, method: 'PUT', body: { url: FLOW_URL, key: flow.key, base: APP, sending: true } });
  const cfg1 = (await api('/mail/config', { token: T.sa })).data;
  check('key stored masked, status connected', cfg1.has_key && cfg1.key_masked.endsWith(flow.key.slice(-4)) && cfg1.url === FLOW_URL);
  check('saved key can be copied by the super admin', (await api('/mail/key', { token: T.sa })).data.key === flow.key);
  const tst2 = await ok('test send with the right key', '/mail/test', { token: T.sa, method: 'POST', body: { to: 'me@example.com' } });
  // (found by its address, not "the last one received": an email queued a moment earlier may reach the flow right after it)
  const tmail = flow.received.filter(m => m.to === 'me@example.com' && /Test email/.test(m.subject)).at(-1);
  check('flow accepted it', tst2.ok === true && tst2.status === 200 && !!tmail);
  check('the test email carries real buttons to try: Sign in and the guide', tmail?.html.includes(`href="${APP}/#/login"`) && tmail?.html.includes(`href="${APP}/guide/requestor.html"`)
    && tmail?.text.includes(`Sign in to ONE Desk: ${APP}/#/login`));
  flow.received.length = 0;
  r = await raise('alpha', elecBody('Mail', 'r8@example.com')); const noM = r.data.ticket_no;
  const sent = await waitFor(async () => { const m = await mailsFor(noM); return m.length >= 2 && m.every(x => x.status === 'sent') ? m : null; });
  check('new ticket emails delivered through the flow', !!sent, JSON.stringify(await mailsFor(noM)));
  const got = flow.received.find(x => x.to === 'r8@example.com');
  check('flow received to / subject / html / text with the designed sections', !!got && /\[.*\] Ticket received/.test(got.subject) && /Progress/.test(got.html) && /View your ticket/.test(got.html) && /Ticket details/.test(got.text));
  await ok('switch off “update from the provider”', '/mail/config', { token: T.sa, method: 'PUT', body: { events: { note: false } } });
  const idM = (await q('SELECT id FROM tickets WHERE ticket_no=? AND tenant_id=?', noM, alpha.id))[0].id;
  await ok('provider adds a public note', `/tickets/${idM}/notes`, { token: T.pavan, method: 'POST', body: { body: 'Coming today' } });
  check('switched-off step is logged as skipped', (await mailsFor(noM)).find(m => m.k === 'note')?.status === 'skipped');
  await ok('switch it back on', '/mail/config', { token: T.sa, method: 'PUT', body: { events: { note: true } } });
  await fails('template with a field this email lacks is rejected', '/mail/template/created', { token: T.sa, method: 'PUT', body: { subject: 'x {{temp_password}}', body: 'y' } }, 400);
  await ok('customise the “received” template', '/mail/template/created', { token: T.sa, method: 'PUT', body: { subject: '[{{ticket_no}}] Got it, {{requestor_name}}', body: 'Hi {{requestor_name}}\n[[Open|{{ticket_link}}]]' } });
  r = await raise('alpha', elecBody('Tpl', 'r10@example.com')); const noT = r.data.ticket_no;
  check('custom template used', (await mailsFor(noT)).find(m => m.k === 'created')?.subject === `[${noT}] Got it, Tpl`);
  check('marked customised', (await api('/mail/config', { token: T.sa })).data.events.find(e => e.key === 'created').custom === true);
  await ok('reset to default', '/mail/template/created', { token: T.sa, method: 'PUT', body: { subject: '', body: '' } });
  check('back to default', (await api('/mail/config', { token: T.sa })).data.events.find(e => e.key === 'created').custom === false);
  const pv = await ok('preview with sample values', '/mail/preview', { token: T.sa, method: 'POST', body: { key: 'status_hold' } });
  const pvs = await Promise.all((await api('/mail/config', { token: T.sa })).data.events.map(e => api('/mail/preview', { token: T.sa, method: 'POST', body: { key: e.key, subject: e.default_subject, body: e.default_body } }).then(r => [e.key, r.data.html])));
  const broken = pvs.filter(([, h]) => h.includes('[[') || !/href="/.test(h) || [...h.matchAll(/href="([^"]+)"/g)].some(m => !/^https?:\/\//.test(m[1]))).map(([k]) => k);
  check(`every email's button is a working link (all ${pvs.length} emails)`, pvs.length >= 18 && !broken.length, broken.join(', '));
  const inl = (await api('/mail/preview', { token: T.sa, method: 'POST', body: { key: 'created', body: 'Hi {{requestor_name}}, see [[your ticket|{{ticket_link}}]] any time.' } })).data.html;
  check('[[Text|link]] inside a sentence becomes a plain link', /Hi Meena, see <a href="http[^"]+"[^>]*>your ticket<\/a> any time\./.test(inl), inl.slice(-400));
  check('preview renders subject and sections', /0042/.test(pv.subject) && /Progress/.test(pv.html) && /On hold/.test(pv.html));
  const logS = await ok('delivery log (sent)', '/mail/log?status=sent', { token: T.sa });
  check('log lists sent emails with campus', logS.length >= 2 && logS[0].campus);
  const logA = await ok('campus admin sees her campus’s log', '/mail/log?status=all', { token: T.asha });
  check('campus admin log has no Beta emails', logA.every(m => m.campus !== 'BETA'));
  const logged = (await q("SELECT id FROM notifications WHERE status='logged' LIMIT 1"))[0];
  await ok('resend a logged email', '/mail/resend', { token: T.sa, method: 'POST', body: { ids: [logged.id] } });
  check('resent through the flow', !!(await waitFor(async () => (await q("SELECT status FROM notifications WHERE id=?", logged.id))[0].status === 'sent')));
  await ok('pause sending', '/mail/config', { token: T.sa, method: 'PUT', body: { sending: false } });
  r = await raise('alpha', elecBody('Paused', 'r11@example.com')); await sleep(1500);
  check('paused: email logged with the reason', (await mailsFor(r.data.ticket_no)).find(m => m.k === 'created')?.last_error === 'Sending is paused');
  await ok('resume sending', '/mail/config', { token: T.sa, method: 'PUT', body: { sending: true } });

  // ======================= G. people, roles, isolation =======================
  sec('People management');
  const omarR = await ok('campus admin adds a provider', '/users', { token: T.asha, method: 'POST', body: { name: 'Omar Ops', email: 'omar@example.com', role: 'provider' } });
  await fails('campus admin cannot create an admin', '/users', { token: T.asha, method: 'POST', body: { name: 'X', email: 'x@example.com', role: 'tenant_admin' } }, 403);
  await ok('super admin promotes Omar to campus admin', `/users/${omarR.id}`, { ...A, method: 'PATCH', body: { role: 'tenant_admin' } });
  await fails('campus admin cannot change roles', `/users/${omarR.id}`, { token: T.asha, method: 'PATCH', body: { role: 'provider' } }, 403);
  await ok('super admin sets Omar back to provider', `/users/${omarR.id}`, { ...A, method: 'PATCH', body: { role: 'provider' } });
  await ok('edit Omar’s phone', `/users/${omarR.id}`, { token: T.asha, method: 'PATCH', body: { phone: '9000012345' } });
  const rs = await ok('reset Omar’s password', `/users/${omarR.id}/reset-password`, { token: T.asha, method: 'POST' });
  check('old temporary password stops working, new one works and must be changed', !(await login('omar@example.com', omarR.temp_password)) && (await api('/me', { token: await login('omar@example.com', rs.temp_password) })).data.user.must_change_pw === 1);
  check('reset was emailed', (await q("SELECT count(*) n FROM notifications WHERE template_key='password_reset' AND recipient='omar@example.com'"))[0].n === 1);
  await fails('cannot deactivate yourself', `/users/${asha.id}`, { token: T.asha, method: 'PATCH', body: { is_active: 0 } }, 400);
  await fails('cannot reset your own password here', `/users/${asha.id}/reset-password`, { token: T.asha, method: 'POST' }, 400);
  await ok('add Omar to Electrical', `/services/${elec.id}/members`, { token: T.asha, method: 'PUT', body: { user_ids: [pavan.id, omarR.id] } });
  await ok('deactivate Omar', `/users/${omarR.id}`, { token: T.asha, method: 'PATCH', body: { is_active: 0 } });
  check('deactivated: cannot sign in, removed from the service', !(await login('omar@example.com', rs.temp_password)) && (await api('/services', { token: T.asha })).data.find(x => x.code === 'ELEC').members.length === 1);
  await fails('providers cannot manage people', '/users', { token: T.pavan }, 403);
  const users = await ok('people list', '/users', { token: T.asha });
  check('list shows services per person', users.find(u => u.email === 'pavan@example.com')?.services?.includes('Electrical'));
  const audit = await ok('audit log', '/audit', { token: T.asha });
  check('admin actions are audited', ['user.create', 'user.reset_password', 'service.create', 'sla.update'].every(a => audit.some(x => x.action === a)));

  sec('Campus isolation');
  check('Beta admin sees only Beta tickets', (await api('/tickets?status=all', { token: T.bina })).data.every(t => t.ticket_no === '0001' && t.service_code === 'GEN'));
  await fails('Beta admin cannot open an Alpha ticket', `/tickets/${ids.t1}`, { token: T.bina }, 404);
  await fails('a provider cannot switch campus with the header', '/tickets', { token: T.pavan, tenant: beta.id }, 403);
  check('super admin can look into Beta', (await api('/services', { token: T.sa, tenant: beta.id })).data[0].code === 'GEN');
  const grp = await ok('group-wide report', '/group/report', { token: T.sa });
  check('group report has every campus', grp.length === 3 && ['ALPHA', 'BETA', 'GAMMA'].every(c => grp.some(g => g.code === c)));
  const repA = await ok('Alpha reports', '/reports?days=30', { token: T.asha });
  check('reports have counts and per-service rows', repA.counts.created_period >= 8 && repA.by_service.some(x => x.name === 'Electrical'));
  let last; for (let i = 0; i < 6; i++) last = await raise('beta', { service_id: gen.id, name: 'Lim', email: 'limit@example.com', subject: 'Many', location: 'x' });
  check('6th ticket in an hour from one email is rate-limited', last.status === 429);
  check('deactivated campus hides its portal', (await api('/tenants/' + beta.id, { token: T.sa, method: 'PATCH', body: { is_active: 0 } })).status === 200 && (await api('/public/beta')).status === 404);

  // ======================= G2. concurrent requests =======================
  sec('Concurrent requests');
  r = await raise('alpha', elecBody('Race', 'race@example.com'));
  const idR = (await q('SELECT id FROM tickets WHERE ticket_no=? AND tenant_id=?', r.data.ticket_no, alpha.id))[0].id;
  const before = (await api('/points', { token: T.pavan })).data.me;
  const both = await Promise.all([1, 2].map(() => api(`/tickets/${idR}/status`, { method: 'POST', token: T.pavan, body: { to: 'closed', note: 'Double click' } })));
  check('two closes at once: one wins, the other gets 409', both.map(x => x.status).sort().join() === '200,409', both.map(x => x.status).join());
  check('…and points are awarded once', (await api('/points', { token: T.pavan })).data.me - before === both.find(x => x.status === 200)?.data.points);
  check('…and one close event is recorded', (await q("SELECT count(*) n FROM ticket_events WHERE ticket_id=? AND event_type='status_changed'", idR))[0].n === 1);

  // ======================= G3. start-up provisioning =======================
  sec('Start-up provisioning (provision/ files)');
  const PDIR = path.join(TMP, 'provision'); fs.mkdirSync(PDIR, { recursive: true });
  fs.writeFileSync(path.join(PDIR, 'delta.json'), JSON.stringify({ campus: { code: 'DELTA', name: 'Delta Campus', slug: 'delta' },
    services: [{ code: 'DHELP', name: 'Delta help', form_schema: { form_type: 'general', fields: [] } }, { code: 'DEXAM', name: 'Delta exams', form_schema: { form_type: 'student', fields: [] } },
               { code: 'bad code', name: 'Broken' }] }));
  fs.writeFileSync(path.join(PDIR, 'delta.private.json'), JSON.stringify({ campus: { code: 'DELTA' },
    people: [{ name: 'Dev Provider', email: 'dev@example.com', phone: '9000000099' }, { name: 'Esha Lead', email: 'esha@example.com' }, { name: 'Pavan again', email: 'PAVAN@example.com' }],
    assign: { DHELP: { providers: ['dev@example.com'], escalation: 'esha@example.com' }, DEXAM: { providers: ['dev@example.com', 'esha@example.com'] } },
    mail: { url: 'https://example.com/other-flow', key: 'another-key-0123456789', base: 'https://elsewhere.example.com' } }));
  const mailBefore = (await api('/mail/config', { token: T.sa })).data;
  await stop(); await start();
  const delta = (await q("SELECT id FROM tenants WHERE code='DELTA'"))[0];
  check('campus created from the file', !!delta && (await api('/public/delta')).data?.services.length === 2);
  const dsv = delta ? (await api('/services', { token: T.sa, tenant: delta.id })).data : [];
  check('services added; a bad one is skipped', dsv.length === 2 && !dsv.some(x => x.name === 'Broken'));
  check('staff added as providers who must set a password', (await q("SELECT count(*) n FROM users WHERE email IN ('dev@example.com','esha@example.com') AND role='provider' AND must_change_pw=1"))[0].n === 2);
  check('an existing email is not duplicated or moved', (await q("SELECT count(*) n FROM users WHERE lower(email)='pavan@example.com'"))[0].n === 1 && (await q("SELECT tenant_id FROM users WHERE lower(email)='pavan@example.com'"))[0].tenant_id === alpha.id);
  check('providers and escalation person assigned', dsv.find(x => x.code === 'DHELP')?.members[0]?.email === 'dev@example.com' && dsv.find(x => x.code === 'DHELP')?.escalation_user?.name === 'Esha Lead' && dsv.find(x => x.code === 'DEXAM')?.members.length === 2);
  const mailAfter = (await api('/mail/config', { token: T.sa })).data;
  check('an existing email connection is not overwritten by the file', mailAfter.url === mailBefore.url && mailAfter.base === mailBefore.base && mailAfter.key_masked === mailBefore.key_masked);
  check('invites are held, not sent', (await q("SELECT status FROM notifications WHERE template_key='invite' AND recipient IN ('dev@example.com','esha@example.com')")).every(n => n.status === 'logged'));
  const devWelcome = (await q("SELECT body FROM notifications WHERE template_key='invite' AND recipient='dev@example.com'"))[0];
  check('held welcome email lists the services the file assigned', devWelcome.body.includes(dsv.find(x => x.code === 'DHELP').name));
  const DT = { token: T.sa, tenant: delta.id }, open1 = dsv.find(x => x.members.length < 2), full = dsv.find(x => x.members.length >= 2);
  const zed = await ok('add a provider with a service', '/users', { ...DT, method: 'POST', body: { name: 'Zed Provider', email: 'zed@example.com', role: 'provider', service_ids: [open1.id] } });
  check('new provider is on the service and their welcome lists it', (await api('/services', DT)).data.find(x => x.id === open1.id).members.some(m => m.email === 'zed@example.com')
    && (await q("SELECT body FROM notifications WHERE template_key='invite' AND recipient='zed@example.com'"))[0].body.includes(open1.name));
  if (full) await ok('a third provider can join a team', '/users', { ...DT, method: 'POST', body: { name: 'Yan', email: 'yan@example.com', role: 'provider', service_ids: [full.id] } });
  await ok('deactivate the extra provider', `/users/${zed.id}`, { ...DT, method: 'PATCH', body: { is_active: 0 } });
  await ok('admin removes DEXAM’s providers', `/services/${dsv.find(x => x.code === 'DEXAM').id}/members`, { token: T.sa, tenant: delta.id, method: 'PUT', body: { user_ids: [] } });
  await ok('admin renames DHELP', `/services/${dsv.find(x => x.code === 'DHELP').id}`, { token: T.sa, tenant: delta.id, method: 'PATCH', body: { name: 'Delta helpdesk' } });
  await stop(); await start();
  const dsv2 = (await api('/services', { token: T.sa, tenant: delta.id })).data;
  check('restart: nothing duplicated, admin changes kept', dsv2.length === 2 && dsv2.find(x => x.code === 'DHELP')?.name === 'Delta helpdesk' && dsv2.find(x => x.code === 'DEXAM')?.members.length === 0
    && (await q("SELECT count(*) n FROM users WHERE email IN ('dev@example.com','esha@example.com')"))[0].n === 2);
  check('provisioning is in the audit log', (await q("SELECT count(*) n FROM audit_logs WHERE action='provision'"))[0].n >= 1);
  fs.rmSync(PDIR, { recursive: true, force: true });

  sec('Daily ticket limit and report dates');
  await stop(); await start(); // fresh hourly counters
  const day = async (email, type, n) => { let r; for (let i = 0; i < n; i++) r = await raise('alpha', { service_id: trans.id, name: 'Day', email, subject: 'Daily ' + i, location: 'Gate', requestor_type: type }); return r; };
  check('limits are on the SLA page: 5 a day, 9 for faculty', (await api('/sla', { token: T.asha })).data.daily_limits?.student === 5 && (await api('/sla', { token: T.asha })).data.daily_limits?.faculty === 9);
  check('a student email raises 5 tickets today', (await day('stud@example.com', 'student', 5)).status === 200);
  const studMails = await q("SELECT n.html FROM notifications n JOIN tickets t ON t.id=n.ticket_id WHERE n.template_key='created' AND n.recipient='stud@example.com' ORDER BY t.ticket_no");
  check('only the first ticket’s email links the requestor guide', studMails.length === 5 && studMails[0].html.includes('/guide/requestor.html')
    && studMails.slice(1).every(m => !m.html.includes('/guide/')), studMails.map(m => m.html.includes('/guide/')).join(','));
  r = await day('stud@example.com', 'student', 1);
  check('6th is refused with when they can raise again', r.status === 429 && r.error.code === 'DAILY_LIMIT' && /5 tickets a day/.test(r.error.message) && /after/.test(r.error.message), r.error?.message);
  check('a faculty email raises 9 tickets today', (await day('fac@example.com', 'faculty', 9)).status === 200);
  r = await day('fac@example.com', 'faculty', 1);
  check('10th faculty ticket is refused', r.status === 429 && /9 tickets a day/.test(r.error.message), r.error?.message);
  const todayIST = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const repToday = await ok('report for a custom range (today)', `/reports?from=${todayIST}&to=${todayIST}`, { token: T.asha });
  check('custom range counts today\'s tickets', repToday.counts.created_period >= 14 && repToday.range.from < repToday.range.to);
  const repOld = await ok('report for an old range', '/reports?from=2020-01-01&to=2020-01-31', { token: T.asha });
  check('a range with no tickets shows zero', Number(repOld.counts.created_period) === 0 && repOld.daily.length === 0 && repOld.by_service.length === 0);
  await fails('From after To is refused', '/reports?from=2026-02-10&to=2026-02-01', { token: T.asha }, 400);

  sec('Raise form: who you are, questions to tick, Other');
  await stop(); await start(); // fresh hourly counters
  const oth = await mkSvc(A, { code: 'HELP', name: 'Help desk', form_schema: { form_type: 'general', fields: [
    { label: 'What do you need help with?', type: 'select', required: true, options: ['Bus pass', 'Other'] }, { label: 'Faculty name (if related)', type: 'short_text', required: false }] } });
  const [qHelp, qFac] = (await api('/services', { token: T.asha })).data.find(x => x.code === 'HELP').form_schema.fields.map(f => f.key);
  const base = n => ({ service_id: oth.id, name: n, email: n.toLowerCase() + '@example.com', subject: 'Need help', location: 'Library' });
  r = await raise('alpha', { ...base('Opt'), description: '', form_data: { [qHelp]: 'Bus pass' } });
  check('description and unticked questions can be left empty', r.status === 200, r.error?.message);
  r = await raise('alpha', { ...base('Oth'), form_data: { [qHelp]: 'Other: Lost my ID card', [qFac]: '' } });
  check('"Other" with typed words is accepted and saved', r.status === 200 && (await q("SELECT count(*) n FROM tickets WHERE service_id=? AND form_data LIKE '%Other: Lost my ID card%'", oth.id))[0].n === 1, r.error?.message);
  r = await raise('alpha', { ...base('Bad'), form_data: { [qHelp]: 'Something else' } });
  check('an answer that is not an option is refused', r.status === 400);
  r = await raise('alpha', { service_id: exam.id, name: 'Prof Rao', email: 'prof.rao@example.com', subject: 'Exam duty', requestor_type: 'faculty', identifier: 'FAC9', department: 'Physio', form_data: { what_do_you_need: 'Results' } });
  check('faculty on a student service give a faculty ID, not student details', r.status === 200
    && (await q("SELECT r.identifier, r.requestor_type FROM requestors r WHERE lower(r.email)='prof.rao@example.com'"))[0]?.identifier === 'FAC9', r.error?.message);
  r = await raise('alpha', { service_id: exam.id, name: 'Stu Dent', email: 'stu.dent@example.com', subject: 'Results', requestor_type: 'student', form_data: { what_do_you_need: 'Results' } });
  check('a student on a student service still gives student details', r.status === 400 && /Student ID/.test(Object.values(r.error.details || {}).join(' ')), JSON.stringify(r.error));
  check('one plain line names every empty box, without the word required', /^Please fill in: .*Student ID.*Department/.test(r.error.message) && !/required|optional|mandatory/i.test(r.error.message), r.error.message);
  r = await raise('alpha', { ...base('Nob'), subject: '' });
  check('a skipped subject is asked for in plain words', r.status === 400 && r.error.message === 'Please fill in the subject', r.error?.message);

  sec('Photos in every format');
  await stop(); await start(); // fresh hourly counters
  const heicData = 'data:;base64,' + fs.readFileSync(HEIC_FILE).toString('base64'); // Chrome gives a HEIC file no type at all
  const attOf = async tok => q('SELECT * FROM attachments WHERE ticket_id=(SELECT id FROM tickets WHERE tracking_token=?) ORDER BY created_at', tok);
  r = await raise('alpha', { ...elecBody('Heic', 'heic@example.com'), files: [{ name: 'IMG20261029145618.heic', type: '', source: 'gallery', data: heicData }] });
  const hAtt = r.status === 200 ? (await attOf(r.data.tracking_token))[0] : null;
  check('a HEIC photo is stored as a JPEG picture', hAtt?.mime_type === 'image/jpeg' && hAtt.file_name === 'IMG20261029145618.jpg' && hAtt.storage_key.endsWith('.jpg'), JSON.stringify(hAtt || r.error));
  const hf = await fetch(`${APP}/api/files/${hAtt?.storage_key}`), hb = Buffer.from(await hf.arrayBuffer());
  check('it is served as image/jpeg, never sniffed', hf.headers.get('content-type') === 'image/jpeg' && hf.headers.get('x-content-type-options') === 'nosniff' && hb[0] === 0xff && hb[1] === 0xd8);
  r = await raise('alpha', { ...elecBody('Mislabel', 'mislabel@example.com'), files: [{ name: 'shot.heic', type: 'image/heic', source: 'gallery', data: PNG }] });
  check('the bytes decide the type: a PNG named .heic stays a PNG', r.status === 200 && (await attOf(r.data.tracking_token))[0]?.mime_type === 'image/png', r.error?.message);
  r = await raise('alpha', { ...elecBody('Fake', 'fake@example.com'), files: [{ name: 'x.png', type: 'image/png', source: 'gallery', data: 'data:image/png;base64,' + Buffer.from('<html><script>alert(1)</script></html>').toString('base64') }] });
  check('a web page dressed up as a picture is refused', r.status === 400, r.error?.message);
  const pUrl = `${APP}/api/files/${hAtt?.storage_key}`, mailsOf = (key, id) => q('SELECT html, text_body FROM notifications WHERE template_key=? AND ticket_id=? ORDER BY created_at DESC', key, id);
  const hMail = (await mailsOf('created', hAtt?.ticket_id))[0];
  check("the requestor's email shows the photo (and links it in the text version)", !!hMail && hMail.html.includes(`<img src="${pUrl}"`) && hMail.text_body.includes(pUrl));
  check("the providers' new-ticket email shows the photo", (await mailsOf('new_ticket', hAtt?.ticket_id)).some(m => m.html.includes(`<img src="${pUrl}"`)));
  await ok('provider adds a note with a photo', `/tickets/${hAtt?.ticket_id}/notes`, { token: T.pavan, method: 'POST', body: { body: 'Fixed, see the photo', files: [{ name: 'after.heic', type: '', source: 'camera', data: heicData }] } });
  const after = (await q("SELECT storage_key FROM attachments WHERE ticket_id=? AND file_name='after.jpg'", hAtt?.ticket_id))[0];
  check("the update email shows the provider's photo under that update", !!after && (await mailsOf('note', hAtt?.ticket_id))[0]?.html.includes(`<img src="${APP}/api/files/${after.storage_key}"`));
  // a HEIC photo stored before uploads were converted: turned into JPEG once, when the server starts
  const oldKey = crypto.randomBytes(18).toString('hex') + '.heic'; fs.copyFileSync(HEIC_FILE, path.join(UPLOADS, oldKey));
  await q("INSERT INTO attachments (id, tenant_id, ticket_id, uploaded_by_type, source, file_name, mime_type, size_bytes, storage_key, created_at) SELECT 'old-heic', tenant_id, id, 'requestor', 'gallery', 'IMG_OLD.heic', 'image/heic', 1, ?, created_at FROM tickets WHERE id=?", oldKey, hAtt?.ticket_id);
  await stop(); await start();
  let conv; for (let i = 0; i < 40 && conv?.mime_type !== 'image/jpeg'; i++) { await sleep(250); conv = (await q("SELECT * FROM attachments WHERE id='old-heic'"))[0]; }
  check('HEIC photos stored earlier become JPEG at start-up', conv?.mime_type === 'image/jpeg' && conv.file_name === 'IMG_OLD.jpg' && fs.existsSync(path.join(UPLOADS, conv.storage_key)) && !fs.existsSync(path.join(UPLOADS, oldKey)), JSON.stringify(conv));

  sec('ONE Desk Bot (answers from the app, by who is asking)');
  {
    const pb = q => api('/public/alpha/bot', { method: 'POST', body: { q } }), sb = (q, token) => api('/bot', { method: 'POST', token, body: { q } });
    let b = (await pb('hi')).data;
    check('requestor: a greeting with quick choices', /ONE Desk Bot/.test(b.text) && b.chips.includes('Track my ticket'));
    b = (await pb('status of ticket 0001')).data;
    check('requestor: a ticket number gives its status, team and a link; nothing anybody typed (no place, no notes, no names)', /Ticket 0001 is/.test(b.text) && /Electrical/.test(b.text) && b.items[0].href === '#/d/alpha/t/0001' && !/r1@example\.com|Ria|Room 214|Latest update|Handled by|sparks/.test(b.text), b.text);
    check('requestor: no personal details of others (no requestor name or email)', !/@example\.com/.test(JSON.stringify(b)));
    b = (await pb('how do I raise a complaint?')).data;
    check('requestor: how to raise, with links to the form and the guide', /To raise a ticket/.test(b.text) && b.items.some(x => x.href === '#/d/alpha/raise'));
    b = (await pb('which teams can help')).data;
    check('requestor: the campus teams, each linking to its form', b.items.some(x => x.href === '#/d/alpha/raise/ELEC'));
    check('requestor: the daily limit from the campus settings', /5 tickets a day \(faculty 9/.test((await pb('daily limit')).data.text));
    check('requestor: an unknown ticket is said plainly', /couldn't find ticket 9999/.test((await pb('9999')).data.text));
    b = (await sb('overdue', T.pavan)).data;
    check('provider: overdue lists only tickets in their services', b.items.every(x => /Electrical/.test(x.sub)), JSON.stringify(b.items.slice(0, 2)));
    b = (await sb('my open tickets', T.pavan)).data;
    check('provider: open tickets, most urgent first, linking to each', /open ticket/.test(b.text) && b.items.every(x => x.href.startsWith('#/c/t/')));
    const examNo = (await q("SELECT t.ticket_no FROM tickets t JOIN services s ON s.id=t.service_id WHERE s.code='EXAM' AND t.tenant_id=? LIMIT 1", alpha.id))[0]?.ticket_no;
    b = (await sb(`ticket ${examNo}`, T.pavan)).data;
    check("provider: another team's ticket is not shown", !!examNo && /not in your services/.test(b.text), b.text);
    check('provider: admin questions are for admins', /for admins/.test((await sb('services with no provider', T.pavan)).data.text));
    check('provider: own Fair Score (or how many tickets are still needed)', /Fair Score is [\d.]+ \(rank \d+\)|closed tickets in \d+ days to be ranked/.test((await sb('my points', T.pavan)).data.text));
    b = (await sb(`ticket ${examNo}`, T.asha)).data;
    check('admin: any ticket of the campus', new RegExp(`#${examNo}`).test(b.text) && /Raised by/.test(b.text), b.text);
    check("admin: today's summary for the campus", /Today at Alpha Campus: \d+ raised/.test((await sb("today's summary", T.asha)).data.text));
    check('admin: provider workload', (await sb('provider workload', T.asha)).data.items.some(x => /Pavan/.test(x.title)));
    check('the bot needs a sign-in for staff answers', (await api('/bot', { method: 'POST', body: { q: 'overdue' } })).status === 401);
  }

  sec('Same-day duplicate reports');
  { // its own block, so its names don't clash with the rest
  await stop(); await start(); // fresh rate limits
  const { dayIn, normRoom } = await import('../merge.js');
  const dup = (n, room = '203', extra = {}) => raise('alpha', { ...elecBody(n, `${n.toLowerCase()}@dup.example.com`), ...extra,
    form_data: { loc_block: 'Hostel block', loc_floor: '2nd floor', loc_room: room, issue: 'Fan', ...extra.form_data } });
  const tk = async no => (await q('SELECT * FROM tickets WHERE tenant_id=? AND ticket_no=?', alpha.id, no))[0];
  check('room numbers written any way are the same room', ['203', 'Room no. 203', '203 room', '#203'].every(x => normRoom(x) === '203'));
  check('the day turns at midnight IST: 11:58 pm and 12:02 am are different days', dayIn('Asia/Kolkata', '2026-10-30T18:28:00Z') === '2026-10-30' && dayIn('Asia/Kolkata', '2026-10-30T18:32:00Z') === '2026-10-31');
  const d1 = (await dup('Dupa')).data;
  check('the first report makes a ticket (1 affected, normal priority)', !d1.merged && d1.affected_count === 1 && (await tk(d1.ticket_no)).priority === 'medium', JSON.stringify(d1));
  const d2 = (await dup('Dupb', 'Room no. 203')).data;
  check('a second report of the same spot and problem the same day joins it: 2 affected', d2.merged && d2.ticket_no === d1.ticket_no && d2.affected_count === 2, JSON.stringify(d2));
  const d3 = (await dup('Dupc', '#203')).data, d4 = (await dup('Dupd', '203 room')).data;
  check('"#203" and "203 room" join it too; 3+ affected makes it High', d3.ticket_no === d1.ticket_no && d4.ticket_no === d1.ticket_no && d4.affected_count === 4 && (await tk(d1.ticket_no)).priority === 'high');
  const again = (await dup('Dupb', '203')).data;
  check('the same person reporting twice is not counted twice', again.ticket_no === d1.ticket_no && (await tk(d1.ticket_no)).affected_count === 4, JSON.stringify(again));
  check("the joiner's email says how many others reported it", (await q("SELECT body FROM notifications WHERE template_key='created' AND recipient='dupb@dup.example.com'"))[0]?.body.includes('Known issue: 1 other reported this too'));
  check('the ticket page shows how many reported it', (await api(`/public/alpha/tickets/${d1.ticket_no}`)).data.affected_count === 4);
  const other = (await dup('Dupe', '203', { form_data: { loc_block: 'Main block' } })).data;
  check('another building with the same room number is a new ticket', !other.merged && other.ticket_no !== d1.ticket_no);
  const light = (await dup('Dupf', '203', { form_data: { issue: 'Light' } })).data;
  check('same place, different problem is a new ticket', !light.merged && light.ticket_no !== d1.ticket_no);
  for (const n of ['Dupg', 'Duph', 'Dupi', 'Dupj', 'Dupk']) await dup(n);
  const t9 = await tk(d1.ticket_no); await dup('Dupl'); const t10 = await tk(d1.ticket_no);
  check('priority by people affected: 9 still High, 10 makes it Urgent', t9.affected_count === 9 && t9.priority === 'high' && t10.affected_count === 10 && t10.priority === 'critical', `${t9.affected_count}/${t9.priority} ${t10.affected_count}/${t10.priority}`);
  const lt = await tk(light.ticket_no);
  await ok('provider sets a priority by hand', `/tickets/${lt.id}/priority`, { token: T.pavan, method: 'POST', body: { priority: 'low' } });
  for (const n of ['Dupm', 'Dupn', 'Dupo']) await dup(n, '203', { form_data: { issue: 'Light' } });
  check('a priority the provider set is never changed by more reports', (await tk(light.ticket_no)).priority === 'low' && (await tk(light.ticket_no)).affected_count === 4);
  // yesterday's ticket takes no reports after midnight
  const y = (await dup('Dupp', '404')).data; await q("UPDATE tickets SET created_date = created_date - 1 WHERE tenant_id=? AND ticket_no=?", alpha.id, y.ticket_no);
  const y2 = (await dup('Dupq', '404')).data;
  check("yesterday's ticket does not take today's report", !y2.merged && y2.ticket_no !== y.ticket_no);
  // a closed ticket takes no more reports
  const c1 = (await dup('Dupr', '505')).data; r = await act((await tk(c1.ticket_no)).id, { to: 'closed', note: 'Fixed' });
  const c2 = (await dup('Dups', '505')).data;
  check('a closed ticket does not take a new report', r.status === 200 && !c2.merged && c2.ticket_no !== c1.ticket_no, r.error?.message);
  // "Other": typed problems match when they are alike (pg_trgm similarity ≥ 0.6)
  const o1 = await raise('alpha', { ...base('Otha'), form_data: { [qHelp]: 'Other: Lost my ID card!!' } });
  const o2 = await raise('alpha', { ...base('Othb'), form_data: { [qHelp]: 'Other: water tap leaking' } });
  check('"Other" problems: alike words join, different ones do not', o1.data?.merged && !o2.data?.merged, JSON.stringify([o1.data || o1.error, o2.data || o2.error]));
  // 50 at once still make exactly one ticket
  const burst = await Promise.all(Array.from({ length: 50 }, (_, i) => dup(`Burst${i}`, '301')));
  const bt = await q("SELECT ticket_no, affected_count, priority FROM tickets WHERE tenant_id=? AND location_key='hostel block:301'", alpha.id);
  check('50 reports at the same moment make exactly one ticket with 50 affected', burst.every(x => x.status === 200) && bt.length === 1 && bt[0].affected_count === 50 && bt[0].priority === 'critical',
    JSON.stringify({ errors: burst.filter(x => x.status !== 200).map(x => x.error?.message).slice(0, 2), tickets: bt }));
  check('…and every one of them got that ticket number', new Set(burst.map(x => x.data.ticket_no)).size === 1);
  // one status change: one email to every requestor, each by name
  const big = await tk(d1.ticket_no); r = await act(big.id, { to: 'in_progress', note: 'Electrician on the way' });
  const sent = await q("SELECT recipient, body FROM notifications WHERE template_key='status_in_progress' AND ticket_id=?", big.id);
  check('a status change emails all 10 requestors, each greeted by name', r.status === 200 && sent.length === 10 && new Set(sent.map(m => m.recipient)).size === 10 && sent.some(m => m.recipient === 'dupb@dup.example.com' && /Hi Dupb/.test(m.body)), sent.length);
  // closing can close the same problem's older tickets too
  const e1 = (await dup('Dupt', '606')).data; await q('UPDATE tickets SET created_date = created_date - 1 WHERE tenant_id=? AND ticket_no=?', alpha.id, e1.ticket_no);
  const e2 = (await dup('Dupu', '606')).data; r = await act((await tk(e2.ticket_no)).id, { to: 'closed', note: 'Rewired the room', close_earlier: true });
  const old = await tk(e1.ticket_no);
  check("closing with \"also close earlier\" closes yesterday's ticket for the same spot and problem, and emails its requestor", r.status === 200 && r.data.closed_earlier === 1 && old.status === 'closed'
    && (await q("SELECT 1 FROM notifications WHERE template_key='status_closed' AND ticket_id=? AND recipient='dupt@dup.example.com'", old.id)).length === 1, JSON.stringify(r.data || r.error));
  // confirm mode: the person is asked first
  await ok('super admin switches to confirm mode', '/merge-mode', { token: T.sa, tenant: alpha.id, method: 'PUT', body: { mode: 'confirm' } });
  await fails('a tenant admin cannot switch it', '/merge-mode', { token: T.asha, method: 'PUT', body: { mode: 'silent' } }, 403);
  const ask = await dup('Dupv', '301');
  check('confirm mode: a match is offered first ("Same issue?"), by the problem and the place: never the first person’s own words', ask.status === 409 && ask.error.code === 'POSSIBLE_DUPLICATE' && ask.error.details.ticket_no === bt[0].ticket_no
    && ask.error.details.subject === 'Fan · Hostel block · 2nd floor · 301' && !/Ticket from/.test(JSON.stringify(ask.error)), JSON.stringify(ask.error));
  const no = (await dup('Dupv', '301', { merge: 'no' })).data, yes = (await dup('Dupw', '301', { merge: 'yes' })).data;
  check('"No, raise new" makes a separate ticket marked not merged; "Yes, add me" joins', !no.merged && (await tk(no.ticket_no)).not_merged === 1 && yes.merged && yes.ticket_no === bt[0].ticket_no);
  await ok('back to silent mode', '/merge-mode', { token: T.sa, tenant: alpha.id, method: 'PUT', body: { mode: 'silent' } });
  const rep = (await api('/reports?days=1', { token: T.asha })).data, row = rep.by_location.find(x => x.location === 'Hostel block · 2nd floor · 301');
  check('reports: students affected in total and per place', rep.affected >= 70 && row?.affected === 52 && row.tickets === 2, JSON.stringify({ affected: rep.affected, row }));
  check('CSV export has the number affected', (await (await fetch(`${API}/tickets.csv`, { headers: { authorization: 'Bearer ' + T.asha } })).text()).split('\n')[0].includes('affected_count'));
  }

  sec('Team daily queue, provider phone and priority for requestors');
  { // its own block, so its names don't clash with the rest
  await stop(); await start(); // fresh rate limits
  const A = { token: T.sa, tenant: (await q("SELECT id FROM tenants WHERE slug='alpha'"))[0].id }, aid = A.tenant;
  const pavanId = (await q("SELECT id FROM users WHERE email='pavan@example.com'"))[0].id;
  await ok('Pavan has a mobile number', `/users/${pavanId}`, { ...A, method: 'PATCH', body: { phone: '9000055555' } });
  const { n: today } = (await q("SELECT count(*)::int n FROM tickets WHERE service_id=? AND (queue_day=(now() AT TIME ZONE 'Asia/Kolkata')::date OR (queue_day IS NULL AND created_date=(now() AT TIME ZONE 'Asia/Kolkata')::date))", ids.elec))[0];
  await ok('admin sets Electrical to take today’s tickets + 2 a day', `/services/${ids.elec}`, { ...A, method: 'PATCH', body: { daily_cap: today + 2 } });
  await fails('tickets a day must be a whole number', `/services/${ids.elec}`, { ...A, method: 'PATCH', body: { daily_cap: -3 } }, 400);
  check('the service shows its daily limit', (await api('/services', A)).data.find(x => x.id === ids.elec)?.daily_cap === today + 2);
  const qb = (n, type) => raise('alpha', { ...elecBody(n, `${n.toLowerCase()}@queue.example.com`, { requestor_type: type }), form_data: { loc_block: 'Main block', loc_floor: '2nd floor', loc_room: `Q-${n}`, issue: 'Fan' } });
  const r1 = (await qb('Qa', 'student')).data, r2 = (await qb('Qb', 'faculty')).data, r3 = (await qb('Qc', 'student')).data, r4 = (await qb('Qd', 'faculty')).data;
  check('the first tickets within the limit land today, no queue number', r1?.ticket_no && !r1.queue && !r2.queue, JSON.stringify(r1));
  check('past the limit: queue number 1 and 2, how many ahead, and the day it reaches the team', r3.queue?.queue_no === 1 && r3.queue.ahead === 0 && r4.queue?.queue_no === 2 && r4.queue.ahead === 1 && r4.queue.waiting === 2 && !!r4.queue.lands_on, JSON.stringify(r4.queue));
  const t3 = (await q('SELECT * FROM tickets WHERE tenant_id=? AND ticket_no=?', aid, r3.ticket_no))[0];
  check('a queued ticket waits for the next working day, its target counted from then', t3.queued === 1 && t3.queue_day > t3.created_date && t3.lands_at > t3.created_at && t3.due_at > t3.lands_at, JSON.stringify({ d: t3.queue_day, l: t3.lands_at, due: t3.due_at }));
  check('students never see the provider’s mobile number; others do', r1.providers.every(p => !('phone' in p)) && r2.providers.some(p => p.phone === '9000055555'), JSON.stringify([r1.providers, r2.providers]));
  const pub1 = (await api(`/public/alpha/tickets/${r1.ticket_no}`)).data, pub2 = (await api(`/public/alpha/tickets/${r2.ticket_no}`)).data, pub3 = (await api(`/public/alpha/tickets/${r3.ticket_no}`)).data;
  check('ticket page: no phone for a student, phone for faculty', pub1.providers.every(p => !p.phone) && pub2.providers.some(p => p.phone === '9000055555'));
  check('ticket page never shows the priority to the requestor', !('priority' in pub1) && !('priority' in pub3));
  check('ticket page shows the queue number', pub3.queue?.queue_no === 1 && !pub1.queue);
  const mails = async (key, id) => q('SELECT recipient, html, text_body FROM notifications WHERE template_key=? AND ticket_id=?', key, id);
  const c3 = (await mails('created', t3.id))[0];
  check('the received email gives the queue number and the day', /Queue number: 1/.test(c3?.text_body) && /In queue/.test(c3.html), c3?.text_body);
  check('no new-ticket email to the providers while it waits', (await mails('new_ticket', t3.id)).length === 0);
  check('requestor emails never show the priority; provider emails do', !/Priority/.test(c3.html) && !/Priority/.test((await mails('created', (await q('SELECT id FROM tickets WHERE tenant_id=? AND ticket_no=?', aid, r1.ticket_no))[0].id))[0].html)
    && /Priority/.test((await mails('new_ticket', (await q('SELECT id FROM tickets WHERE tenant_id=? AND ticket_no=?', aid, r1.ticket_no))[0].id))[0]?.html || ''));
  const list = (await api('/tickets?status=all', { token: T.pavan })).data, inq = (await api('/tickets?status=queued', { token: T.pavan })).data;
  check('the provider’s list holds only what landed; "In queue" holds the rest, in order', !list.some(x => x.ticket_no === r3.ticket_no) && list.some(x => x.ticket_no === r1.ticket_no) && inq.map(x => x.ticket_no).join() === [r3.ticket_no, r4.ticket_no].join());
  check('reports count the queue apart from open', (await api('/reports?days=1', { token: T.pavan })).data.counts.queued === 2);
  // the day comes: the queue lands at the start of working hours, the team and the requestor are emailed
  await run('UPDATE tickets SET lands_at=? WHERE id=?', new Date(Date.now() - 60e3).toISOString(), t3.id);
  await stop(); await start(); // the release runs a few seconds after start
  const landed = await waitFor(async () => (await q('SELECT queued FROM tickets WHERE id=?', t3.id))[0].queued === 0, 9000);
  check('on its day the ticket reaches the team', landed && (await mails('new_ticket', t3.id)).some(m => m.recipient === 'pavan@example.com'));
  check('the requestor is told it reached the team', (await mails('queue_landed', t3.id)).length === 1);
  check('the one behind it moves up to number 1', (await api(`/public/alpha/tickets/${r4.ticket_no}`)).data.queue?.queue_no === 1);
  const t4 = (await q('SELECT id FROM tickets WHERE tenant_id=? AND ticket_no=?', aid, r4.ticket_no))[0];
  r = await act(t4.id, { to: 'in_progress', note: 'Taking it early' });
  check('a provider can take a queued ticket early', r.status === 200 && (await q('SELECT queued FROM tickets WHERE id=?', t4.id))[0].queued === 0);
  await ok('limit off again', `/services/${ids.elec}`, { ...A, method: 'PATCH', body: { daily_cap: '' } });

  // sub-teams: Maintenance → Plumbing, each with its own providers, escalation officers, limit and queue
  const latId = (await q("SELECT id FROM users WHERE email='lata@example.com'"))[0].id, ashaId = (await q("SELECT id FROM users WHERE email='asha@example.com'"))[0].id;
  const maint = await ok('main team Maintenance', '/services', { ...A, method: 'POST', body: { code: 'MAINT', name: 'Maintenance', form_schema: { form_type: 'general', fields: [] } } });
  await ok('Lata is Maintenance’s nodal officer', `/services/${maint.id}/members`, { ...A, method: 'PUT', body: { user_ids: [latId] } });
  const plumb = await ok('sub-team Plumbing with two escalation officers and 1 ticket a day', '/services', { ...A, method: 'POST', body: { code: 'PLUMB', name: 'Plumbing', parent_id: maint.id, daily_cap: 1,
    escalation_user_ids: [latId, ashaId], form_schema: { form_type: 'general', fields: [] } } });
  await ok('Plumbing’s providers', `/services/${plumb.id}/members`, { ...A, method: 'PUT', body: { user_ids: [pavanId] } });
  await fails('a sub-team cannot have sub-teams', '/services', { ...A, method: 'POST', body: { code: 'DEEP', name: 'Deep', parent_id: plumb.id } }, 400);
  const sv = (await api('/services', A)).data.find(x => x.id === plumb.id);
  check('the sub-team shows its main team and every escalation officer', sv.parent_id === maint.id && sv.escalation_users.length === 2);
  check('the portal knows which team a sub-team belongs to', (await api('/public/alpha')).data.services.find(x => x.code === 'PLUMB')?.parent_id === maint.id);
  const pr = n => raise('alpha', { service_id: plumb.id, name: n, email: `${n.toLowerCase()}@plumb.example.com`, subject: 'Tap leaking ' + n, location: 'Washroom ' + n, requestor_type: 'staff' });
  const p1 = (await pr('Pa')).data, p2 = (await pr('Pb')).data;
  check('the sub-team has its own limit and queue', p1?.ticket_no && !p1.queue && p2?.queue?.queue_no === 1, JSON.stringify(p2));
  check('the main team’s nodal officer sees the sub-team’s tickets', (await api('/tickets?status=all', { token: T.lata })).data.some(x => x.ticket_no === p1.ticket_no));
  check('the sub-team’s provider sees them too', (await api('/tickets?status=all', { token: T.pavan })).data.some(x => x.ticket_no === p1.ticket_no));
  const pt = (await q('SELECT id FROM tickets WHERE tenant_id=? AND ticket_no=?', aid, p1.ticket_no))[0];
  await run('UPDATE tickets SET escalated_at=?, escalated_to=? WHERE id=?', new Date().toISOString(), latId, pt.id);
  await ok('admin changes Plumbing’s escalation officers to Asha only', `/services/${plumb.id}`, { ...A, method: 'PATCH', body: { escalation_user_ids: [ashaId] } });
  check('the change is saved', (await api('/services', A)).data.find(x => x.id === plumb.id).escalation_users.map(u => u.id).join() === ashaId);
  check('open escalated tickets move to the new escalation officer, who is emailed', (await q('SELECT escalated_to FROM tickets WHERE id=?', pt.id))[0].escalated_to === ashaId
    && (await q("SELECT 1 FROM notifications WHERE template_key='escalated' AND ticket_id=? AND recipient='asha@example.com'", pt.id)).length === 1);
  // the team's own escalation time, and only its escalation officers are told
  const late = (await pr('Pc')).data, lt = (await q('SELECT id FROM tickets WHERE tenant_id=? AND ticket_no=?', aid, late.ticket_no))[0];
  await run("UPDATE tickets SET queued=0, due_at=? WHERE id=?", new Date(Date.now() - 60e3).toISOString(), lt.id); // missed its target a minute ago
  await ok('Plumbing escalates 200 working hours after the target', `/services/${plumb.id}`, { ...A, method: 'PATCH', body: { escalate_after_hours: 200 } });
  await stop(); await start(); await sleep(5000);
  check('not escalated before the team’s time is up', !(await q('SELECT escalated_at FROM tickets WHERE id=?', lt.id))[0].escalated_at);
  await ok('Plumbing escalates the moment the target is missed', `/services/${plumb.id}`, { ...A, method: 'PATCH', body: { escalate_after_hours: 0 } });
  await stop(); await start();
  const escd = await waitFor(async () => (await q('SELECT escalated_to FROM tickets WHERE id=? AND escalated_at IS NOT NULL', lt.id))[0], 9000);
  const em = (await waitFor(async () => { const r = await q("SELECT recipient FROM notifications WHERE template_key='escalated' AND ticket_id=?", lt.id); return r.length ? r : null; }, 5000) || []).map(r => r.recipient);
  check('on time it escalates to the chosen officer', escd?.escalated_to === ashaId, JSON.stringify(escd));
  check('only the escalation officer is emailed, not the team’s providers', em.length === 1 && em[0] === 'asha@example.com', JSON.stringify(em));
  }

  sec('Suggestion box and team SLA');
  { const A = { token: T.sa, tenant: (await q("SELECT id FROM tenants WHERE slug='alpha'"))[0].id };
  await stop(); await start();
  const sg = await api('/public/alpha/tickets', { method: 'POST', body: { kind: 'suggestion', service_id: ids.elec, name: 'Sia', email: 'sia@sugg.example.com', phone: '9000066666', requestor_type: 'faculty', identifier: 'FAC9', department: 'Physio',
    subject: 'Motion-sensor lights in corridors', description: 'Lights stay on all night; sensors would save power.', form_data: { loc_block: '', issue: '' } } });
  const st_ = (await q('SELECT * FROM tickets WHERE ticket_no=? AND tenant_id=?', sg.data?.ticket_no, A.tenant))[0];
  check('a suggestion goes through the same form: no location or service questions needed', sg.status === 200 && sg.data.kind === 'suggestion', JSON.stringify(sg.error || sg.data));
  check('it has no target time, low priority, and never counts as overdue', st_.kind === 'suggestion' && st_.due_at === null && st_.priority === 'low');
  check('a suggestion needs words', (await api('/public/alpha/tickets', { method: 'POST', body: { kind: 'suggestion', service_id: ids.elec, name: 'Sia', email: 'sia2@sugg.example.com', phone: '9000066667', requestor_type: 'faculty', identifier: 'F', department: 'D', subject: 'x' } })).status === 400);
  check('the provider sees it under Suggestions, with the requester type', (await api('/tickets?status=suggestions', { token: T.pavan })).data.some(t => t.id === st_.id && t.requestor_type === 'faculty'));
  const sd = (await api(`/tickets/${st_.id}`, { token: T.pavan })).data;
  check('its page has no SLA clock', sd.kind === 'suggestion' && sd.sla_left_min === null);
  check('the received email says the team will read it (no target)', (await q("SELECT body, html FROM notifications WHERE template_key='created' AND ticket_id=?", st_.id))[0]?.html.includes('will read your suggestion'));
  await ok('priority can still change, without a target', `/tickets/${st_.id}/priority`, { token: T.pavan, method: 'POST', body: { priority: 'high' } });
  check('still no target after that', (await q('SELECT due_at FROM tickets WHERE id=?', st_.id))[0].due_at === null);
  const cl = await api(`/tickets/${st_.id}/status`, { token: T.pavan, method: 'POST', body: { to: 'closed', note: 'Added to next year’s plan' } });
  check('closing a suggestion gives no SLA points', cl.status === 200 && cl.data.points === undefined);
  // team SLA: a sub-team without its own targets uses its main team's
  const main = await ok('main team with its own SLA', '/services', { ...A, method: 'POST', body: { code: 'CIVIL', name: 'Civil works', sla: { critical: 2, high: 4, medium: 6, low: 12 }, form_schema: { form_type: 'general', fields: [] } } });
  const sub = await ok('sub-team with none', '/services', { ...A, method: 'POST', body: { code: 'PAINT', name: 'Painting', parent_id: main.id, form_schema: { form_type: 'general', fields: [] } } });
  check('the team’s SLA is saved', (await api('/services', A)).data.find(x => x.id === main.id)?.sla.medium === 6);
  const pt = await api('/public/alpha/tickets', { method: 'POST', body: { service_id: sub.id, name: 'Pi', email: 'pi@sla.example.com', phone: '9000077771', requestor_type: 'staff', identifier: 'S1', department: 'Admin', subject: 'Wall paint peeling', location: 'Block C' } });
  const pr_ = (await q('SELECT created_at, due_at FROM tickets WHERE ticket_no=? AND tenant_id=?', pt.data.ticket_no, A.tenant))[0];
  const { calendar, workingBetween } = await import('../sla.js'), tnr = (await q('SELECT * FROM tenants WHERE id=?', A.tenant))[0];
  check('a sub-team ticket uses its main team’s target (6 working hours, not the campus 8)', workingBetween(calendar(tnr), pr_.created_at, pr_.due_at) === 6 * 60, JSON.stringify(pr_));
  // deactivate and delete a service
  await fails('a team with tickets cannot be deleted', `/services/${ids.elec}`, { ...A, method: 'DELETE' }, 409, 'deactivate it instead');
  await fails('a main team with sub-teams cannot be deleted', `/services/${main.id}`, { ...A, method: 'DELETE' }, 409, 'sub-teams');
  const tmp = await ok('a new unused service', '/services', { ...A, method: 'POST', body: { code: 'TMPX', name: 'Temp service', form_schema: { form_type: 'general', fields: [] } } });
  await ok('…with a provider', `/services/${tmp.id}/members`, { ...A, method: 'PUT', body: { user_ids: [(await q("SELECT id FROM users WHERE email LIKE 'pavan%'"))[0].id] } });
  await ok('deactivate it', `/services/${tmp.id}`, { ...A, method: 'PATCH', body: { is_active: 0 } });
  check('a deactivated service leaves the portal', !(await api('/public/alpha')).data.services.some(x => x.id === tmp.id));
  await fails('a provider cannot delete a service', `/services/${tmp.id}`, { token: T.pavan, method: 'DELETE' }, 403);
  await ok('an admin deletes the unused service', `/services/${tmp.id}`, { ...A, method: 'DELETE' });
  check('it is gone, with its providers list', !(await api('/services', A)).data.some(x => x.id === tmp.id) && !(await q('SELECT 1 FROM service_members WHERE service_id=?', tmp.id)).length);
  }

  sec('Fair Score: busy and quiet teams ranked on equal terms');
  { const A = { token: T.sa, tenant: (await q("SELECT id FROM tenants WHERE slug='alpha'"))[0].id }, tid = A.tenant;
  const mk = async (name, email) => (await ok(`provider ${name}`, '/users', { ...A, method: 'POST', body: { name, email, role: 'provider' } })).id;
  const [p1, p2, p3, p4, p5] = [await mk('Busy One', 'busy1@fair.example.com'), await mk('Busy Two', 'busy2@fair.example.com'), await mk('Quiet One', 'quiet1@fair.example.com'), await mk('Quiet Two', 'quiet2@fair.example.com'), await mk('New One', 'new1@fair.example.com')];
  const busy = await ok('a busy team with long jobs', '/services', { ...A, method: 'POST', body: { code: 'BUSYX', name: 'Busy Maintenance', form_schema: { form_type: 'general', fields: [] } } });
  const quiet = await ok('a quiet team with quick jobs', '/services', { ...A, method: 'POST', body: { code: 'QUIETX', name: 'Quiet Exams', form_schema: { form_type: 'general', fields: [] } } });
  const third = await ok('a third team', '/services', { ...A, method: 'POST', body: { code: 'NEWX', name: 'New Team', form_schema: { form_type: 'general', fields: [] } } });
  await ok('busy members', `/services/${busy.id}/members`, { ...A, method: 'PUT', body: { user_ids: [p1, p2] } });
  await ok('new team member', `/services/${third.id}/members`, { ...A, method: 'PUT', body: { user_ids: [p5] } });
  await ok('quiet members', `/services/${quiet.id}/members`, { ...A, method: 'PUT', body: { user_ids: [p3, p4] } });
  const { calendar, addWorking, dateStart } = await import('../sla.js'), tnr = (await q('SELECT * FROM tenants WHERE id=?', tid))[0], cal = calendar(tnr);
  let day = null; for (let b = 12; b < 30 && !day; b++) { const d = new Date(Date.now() - b * 864e5).toISOString().slice(0, 10); if (cal.days.has(new Date(d + 'T00:00:00Z').getUTCDay())) day = d; }
  const start = addWorking(cal, dateStart(cal.tz, day), 0); let seq = 0;
  // close n tickets for a provider, each taking `work` working minutes (all within their SLA)
  const closeN = async (svc, who, n, work) => { for (let i = 0; i < n; i++) { seq++;
    const t = await ok(`ticket ${seq}`, '/tickets', { ...A, method: 'POST', body: { channel: 'walk_in', service_id: svc, name: 'Fair ' + seq, email: `fair${seq}@fair.example.com`, phone: '90000' + String(10000 + seq), requestor_type: 'staff', subject: 'Fair job ' + seq, description: 'x', location: 'Room ' + seq } });
    const closed = addWorking(cal, start, work);
    await q("UPDATE tickets SET status='closed', closed_by=?, created_at=?, lands_at=NULL, closed_at=?, due_at=?, held_minutes=0, priority='medium' WHERE id=?", who, start, closed, addWorking(cal, closed, 60), t.id); } };
  await closeN(busy.id, p1, 10, 600); await closeN(busy.id, p2, 10, 900); await closeN(quiet.id, p3, 6, 30); await closeN(quiet.id, p4, 6, 60); await closeN(third.id, p5, 2, 600);
  const f = (await api('/fair', A)).data, row = id => f.rows.find(x => x.id === id), order = f.rows.filter(x => [p1, p2, p3, p4].includes(x.id)).map(x => x.id);
  check('each ticket is measured against its own team’s usual time (busy 12.5 h, quiet 45 min)', row(p1).team_typical_hours === 12.5 && row(p3).team_typical_hours === 0.8 && row(p1).team === 'Busy Maintenance' && row(p3).team === 'Quiet Exams', JSON.stringify([row(p1), row(p3)]));
  check('the quick provider of the quiet team (6 tickets, 3 work-hours) ranks with the best of the busy team (10 tickets, 100 work-hours)', order.join() === [p3, p1, p2, p4].join(), JSON.stringify(f.rows.filter(x => [p1, p2, p3, p4].includes(x.id)).map(x => [x.name, x.score, x.parts])));
  check('the math: Quiet One 78.9 = 0.4×68.2 pace + 0.3×100 on time + 0.15×100 done right + 0.15×44.4 load', row(p3).score === 78.9 && row(p3).parts.pace === 68 && row(p3).parts.load === 44 && row(p1).score === 78.3, JSON.stringify([row(p3), row(p1)]));
  check('too few tickets: listed as not ranked yet', row(p5).eligible === false && row(p5).rank === undefined && row(p5).tickets === 2);
  await fails('a provider can’t change the Fair Score settings', '/fair', { token: (await login('busy1@fair.example.com', (await q("SELECT 1"))[0] && 'x')) || T.pavan, method: 'PUT', body: { min_tickets: 1 } }, 403);
  await fails('weights must be 0–100', '/fair', { ...A, method: 'PUT', body: { weights: { pace: 150 } } }, 400);
  await ok('admin lowers the minimum to 2', '/fair', { ...A, method: 'PUT', body: { min_tickets: 2 } });
  check('…then the new provider is ranked too', (await api('/fair', A)).data.rows.find(x => x.id === p5).eligible === true);
  await ok('(back to 5)', '/fair', { ...A, method: 'PUT', body: { min_tickets: 5 } });
  // --- rules the independent audit found unfair ---
  const board = async () => { await ok('(the board is worked out afresh)', '/fair', { ...A, method: 'PUT', body: { min_tickets: 5 } }); const d = (await api('/fair', A)).data; return id => d.rows.find(x => x.id === id); };
  const mkT = async (svc, n) => (await ok(`ticket “${n}”`, '/tickets', { ...A, method: 'POST', body: { channel: 'walk_in', service_id: svc, name: n, email: `${n.toLowerCase().replace(/\W/g, '')}@fair.example.com`, phone: '9000012345', requestor_type: 'staff', subject: n, description: 'x', location: 'Room ' + n } })).id;
  const soon = () => new Date(Date.now() + 1000).toISOString();
  // a ticket that waited with another team
  let b0 = await board(), h3 = b0(p3).hours, n3 = b0(p3).tickets;
  const tr = await mkT(busy.id, 'Moved job');
  await q('UPDATE tickets SET created_at=?, due_at=? WHERE id=?', start, addWorking(cal, start, 480), tr); // it sat with the busy team for 12 days or more
  await ok('a ticket that waited with one team is moved to another', `/tickets/${tr}/transfer`, { ...A, method: 'POST', body: { service_id: quiet.id, note: 'This is an exam matter.', approved: true } });
  await q("UPDATE tickets SET status='closed', closed_by=?, closed_at=? WHERE id=?", p3, soon(), tr);
  let b1 = await board();
  check('…the days with the old team are not charged to whoever closes it in the new one', b1(p3).tickets === n3 + 1 && b1(p3).hours - h3 <= 0.1, `${h3} → ${b1(p3).hours} work hours`);
  // a ticket that sat closed and was reopened
  const ro = await mkT(quiet.id, 'Reopened job'), roNo = (await q('SELECT ticket_no FROM tickets WHERE id=?', ro))[0].ticket_no, two = Date.now() - 2 * 864e5;
  await q("UPDATE tickets SET status='closed', closed_by=?, created_at=?, closed_at=?, due_at=? WHERE id=?", p3, new Date(two - 30 * 60e3).toISOString(), new Date(two).toISOString(), new Date(two + 3600e3).toISOString(), ro);
  b0 = await board(); h3 = b0(p3).hours; const miss3 = b0(p3).reopens_holds;
  await ok('the requester asks to reopen a ticket closed two days ago', `/public/alpha/tickets/${roNo}/reopen`, { method: 'POST', body: { reason: 'It broke again.' } });
  await fails('with that request waiting, staff cannot reopen it by a plain status change (that skipped the “done right” mark)', `/tickets/${ro}/status`, { ...A, method: 'POST', body: { to: 'open', note: 'reopening', is_internal: true } }, 409, 'asked to reopen');
  await ok('it is accepted', `/tickets/${ro}/reopen-request`, { ...A, method: 'POST', body: { decision: 'accept', note: 'We will look again.', approved: true } });
  await q("UPDATE tickets SET status='closed', closed_by=?, closed_at=? WHERE id=?", p3, soon(), ro);
  b1 = await board();
  check('…the days it sat closed are not counted as work; the reopen itself is counted once, under Done right', b1(p3).hours <= h3 + 0.1 && b1(p3).reopens_holds === miss3 + 1, `${h3} → ${b1(p3).hours} work hours, ${miss3} → ${b1(p3).reopens_holds} misses`);
  // a job done in the evening
  const nt = await mkT(quiet.id, 'Night job'), nine = new Date(Date.parse(dateStart(cal.tz, day)) + 21 * 3600e3).toISOString(); // 9 pm that day
  b0 = await board(); h3 = b0(p3).hours;
  await q("UPDATE tickets SET status='closed', closed_by=?, created_at=?, closed_at=?, due_at=? WHERE id=?", p3, nine, new Date(Date.parse(nine) + 30 * 60e3).toISOString(), addWorking(cal, nine, 60), nt);
  b1 = await board();
  check('a 30-minute job done at 9 in the evening counts 30 minutes (it used to count 1)', Math.abs(b1(p3).hours - h3 - 0.5) < 0.05, `${h3} → ${b1(p3).hours} work hours`);
  // tickets someone raises and closes themselves
  const rp = await ok('(Quiet Two gets a password)', `/users/${p4}/reset-password`, { ...A, method: 'POST' }); let t4 = await login('quiet2@fair.example.com', rp.temp_password);
  await ok('(and chooses their own)', '/me/password', { token: t4, method: 'POST', body: { current: rp.temp_password, password: 'Quiet#Two2026' } }); t4 = await login('quiet2@fair.example.com', 'Quiet#Two2026');
  b0 = await board(); const was = { n4: b0(p4).tickets, pace4: b0(p4).pace, pace3: b0(p3).pace, usual3: b0(p3).team_typical_hours };
  for (let i = 0; i < 6; i++) { const own = await ok('Quiet Two raises an internal ticket for the own team', '/tickets', { token: t4, method: 'POST', body: { channel: 'internal', service_id: quiet.id, name: 'Quiet Two', email: 'quiet2@fair.example.com', subject: 'Own job ' + i, description: 'x' } });
    await ok('…and closes it at once', `/tickets/${own.id}/status`, { token: t4, method: 'POST', body: { to: 'closed', note: 'Done.', approved: true } }); }
  b1 = await board();
  check('…six of them change nothing on the board: not their own place, not their colleagues’', b1(p4).tickets === was.n4 && b1(p4).pace === was.pace4 && b1(p3).pace === was.pace3 && b1(p3).team_typical_hours === was.usual3,
    JSON.stringify([was, { n4: b1(p4).tickets, pace4: b1(p4).pace, pace3: b1(p3).pace, usual3: b1(p3).team_typical_hours }]));
  const wk = await ok('a walk-in they log at the counter', '/tickets', { token: t4, method: 'POST', body: { channel: 'walk_in', service_id: quiet.id, name: 'Walker', email: 'walker@fair.example.com', phone: '9000012346', requestor_type: 'staff', subject: 'Counter job', description: 'x', location: 'Counter' } });
  await ok('…and close at once', `/tickets/${wk.id}/status`, { token: t4, method: 'POST', body: { to: 'closed', note: 'Done at the counter.', approved: true } });
  b1 = await board();
  check('…counts as their ticket, but not in Pace or in the team’s usual time', b1(p4).tickets === was.n4 + 1 && b1(p4).pace === was.pace4 && b1(p3).team_typical_hours === was.usual3, JSON.stringify([b1(p4).tickets, b1(p4).pace, b1(p3).team_typical_hours]));
  check('the real share closed on time is given with the score', b1(p3).on_time_of >= 6 && b1(p3).on_time_count <= b1(p3).on_time_of && b1(p3).on_time_count >= 6, JSON.stringify([b1(p3).on_time_count, b1(p3).on_time_of]));
  // someone in two teams; equal scores
  const p6 = await mk('Both Teams', 'both@fair.example.com');
  await ok('(a person in two teams)', `/services/${busy.id}/members`, { ...A, method: 'PUT', body: { user_ids: [p1, p2, p6] } }); await ok('(…the second)', `/services/${quiet.id}/members`, { ...A, method: 'PUT', body: { user_ids: [p3, p4, p6] } });
  const [w1, w2] = [await mk('Twin A', 'twina@fair.example.com'), await mk('Twin B', 'twinb@fair.example.com')];
  const twin = await ok('a team of two who do the same work', '/services', { ...A, method: 'POST', body: { code: 'TWINX', name: 'Twin Team', form_schema: { form_type: 'general', fields: [] } } });
  await ok('(its members)', `/services/${twin.id}/members`, { ...A, method: 'PUT', body: { user_ids: [w1, w2] } });
  await closeN(twin.id, w1, 5, 120); await closeN(twin.id, w2, 5, 120);
  b1 = await board();
  check('someone in two teams with no closed ticket is listed under one team: its name and its id belong together', b1(p6).team === 'Busy Maintenance' && b1(p6).team_id === busy.id, JSON.stringify([b1(p6).team, b1(p6).team_id === busy.id]));
  check('equal scores share a place (both get the medal)', b1(w1).score === b1(w2).score && b1(w1).rank === b1(w2).rank && Number.isInteger(b1(w1).rank), JSON.stringify([b1(w1).score, b1(w1).rank, b1(w2).score, b1(w2).rank]));
  // settings and targets
  await fails('an emptied weight is refused, not saved as 0', '/fair', { ...A, method: 'PUT', body: { weights: { pace: '' } } }, 400, 'whole number');
  await fails('weights are the four named numbers', '/fair', { ...A, method: 'PUT', body: { weights: 'junk' } }, 400);
  await fails('a setting the board does not have is refused, not ignored', '/fair', { ...A, method: 'PUT', body: { k: 0 } }, 400, 'Not a Fair Score setting');
  await fails('the usual time must look back at least as far as the ranking window', '/fair', { ...A, method: 'PUT', body: { window_days: 90, baseline_days: 14 } }, 400, 'look back');
  const od = await mkT(quiet.id, 'Late job'), past = new Date(Date.now() - 3600e3).toISOString();
  await q('UPDATE tickets SET due_at=?, priority=? WHERE id=?', past, 'high', od);
  await ok('the priority of a ticket that already missed its target is lowered', `/tickets/${od}/priority`, { ...A, method: 'POST', body: { priority: 'low' } });
  check('…the missed target stays where it was (it used to move ahead, so the ticket closed “on time”)', (await q('SELECT due_at FROM tickets WHERE id=?', od))[0].due_at === past);
  for (const id of [p6, w1, w2]) await ok('(the extra accounts are switched off)', `/users/${id}`, { ...A, method: 'PATCH', body: { is_active: 0 } });
  await ok('(the extra team is switched off)', `/services/${twin.id}`, { ...A, method: 'PATCH', body: { is_active: 0 } }); }

  sec('Teams: a closed main team closes its sub-teams; only real values are saved');
  { const A = { token: T.sa, tenant: ids.alpha };
  const mainZ = await ok('a main team', '/services', { ...A, method: 'POST', body: { code: 'MAINZ', name: 'Main Zed', form_schema: { form_type: 'general', fields: [] } } });
  const subZ = await ok('…with a sub-team', '/services', { ...A, method: 'POST', body: { code: 'SUBZ', name: 'Sub Zed', parent_id: mainZ.id, form_schema: { form_type: 'general', fields: [] } } });
  const listed = async () => (await api('/public/alpha')).data.services.map(s => s.code);
  check('both are on the portal', (await listed()).includes('MAINZ') && (await listed()).includes('SUBZ'));
  await ok('the main team is deactivated', `/services/${mainZ.id}`, { ...A, method: 'PATCH', body: { is_active: 0 } });
  check('…its sub-team leaves the portal with it (it used to stay on, as a team of its own)', !(await listed()).includes('MAINZ') && !(await listed()).includes('SUBZ'));
  r = await raise('alpha', { service_id: subZ.id, name: 'Zed', email: 'zed@teams.example.com', subject: 'x', location: 'y' });
  check('…and takes no new tickets', r.status === 404, String(r.status));
  await ok('the main team is activated again', `/services/${mainZ.id}`, { ...A, method: 'PATCH', body: { is_active: 1 } });
  check('…and the sub-team is back with it', (await listed()).includes('SUBZ'));
  await fails('is_active is 1 or 0, nothing else', `/services/${mainZ.id}`, { ...A, method: 'PATCH', body: { is_active: 2 } }, 400);
  await fails('…not a word either (it used to answer 500)', `/services/${mainZ.id}`, { ...A, method: 'PATCH', body: { is_active: 'yes' } }, 400);
  await fails('a team’s name cannot be made blank', `/services/${mainZ.id}`, { ...A, method: 'PATCH', body: { name: '   ' } }, 400);
  for (const id of [subZ.id, mainZ.id]) await ok('(the test teams are removed)', `/services/${id}`, { ...A, method: 'DELETE' }); }

  sec('Morning brief: whole campus for admins, own team for providers');
  { const tid = (await q("SELECT id FROM tenants WHERE slug='alpha'"))[0].id, pav = (await q("SELECT id, email FROM users WHERE email='pavan@example.com'"))[0];
  const before = (await q("SELECT count(*)::int n FROM notifications WHERE template_key IN ('digest','digest_admin')"))[0].n;
  await fails('a provider can’t send it', '/digest/send', { token: T.pavan, method: 'POST' }, 403);
  const r = await ok('admin sends this campus’s morning brief now', '/digest/send', { token: T.asha, method: 'POST' });
  const mails = await q("SELECT recipient, template_key, subject, body FROM notifications WHERE template_key IN ('digest','digest_admin') ORDER BY created_at DESC LIMIT ?", r.sent);
  const adm = mails.find(m => m.template_key === 'digest_admin' && m.recipient === 'asha@example.com'), mine = mails.find(m => m.template_key === 'digest' && m.recipient === pav.email);
  check('the campus admin gets the whole campus: counts, then every open ticket by group', !!adm && /\d+ open · Overdue \d+ · Due today \d+/.test(adm.body) && /(Yesterday|Since \w+): \d+ raised, \d+ closed/.test(adm.body) && /OVERDUE \(\d+\)/.test(adm.body), adm?.body?.slice(0, 400));
  const myS = (await q("SELECT m.service_id FROM service_members m WHERE m.user_id=? UNION SELECT s.id FROM services s JOIN service_members m ON m.service_id=s.parent_id WHERE m.user_id=?", pav.id, pav.id)).map(x => x.service_id);
  const other = (await q(`SELECT ticket_no FROM tickets WHERE tenant_id=? AND status IN ('open','in_progress') AND queued=0 AND coalesce(kind,'issue')<>'suggestion' AND NOT (service_id = ANY(?::text[])) LIMIT 1`, tid, myS))[0];
  const own = (await q(`SELECT ticket_no FROM tickets WHERE tenant_id=? AND status IN ('open','in_progress') AND queued=0 AND coalesce(kind,'issue')<>'suggestion' AND service_id = ANY(?::text[]) LIMIT 1`, tid, myS))[0];
  check('a provider gets only their own team’s tickets', !!mine && (!own || mine.body.includes('#' + own.ticket_no)) && (!other || !mine.body.includes('#' + other.ticket_no)) && /Morning brief\] .+: (\d+ open tickets?|nothing open) · /.test(mine.subject), mine?.subject);
  check('…and the admin’s list has the other teams’ tickets too', !other || adm.body.includes('#' + other.ticket_no));
  check('no brief for another campus’s admin', !mails.some(m => m.recipient === 'bina@example.com'));
  check('one email per person', new Set(mails.map(m => m.recipient + m.template_key)).size === mails.length && mails.length === r.sent && r.sent >= 2, String(r.sent)); }

  sec('Replies: tidied on this server, previewed, polite template');
  { const tk = (await q("SELECT t.id, t.ticket_no, t.tenant_id FROM tickets t JOIN services s ON s.id=t.service_id WHERE s.code='ELEC' AND t.status IN ('open','in_progress') ORDER BY t.created_at LIMIT 1"))[0];
  const pv = (await api(`/tickets/${tk.id}/preview`, { token: T.pavan, method: 'POST', body: { to: 'note', note: 'tubelight choke is damged we orderd new one wil fix by tommorow plz wait' } })).data;
  check('the note is tidied: spelling, short-forms, capitals and a full stop', pv.text === 'Tube light choke is damaged we ordered new one will fix by tomorrow please wait.', pv.text);
  check('…with the list of fixes and the original kept', pv.changes.some(c => c.from === 'damged' && c.to === 'damaged') && pv.original.startsWith('tubelight'));
  check('the preview is the real email: Hi name, the note, Thank you and the provider’s name', /Hi /.test(pv.html) && pv.html.includes('Tube light choke is damaged') && /Thank you,/.test(pv.html) && pv.html.includes('Pavan Provider') && /ONE DESK/.test(pv.html));
  const keep = (await api(`/tickets/${tk.id}/preview`, { token: T.pavan, method: 'POST', body: { to: 'note', note: 'Mail sent to Abc.Xyz@college.edu.in, see https://erp.example.com/fee?id=7' } })).data;
  check('emails and links are left exactly as typed', keep.text.includes('Abc.Xyz@college.edu.in') && keep.text.includes('https://erp.example.com/fee?id=7'), keep.text);
  const nm = (await api(`/tickets/${tk.id}/preview`, { token: T.pavan, method: 'POST', body: { to: 'note', note: 'devi madam and suresh garu will visit r block tommorow. rani, priya, anil reddy and sita informed, contact HR or IT dept. 40 wat bulb fixd in room r 12' } })).data;
  check('names, places and abbreviations are never “corrected” (Devi, Rani, Priya, Reddy, R block, HR)', nm.text === 'Devi madam and suresh garu will visit R block tomorrow. Rani, priya, anil reddy and sita informed, contact HR or IT department. 40 wat bulb fixed in room R 12.', nm.text);
  const ac = (await api(`/tickets/${tk.id}/preview`, { token: T.pavan, method: 'POST', body: { to: 'note', note: 'wifi router in pg hostel wing c replaced, pls check ur id. WATER PROBLEM IN BLOCK A SOLVED' } })).data;
  check('campus abbreviations and block letters shown the usual way', ac.text === 'Wi-Fi router in PG hostel wing C replaced, please check your ID. WATER PROBLEM IN BLOCK A SOLVED.', ac.text);
  await ok('a note sent without the preview is still tidied for the requester', `/tickets/${tk.id}/notes`, { token: T.pavan, method: 'POST', body: { body: 'we r checking the mcb now' } });
  const ev1 = (await q("SELECT body, meta FROM ticket_events WHERE ticket_id=? AND event_type='note' ORDER BY id DESC LIMIT 1", tk.id))[0];
  check('…stored clean, the provider’s original kept for staff only', ev1.body === 'We are checking the MCB now.' && JSON.parse(ev1.meta).original === 'we r checking the mcb now', JSON.stringify(ev1));
  await ok('a note approved in the preview is sent exactly as approved', `/tickets/${tk.id}/notes`, { token: T.pavan, method: 'POST', body: { body: 'ok sir, done', approved: true } });
  check('…as approved', (await q("SELECT body FROM ticket_events WHERE ticket_id=? AND event_type='note' ORDER BY id DESC LIMIT 1", tk.id))[0].body === 'ok sir, done');
  const slug = (await q('SELECT slug FROM tenants WHERE id=?', tk.tenant_id))[0].slug, pub = (await api(`/public/${slug}/tickets/${tk.ticket_no}`)).data;
  check('the requester’s ticket page shows only the tidied text, never the original', JSON.stringify(pub).includes('We are checking the MCB now.') && !JSON.stringify(pub).includes('we r checking'));
  const mail = (await q("SELECT body FROM notifications WHERE ticket_id=? AND template_key='note' ORDER BY created_at DESC LIMIT 2", tk.id)).map(x => x.body).join('\n');
  check('the email: Hi, the note, Thank you and the provider’s name and team', mail.includes('We are checking the MCB now.') && /Thank you,\n\*\*Pavan Provider\*\* · Electrical team/.test(mail), mail.slice(0, 300));
  const ph = (await api('/reply-phrases?service=' + (await q("SELECT id FROM services WHERE code='ELEC' LIMIT 1"))[0].id, { token: T.pavan })).data;
  check('ready-made sentences for every step', ['in_progress', 'hold', 'open', 'closed', 'rejected', 'note'].every(k => ph.phrases[k].length >= 3));
  await fails('a provider can’t change them', '/reply-phrases', { token: T.pavan, method: 'PUT', body: { phrases: { closed: ['x'] } } }, 403);
  const elec = (await q("SELECT id FROM services WHERE code='ELEC' LIMIT 1"))[0].id;
  await ok('admin sets Electrical’s own closing sentences (tidied on save)', '/reply-phrases', { token: T.asha, method: 'PUT', body: { scope: elec, phrases: { closed: ['fuse replaced, power is back', 'MCB reset done'] } } });
  const ph2 = (await api('/reply-phrases?service=' + elec, { token: T.pavan })).data;
  check('the team sees its own list; other steps fall back to the campus list', ph2.phrases.closed[0] === 'Fuse replaced, power is back.' && ph2.phrases.hold.length >= 3, JSON.stringify(ph2.phrases.closed));
  await ok('back to the campus list', '/reply-phrases', { token: T.asha, method: 'PUT', body: { scope: elec, reset: true } });
  const rq = (await q("SELECT html FROM notifications WHERE ticket_id=? AND template_key='note' ORDER BY created_at DESC LIMIT 1", tk.id))[0].html;
  const st = (await q("SELECT html FROM notifications WHERE template_key='new_ticket' ORDER BY created_at DESC LIMIT 1"))[0].html;
  check('requester emails carry the brand: Learn · Live · Grow, the ONE strip and the welcome message', rq.includes('Learn · Live · Grow') && /Own<\/b>|>O<\/b>wn/.test(rq) && rq.includes('elevate your academic and learning experience'));
  check('staff emails carry only the header line', st.includes('Learn · Live · Grow') && !st.includes('elevate your academic') && !st.includes('navigate it to the right team'));
  await ok('the super admin edits the welcome message', '/mail/config', { token: T.sa, method: 'PUT', body: { brand: { brand_welcome: 'Welcome to ONE DESK. Test line.' } } });
  await ok('another note', `/tickets/${tk.id}/notes`, { token: T.pavan, method: 'POST', body: { body: 'Checked again.', approved: true } });
  check('…and the next email uses it', (await q("SELECT html FROM notifications WHERE ticket_id=? AND template_key='note' ORDER BY created_at DESC LIMIT 1", tk.id))[0].html.includes('Test line.'));
  await ok('(back to the standard text)', '/mail/config', { token: T.sa, method: 'PUT', body: { brand: { brand_welcome: "Welcome to ONE DESK, St. Mary's own student service centre. We are always working to elevate your academic and learning experience, and to help every student grow into a life-ready professional." } } }); }

  sec('Reply clean-up: prepared corrections only; names, capitals and codes are never touched');
  { const P = x => polish(x).text, same = (...xs) => xs.filter(x => { const o = P(x), base = o.replace(/\.$/, ''); return base !== x && base !== x[0].toUpperCase() + x.slice(1); });
  const never = [...new Set(fs.readFileSync(path.join(ROOT, 'tools/never-touch.txt'), 'utf8').split(/\s+/).filter(Boolean).map(w => w.toLowerCase()))], L = x => P(x).toLowerCase();
  const hurt = never.filter(w => !L(`we spoke to ${w} today`).includes(` ${w} `) || !L(`${w} will come today`).startsWith(`${w} `) || !L(`informed Dr. ${w} and Mr. ${w}`).includes(`dr. ${w} and mr. ${w}`)
    || !L(`${w} sir informed`).startsWith(`${w} sir`) || !L(`PLEASE CONTACT ${w.toUpperCase()} IN THE OFFICE`).includes(` ${w} `));
  check(`${never.length} names, places, brands and campus terms come out as typed: in small letters, at the start of a sentence, after Dr./Mr., before “sir”, in capitals`, never.length > 2500 && !hurt.length, hurt.slice(0, 12).join(', '));
  const typos = JSON.parse(fs.readFileSync(path.join(ROOT, 'typos.json'), 'utf8'));
  check('the two correction lists hold no name or term, and no slip shorter than 6 letters', !never.some(w => Object.hasOwn(SHORT, w) || Object.hasOwn(typos, w)) && Object.keys(typos).every(k => k.length >= 6) && Object.keys(typos).length > 5000);
  check('people and brands stay themselves (these became China, Mannish, Satay, Hedge, Moron and worse)', !same('Chinna will clean the room today', 'spoke to satya and manish, hegde sir also informed', 'Omron BP monitor is not working, we will replace it',
    'niger seeds chutney served today', 'meet brian sir or christina madam in accounts', 'Uppal bus will come late', 'Imprest amount released to hostel office', 'Wen Li seminar on AI', 'Ty BPT students: lab at 9').length,
    same('Chinna will clean the room today', 'spoke to satya and manish, hegde sir also informed', 'Omron BP monitor is not working, we will replace it', 'niger seeds chutney served today').map(P).join(' | '));
  check('a note in capitals stays in capitals (names, initials and codes keep theirs); its words are still corrected', P('SPOKE TO RAVI KUMAR SIR. UPS AND TV REPAIRED IN R BLOCK ROOM 12B. CONTACT IT TEAM OR VC OFFICE') === 'SPOKE TO RAVI KUMAR SIR. UPS AND TV REPAIRED IN R BLOCK ROOM 12B. CONTACT IT TEAM OR VC OFFICE.'
    && P('INFORMED R SURESH GARU AND U RAMESH') === 'INFORMED R SURESH GARU AND U RAMESH.' && P('PLS WAIT TOMMOROW WE WIL FIX THE PROBLAM') === 'PLEASE WAIT TOMORROW WE WILL FIX THE PROBLEM.', P('PLS WAIT TOMMOROW WE WIL FIX THE PROBLAM'));
  check('“r” and “u” are “are” and “you” only where the sentence shows it; initials and abbreviations are left', P('informed r suresh garu') === 'Informed r suresh garu.' && P('w.r.t. your ticket, work is in progress') === 'w.r.t. your ticket, work is in progress.'
    && P('r/o Guntur, c/o warden, u/s 10') === 'r/o Guntur, c/o warden, u/s 10.' && P('in which block r u staying') === 'In which block are you staying.' && P('fans r working, thank u priya') === 'Fans are working, thank you priya.'
    && P('we r coming now, u r requested to wait') === 'We are coming now, you are requested to wait.', [P('in which block r u staying'), P('fans r working, thank u priya')].join(' | '));
  check('short forms with another meaning on a campus are left where they mean that', P('room b4 fan capacitor changed') === 'Room b4 fan capacitor changed.' && P('collect key b4 8pm') === 'Collect key before 8pm.' && P('apply pl for 2 days') === 'Apply pl for 2 days.'
    && P('pl. collect from counter 2') === 'Please collect from counter 2.' && P('til laddu and gud served for sankranti') === 'Til laddu and gud served for sankranti.' && P('see pg 12 of the manual') === 'See pg 12 of the manual.'
    && P('hv panel maintenance on sunday') === 'HV panel maintenance on sunday.', [P('collect key b4 8pm'), P('pl. collect from counter 2'), P('hv panel maintenance on sunday')].join(' | '));
  check('abbreviations with a full stop do not break the sentence', P('It will take approx. 2 days') === 'It will take approximately 2 days.' && P('accounts dept. will call you') === 'Accounts department will call you.'
    && P('office is open from 10 a.m. to 5 p.m. on working days') === 'Office is open from 10 a.m. to 5 p.m. on working days.' && P('B.Tech and M.Sc students can collect') === 'B.Tech and M.Sc students can collect.'
    && P('e.g. id card, fee receipt etc. are required') === 'e.g. ID card, fee receipt etc. are required.' && P('the no. of chairs is 40. Rs. five hundred paid') === 'The no. of chairs is 40. Rs. five hundred paid.', P('the no. of chairs is 40. Rs. five hundred paid'));
  check('passwords, user names, network names, addresses and file names are never changed, and a password gets no full stop', P('connect to smru-wifi with password smru@123') === 'Connect to smru-wifi with password smru@123'
    && P('ur password is welcom@123 and username is erp_student') === 'Your password is welcom@123 and username is erp_student' && P('Your MAC a4:5e:60:c1:22:9f is registered') === 'Your MAC a4:5e:60:c1:22:9f is registered.'
    && P('pay at smru.edu.in/erp/login or bit.ly/smru-info') === 'Pay at smru.edu.in/erp/login or bit.ly/smru-info' && P('download form.pdf from drive.google.com/file/d/1AbCdEf') === 'Download form.pdf from drive.google.com/file/d/1AbCdEf'
    && P('roll no 23BPT014, mail ravi@smru') === 'Roll no 23BPT014, mail ravi@smru', [P('ur password is welcom@123 and username is erp_student'), P('pay at smru.edu.in/erp/login or bit.ly/smru-info')].join(' | '));
  check('a letter next to “block”, “room”, “wing” is a place only where it can be nothing else', P('pls come to lab u can collect ur id card') === 'Please come to lab you can collect your ID card.' && P('cleaning done in 2nd floor n 3rd floor') === 'Cleaning done in 2nd floor n 3rd floor.'
    && P('we gave the hall a 2nd coat of paint') === 'We gave the hall a 2nd coat of paint.' && P('plug point in room r 12 and c wing repaired') === 'Plug point in room R 12 and C wing repaired.', P('plug point in room r 12 and c wing repaired'));
  check('smileys, product names, a signature and a missing space', P('thanks :) will do') === 'Thanks :) will do.' && P('iPhone charger issue. ePass scholarship status is pending') === 'iPhone charger issue. ePass scholarship status is pending.'
    && P('Thanks & Regards,\nSuresh Kumar\nElectrician\n98480 12345') === 'Thanks & Regards,\nSuresh Kumar\nElectrician\n98480 12345' && P('work is done.please check') === 'Work is done. Please check.' && P('- tap changed\n- flush repaired') === '- Tap changed.\n- Flush repaired.'
    && P('at 5 : 30 pm the bus starts') === 'At 5:30 pm the bus starts.', [P('work is done.please check'), P('- tap changed\n- flush repaired')].join(' | '));
  const all = ['tubelight choke is damged we orderd new one wil fix by tommorow plz wait', 'Recieved ur complaint, techncian wil come', 'ac in hod cabin servicd. filtr cleaned', 'Thanks & Regards,\nSuresh Kumar', 'pl. collect from counter 2', 'in which block r u staying'];
  check('running it twice changes nothing more; odd input is handled', all.every(x => P(P(x)) === P(x)) && P('Recieved ur complaint, techncian wil come') === 'Received your complaint, technician will come.' && P(null) === '' && P('a\u0000b c') === 'Ab c.' && P('   ') === '',
    all.filter(x => P(P(x)) !== P(x)).join(' | '));
  const ptk = (await q("SELECT t.id FROM tickets t JOIN services s ON s.id=t.service_id WHERE s.code='ELEC' AND t.status IN ('open','in_progress') ORDER BY t.created_at LIMIT 1"))[0];
  await fails('a note that is not text is refused (not turned into “[object Object]”)', `/tickets/${ptk.id}/notes`, { token: T.pavan, method: 'POST', body: { body: { a: 1 } } }, 400);
  await fails('…in the preview too', `/tickets/${ptk.id}/preview`, { token: T.pavan, method: 'POST', body: { to: 'note', note: ['pls', 'chk'] } }, 400); }

  sec('Replies: what the requester may and may not see; long and many-line notes; who gets it');
  { const mk = async (name, room, extra = {}) => { const r = await raise('alpha', { service_id: ids.elec, name, email: `${name.toLowerCase()}@rep.example.com`, requestor_type: 'student', subject: `${name}: socket loose`, form_data: { loc_block: 'Main block', loc_floor: '2nd floor', loc_room: room, issue: 'Fan' }, ...extra });
      return { no: r.data?.ticket_no, id: (await q("SELECT id FROM tickets WHERE ticket_no=? AND tenant_id=(SELECT id FROM tenants WHERE slug='alpha')", r.data?.ticket_no))[0]?.id, r }; };
  const mailsOf2 = (id, key) => q('SELECT recipient, body, html, text_body FROM notifications WHERE ticket_id=? AND template_key=? ORDER BY created_at', id, key);
  // a private note while reopening a closed ticket stays private
  const a = await mk('Reo', 'Reply room 1'); await act(a.id, { to: 'closed', note: 'Socket tightened.', approved: true });
  const before = (await mailsOf2(a.id, 'status_open')).length;
  await ok('staff reopen a closed ticket with an internal note', `/tickets/${a.id}/status`, { token: T.pavan, method: 'POST', body: { to: 'open', note: 'closed by mistake, this student complains every week', is_internal: true } });
  const pubA = JSON.stringify((await api(`/public/alpha/tickets/${a.no}`)).data), evA = await q('SELECT event_type, is_internal, body FROM ticket_events WHERE ticket_id=? ORDER BY id DESC LIMIT 2', a.id);
  check('…the requester sees that it was reopened, never the note, and is not emailed', pubA.includes('"reopened"') && !pubA.includes('complains every week') && evA.some(e => e.event_type === 'note' && e.is_internal === 1 && e.body.includes('complains')) && evA.some(e => e.event_type === 'reopened' && !e.body)
    && (await mailsOf2(a.id, 'status_open')).length === before, JSON.stringify(evA));
  // reopened with a note for the requester: they are emailed, and the preview showed exactly that
  await act(a.id, { to: 'closed', note: 'Closed again.', approved: true });
  const pvR = (await api(`/tickets/${a.id}/preview`, { token: T.pavan, method: 'POST', body: { to: 'open', note: 'we will check the socket again tomorrow' } })).data;
  await ok('staff reopen it with a note for the requester', `/tickets/${a.id}/status`, { token: T.pavan, method: 'POST', body: { to: 'open', note: pvR.text, approved: true, typed: 'we will check the socket again tomorrow' } });
  const reoMail = (await mailsOf2(a.id, 'status_open')).pop();
  check('…the requester gets the email the preview promised', pvR.sends === true && !!reoMail && reoMail.recipient === 'reo@rep.example.com' && reoMail.body.includes('We will check the socket again tomorrow.') && /Reopened/.test(reoMail.html) && /Reopened/.test(pvR.html), reoMail?.body?.slice(0, 200));
  // transfer and reopen decisions keep what the provider typed, for staff
  const other2 = (await q("SELECT id FROM services WHERE tenant_id=(SELECT id FROM tenants WHERE slug='alpha') AND id<>? AND parent_id IS NULL AND is_active=1 LIMIT 1", ids.elec))[0].id;
  const b = await mk('Trn', 'Reply room 2'); await ok('a transfer note', `/tickets/${b.id}/transfer`, { token: T.pavan, method: 'POST', body: { service_id: other2, note: 'pls chk this, not our dept' } });
  const evB = (await q("SELECT body, meta FROM ticket_events WHERE ticket_id=? AND event_type='transferred'", b.id))[0];
  check('…is tidied for the requester and the original is kept for staff', evB.body === 'Please check this, not our department.' && JSON.parse(evB.meta).original === 'pls chk this, not our dept', JSON.stringify(evB));
  // length and type
  const c = await mk('Len', 'Reply room 3');
  await fails('a note over 5,000 characters is refused', `/tickets/${c.id}/notes`, { token: T.pavan, method: 'POST', body: { body: 'a '.repeat(2501) } }, 400, 'too long');
  await fails('…in the preview and on a status change too', `/tickets/${c.id}/preview`, { token: T.pavan, method: 'POST', body: { to: 'note', note: 'x'.repeat(5001) } }, 400, 'too long');
  await fails('…and from the requester’s side', `/public/alpha/tickets/${c.no}/notes`, { method: 'POST', body: { body: 'y'.repeat(5001) } }, 400, 'too long');
  const t0 = Date.now(); await api(`/tickets/${c.id}/preview`, { token: T.pavan, method: 'POST', body: { to: 'note', note: 'a'.repeat(5000) } });
  check('one very long word is tidied at once (it used to hold the whole server for seconds)', Date.now() - t0 < 1500, `${Date.now() - t0} ms`);
  // a note of several lines stays one note
  const many = 'work done:\n1. fan regulator changed\n2. socket near bed fixd\nPassword: Abc@123\n> not a box\nplz check';
  await ok('a note of several lines', `/tickets/${c.id}/notes`, { token: T.pavan, method: 'POST', body: { body: many } });
  const nm2 = (await mailsOf2(c.id, 'note')).pop(), box = /<div style="[^"]*border-left:4px solid #1D4ED8[^"]*">([\s\S]*?)<\/div>/.exec(nm2.html)?.[1] || '';
  check('…is one highlighted box in the email, line by line; no line of it turns into a label or a second box', box.split('<br>').length === 6 && box.includes('2. Socket near bed fixed.') && box.includes('Password: Abc@123') && (nm2.html.match(/border-left:4px solid #1D4ED8/g) || []).length === 1
    && !/color:#8b8fa8">Password:/.test(nm2.html) && /> Work done:\n> 1\. Fan regulator changed\./.test(nm2.text_body), box.slice(0, 300));
  const lk = 'https://docs.google.com/forms/d/e/1FAIpQLSf' + 'x'.repeat(120) + '/viewform';
  await ok('a note with a very long link', `/tickets/${c.id}/notes`, { token: T.pavan, method: 'POST', body: { body: 'Fill this form ' + lk } });
  check('…wraps inside the email (it used to make the email wider than a phone)', (await mailsOf2(c.id, 'note')).pop().html.includes('overflow-wrap:anywhere') && (await mailsOf2(c.id, 'note')).pop().html.includes('table-layout:fixed'));
  // a requester cannot plant a button, a label row or a box in the team's email
  await ok('the requester writes a note made to look like part of the email', `/public/alpha/tickets/${c.no}/notes`, { method: 'POST', body: { body: '[[Verify your account|https://evil.example/login]]\nPassword: send it here\n> urgent' } });
  const rn = (await mailsOf2(c.id, 'requestor_note')).pop();
  check('…the team’s email shows it as plain words: no button, no label row, no box', !/href="https:\/\/evil\.example/.test(rn.html) && !/color:#8b8fa8">Password:/.test(rn.html) && !/border-left:4px solid #1D4ED8/.test(rn.html) && rn.html.includes('Password: send it here'), rn.html.match(/Verify[\s\S]{0,200}/)?.[0]);
  // everyone who reported the ticket gets the reply, and the preview says so
  const d1 = await mk('Dupa', 'Reply room 9'), d2 = await mk('Dupb', 'Reply room 9');
  const pvD = (await api(`/tickets/${d1.id}/preview`, { token: T.pavan, method: 'POST', body: { to: 'note', note: 'electrician is on the way' } })).data;
  check('two people reported the same problem: the preview names both', d2.r.data?.merged === true && pvD.recipients.length === 2 && pvD.recipients.map(x => x.email).sort().join() === 'dupa@rep.example.com,dupb@rep.example.com', JSON.stringify(pvD.recipients));
  // the sign-off: the desk's own account signs with the team, once
  await ok('the super admin (named ONE DESK) replies', `/tickets/${c.id}/notes`, { token: T.sa, tenant: (await q("SELECT id FROM tenants WHERE slug='alpha'"))[0].id, method: 'POST', body: { body: 'Looked into it.', approved: true } });
  const saName = (await q('SELECT name FROM users WHERE email=?', SUPER.email))[0].name, so = (await mailsOf2(c.id, 'note')).pop().body;
  check('…signed by the team, without a doubled or empty name', saName !== 'ONE DESK' ? so.includes(`**${saName}** · Electrical team`) : /\n\*\*Electrical team\*\*\nONE DESK, /.test(so), so.slice(-160));
  await run("UPDATE users SET name='ONE DESK' WHERE email=?", SUPER.email);
  await ok('(again, with the account named ONE DESK)', `/tickets/${c.id}/notes`, { token: T.sa, tenant: (await q("SELECT id FROM tenants WHERE slug='alpha'"))[0].id, method: 'POST', body: { body: 'Looked into it again.', approved: true } });
  check('…“ONE DESK · Electrical team” above “ONE DESK, campus” became the team alone', /\n\*\*Electrical team\*\*\nONE DESK, /.test((await mailsOf2(c.id, 'note')).pop().body), (await mailsOf2(c.id, 'note')).pop().body.slice(-160));
  await run('UPDATE users SET name=? WHERE email=?', saName, SUPER.email);
  // a suggestion that is closed is thanked, not "resolved"
  const sgn = await api('/public/alpha/tickets', { method: 'POST', body: { kind: 'suggestion', service_id: ids.elec, name: 'Sugi', email: 'sugi@rep.example.com', phone: '9000055551', requestor_type: 'faculty', identifier: 'FAC7', department: 'Physio', subject: 'Projector in every lab', description: 'It would help the classes.' } });
  const sid2 = (await q("SELECT id FROM tickets WHERE ticket_no=? AND tenant_id=(SELECT id FROM tenants WHERE slug='alpha')", sgn.data?.ticket_no))[0]?.id;
  const pvS = (await api(`/tickets/${sid2}/preview`, { token: T.pavan, method: 'POST', body: { to: 'closed', note: 'Noted for next year’s budget.' } })).data;
  await act(sid2, { to: 'closed', note: 'Noted for next year’s budget.', approved: true });
  const sm = (await mailsOf2(sid2, 'suggestion_closed')).pop();
  check('closing a suggestion: “Thank you for your suggestion”, nothing about “resolved” or reopening; the preview said the same', !!sm && /Thank you for your suggestion "Projector in every lab"/.test(sm.body) && !/resolved|Still not fixed/i.test(sm.body) && /Thank you for your suggestion/.test(pvS.subject + pvS.html)
    && !(await mailsOf2(sid2, 'status_closed')).length, sm?.body?.slice(0, 200));
  // ready-made sentences: a sub-team follows its main team; only changed steps are saved; an emptied step falls back
  const tidA = (await q("SELECT id FROM tenants WHERE slug='alpha'"))[0].id, mainT = (await q("SELECT id, parent_id FROM services WHERE tenant_id=? AND parent_id IS NOT NULL AND is_active=1 LIMIT 1", tidA))[0];
  await ok('the main team gets its own closing sentence', '/reply-phrases', { token: T.asha, method: 'PUT', body: { scope: mainT.parent_id, phrases: { closed: ['main team closed sentence'] } } });
  await ok('the sub-team gets its own “on hold” sentences only', '/reply-phrases', { token: T.asha, method: 'PUT', body: { scope: mainT.id, phrases: { hold: ['waiting for paint', 'Waiting for paint.', 'waiting for brush'] } } });
  const phS = (await api('/reply-phrases?service=' + mainT.id, { token: T.sa, tenant: tidA })).data;
  check('…it keeps following its main team for the other steps; doubles are dropped after tidying', phS.phrases.closed[0] === 'Main team closed sentence.' && phS.phrases.hold.join('|') === 'Waiting for paint.|Waiting for brush.' && !phS.saved[mainT.id].closed, JSON.stringify(phS.phrases.hold));
  await ok('an emptied step goes back to the list it followed', '/reply-phrases', { token: T.asha, method: 'PUT', body: { scope: mainT.id, phrases: { hold: [] } } });
  check('…and a team with nothing of its own left has no list', !(await api('/reply-phrases', { token: T.asha })).data.saved[mainT.id] && (await api('/reply-phrases?service=' + mainT.id, { token: T.sa, tenant: tidA })).data.phrases.hold.length >= 3);
  await ok('(the main team’s list is dropped again)', '/reply-phrases', { token: T.asha, method: 'PUT', body: { scope: mainT.parent_id, reset: true } }); }

  sec('Emails: “Latest updates” as one joined timeline; the preview is the email that goes out');
  { const TO = 'tara@tl.example.com', tl = await raise('alpha', { service_id: ids.elec, name: 'Tara', email: TO, requestor_type: 'student', subject: 'Switch board sparking', form_data: { loc_block: 'Main block', loc_floor: '2nd floor', loc_room: 'Timeline room 3', issue: 'Fan' } });
  const tk = (await q("SELECT id FROM tickets WHERE ticket_no=? AND tenant_id=(SELECT id FROM tenants WHERE slug='alpha')", tl.data?.ticket_no))[0];
  check('a ticket to follow', !!tk, JSON.stringify(tl.error || ''));
  // times are compared by shape: the preview is built a moment before the email, so a minute can tick over between the two
  const norm = h => String(h || '').replace(/\d{1,2}:\d{2}\s?[ap]m/gi, 'TIME').replace(/\d{1,2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*( \d{4})?/g, 'DAY');
  const differs = (a, b) => { let i = 0; while (i < a.length && a[i] === b[i]) i++; return `${a.slice(Math.max(0, i - 80), i + 80)} ≠ ${b.slice(Math.max(0, i - 80), i + 80)}`; };
  const mailOf = async (key, to) => (await q('SELECT html, text_body FROM notifications WHERE ticket_id=? AND template_key=? AND recipient=? ORDER BY created_at DESC LIMIT 1', tk.id, key, to))[0];
  const same = async (name, to, body, key) => { const pv = (await api(`/tickets/${tk.id}/preview`, { token: T.pavan, method: 'POST', body: { to, ...body } })).data;
    const r = await act(tk.id, { to, ...body, note: pv.text, approved: true }), m = await mailOf(key, TO);
    check(name, r.status === 200 && !!m && norm(m.html) === norm(pv.html), r.status === 200 && m ? differs(norm(m.html), norm(pv.html)) : `${r.status} ${r.error?.message || 'no email'}`); return m; };
  const m1 = await same('work started: the preview and the email that goes out are the same', 'in_progress', { note: 'our technician is on the way' }, 'status_in_progress');
  check('…newest first with a “Latest” tag, who did it with the team, the note in its box', m1.html.indexOf('Work started') < m1.html.indexOf('Ticket received') && m1.html.includes('>Latest<') && m1.html.includes('Pavan Provider, Electrical team') && m1.html.includes('Our technician is on the way.'));
  check('…the requester’s own step reads “You”', /· You</.test(m1.html) && !/· Tara</.test(m1.html), m1.html.match(/Latest updates[\s\S]{0,400}/)?.[0]);
  await same('on hold: the preview shows the hold, its reason and the resume time, as the email does', 'hold', { note: 'parts ordered', hold_reason: 'parts' }, 'status_hold');
  await same('resumed: the same again, with the moved target', 'in_progress', { note: 'parts arrived, work resumed' }, 'status_open');
  await ok('the requester adds a note', `/public/alpha/tickets/${tl.data.ticket_no}/notes`, { method: 'POST', body: { body: 'Please come after 4 pm.' } });
  const st = await mailOf('requestor_note', 'pavan@example.com');
  check('the team’s email names the requester (no “You”) and colours each step', /· Tara</.test(st.html) && !/· You</.test(st.html) && st.html.includes('bgcolor="#F79009"') && st.html.includes('bgcolor="#7A5AF8"'), st.html.match(/Latest updates[\s\S]{0,300}/)?.[0]);
  const m4 = await same('closed: the same again', 'closed', { note: 'switch board replaced and tested' }, 'status_closed');
  check('more than 5 updates: the last 5 are shown, with a link to the rest', (m4.html.match(/mso-line-height-rule:exactly/g) || []).length === 5 && m4.html.includes('Showing the last 5 updates') && m4.html.includes('See all on your ticket page') && !m4.html.includes('Ticket received'));
  check('the plain-text version carries the same list', /Latest updates\n.+· Pavan Provider, Electrical team · Resolved: Switch board replaced and tested\./.test(m4.text_body) && /See all updates: http/.test(m4.text_body), m4.text_body.match(/Latest updates[\s\S]{0,300}/)?.[0]); }

  sec('Emails: fixes from the independent audit');
  { await stop(); await start(); // fresh rate limits
  const tidA = (await q("SELECT id FROM tenants WHERE slug='alpha'"))[0].id, SA = { token: T.sa, tenant: tidA };
  const mailTo = async (to, key) => (await q('SELECT id, recipient, subject, body, html, text_body, status, secret FROM notifications WHERE recipient=? AND template_key=? ORDER BY created_at DESC LIMIT 1', to, key))[0];
  const idOf = async no => (await q('SELECT id FROM tickets WHERE tenant_id=? AND ticket_no=?', tidA, no))[0]?.id;
  // --- two people on one ticket: each reads their own report ---
  const wtr = await ok('a team with a Location & Student form, with nobody on it yet', '/services', { ...SA, method: 'POST', body: { code: 'WATER', name: 'Water supply',
    form_schema: { form_type: 'both', lists: { block: ['Main block', 'Hostel block'] }, fields: [{ key: 'issue', label: 'Issue', type: 'select', required: true, options: ['No water', 'Leak'] }] } } });
  const stu = (n, sid, words, extra = {}) => raise('alpha', { service_id: wtr.id, name: n, email: `${n.toLowerCase()}@join.example.com`, requestor_type: 'student', subject: `${n}: no water`, description: words,
    form_data: { loc_block: 'Hostel block', loc_floor: '1st floor', loc_room: '118', issue: 'No water', stu_branch: 'BPT', stu_id: sid, stu_dept: 'Physiotherapy' }, ...extra });
  const pic = n => [{ name: n, type: 'image/png', source: 'gallery', data: PNG }];
  const j1 = await stu('Divya', '23BPT777', 'No water since morning. Call me on my personal number 9000011111.', { files: pic('tap.png') });
  const j2 = await stu('Esha', '23BPT888', 'Nothing from the tap in our room either.', { files: pic('mine.png') });
  const jt = await idOf(j1.data?.ticket_no);
  const keyOf = async type => (await q('SELECT a.storage_key k FROM attachments a JOIN ticket_events e ON e.id::text=a.event_id::text WHERE a.ticket_id=? AND e.event_type=?', jt, type))[0]?.k;
  const k1 = await keyOf('created'), k2 = await keyOf('merged');
  const e1 = await mailTo('divya@join.example.com', 'created'), e2 = await mailTo('esha@join.example.com', 'created');
  check('a second student reports the same room and problem: one ticket, two people', j2.data?.merged === true && j2.data.ticket_no === j1.data.ticket_no && !!k1 && !!k2 && k1 !== k2, JSON.stringify(j2.data || j2.error));
  check('the first student’s email shows the ticket as they raised it', /23BPT777/.test(e1.text_body) && /personal number 9000011111/.test(e1.text_body) && e1.html.includes(k1), e1.text_body.slice(0, 300));
  const all2 = e2.subject + e2.text_body + e2.html;
  check('the one who joined reads their own words and photo: never the first student’s ID, description or photo', !/23BPT777|9000011111|Divya/.test(all2) && !all2.includes(k1)
    && e2.text_body.includes('Nothing from the tap in our room either.') && e2.html.includes(k2) && e2.subject.includes('Esha: no water') && /Known issue: 1 other/.test(e2.body) && /Problem: No water/.test(e2.text_body), e2.text_body.slice(0, 600));
  r = await act(jt, { to: 'in_progress', note: 'The plumber is on the way.', approved: true }, T.asha);
  const s1 = await mailTo('divya@join.example.com', 'status_in_progress'), s2 = await mailTo('esha@join.example.com', 'status_in_progress');
  check('…the same in every later update; in “Latest updates” the other person is not named', r.status === 200 && /23BPT777/.test(s1.text_body) && /· You</.test(s1.html) && !/23BPT777|9000011111|Divya/.test(s2.subject + s2.text_body + s2.html)
    && s2.text_body.includes('Nothing from the tap') && /Hi Esha,/.test(s2.body) && s2.body.includes('"Esha: no water"') && s2.html.includes('Someone else who reported this'), s2.text_body.slice(0, 700));
  await stu('Divya', '23BPT777', 'Still no water at 6 pm, my roommate is unwell.');
  await ok('the team replies to everyone on the ticket', `/tickets/${jt}/notes`, { token: T.asha, method: 'POST', body: { body: 'The tanker arrives at 7 pm.', approved: true } });
  const n1 = await mailTo('divya@join.example.com', 'note'), n2 = await mailTo('esha@join.example.com', 'note');
  check('one’s own note is shown with its words; another person’s note without their name or their words', n1.html.includes('my roommate is unwell') && !n2.html.includes('roommate') && !n2.html.includes('Divya')
    && n2.html.includes('Someone else who reported this') && n2.html.includes('The tanker arrives at 7 pm.'), n2.text_body.slice(0, 600));
  // the ticket page is each person's own too
  const kd = j1.data.tracking_token, ke = j2.data.tracking_token, pd = (await api(`/public/alpha/tickets/${j1.data.ticket_no}?k=${kd}`)).data, pe = (await api(`/public/alpha/tickets/${j1.data.ticket_no}?k=${ke}`)).data;
  const sd = JSON.stringify(pd), se = JSON.stringify(pe);
  const keyIn = m => /[?&]k=([A-Za-z0-9_-]+)/.exec(m?.html || '')?.[1];
  check('each person on the ticket has their own key, and every email to them carries THEIR key (the later ones too)', !!kd && !!ke && kd !== ke
    && keyIn(e1) === kd && keyIn(s1) === kd && keyIn(n1) === kd && keyIn(e2) === ke && keyIn(s2) === ke && keyIn(n2) === ke
    && !n2.html.includes(kd) && !n2.text_body.includes(kd) && !s2.html.includes(kd), JSON.stringify([keyIn(e2) === ke, keyIn(s2) === ke, keyIn(n2) === ke]));
  await api(`/public/alpha/tickets/${j1.data.ticket_no}/link`, { method: 'POST', body: { email: 'esha@join.example.com' } });
  const jl = await waitFor(() => mailTo('esha@join.example.com', 'ticket_link'));
  check('…and Track ticket sends each person the link to their own page', keyIn(jl) === ke && !jl.html.includes(kd) && jl.subject.includes(j1.data.ticket_no), jl?.subject);
  const ag = await stu('Divya', '23BPT777', 'Third time: still no water.');
  check('a report that repeats one already on the ticket is added to it, but no key is handed out on the screen (typing an email does not prove it is yours)', ag.status === 200 && ag.data.again === true && ag.data.tracking_token === null && ag.data.ticket_no === j1.data.ticket_no, JSON.stringify(ag.data));
  check('the one who joined sees their own report on the ticket page: never the first person’s words, photos or notes', pe.subject === 'Esha: no water' && se.includes('Nothing from the tap in our room either.') && se.includes(k2)
    && !/9000011111|roommate|Divya/.test(se) && !se.includes(k1) && pe.events.some(e => e.event_type === 'joined') && se.includes('The tanker arrives at 7 pm.'), se.slice(0, 600));
  check('…and the first person does not see theirs', sd.includes('my roommate is unwell') && sd.includes(k1) && !sd.includes('Nothing from the tap') && !sd.includes(k2) && !/Esha/.test(sd), sd.slice(0, 400));
  await ok('the one who joined adds a note from their page', `/public/alpha/tickets/${j1.data.ticket_no}/notes`, { method: 'POST', body: { k: ke, body: 'Water is back in our room now.' } });
  const jn = await mailTo('asha@example.com', 'requestor_note');
  check('…the team reads it under that person’s name, and the first person’s page shows only that someone wrote', /Esha added a note/.test(jn.subject)
    && (pd2 => pd2.events.some(e => e.event_type === 'note' && e.actor_name === 'Someone else who reported this' && !e.body) && !JSON.stringify(pd2).includes('Water is back'))((await api(`/public/alpha/tickets/${j1.data.ticket_no}?k=${kd}`)).data), jn.subject);
  check('a team with nobody on it: the campus admin is told about the new ticket, so it does not wait unseen', (await q("SELECT 1 FROM notifications WHERE ticket_id=? AND template_key='new_ticket' AND recipient='asha@example.com'", jt)).length === 1);
  // --- one email address, one line, a length limit ---
  for (const bad of ['one@victims.example.com;two@victims.example.com', 'a@x.example.com,b@y.example.com', 'Dean <dean@x.example.com>', 'a b@x.example.com', 'a@x', 'a@@x.example.com'])
    await fails(`a ticket for “${bad}” is refused: exactly one address`, '/public/alpha/tickets', { method: 'POST', body: { ...elecBody('Many', bad), phone: '9000077001' } }, 400, 'valid email');
  const sp = await raise('alpha', elecBody('Spaced', '  Jaya.Spaced@Student.Example.COM '));
  check('an address typed with capitals and spaces around it is used trimmed and in small letters, from the first email on', sp.status === 200
    && (await q("SELECT recipient FROM notifications WHERE template_key='created' AND subject LIKE ?", `[${sp.data?.ticket_no}]%`))[0]?.recipient === 'jaya.spaced@student.example.com', JSON.stringify(sp.error || ''));
  await fails('a staff account for a list of addresses is refused too', '/users', { ...SA, method: 'POST', body: { name: 'List', email: 'a@x.example.com;b@y.example.com' } }, 400, 'one address');
  await fails('a description over 5,000 characters is refused', '/public/alpha/tickets', { method: 'POST', body: { ...elecBody('Long', 'long@join.example.com'), phone: '9000077002', description: 'x'.repeat(5001) } }, 400, '5,000');
  const cr = await raise('alpha', { ...elecBody('Ctl', 'ctl@join.example.com'), subject: 'Tap\rBcc: evil@x.example.com\nSecond line' });
  const crM = await mailTo('ctl@join.example.com', 'created');
  check('a subject with line breaks or control characters becomes one clean line, in the ticket and in the email subject', cr.status === 200 && crM?.subject === `[${cr.data.ticket_no}] Ticket received: Tap Bcc: evil@x.example.com Second line`, JSON.stringify(crM?.subject));
  // --- the failed-email list, and Resend ---
  await run("UPDATE notifications SET status='failed', last_error='test' WHERE id=?", crM.id);
  const att = (await api('/attention', { token: T.asha })).data.failed_mail.find(m => m.id === crM.id);
  check('Attention lists a failed email by its subject and address: never its text', !!att && att.subject === crM.subject && !('body' in att) && !('html' in att) && !('text_body' in att) && !('secret' in att), JSON.stringify(Object.keys(att || {})));
  await run("UPDATE notifications SET status='sent' WHERE id=?", crM.id);
  const rs = await api(`/notifications/${crM.id}/resend`, { token: T.asha, method: 'POST' });
  check('an email that already went out is not sent again by Resend', rs.status === 200 && rs.data.queued === 0 && (await q('SELECT status FROM notifications WHERE id=?', crM.id))[0].status === 'sent', JSON.stringify(rs.data));
  // --- passwords in stored emails ---
  const cfgWas = (await api('/mail/config', { token: T.sa })).data;
  await ok('(a mail flow is connected for the next checks)', '/mail/config', { token: T.sa, method: 'PUT', body: { url: FLOW_URL, key: flow.key, sending: true } });
  const au = (await q("SELECT tenant_id, meta FROM audit_logs WHERE action='mail.config' ORDER BY created_at DESC LIMIT 1"))[0];
  check('a change to the mail connection is logged for no campus, and without the flow’s address', au.tenant_id === null && !au.meta.includes(FLOW_URL) && /"url":"\(changed\)"/.test(au.meta)
    && !(await api('/audit', { token: T.asha })).data.some(a => a.action === 'mail.config') && (await api('/audit', SA)).data.some(a => a.action === 'mail.config'), au.meta);
  const nu = await ok('an admin adds a person to the Water team', '/users', { ...SA, method: 'POST', body: { name: 'Wally Water', email: 'wally@join.example.com', service_ids: [wtr.id] } });
  const inv = await waitFor(async () => { const m = await mailTo('wally@join.example.com', 'invite'); return m?.status === 'sent' ? m : null; }, 8000);
  const got = flow.received.find(m => m.to === 'wally@join.example.com' && /Welcome/.test(m.subject));
  check('the welcome email reaches the person with the temporary password', !!inv && !!got && got.html.includes(nu.temp_password) && got.text.includes(nu.temp_password) && /works for 14 days/.test(got.text));
  check('…and once it is handed over, the stored copy shows dots instead of the password', !!inv && inv.secret === null && ![inv.body, inv.html, inv.text_body].some(x => x.includes(nu.temp_password)) && inv.body.includes('••••••') && inv.html.includes('••••••'), inv?.body?.slice(-220));
  const na = await ok('a campus admin is added', '/users', { ...SA, method: 'POST', body: { name: 'Zed Admin', email: 'zed@join.example.com', role: 'tenant_admin' } });
  const invA = await mailTo('zed@join.example.com', 'invite');
  check('the welcome email says what is true for each role', /You see every ticket of your campus/.test(invA.body) && !/You get an email when a new ticket arrives/.test(invA.body) && /Your services: All services of your campus/.test(invA.body)
    && /You get an email when a new ticket arrives in your services/.test(inv.body), invA.body.slice(0, 500));
  await run('UPDATE users SET pw_issued_at=? WHERE id=?', new Date(Date.now() - 15 * 864e5).toISOString(), nu.id);
  const exp = await api('/auth/login', { method: 'POST', body: { email: 'wally@join.example.com', password: nu.temp_password } });
  check('a temporary password an admin issued stops working after 14 days, and says what to do', exp.status === 401 && /14 days/.test(exp.error.message) && /Forgot password/.test(exp.error.message), exp.error?.message);
  const rp = await ok('the admin resets it', `/users/${nu.id}/reset-password`, { ...SA, method: 'POST' });
  check('…a reset gives a fresh one that works', !!(await login('wally@join.example.com', rp.temp_password)));
  // --- a sub-team with no members of its own ---
  const sub = await ok('a sub-team of Water supply with no members of its own', '/services', { ...SA, method: 'POST', body: { code: 'WTANK', name: 'Water tanks', parent_id: wtr.id, form_schema: { form_type: 'general', fields: [] } } });
  const sb = await raise('alpha', { service_id: sub.id, name: 'Farid', email: 'farid@join.example.com', subject: 'Tank lid is open', location: 'Roof of block B' }), sbT = await idOf(sb.data?.ticket_no);
  const sbM = await q("SELECT recipient, text_body FROM notifications WHERE ticket_id=? AND template_key='new_ticket'", sbT);
  check('its main team’s provider is told about its tickets, and the requester reads who handles it', sbM.some(m => m.recipient === 'wally@join.example.com') && !sbM.some(m => m.recipient === 'asha@example.com')
    && /Handled by: Wally Water/.test((await mailTo('farid@join.example.com', 'created')).text_body), JSON.stringify(sbM.map(m => m.recipient)));
  check('the staff link in an email carries the campus, so a super admin lands in the right one', !!sbM[0]?.text_body.includes(`/#/c/t/${sbT}?c=${tidA}`));
  // --- tickets staff raised, and requests between staff, on the public side ---
  const room77 = { loc_block: 'Main block', loc_floor: '1st floor', loc_room: '77', issue: 'Leak' };
  const wk = await ok('staff log a walk-in for the Water team, with the caller’s photo', '/tickets', { ...SA, method: 'POST', body: { channel: 'walk_in', service_id: wtr.id, name: 'Wendy Walkin', email: 'wendy@join.example.com', phone: '9000077010', requestor_type: 'staff',
    identifier: 'S9', department: 'Admin', subject: 'Walk-in: tap broken', description: 'Tap broken in the staff room.', form_data: room77, files: pic('wendy-tap.png') } });
  const wkKey = (await q('SELECT storage_key k FROM attachments WHERE ticket_id=?', wk.id))[0]?.k;
  const jay = await raise('alpha', { service_id: wtr.id, name: 'Jay', email: 'jay@join.example.com', requestor_type: 'staff', subject: 'Jay: tap', description: 'The tap is broken for me too.', form_data: room77 });
  const jayPage = jay.data?.merged ? (await api(`/public/alpha/tickets/${jay.data.ticket_no}?k=${jay.data.tracking_token}`)).data : null;
  check('someone who joins a ticket staff typed in for a caller does not see the caller’s photo', !!wkKey && jay.data?.ticket_no === wk.ticket_no && !!jayPage && !JSON.stringify(jayPage).includes(wkKey) && !/Wendy|staff room/.test(JSON.stringify(jayPage))
    && jayPage.events.some(e => e.event_type === 'joined'), JSON.stringify(jay.data || jay.error));
  const itn = await ok('a request between staff (Internal)', '/tickets', { token: T.pavan, method: 'POST', body: { channel: 'internal', service_id: ids.trans, subject: 'Internal: fuel theft suspected', description: 'Do not tell students.' } });
  const before2 = (await q("SELECT count(*)::int n FROM notifications WHERE template_key='ticket_link'"))[0].n;
  const il = await api(`/public/alpha/tickets/${itn.ticket_no}/link`, { method: 'POST', body: { email: 'pavan@example.com' } }); await sleep(500);
  check('…is not on the public side at all: no status by its number, no link sent for its number and the staff member’s email', (await api(`/public/alpha/tickets/${itn.ticket_no}/status`)).status === 404 && il.status === 200
    && (await q("SELECT count(*)::int n FROM notifications WHERE template_key='ticket_link'"))[0].n === before2 && /couldn't find/.test((await api('/public/alpha/bot', { method: 'POST', body: { q: itn.ticket_no } })).data.text));
  check('the requester’s page gives a provider’s name, never the email address', (pp => pp.providers.length > 0 && pp.providers.every(x => x.name && !('email' in x)))((await api('/public/alpha/tickets/0001')).data));
  const dv = await raise('alpha', elecBody('Divya', 'divya@join.example.com')), dvId = await idOf(dv.data?.ticket_no);
  const hist = async tok => ((await api(`/tickets/${dvId}`, tok)).data.requestor_history || []).map(h => h.ticket_no);
  check('a provider sees a requester’s other tickets only where they may open them (not another team’s)', !(await hist({ token: T.pavan })).includes(j1.data.ticket_no) && (await hist({ token: T.asha })).includes(j1.data.ticket_no), JSON.stringify([await hist({ token: T.pavan }), await hist({ token: T.asha })]));
  // --- targets ---
  const cal = (await q('SELECT work_end, work_days, timezone FROM tenants WHERE id=?', tidA))[0], [eh, em] = String(cal.work_end || '17:00').split(':').map(Number);
  const endOfDay = new Date(Date.parse(new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10) + 'T00:00:00Z') + (eh * 60 + em - 330) * 6e4).toISOString(); // closing time in India, 3 days on
  const hz = await raise('alpha', elecBody('Holdz', 'holdz@join.example.com')), hzId = await idOf(hz.data?.ticket_no);
  await act(hzId, { to: 'in_progress', note: 'Looking at it.', approved: true });
  await run('UPDATE tickets SET due_at=? WHERE id=?', endOfDay, hzId);
  await act(hzId, { to: 'hold', hold_reason: 'parts', note: 'Waiting for the part.', approved: true }); r = await act(hzId, { to: 'in_progress', note: 'The part has arrived.', approved: true });
  check('a ticket put on hold and resumed at once keeps its target (closing time did not become the next morning)', r.status === 200 && (await q('SELECT due_at FROM tickets WHERE id=?', hzId))[0].due_at === endOfDay, (await q('SELECT due_at FROM tickets WHERE id=?', hzId))[0].due_at);
  await act(hzId, { to: 'closed', note: 'Part fitted and tested.', approved: true });
  const cl = await mailTo('holdz@join.example.com', 'status_closed');
  check('the closed email offers the reopen once', (cl.text_body.match(/reopen it within/g) || []).length === 1 && /If it is not fixed, you can ask to reopen it within \d+ days/.test(cl.text_body), cl.text_body.slice(0, 500));
  const mv = await raise('alpha', elecBody('Movd', 'movd@join.example.com')), mvId = await idOf(mv.data?.ticket_no);
  await run("UPDATE tickets SET due_at=?, escalated_at=?, escalated_to=(SELECT id FROM users WHERE email='asha@example.com') WHERE id=?", new Date(Date.now() - 3 * 864e5).toISOString(), new Date(Date.now() - 2 * 864e5).toISOString(), mvId);
  await ok('an overdue, escalated ticket is moved to another team', `/tickets/${mvId}/transfer`, { token: T.pavan, method: 'POST', body: { service_id: wtr.id, note: 'This is a water problem.', approved: true } });
  const moved = (await q('SELECT due_at, escalated_at, service_id FROM tickets WHERE id=?', mvId))[0];
  check('…the new team starts with its own full target: it is not escalated on them a minute later', moved.service_id === wtr.id && moved.escalated_at === null && moved.due_at > new Date().toISOString(), JSON.stringify(moved));
  check('…both teams are told, with the new target', /New target: /.test((await mailTo('wally@join.example.com', 'transferred'))?.text_body || '') && !!(await mailTo('pavan@example.com', 'transferred')));
  // --- wording ---
  const pv = async key => (await api('/mail/preview', { token: T.sa, method: 'POST', body: { key } })).data;
  const pvD = await pv('digest'), pvO = await pv('status_open'), pvT = await pv('transferred_requestor');
  check('the morning brief previews with a subject, the team and the counts', /\[Morning brief\] Electrical: 2 open tickets · /.test(pvD.subject) && pvD.html.includes('Overdue 1') && pvD.html.includes('OVERDUE (1)'), pvD.subject);
  check('“Good news: work on … has resumed.” is drawn as a sentence, not as a label and its value', !/color:#8b8fa8">Good news:/.test(pvO.html) && pvO.html.includes('Good news: work on'), pvO.html.match(/Good news[\s\S]{0,120}/)?.[0]);
  check('the provider’s note sits in its box in the “moved to another team” email too', /border-left:4px solid #1D4ED8/.test(pvT.html));
  await fails('a campus cannot be given a time zone that does not exist', `/tenants/${tidA}`, { ...SA, method: 'PATCH', body: { timezone: 'Asia/Calcuta' } }, 400, 'time zone');
  // --- an email that has not gone out keeps its password until that password stops working ---
  await ok('(sending is paused)', '/mail/config', { token: T.sa, method: 'PUT', body: { sending: false } });
  const rp2 = await ok('the admin resets the password while emails are paused', `/users/${nu.id}/reset-password`, { ...SA, method: 'POST' });
  const held = await waitFor(async () => { const m = await mailTo('wally@join.example.com', 'password_reset'); return m?.status === 'logged' ? m : null; }, 8000);
  check('the copy that is still waiting keeps the password, so it can be sent later', !!held && held.secret === rp2.temp_password && held.body.includes(rp2.temp_password), JSON.stringify(held?.status));
  const wt = await login('wally@join.example.com', rp2.temp_password);
  await ok('the person signs in and chooses their own password', '/me/password', { token: wt, method: 'POST', body: { current: rp2.temp_password, password: 'Wally2026okay' } });
  // --- morning brief: once a day, in the morning only, whatever goes wrong ---
  await run(`CREATE OR REPLACE FUNCTION brief_fail() RETURNS trigger AS $$ BEGIN IF NEW.recipient = 'pavan@example.com' AND NEW.template_key = 'digest' THEN RAISE EXCEPTION 'simulated failure while writing one brief'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
  await run('CREATE TRIGGER brief_fail BEFORE INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION brief_fail()');
  const zoneAt = h => { const o = ((h - new Date().getUTCHours() + 36) % 24) - 12; return o === 0 ? 'Etc/GMT' : `Etc/GMT${o > 0 ? '-' : '+'}${Math.abs(o)}`; }; // a zone where it is h o'clock now
  const briefs = async since => q("SELECT recipient, template_key, body FROM notifications WHERE tenant_id=? AND template_key IN ('digest','digest_admin') AND created_at>? ORDER BY created_at", tidA, since);
  const mark = async () => (await q('SELECT value FROM app_settings WHERE key=?', 'digest:' + tidA))[0]?.value;
  await run("UPDATE tenants SET timezone=?, work_days='0,1,2,3,4,5,6' WHERE id=?", zoneAt(9), tidA); await run('DELETE FROM app_settings WHERE key=?', 'digest:' + tidA);
  let t0 = new Date().toISOString(); await stop(); await start({ BRIEF_TICK_MS: '1000', BRIEF_MAX_LINES: '3' });
  await waitFor(mark, 12000); await sleep(3500); // …and three more looks after the day was marked
  const b1 = await briefs(t0), cnt = (to, k) => b1.filter(m => m.recipient === to && m.template_key === k).length;
  check('at 9 in the morning the brief goes out once; one person’s failure neither stops the others nor repeats theirs', !!(await mark()) && cnt('asha@example.com', 'digest_admin') === 1 && cnt('wally@join.example.com', 'digest') === 1 && cnt('pavan@example.com', 'digest') === 0,
    JSON.stringify(b1.map(m => m.recipient)));
  const ab = b1.find(m => m.recipient === 'asha@example.com')?.body || '', heads = ab.split('\n').map((l, i, a) => [l, a[i + 1] || '']).filter(([l]) => /^[A-Z][A-Z ]+ \(\d+/.test(l));
  check('a list longer than the limit: a heading only above lines that are shown, the rest summed up at the end', heads.length >= 1 && heads.every(([, nx]) => nx.startsWith('#')) && /…and more in ONE Desk: \d+ /.test(ab)
    && ab.split('\n').filter(l => l.startsWith('#')).length === 3, ab.slice(0, 700));
  const swept = await waitFor(async () => { const m = (await q('SELECT body, html, secret FROM notifications WHERE id=?', held.id))[0]; return m.secret === null ? m : null; }, 14000);
  check('once the person has chosen their own password, the waiting copy of the old one is masked', !!swept && !swept.body.includes(rp2.temp_password) && swept.body.includes('••••••') && !swept.html.includes(rp2.temp_password));
  check('…and their own new password is not kept in the stored “password changed” notice', !(await mailTo('wally@join.example.com', 'password_changed')).body.includes('Wally2026okay'));
  await run('UPDATE tenants SET timezone=? WHERE id=?', zoneAt(15), tidA); await run('DELETE FROM app_settings WHERE key=?', 'digest:' + tidA);
  t0 = new Date().toISOString(); await stop(); await start({ BRIEF_TICK_MS: '1000' }); await sleep(4000);
  check('a server that comes up in the afternoon does not send “Good morning”', (await briefs(t0)).length === 0 && !(await mark()), JSON.stringify((await briefs(t0)).map(m => m.recipient)));
  await run('DROP TRIGGER brief_fail ON notifications'); await run('DROP FUNCTION brief_fail()');
  // the day before a day off: "Since <day>" covers the last working day and the day off
  const ist = d => new Date(d).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'long' }), wdNo = d => ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].indexOf(ist(d));
  await run('UPDATE tenants SET timezone=?, work_days=? WHERE id=?', 'Asia/Kolkata', [0, 1, 2, 3, 4, 5, 6].filter(d => d !== wdNo(Date.now() - 864e5)).join(','), tidA);
  await stop(); await start();
  await run('UPDATE tickets SET created_at=? WHERE id=?', new Date(Date.now() - 2 * 864e5).toISOString(), sbT);
  await act(sbT, { to: 'hold', hold_reason: 'parts', note: 'Waiting for a new lid.', approved: true }, T.asha); await run('UPDATE tickets SET hold_due_at=? WHERE id=?', new Date(Date.now() - 864e5).toISOString(), sbT);
  t0 = new Date().toISOString(); const d1 = await ok('the admin sends the brief now', '/digest/send', { token: T.asha, method: 'POST' });
  const ab2 = (await briefs(t0)).find(m => m.recipient === 'asha@example.com')?.body || '', since = new RegExp(`Since ${ist(Date.now() - 2 * 864e5)}: (\\d+) raised, \\d+ closed`).exec(ab2);
  check('after a day off the brief counts from the last working day (“Since …”), not an empty “Yesterday”', !!since && Number(since[1]) >= 1 && !/Yesterday:/.test(ab2), ab2.slice(0, 300));
  check('a hold that ran past its limit is said so and counted', /\(\d+ past the hold limit\)/.test(ab2) && /Tank lid is open.* · hold limit passed /.test(ab2), ab2.match(/ON HOLD[\s\S]{0,300}/)?.[0]);
  check('“send now” says how many are really on their way', d1.sent >= 2 && d1.written === d1.sent && d1.live === false, JSON.stringify(d1));
  await ok('(the brief emails are switched off)', '/mail/config', { token: T.sa, method: 'PUT', body: { events: { digest: false, digest_admin: false } } });
  const d2 = await ok('the admin sends it again', '/digest/send', { token: T.asha, method: 'POST' });
  check('…with the brief switched off: written to the log, none sent', d2.sent === 0 && d2.written >= 2, JSON.stringify(d2));
  // put things back as the other checks expect them
  await ok('(the brief emails are switched on again)', '/mail/config', { token: T.sa, method: 'PUT', body: { events: { digest: true, digest_admin: true }, url: cfgWas.url || '', sending: cfgWas.sending } });
  await run('UPDATE tenants SET timezone=?, work_days=? WHERE id=?', cal.timezone, cal.work_days, tidA);
  for (const id of [na.id, nu.id]) await ok('(the extra accounts are switched off)', `/users/${id}`, { ...SA, method: 'PATCH', body: { is_active: 0 } });
  for (const id of [sub.id, wtr.id]) await ok('(the extra teams are switched off)', `/services/${id}`, { ...SA, method: 'PATCH', body: { is_active: 0 } });
  await stop(); await start(); }

  sec('Notice board: team notices, pop-up before raising, permissions');
  { const tid = (await q("SELECT id FROM tenants WHERE slug='alpha'"))[0].id, elec = (await q("SELECT id FROM services WHERE code='ELEC' AND tenant_id=?", tid))[0].id;
  const other = (await q("SELECT id FROM services WHERE tenant_id=? AND id<>? AND parent_id IS NULL AND id NOT IN (SELECT service_id FROM service_members WHERE user_id=(SELECT id FROM users WHERE email='pavan@example.com')) LIMIT 1", tid, elec))[0].id;
  const nt = await ok('a provider posts a notice for their own team', '/notices', { token: T.pavan, method: 'POST', body: { service_id: elec, title: 'power cut in block a til 4pm', body: 'Generator work. Power back by 4 pm.', important: true, status: 'published' } });
  await fails('…but not for another team', '/notices', { token: T.pavan, method: 'POST', body: { service_id: other, title: 'x', status: 'published' } }, 403);
  await fails('…and not for the whole campus', '/notices', { token: T.pavan, method: 'POST', body: { service_id: '', title: 'x', status: 'published' } }, 403);
  const camp = await ok('an admin posts one for the whole campus, for students', '/notices', { token: T.asha, method: 'POST', body: { title: 'Fee last date 30 Nov', body: 'Pay at the accounts office.', audience: 'student', status: 'published' } });
  const draft = await ok('a draft', '/notices', { token: T.pavan, method: 'POST', body: { service_id: elec, title: 'Draft notice', status: 'draft' } });
  const PDF = 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF').toString('base64');
  await ok('a PDF attached', `/notices/${nt.id}/files`, { token: T.pavan, method: 'POST', body: { name: 'schedule.pdf', data: PDF } });
  await fails('not other kinds of files', `/notices/${nt.id}/files`, { token: T.pavan, method: 'POST', body: { name: 'run.exe', data: 'data:application/octet-stream;base64,' + Buffer.from('MZ' + 'x'.repeat(40)).toString('base64') } }, 400);
  const board = (await api('/public/alpha/notices')).data;
  check('the board: live notices only, the important one first', board[0].id === nt.id && board[0].important === true && board.some(x => x.id === camp.id), JSON.stringify(board.map(x => x.title)));
  check('…drafts never show; files can be opened', !board.some(x => x.id === draft.id) && board.find(x => x.id === nt.id).files[0].name === 'schedule.pdf' && (await fetch(API.replace('/api', '') + board.find(x => x.id === nt.id).files[0].url)).status === 200);
  check('“for Faculty” hides the students-only notice', !(await api('/public/alpha/notices?for=faculty')).data.some(x => x.id === camp.id) && (await api('/public/alpha/notices?for=student')).data.some(x => x.id === camp.id));
  const pop = (await api(`/public/alpha/notices/for/${elec}`)).data;
  check('raising for Electrical: its notice pops up (not the whole-campus one)', pop.length === 1 && pop[0].id === nt.id);
  await api('/public/alpha/notices/seen', { method: 'POST', body: { ids: [nt.id] } }); await api('/public/alpha/notices/seen', { method: 'POST', body: { ids: [nt.id], outcome: 'answered' } });
  const tk = await api('/public/alpha/tickets', { method: 'POST', body: { service_id: elec, name: 'Nia', email: 'nia@notice.example.com', phone: '9000088881', requestor_type: 'student', identifier: 'S9', department: 'BPT', subject: 'Fan not working', form_data: { loc_block: 'Main block', loc_floor: '2nd floor', loc_room: 'Notice room 7', issue: 'Fan' }, seen_notices: [nt.id] } });
  const tid2 = (await q('SELECT id FROM tickets WHERE ticket_no=? AND tenant_id=?', tk.data?.ticket_no, tid))[0]?.id;
  check('a ticket raised after reading it says so (for the team only)', !!tid2 && (await q("SELECT is_internal FROM ticket_events WHERE ticket_id=? AND event_type='notice_seen'", tid2))[0]?.is_internal === 1, JSON.stringify(tk.error || ''));
  const n1 = (await api('/notices/' + nt.id, { token: T.pavan })).data;
  check('the team sees the counts: seen, found their answer, raised anyway', n1.views === 1 && n1.answered === 1 && n1.raised === 1, JSON.stringify([n1.views, n1.answered, n1.raised]));
  check('the title is tidied like a reply (no full stop added)', (await api('/notices/' + nt.id, { token: T.pavan })).data.title === 'Power cut in block a till 4pm', (await api('/notices/' + nt.id, { token: T.pavan })).data.title);
  const wf = await ok('a Word file attached (named .zip: it is stored under what it really is)', `/notices/${nt.id}/files`, { token: T.pavan, method: 'POST', body: { name: 'circular.zip', data: docxOf() } });
  await ok('an Excel file attached', `/notices/${nt.id}/files`, { token: T.pavan, method: 'POST', body: { name: 'timetable.xlsx', data: xlsxOf() } });
  await fails('at most 3 files', `/notices/${nt.id}/files`, { token: T.pavan, method: 'POST', body: { name: 'more.pdf', data: PDF } }, 400, 'at most 3');
  const refused = async (name, data) => (await api(`/notices/${draft.id}/files`, { token: T.pavan, method: 'POST', body: { name, data } })).status === 400;
  check('macro-enabled Office files are refused, whatever they are named and however the macro part is spelt', await refused('macro.docm', docxOf([['word/vbaProject.bin', 'x']], 'application/vnd.ms-word.document.macroEnabled.main+xml'))
    && await refused('plain-name.docx', docxOf([['word/VBAPROJECT.BIN', 'x']])) && await refused('sheet.xlsx', xlsxOf([['xl/macrosheets/sheet1.xml', '<x/>']])) && await refused('form.docx', docxOf([['word/activeX/activeX1.xml', '<x/>']])));
  check('…so are templates, a zip with a program in it, a .jar, and a zip that only carries a Word-looking name', await refused('t.dotx', docxOf([], 'application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml'))
    && await refused('tools.docx', docxOf([['setup.exe', 'MZ']])) && await refused('app.jar', zipOf([['META-INF/MANIFEST.MF', 'Manifest-Version: 1.0'], ['word/document.class', 'x']]))
    && await refused('fake.docx', 'data:application/octet-stream;base64,' + Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('x'.repeat(30) + 'word/document.xml' + 'y'.repeat(30))]).toString('base64')));
  check('…an empty file and a picture type browsers do not show get a clear reason', (await api(`/notices/${draft.id}/files`, { token: T.pavan, method: 'POST', body: { name: 'empty.pdf', data: 'data:application/pdf;base64,' } })).error?.message.includes('empty')
    && (await api(`/notices/${draft.id}/files`, { token: T.pavan, method: 'POST', body: { name: 'scan.tiff', data: 'data:image/tiff;base64,' + Buffer.from('II*\0' + 'x'.repeat(40), 'latin1').toString('base64') } })).error?.message.includes('JPEG or PNG'));
  const nf = (await api('/public/alpha/notices/' + nt.id)).data.files;
  check('Word and Excel download with their own type and name', nf.length === 3 && /wordprocessingml/.test(nf[1].type) && nf[1].name === 'circular.docx' && wf.name === 'circular.docx' && /spreadsheetml/.test(nf[2].type) && /attachment; filename="circular\.docx"/.test((await fetch(APP + nf[1].url)).headers.get('content-disposition') || ''), JSON.stringify(nf.map(f => f.name)));
  const longName = await ok('a very long file name keeps its ending', `/notices/${draft.id}/files`, { token: T.pavan, method: 'POST', body: { name: 'x'.repeat(200) + '.pdf', data: PDF } });
  check('…cut to 120 characters, still .pdf', longName.name.length === 120 && longName.name.endsWith('.pdf'));
  check('a draft’s file is not public; the team opens it signed in', (await fetch(`${APP}/api/notice-files/${longName.key}`)).status === 404 && (await api(`/notices/${draft.id}/files/${longName.key}`, { token: T.pavan, raw: true })).status === 200
    && (await api(`/notices/${draft.id}/files/${longName.key}`, { raw: true })).status === 401);
  await fails('removing a file that is not on the notice says so', `/notices/${draft.id}/files/${wf.key}`, { token: T.pavan, method: 'DELETE' }, 404);
  await ok('removing a file', `/notices/${draft.id}/files/${longName.key}`, { token: T.pavan, method: 'DELETE' });
  check('…takes it off the disk too, and both steps are in the audit trail', !fs.existsSync(path.join(UPLOADS, longName.key)) && (await q("SELECT count(*)::int n FROM audit_logs WHERE entity_id=? AND action IN ('notice.file_add','notice.file_remove')", draft.id))[0].n === 2);
  // several uploads arriving together must not pass the limit of 3
  const many = await ok('a notice for the upload race', '/notices', { token: T.pavan, method: 'POST', body: { service_id: elec, title: 'Upload race', status: 'draft' } });
  const race = await Promise.all(Array.from({ length: 6 }, (_, i) => api(`/notices/${many.id}/files`, { token: T.pavan, method: 'POST', body: { name: `f${i}.pdf`, data: PDF } })));
  check('six uploads at once: three are kept', race.filter(r => r.status === 200).length === 3 && (await q('SELECT count(*)::int n FROM notice_files WHERE notice_id=?', many.id))[0].n === 3 && fs.readdirSync(UPLOADS).filter(f => f.endsWith('.pdf')).length === (await q("SELECT count(*)::int n FROM notice_files WHERE storage_key LIKE '%.pdf'"))[0].n, race.map(r => r.status).join(' '));
  await ok('deleting that notice', '/notices/' + many.id, { token: T.pavan, method: 'DELETE' });
  check('…removes its files from the disk', !(await q('SELECT 1 FROM notice_files WHERE notice_id=?', many.id)).length && fs.readdirSync(UPLOADS).filter(f => f.endsWith('.pdf')).length === (await q("SELECT count(*)::int n FROM notice_files WHERE storage_key LIKE '%.pdf'"))[0].n);
  const newTeam = await ok('a new team is created', '/services', { token: T.sa, tenant: tid, method: 'POST', body: { code: 'NEWDEPT', name: 'New Department', form_schema: { form_type: 'general', fields: [] } } });
  check('…and it is in the notice team list straight away (admin), not for a provider outside it', (await api('/notices', { token: T.asha })).data.teams.some(x => x.id === newTeam.id) && !(await api('/notices', { token: T.pavan })).data.teams.some(x => x.id === newTeam.id));
  const later = await ok('a notice scheduled for tomorrow', '/notices', { token: T.asha, method: 'POST', body: { service_id: newTeam.id, title: 'Opens tomorrow', starts_at: new Date(Date.now() + 864e5).toISOString(), status: 'published' } });
  check('scheduled: listed for staff as scheduled, not yet on the board', (await api('/notices', { token: T.asha })).data.notices.find(x => x.id === later.id)?.state === 'scheduled' && !(await api('/public/alpha/notices')).data.some(x => x.id === later.id));
  await fails('Until must be after Show from', '/notices/' + later.id, { token: T.asha, method: 'PATCH', body: { ends_at: new Date().toISOString() } }, 400);
  await ok('end it now', '/notices/' + nt.id, { token: T.pavan, method: 'PATCH', body: { end_now: true } });
  check('an ended notice leaves the board and the pop-up', !(await api('/public/alpha/notices')).data.some(x => x.id === nt.id) && !(await api(`/public/alpha/notices/for/${elec}`)).data.length);
  check('the list for a provider: only their teams', (await api('/notices', { token: T.pavan })).data.notices.every(x => x.service_id === elec) && (await api('/notices', { token: T.asha })).data.notices.some(x => x.id === camp.id));
  await fails('a provider can’t delete the campus notice', '/notices/' + camp.id, { token: T.pavan, method: 'DELETE' }, 404);
  await ok('the admin deletes it', '/notices/' + camp.id, { token: T.asha, method: 'DELETE' });
  check('deleted: gone for everyone', !(await api('/public/alpha/notices')).data.some(x => x.id === camp.id));
  check('the file of an ended notice is no longer public either', (await fetch(APP + nf[0].url)).status === 404 && (await api(`/notices/${nt.id}/files/${wf.key}`, { token: T.pavan, raw: true })).status === 200);
  // counters
  const cn = await ok('a notice for the counters', '/notices', { token: T.pavan, method: 'POST', body: { service_id: elec, title: 'Counter notice', status: 'published' } });
  const seen = body => api('/public/alpha/notices/seen', { method: 'POST', body }), cnt = async id => (await q('SELECT views, answered, raised FROM notices WHERE id=?', id))[0];
  await seen({ ids: [cn.id, cn.id, cn.id, cn.id] }); await seen({ ids: [cn.id], outcome: 'answered' }); await seen({ ids: [cn.id], outcome: 'answered' }); await seen({ ids: [draft.id, 'not-an-id', nt.id] });
  check('counters: a notice named four times in one go counts once, answers never pass views, drafts and ended notices are not counted', (await cnt(cn.id)).views === 1 && (await cnt(cn.id)).answered === 1 && (await cnt(draft.id)).views === 0 && (await cnt(nt.id)).views === 1, JSON.stringify([await cnt(cn.id), await cnt(draft.id), await cnt(nt.id)]));
  check('students see which team posted a notice, never the person; the team sees who', (await api('/public/alpha/notices/' + cn.id)).data.posted_by === 'Electrical team' && !JSON.stringify((await api('/public/alpha/notices')).data).includes('Pavan') && (await api('/notices/' + cn.id, { token: T.pavan })).data.posted_by === 'Pavan Provider');
  // who it is for
  const fac = await ok('a team notice for faculty only', '/notices', { token: T.pavan, method: 'POST', body: { service_id: elec, title: 'Faculty lab keys', audience: 'faculty', status: 'published' } });
  check('the pop-up before a ticket shows it to faculty and to “All”, not to a student', (await api(`/public/alpha/notices/for/${elec}?for=student`)).data.every(x => x.id !== fac.id) && (await api(`/public/alpha/notices/for/${elec}?for=faculty`)).data.some(x => x.id === fac.id) && (await api(`/public/alpha/notices/for/${elec}`)).data.some(x => x.id === fac.id));
  await fails('an unknown “For” is refused, not saved as Everyone', '/notices/' + fac.id, { token: T.pavan, method: 'PATCH', body: { audience: 'students' } }, 400, 'who the notice is for');
  // dates
  await fails('a date that does not exist is refused', '/notices', { token: T.pavan, method: 'POST', body: { service_id: elec, title: 'Bad date', starts_at: '2027-02-30T10:00:00.000Z', status: 'draft' } }, 400, 'Show from');
  await fails('…so is a bare number or a date without a time zone', '/notices', { token: T.pavan, method: 'POST', body: { service_id: elec, title: 'Bad date', starts_at: '12', ends_at: '2027-03-01T10:00', status: 'draft' } }, 400);
  await fails('publishing with an Until that is already over is refused', '/notices', { token: T.pavan, method: 'POST', body: { service_id: elec, title: 'Too late', ends_at: new Date(Date.now() - 3600e3).toISOString(), status: 'published' } }, 400, 'already past');
  // tidying: lengths, saving again, the poster's own words
  const longT = ('Fee refund: pls bring ur ID card and ur receipt to the accounts office by 5 pm, pls come early and pls wait in the line ' + 'now '.repeat(10)).slice(0, 120).trim();
  const lg = await ok('a title that grows past 120 characters when tidied is saved', '/notices', { token: T.pavan, method: 'POST', body: { service_id: elec, title: longT, status: 'published' } });
  check('…and the poster is told the text was tidied', lg.tidied === true && lg.title.length > 120 && lg.title.includes('please bring your ID card'), JSON.stringify(lg));
  await ok('…it can still be saved again unchanged (text that was tidied is not tidied twice)', '/notices/' + lg.id, { token: T.pavan, method: 'PATCH', body: { title: lg.title, important: true } });
  await ok('…and ended', '/notices/' + lg.id, { token: T.pavan, method: 'PATCH', body: { end_now: true } });
  const own = await ok('“use my text exactly” keeps what was typed', '/notices/' + lg.id, { token: T.pavan, method: 'PATCH', body: { title: 'Wen Li seminar on AI, pls come', as_typed: true } });
  check('…exactly', own.title === 'Wen Li seminar on AI, pls come' && own.tidied === false && (await q('SELECT title FROM notices WHERE id=?', lg.id))[0].title === 'Wen Li seminar on AI, pls come');
  const nul = await ok('a stray NUL character in the text is dropped, not an error', '/notices', { token: T.pavan, method: 'POST', body: { service_id: elec, title: 'Lift\u0000 under repair', body: 'Use the stairs\u0000.', status: 'draft' } });
  check('…saved clean', (await q('SELECT title, body FROM notices WHERE id=?', nul.id))[0].title === 'Lift under repair' && (await q('SELECT body FROM notices WHERE id=?', nul.id))[0].body === 'Use the stairs.');
  check('…and a NUL in a link is a plain “not found”, never a crash', (await api('/public/alpha/notices/%00')).status === 404 && (await fetch(`${APP}/api/notice-files/%00`)).status === 404 && (await api('/notices/%00', { token: T.pavan, method: 'DELETE' })).status === 404 && (await api(`/public/alpha/notices/for/%00`)).status === 200);
  // a draft published later is today's notice
  await run('UPDATE notices SET created_at=?, published_at=NULL WHERE id=?', new Date(Date.now() - 10 * 864e5).toISOString(), nul.id);
  await ok('a draft written ten days ago is published today', '/notices/' + nul.id, { token: T.pavan, method: 'PATCH', body: { status: 'published' } });
  const b2 = (await api('/public/alpha/notices')).data;
  check('…dated today and listed with the newest, not below everything written since', b2.filter(x => !x.important)[0]?.id === nul.id && Date.now() - new Date(b2.find(x => x.id === nul.id).published_at) < 60000, JSON.stringify(b2.map(x => x.title)));
  // a deactivated team
  const offTeam = await ok('a team with a live notice', '/services', { token: T.sa, tenant: tid, method: 'POST', body: { code: 'OFFDEPT', name: 'Off Department', form_schema: { form_type: 'general', fields: [] } } });
  const on1 = await ok('its notice', '/notices', { token: T.asha, method: 'POST', body: { service_id: offTeam.id, title: 'Office shifted to block C', status: 'published' } });
  await ok('the team is deactivated', '/services/' + offTeam.id, { token: T.sa, tenant: tid, method: 'PATCH', body: { is_active: 0 } });
  const stf = (await api('/notices', { token: T.asha })).data.notices.find(x => x.id === on1.id);
  check('a deactivated team’s notice leaves the board and its own page, and the team’s list says why', !(await api('/public/alpha/notices')).data.some(x => x.id === on1.id) && (await api('/public/alpha/notices/' + on1.id)).status === 404 && stf?.state === 'off' && stf.team_active === false, JSON.stringify(stf));
  await ok('editing it keeps it with its team', '/notices/' + on1.id, { token: T.asha, method: 'PATCH', body: { service_id: offTeam.id, title: 'Office shifted to block C', body: 'From Monday.' } });
  check('…it is not moved to the whole campus', (await q('SELECT service_id FROM notices WHERE id=?', on1.id))[0].service_id === offTeam.id);
  await fails('no new notice for a deactivated team', '/notices', { token: T.asha, method: 'POST', body: { service_id: offTeam.id, title: 'x', status: 'draft' } }, 400, 'deactivated');
  await ok('(that team is deleted again)', '/services/' + offTeam.id, { token: T.sa, tenant: tid, method: 'DELETE' });
  // "raised a ticket anyway"
  const oth = await ok('another team’s notice', '/notices', { token: T.asha, method: 'POST', body: { service_id: other, title: 'Other team notice', status: 'published' } });
  const rq3 = { service_id: elec, requestor_type: 'student', identifier: 'S10', department: 'BPT', subject: 'Fan regulator broken', form_data: { loc_block: 'Main block', loc_floor: '2nd floor', loc_room: 'Notice room 8', issue: 'Fan' } };
  const tk3 = await api('/public/alpha/tickets', { method: 'POST', body: { ...rq3, name: 'Omi', email: 'omi@notice.example.com', phone: '9000088882', seen_notices: [cn.id, oth.id, draft.id] } });
  check('“raised anyway” counts only what the pop-up showed: the team’s own published notices', tk3.status === 200 && (await cnt(cn.id)).raised === 1 && (await cnt(oth.id)).raised === 0 && (await cnt(draft.id)).raised === 0, JSON.stringify(tk3.error || [await cnt(cn.id), await cnt(oth.id)]));
  const tk4 = await api('/public/alpha/tickets', { method: 'POST', body: { ...rq3, name: 'Pia', email: 'pia@notice.example.com', phone: '9000088883', seen_notices: [cn.id] } });
  check('a report that joins an existing ticket is counted too', tk4.status === 200 && tk4.data.merged === true && (await cnt(cn.id)).raised === 2, JSON.stringify(tk4.data || tk4.error));
  await ok('(the other team’s notice is removed)', '/notices/' + oth.id, { token: T.asha, method: 'DELETE' });
  for (const x of [cn, fac, nul, lg, draft]) await api('/notices/' + x.id, { token: T.pavan, method: 'DELETE' });
  check('(the test notices are cleared: Electrical has no live notice left for the screens tested below)', !(await api(`/public/alpha/notices/for/${elec}`)).data.length);
  const nd = await ok('a file on the new team’s notice', `/notices/${later.id}/files`, { token: T.asha, method: 'POST', body: { name: 'plan.pdf', data: PDF } });
  await ok('a team with notices (and no tickets) can be deleted', '/services/' + newTeam.id, { token: T.sa, tenant: tid, method: 'DELETE' });
  check('…its notices and their files go with it; the notice list still loads', !(await q('SELECT 1 FROM notices WHERE service_id=?', newTeam.id)).length && !(await q('SELECT 1 FROM notice_files WHERE notice_id=?', later.id)).length
    && (await api('/notices', { token: T.asha })).status === 200 && !(await api('/notices', { token: T.asha })).data.teams.some(x => x.id === newTeam.id), JSON.stringify(nd || '')); }

  sec('Forgot password: a temporary password by email');
  { const pav = (await q("SELECT email FROM users WHERE email LIKE 'pavan%' LIMIT 1"))[0].email, mustChange = async e => (await q('SELECT must_change_pw m FROM users WHERE email=?', e))[0]?.m;
  const r1 = await api('/auth/forgot', { method: 'POST', body: { email: 'nobody-here@example.com' } }), r2 = await api('/auth/forgot', { method: 'POST', body: { email: pav.toUpperCase() } });
  check('the same answer for a known and an unknown email', r1.status === 200 && r2.status === 200 && r1.data.message === r2.data.message);
  const fm = (await q("SELECT recipient, body FROM notifications WHERE template_key='password_forgot' ORDER BY created_at DESC"));
  const tpw = fm[0]?.body.match(/Temporary password: (\S+)/)?.[1];
  check('only the real account gets the email, with a temporary password', fm.length === 1 && fm[0].recipient === pav && !!tpw);
  const lt = await api('/auth/login', { method: 'POST', body: { email: pav, password: tpw } });
  check('the temporary password signs in and asks for a new password', lt.status === 200 && await mustChange(pav) === 1);
  await ok('choosing a new password with the temporary one', '/me/password', { token: lt.data.token, method: 'POST', body: { current: tpw, password: 'Pavan#New2026' } });
  check('after that the temporary one stops working and the new one works', !(await login(pav, tpw)) && !!(await login(pav, 'Pavan#New2026')) && await mustChange(pav) === 0);
  check('choosing a new password signs out every other session of the account; this one carries on with a new token', (await api('/me', { token: lt.data.token })).status === 401 && (await api('/me', { token: T.pavan })).status === 401);
  await api('/auth/forgot', { method: 'POST', body: { email: pav } });
  const tpw2 = (await q("SELECT body FROM notifications WHERE template_key='password_forgot' AND recipient=? ORDER BY created_at DESC LIMIT 1", pav))[0].body.match(/Temporary password: (\S+)/)[1];
  await api('/auth/forgot', { method: 'POST', body: { email: pav } }); const again = await api('/auth/forgot', { method: 'POST', body: { email: pav } });
  check('asking again within the hour (anyone can, with your address) does not cancel the temporary password already in the inbox', again.status === 200 && again.data.message === r1.data.message
    && (await q("SELECT count(*)::int n FROM notifications WHERE template_key='password_forgot' AND recipient=?", pav))[0].n === 2 && !!(await login(pav, tpw2)));
  const stuck = await login(pav, tpw2);
  check('a session from a temporary password can only choose a new password: the rest of the desk stays shut', (await api('/tickets', { token: stuck })).status === 403 && (await api('/me', { token: stuck })).status === 200
    && !('temp_pw_hash' in (await api('/me', { token: stuck })).data.user) && !('password_hash' in (await api('/me', { token: stuck })).data.user));
  await fails('…and the new password cannot be the temporary one again', '/me/password', { token: stuck, method: 'POST', body: { current: tpw2, password: tpw2 } }, 400, 'different');
  await q('UPDATE users SET must_change_pw=0 WHERE email=?', pav); // (the person did not use it: their own password still stands)
  check('the own password keeps working while a temporary one is out (no lock-out)', !!(await login(pav, 'Pavan#New2026')));
  await q("UPDATE users SET temp_pw_expires=? WHERE email=?", new Date(Date.now() - 1000).toISOString(), pav);
  const last = (await q("SELECT body FROM notifications WHERE template_key='password_forgot' AND recipient=? ORDER BY created_at DESC LIMIT 1", pav))[0].body.match(/Temporary password: (\S+)/)[1];
  check('an expired temporary password is refused', !(await login(pav, last)));
  const tk2 = await login(pav, 'Pavan#New2026'); const bk = await ok('(back to the usual test password)', '/me/password', { token: tk2, method: 'POST', body: { current: 'Pavan#New2026', password: 'Pavan2026ok' } });
  check('the answer carries the new session', (await api('/me', { token: bk.token })).status === 200 && (await api('/me', { token: tk2 })).status === 401);
  // wrong tries are counted per account: a few wrong passwords do not lock the whole campus out, ten do stop that account for a while
  for (let i = 0; i < 10; i++) await api('/auth/login', { method: 'POST', body: { email: 'lata@example.com', password: 'wrong-' + i } });
  const locked = await api('/auth/login', { method: 'POST', body: { email: 'lata@example.com', password: 'wrong-again' } });
  check('ten wrong passwords for one account: that account waits 15 minutes; everyone else on the same network still signs in', locked.status === 429 && /Forgot password/.test(locked.error.message) && !!(await login(pav, 'Pavan2026ok')), `${locked.status} ${locked.error?.message}`);
  check('a password that is not text is simply wrong (it used to answer 500)', (await api('/auth/login', { method: 'POST', body: { email: pav, password: 12345678 } })).status === 401);
  await stop(); await start(); // (fresh counts)
  T.pavan = await login(pav, 'Pavan2026ok'); }

  sec('Remind me later (a provider’s reminder on a ticket)');
  { const tk = (await q("SELECT id, status, due_at, ticket_no, subject FROM tickets WHERE service_id=? AND status IN ('open','in_progress') ORDER BY created_at LIMIT 1", ids.elec))[0];
  const r1 = await ok('a provider sets a reminder for a week', `/tickets/${tk.id}/reminders`, { token: T.pavan, method: 'POST', body: { in: 'week', note: 'Check the new bulb still works' } });
  check('it lands about 7 days ahead', Math.abs(new Date(r1.remind_at) - Date.now() - 7 * 864e5) < 120e3);
  await fails('a reminder needs a note', `/tickets/${tk.id}/reminders`, { token: T.pavan, method: 'POST', body: { in: 'day', note: ' ' } }, 400);
  await fails('a reminder must be in the future', `/tickets/${tk.id}/reminders`, { token: T.pavan, method: 'POST', body: { at: new Date(Date.now() - 3600e3).toISOString(), note: 'x' } }, 400);
  await fails('and within a year', `/tickets/${tk.id}/reminders`, { token: T.pavan, method: 'POST', body: { at: new Date(Date.now() + 400 * 864e5).toISOString(), note: 'x' } }, 400);
  const at = new Date(Date.now() + 3 * 3600e3).toISOString();
  const r2 = await ok('or for a picked date and time', `/tickets/${tk.id}/reminders`, { token: T.pavan, method: 'POST', body: { at, note: 'Call the electrician' } });
  const after = (await q('SELECT status, due_at FROM tickets WHERE id=?', tk.id))[0];
  check('the ticket itself does not change', after.status === tk.status && after.due_at === tk.due_at);
  const tv = (await api(`/tickets/${tk.id}`, { token: T.pavan })).data;
  check('the ticket page lists my reminders, soonest first', tv.reminders.length === 2 && tv.reminders[0].id === r2.id);
  check('the admin on the same ticket does not see them (they are mine)', (await api(`/tickets/${tk.id}`, { token: T.sa, tenant: (await q("SELECT tenant_id FROM tickets WHERE id=?", tk.id))[0].tenant_id })).data?.reminders?.length === 0);
  await fails('someone without the ticket cannot set one', `/tickets/${tk.id}/reminders`, { token: T.bina, method: 'POST', body: { in: 'day', note: 'x' } }, 404);
  // what is typed: only text for the note; a date and time without a zone is campus time
  await fails('a note that is not text is refused (it used to answer 500)', `/tickets/${tk.id}/reminders`, { token: T.pavan, method: 'POST', body: { in: 'day', note: 12345 } }, 400);
  await fails('…a list too', `/tickets/${tk.id}/reminders`, { token: T.pavan, method: 'POST', body: { in: 'day', note: ['a', 'b'] } }, 400);
  const d10 = new Date(Date.now() + 10 * 864e5).toISOString().slice(0, 10);
  const r3 = await ok('a date and time as typed in the box, with no time zone', `/tickets/${tk.id}/reminders`, { token: T.pavan, method: 'POST', body: { at: `${d10}T10:00`, note: 'Ten in the morning' } });
  check('…is campus time: 10:00 in India, whatever the device or the server is set to', r3.remind_at === `${d10}T04:30:00.000Z`, r3.remind_at);
  await ok('(that one is cleared)', `/reminders/${r3.id}/done`, { token: T.pavan, method: 'POST' });
  // a reminder on a ticket that then moves to a team its owner is not in
  const tidR = (await q('SELECT tenant_id FROM tickets WHERE id=?', tk.id))[0].tenant_id, mvR = await raise('alpha', elecBody('Remmove', 'remmove@example.com')), mvT = (await q('SELECT id FROM tickets WHERE ticket_no=? AND tenant_id=?', mvR.data?.ticket_no, tidR))[0].id;
  const away = (await q("SELECT id FROM services s WHERE tenant_id=? AND is_active=1 AND parent_id IS NULL AND coalesce(form_schema::jsonb->>'form_type','')<>'food' AND id NOT IN (SELECT service_id FROM service_members WHERE user_id=(SELECT id FROM users WHERE email='pavan@example.com')) ORDER BY name LIMIT 1", tidR))[0].id;
  const r4 = await ok('a reminder on another ticket', `/tickets/${mvT}/reminders`, { token: T.pavan, method: 'POST', body: { in: 'day', note: 'Check the fan' } });
  await ok('…which is then moved to a team the provider is not in', `/tickets/${mvT}/transfer`, { token: T.pavan, method: 'POST', body: { service_id: away, note: 'This belongs to another team.', approved: true } });
  await q("UPDATE ticket_reminders SET remind_at=? WHERE id IN (?, ?)", new Date(Date.now() - 60e3).toISOString(), r2.id, r4.id);
  await stop(); await start(); await new Promise(r => setTimeout(r, 6500)); // the worker runs 5 s after start
  const mail = (await q("SELECT recipient, subject, body, text_body FROM notifications WHERE template_key='reminder' AND ticket_id=?", tk.id));
  check('when it comes due the provider is emailed once; the note is in the email, never in its subject (subjects show in the Email log)', mail.length === 1 && mail[0].subject === `[${tk.ticket_no}] Reminder: ${tk.subject}`
    && mail[0].body.includes('> Call the electrician') && /Status: /.test(mail[0].text_body) && !/We'll email you|You can reopen|ask to reopen/.test(mail[0].text_body), JSON.stringify(mail.map(m => [m.subject, m.text_body.slice(0, 300)])));
  check('a reminder on a ticket its owner can no longer open is not mailed, and leaves their list', (await q("SELECT 1 FROM notifications WHERE template_key='reminder' AND ticket_id=?", mvT)).length === 0
    && (await q('SELECT done_at FROM ticket_reminders WHERE id=?', r4.id))[0].done_at !== null && !(await api('/reminders', { token: T.pavan })).data.due.some(m => m.id === r4.id));
  const mine = (await api('/reminders', { token: T.pavan })).data;
  check('it shows as due on Home; the week one is still upcoming', mine.due.length === 1 && mine.due[0].id === r2.id && mine.upcoming.some(m => m.id === r1.id));
  await fails('only its owner can clear it', `/reminders/${r2.id}/done`, { token: T.lata, method: 'POST' }, 404);
  await ok('marking it done', `/reminders/${r2.id}/done`, { token: T.pavan, method: 'POST' });
  check('done reminders leave the list', (await api('/reminders', { token: T.pavan })).data.due.length === 0);
  }

  sec('Food: rate a meal (feedback) or report a problem (ticket)');
  { // its own block
  await stop(); await start({ FOOD_REPORT_KEY: 'food-report-key-0123456789' });
  const A = { token: T.sa, tenant: (await q("SELECT id FROM tenants WHERE slug='alpha'"))[0].id }, aid = A.tenant;
  const { mealAt, DEFAULT_MEAL_WINDOWS: W } = await import('../public/shared.js');
  check('default meal by time: being served, else the one just finished, else breakfast', mealAt(W, '07:00') === 'breakfast' && mealAt(W, '10:45') === 'breakfast' && mealAt(W, '12:00') === 'lunch'
    && mealAt(W, '16:00') === 'snacks' && mealAt(W, '20:00') === 'dinner' && mealAt(W, '23:40') === 'dinner' && mealAt(W, '05:00') === 'breakfast');
  const pavanId = (await q("SELECT id FROM users WHERE email='pavan@example.com'"))[0].id;
  const fsvc = await ok('a Food service (form type Food)', '/services', { ...A, method: 'POST', body: { code: 'FOODX', name: 'Food & Catering', form_schema: { form_type: 'food', fields: [] } } });
  await ok('the kitchen provider', `/services/${fsvc.id}/members`, { ...A, method: 'PUT', body: { user_ids: [pavanId] } });
  await fails('meal times must be HH:MM, start before end', '/food/settings', { ...A, method: 'PUT', body: { windows: { lunch: ['15:00', '12:00'] } } }, 400);
  // every meal starts at midnight here, so the checks below can rate "today's" meals whatever the clock says (a meal not served yet cannot be rated: tested further down)
  await ok('admin adds messes and meal times', '/food/settings', { ...A, method: 'PUT', body: { locations: [{ name: 'Boys mess' }, { name: 'Girls mess' }], windows: { breakfast: ['00:00', '10:30'], lunch: ['00:00', '15:00'], dinner: ['00:00', '22:00'] } } });
  await fails('a provider cannot change them', '/food/settings', { token: T.pavan, method: 'PUT', body: { locations: [] } }, 403);
  const fi = await ok('the food screens’ data', '/public/alpha/food');
  check('locations, meal times, chips and categories for the forms', fi.locations.length === 2 && fi.windows.dinner[1] === '22:00' && fi.meals.join() === 'breakfast,lunch,dinner' && fi.chips.includes('Cold food') && fi.categories.length === 7 && fi.meals.includes(fi.meal_now));
  const L1 = fi.locations[0].id, L2 = fi.locations[1].id, fb = (b, dk = 'dev-' + Math.random().toString(36).slice(2, 12)) => api('/public/alpha/food/feedback', { method: 'POST', body: { device_key: dk, ...b } });
  let r = await fb({ location_id: L1, meal: 'lunch' });
  check('a rating needs stars', r.status === 400 && /stars/.test(r.error.message));
  r = await fb({ location_id: L1, meal: 'lunch', rating: 2, chips: ['Cold food', 'Taste'], comment: 'Rice was cold' }, 'dev-once-0001');
  check('feedback saved, anonymous, no ticket', r.status === 200 && /goes to the kitchen team/.test(r.data.message) && (await q("SELECT count(*)::int n FROM tickets WHERE service_id=?", fsvc.id))[0].n === 0);
  r = await fb({ location_id: L1, meal: 'lunch', rating: 4 }, 'dev-once-0001');
  check('one rating per meal per device a day', r.status === 409 && /already rated lunch/.test(r.error.message));
  check('unknown chips are refused', (await fb({ location_id: L1, meal: 'lunch', rating: 3, chips: ['Bad vibes'] })).status === 400);
  for (const [rt, meal, loc, chips] of [[5, 'lunch', L2, ['Good food 👍']], [4, 'breakfast', L1, []], [1, 'dinner', L1, ['Cold food', 'Quantity']]]) await fb({ location_id: loc, meal, rating: rt, chips, name: 'Roll 23BPT01' });
  const PNGF = [{ name: 'p.png', type: 'image/png', source: 'camera', data: PNG }];
  const cb = (who, extra = {}) => ({ location_id: L1, meal: 'lunch', category: 'insect', description: 'Insect in the dal', name: who, email: `${who.toLowerCase()}@food.example.com`, phone: '9000044444', ...extra });
  r = await api('/public/alpha/food/complaint', { method: 'POST', body: cb('Fa', { description: '' }) });
  check('a photo is optional (only the description is asked for here)', r.status === 400 && !/photo/i.test(r.error.message) && /describe/i.test(r.error.message), r.error?.message);
  r = await api('/public/alpha/food/complaint', { method: 'POST', body: cb('Fa', { files: [{ name: 'a.pdf', type: 'application/pdf', data: 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4 x').toString('base64') }] }) });
  check('photos only (no PDFs)', r.status === 400);
  const c1 = (await api('/public/alpha/food/complaint', { method: 'POST', body: cb('Fa', { files: PNGF }) })).data, c2 = (await api('/public/alpha/food/complaint', { method: 'POST', body: cb('Fb', { files: PNGF }) })).data;
  const ct = (await q('SELECT * FROM tickets WHERE tenant_id=? AND ticket_no=?', aid, c1?.ticket_no))[0];
  check('a complaint is a normal ticket for the food service, with location, meal and category', ct?.service_id === fsvc.id && ct.meal === 'lunch' && ct.food_category === 'insect' && ct.food_location_id === L1 && ct.subject.includes('Insect'), JSON.stringify(c1));
  check('the same problem at the same mess today joins that ticket', c2?.ticket_no === c1.ticket_no && c2.merged && c2.affected_count === 2);
  const c2page = (await api(`/public/alpha/tickets/${c2.ticket_no}?k=${c2.tracking_token}`)).data;
  check('…and the second person is handed the key of their OWN report, not the first person’s', !!c2.tracking_token && c2.tracking_token !== c1.tracking_token && c1.tracking_token === ct.tracking_token
    && c2page?.events.some(e => e.event_type === 'joined') && !c2page.events.some(e => e.event_type === 'created' && e.files?.length), JSON.stringify([c2.tracking_token === c1.tracking_token, c2page?.events.map(e => e.event_type)]));
  const c3 = (await api('/public/alpha/food/complaint', { method: 'POST', body: cb('Fc', { category: 'other', files: PNGF }) })).data, c4 = (await api('/public/alpha/food/complaint', { method: 'POST', body: cb('Fd', { category: 'other', files: PNGF }) })).data;
  check('"Something else" complaints never merge', c3.ticket_no !== c4.ticket_no && !c4.merged);
  check('the requestor gets the usual acknowledgement email', (await q("SELECT 1 FROM notifications WHERE template_key='created' AND ticket_id=? AND recipient='fa@food.example.com'", ct.id)).length === 1);
  r = await fb({ location_id: L2, meal: 'lunch', converted_from_complaint: true, chips: ['Hygiene look'], comment: 'Tables dirty', name: 'Fe' }, null);
  const conv = (await q("SELECT * FROM food_feedback WHERE tenant_id=? AND converted_from_complaint", aid))[0];
  check('"No, send as feedback": saved as feedback, no stars needed, comment and chip kept, no ticket', r.status === 200 && conv?.rating === null && conv.comment === 'Tables dirty' && conv.chips[0] === 'Hygiene look');
  const dash = await ok('the kitchen provider’s dashboard', '/food/dashboard', { token: T.pavan });
  check('today per meal: average, count and top chips', dash.today.per_meal.lunch.count === 2 && dash.today.per_meal.lunch.avg === 3.5 && dash.today.per_meal.dinner.chips[0].chip === 'Cold food' && dash.today.total === 5 && dash.complaints === 3, JSON.stringify(dash.today.per_meal.lunch));
  check('location filter', (await api(`/food/dashboard?location=${L2}`, { token: T.pavan })).data.today.total === 2);
  await fails('only the food team and admins see food scores', '/food/dashboard', { token: T.lata }, 403);
  // feedback for a chosen day; meals and tags set by the admin
  { const pf = (await api('/public/alpha/food')).data, dback = n => { const d = new Date(pf.today + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
  const y = await fb({ location_id: L1, meal: 'lunch', meal_date: dback(1), rating: 4 }, 'dev-yday-1');
  check('feedback for yesterday’s lunch is kept under yesterday', y.status === 200 && (await q("SELECT meal_date::text d FROM food_feedback WHERE device_key='dev-yday-1'"))[0]?.d === dback(1), JSON.stringify(y.error));
  check('the same phone can’t rate that lunch twice; the message names the day', (r => r.status === 409 && / on /.test(r.error.message))(await fb({ location_id: L1, meal: 'lunch', meal_date: dback(1), rating: 2 }, 'dev-yday-1')));
  check('not a future day', (await fb({ location_id: L1, meal: 'lunch', meal_date: dback(-1), rating: 4 })).status === 400);
  check('not more than 6 days back', (await fb({ location_id: L1, meal: 'lunch', meal_date: dback(7), rating: 4 })).status === 400);
  const before = (await api('/food/settings', A)).data;
  check('settings list the three default meals (Breakfast, Lunch, Dinner) and tags', before.meals.length === 3 && before.chips.includes('Cold food'));
  await fails('a meal needs a name', '/food/settings', { ...A, method: 'PUT', body: { meals: [{ name: '', start: '08:00', end: '09:00' }] } }, 400);
  await ok('admin adds Brunch, switches off Dinner and sets their own tags', '/food/settings', { ...A, method: 'PUT', body: {
    meals: [...before.meals.map(m => ({ ...m, active: m.key !== 'dinner' })), { name: 'Brunch', start: '00:00', end: '11:30' }], chips: ['Tasty', 'Too oily', 'Small portion'] } });
  const pf2 = (await api('/public/alpha/food')).data;
  check('the form now offers Brunch and not Dinner, with the new tags', pf2.meals.includes('brunch') && !pf2.meals.includes('dinner') && pf2.meal_list.find(m => m.key === 'brunch').name === 'Brunch' && pf2.chips.join() === 'Tasty,Too oily,Small portion');
  check('a switched-off meal can’t be rated', (await fb({ location_id: L1, meal: 'dinner', rating: 4 })).status === 400);
  check('old tags are refused, new ones accepted', (await fb({ location_id: L1, meal: 'brunch', rating: 3, chips: ['Cold food'] })).status === 400 && (await fb({ location_id: L1, meal: 'brunch', rating: 3, chips: ['Tasty'] })).status === 200);
  for (const [i, c] of ['Dal was too salty', 'too salty and cold rice', 'Cold rice, too salty again'].entries()) await fb({ location_id: L1, meal: 'brunch', rating: 2, comment: c }, 'dev-kw-' + i);
  const dsh = (await api('/food/dashboard', { token: T.pavan })).data;
  check('the kitchen dashboard shows Brunch, per day and meal', dsh.meals.some(m => m.key === 'brunch') && dsh.today.per_meal.brunch.count === 4 && Array.isArray(dsh.period.counts.brunch));
  const kw = dsh.period.keywords, salty = kw.find(k => k.word === 'too salty');
  check('major keywords from written reviews: “too salty” 3 times, with example reviews', salty?.count === 3 && salty.examples.length === 3 && kw.some(k => k.word === 'cold rice' && k.count === 2), JSON.stringify(kw.slice(0, 5).map(k => [k.word, k.count])));
  check('…and per meal', dsh.period.per_meal.brunch.keywords[0]?.word === 'too salty' && dsh.period.reviews >= 3);
  const mv = (await api('/food/meal?meal=brunch', { token: T.pavan })).data;
  check('one meal’s page: every entry with its cumulative summary', mv.total === 4 && mv.rows.length === 4 && mv.summary.per_meal.brunch.count === 4 && mv.summary.keywords[0]?.word === 'too salty', JSON.stringify({ t: mv.total }));
  check('…filter by stars and by written reviews', (await api('/food/meal?meal=brunch&stars=3', { token: T.pavan })).data.total === 1 && (await api('/food/meal?meal=brunch&written=1', { token: T.pavan })).data.total === 3);
  await fails('only the food team sees it', '/food/meal?meal=brunch', { token: T.lata }, 403);
  await ok('admin puts the defaults back', '/food/settings', { ...A, method: 'PUT', body: { meals: before.meals.map(m => ({ ...m, active: true })), chips: before.default_chips } });
  check('back to three meals', (await api('/public/alpha/food')).data.meals.join() === 'breakfast,lunch,dinner');
  const cs = dsh.complaint_split;
  check('the kitchen sees complaints apart from feedback: total, open, by problem and by meal', cs.total >= 1 && cs.open >= 1 && cs.by_category.length >= 1 && cs.by_meal.reduce((x, y) => x + y.count, 0) === cs.total, JSON.stringify(cs)); }
  // the export: meal names, a campus-time column, and nothing a spreadsheet would run as a formula
  const pf = (await api('/public/alpha/food')).data, dback = n => { const d = new Date(pf.today + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
  await fb({ location_id: L1, meal: 'breakfast', rating: 3, comment: '=HYPERLINK("http://attacker.example","menu")', name: '@SUM(1+1)' }, 'dev-csv-0001');
  const csvB = Buffer.from(await (await fetch(`${API}/food/feedback.csv`, { headers: { authorization: 'Bearer ' + T.pavan } })).arrayBuffer()), csvF = csvB.toString('utf8');
  check('CSV export: the meal by its name, typed text that looks like a formula made plain text, readable in Excel', csvB[0] === 0xef && csvB[1] === 0xbb && csvB[2] === 0xbf && csvF.slice(1).startsWith('meal_date,meal,meal_key,location,rating') && /"Breakfast","breakfast"/.test(csvF)
    && csvF.includes(`"'=HYPERLINK(""http://attacker.example"",""menu"")"`) && csvF.includes(`"'@SUM(1+1)"`) && /sent_at_campus_time/.test(csvF), csvF.slice(0, 200));
  // what may be rated, and by whom
  check('wrong kinds of values are refused, not guessed at (stars as true or a list, a review that is not text, 30 February)', (await fb({ location_id: L1, meal: 'lunch', rating: true })).status === 400 && (await fb({ location_id: L1, meal: 'lunch', rating: [5] })).status === 400
    && (await fb({ location_id: L1, meal: 'lunch', rating: 4, comment: { a: 1 } })).status === 400 && (await fb({ location_id: L1, meal: 'lunch', rating: 4, meal_date: pf.today.slice(0, 5) + '02-30' })).status === 400);
  const noKey = b => api('/public/alpha/food/feedback', { method: 'POST', body: b });
  const nk1 = await noKey({ location_id: L2, meal: 'breakfast', rating: 1 }), nk2 = await noKey({ location_id: L2, meal: 'breakfast', rating: 1 });
  check('leaving the device key out does not allow rating one meal again and again', nk1.status === 200 && nk2.status === 409, `${nk1.status} ${nk2.status}`);
  const hNow = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
  if (hNow < 21) { // a meal that starts two hours from now (not possible to set up in the last hours of the day)
    const cur = (await api('/food/settings', A)).data.meals;
    await ok('a meal that is served later today', '/food/settings', { ...A, method: 'PUT', body: { meals: [...cur, { name: 'Late snack', start: `${String(hNow + 2).padStart(2, '0')}:00`, end: '23:59' }] } });
    const lateR = await fb({ location_id: L1, meal: 'late_snack', rating: 4 }), ydayR = await fb({ location_id: L1, meal: 'late_snack', rating: 4, meal_date: dback(1) });
    check('a meal of today that has not been served yet cannot be rated; yesterday’s can', lateR.status === 400 && /not been served yet/.test(lateR.error.message) && ydayR.status === 200, JSON.stringify(lateR.error));
    await ok('(that meal is removed: it has a rating, so it is switched off and keeps its name)', '/food/settings', { ...A, method: 'PUT', body: { meals: cur } });
    check('…a removed meal that was rated stays, switched off; the form no longer offers it', (await api('/food/settings', A)).data.meals.some(m => m.key === 'late_snack' && !m.active) && !(await api('/public/alpha/food')).data.meals.includes('late_snack'));
  } else check('(a meal not served yet cannot be rated: not checked in the last hours of the day)', true);
  const cur2 = (await api('/food/settings', A)).data.meals;
  await ok('a meal added by mistake', '/food/settings', { ...A, method: 'PUT', body: { meals: [...cur2, { name: 'Brekfast typo', start: '00:00', end: '09:00' }] } });
  await ok('…and removed again', '/food/settings', { ...A, method: 'PUT', body: { meals: cur2 } });
  check('a removed meal that was never rated is deleted for good', !(await api('/food/settings', A)).data.meals.some(m => /typo/.test(m.name)));
  const twoCol = (await api('/food/settings', A)).data.meals.filter(m => m.active).map(m => m.color);
  check('every meal has its own colour', new Set(twoCol).size === twoCol.length, twoCol.join());
  // settings are saved all together or not at all
  const tagsBefore = (await api('/food/settings', A)).data.chips;
  await fails('a save with one wrong part is refused as a whole', '/food/settings', { ...A, method: 'PUT', body: { chips: ['Only this'], locations: [{ name: 'Same' }, { name: 'same' }] } }, 400, 'same name');
  check('…nothing of it was saved', (await api('/food/settings', A)).data.chips.join() === tagsBefore.join());
  await fails('odd values are refused, not saved as “[object Object]”', '/food/settings', { ...A, method: 'PUT', body: { meals: [{ name: {}, start: '08:00', end: '09:00' }] } }, 400);
  await fails('…', '/food/settings', { ...A, method: 'PUT', body: { meals: [null] } }, 400);
  await ok('two messes swap names in one save', '/food/settings', { ...A, method: 'PUT', body: { locations: [{ id: L1, name: 'Girls mess' }, { id: L2, name: 'Boys mess' }] } });
  await ok('(and back)', '/food/settings', { ...A, method: 'PUT', body: { locations: [{ id: L1, name: 'Boys mess' }, { id: L2, name: 'Girls mess' }] } });
  check('…and the change is in the audit trail', (await q("SELECT count(*)::int n FROM audit_logs WHERE action='food.settings'"))[0].n >= 3);
  // praise is not an issue
  await ok('the admin marks which tags are praise', '/food/settings', { ...A, method: 'PUT', body: { chips: [...tagsBefore.filter(c => c !== 'Tasty'), 'Tasty'], good_chips: ['Tasty', 'Good food 👍'] } });
  for (const i of [1, 2, 3]) await fb({ location_id: L1, meal: 'breakfast', rating: 5, chips: ['Tasty'] }, 'dev-good-' + i);
  const dg = (await api('/food/dashboard', { token: T.pavan })).data, repG = (await (await fetch(`${API}/reports/food/daily?tenant=alpha&format=json`, { headers: { 'x-report-key': 'food-report-key-0123456789' } })).json()).data;
  check('the dashboard knows which tags are praise; the daily email’s “Top 3 issues” leaves them out', dg.good_chips.includes('Tasty') && dg.period.chips.some(c => c.chip === 'Tasty') && !/<li>Tasty/.test(repG.html.match(/Top 3 issues[\s\S]*?<\/ol>|Top 3 issues[\s\S]*?No issues tagged/)?.[0] || 'x<li>Tasty')
    && !/<li>Good food/.test(repG.html.match(/Top 3 issues[\s\S]*?<\/ol>|Top 3 issues[\s\S]*?No issues tagged/)?.[0] || ''), repG.html.match(/Top 3 issues[\s\S]{0,300}/)?.[0]);
  await ok('(tags back to the standard ones)', '/food/settings', { ...A, method: 'PUT', body: { chips: tagsBefore } });
  // a rating that comes in late for an earlier day is in the next daily report
  await run("INSERT INTO food_feedback (id, tenant_id, location_id, meal, rating, chips, comment, meal_date, created_at) VALUES (gen_random_uuid()::text, ?, ?, 'dinner', 2, '{}', 'Late night rating for yesterday dinner', ?, ?)", aid, L1, dback(1), new Date().toISOString());
  const repL = (await (await fetch(`${API}/reports/food/daily?tenant=alpha&format=json`, { headers: { 'x-report-key': 'food-report-key-0123456789' } })).json()).data;
  check('…listed under “Came in since the last report, for earlier days”', /Came in since the last report, for earlier days/.test(repL.html) && /Late night rating for yesterday dinner/.test(repL.html));
  // dates
  await fails('a range of more than 400 days is refused with a clear message', '/food/dashboard?from=2024-01-01&to=2026-01-01', { token: T.pavan }, 400, '400 days');
  // one meal's page: the next page starts after the last row shown, also when new feedback arrived meanwhile
  for (let i = 0; i < 55; i++) await run("INSERT INTO food_feedback (id, tenant_id, location_id, meal, rating, chips, meal_date, created_at) VALUES (gen_random_uuid()::text, ?, ?, 'lunch', 4, '{}', ?, ?)", aid, L1, pf.today, new Date(Date.now() - 60000 - i * 1000).toISOString());
  const pg1 = (await api('/food/meal?meal=lunch', { token: T.pavan })).data;
  await fb({ location_id: L2, meal: 'lunch', rating: 5 }, 'dev-page-new1');
  const pg2 = (await api(`/food/meal?meal=lunch&offset=50&after=${pg1.rows.at(-1).id}`, { token: T.pavan })).data;
  check('“Show more” repeats no row when a new rating arrived in between', pg1.rows.length === 50 && pg2.rows.length > 0 && !pg2.rows.some(r => pg1.rows.some(x => x.id === r.id)), `${pg1.rows.length} ${pg2.rows.length}`);
  // complaints: what joins a ticket and what does not
  const cmp = o => api('/public/alpha/food/complaint', { method: 'POST', body: { location_id: L2, meal: 'breakfast', category: 'spoiled', description: 'Stale bread at breakfast', name: 'Cmp', email: 'cmp@food.example.com', phone: '9000044451', requestor_type: 'student', ...o } });
  const k1 = await cmp({}), k2 = await cmp({ meal: 'dinner', description: 'Stale curry at dinner' });
  check('the same person, another meal the same day: a second ticket (it used to be dropped without a word)', k1.status === 200 && k2.status === 200 && !k2.data.merged && k2.data.ticket_no !== k1.data.ticket_no, JSON.stringify(k2.data || k2.error));
  const k3 = await cmp({ description: 'More stale bread, see the photo', files: PNGF }), k1id = (await q('SELECT id FROM tickets WHERE tenant_id=? AND ticket_no=?', aid, k1.data.ticket_no))[0].id;
  check('the same person reporting the same problem again: the new words and photo are added and the kitchen is told', k3.data?.merged && (await q("SELECT body FROM ticket_events WHERE ticket_id=? AND event_type='note'", k1id)).some(e => e.body === 'Reported again: More stale bread, see the photo')
    && (await q('SELECT count(*)::int n FROM attachments WHERE ticket_id=?', k1id))[0].n === 1 && (await q("SELECT count(*)::int n FROM notifications WHERE ticket_id=? AND template_key='requestor_note'", k1id))[0].n >= 1, JSON.stringify(k3.data || k3.error));
  const k4 = await cmp({ name: 'Other', email: 'other@food.example.com', phone: '9000044452' });
  check('another person, the same problem at the same meal and mess: one ticket', k4.data?.merged && k4.data.ticket_no === k1.data.ticket_no);
  const b1 = await cmp({ category: 'billing', meal: 'lunch', description: 'Lunch coupon charged twice', name: 'Rao', email: 'rao@food.example.com', phone: '9000044453' }), b2 = await cmp({ category: 'billing', meal: 'lunch', description: 'Mess card debited for a meal I did not take', name: 'Charan', email: 'charan@food.example.com', phone: '9000044454' });
  check('billing and staff-behaviour complaints are personal: never joined to someone else’s ticket', b1.status === 200 && b2.status === 200 && !b2.data.merged && b1.data.ticket_no !== b2.data.ticket_no);
  // one person is one email: a phone number someone else typed never hands over their record
  const rq0 = (await q("SELECT id, name, email FROM requestors WHERE tenant_id=? AND lower(email)='rao@food.example.com'", aid))[0];
  await cmp({ category: 'other', meal: 'lunch', description: 'Another matter', name: 'Anil Kumar', email: 'anil@food.example.com', phone: '9000044453' });
  const rq1 = (await q('SELECT name, email FROM requestors WHERE id=?', rq0.id))[0];
  check('a new person who types a phone number already on file gets their own record; the other person’s name and email stay', rq1.name === 'Rao' && rq1.email === 'rao@food.example.com' && (await q("SELECT count(*)::int n FROM requestors WHERE tenant_id=? AND lower(email)='anil@food.example.com'", aid))[0].n === 1, JSON.stringify(rq1));
  // one Food team per campus
  await fails('a second Food team on a campus is refused', '/services', { ...A, method: 'POST', body: { code: 'FOODY', name: 'Night Canteen', form_schema: { form_type: 'food', fields: [] } } }, 400, 'already has a Food team');
  const gen2 = await ok('an ordinary team', '/services', { ...A, method: 'POST', body: { code: 'FOODZ', name: 'Canteen desk', form_schema: { form_type: 'general', fields: [] } } });
  await fails('…also by turning another team into one', '/services/' + gen2.id, { ...A, method: 'PATCH', body: { form_schema: { form_type: 'food', fields: [] } } }, 400, 'already has a Food team');
  await ok('(that team is deleted)', '/services/' + gen2.id, { ...A, method: 'DELETE' });
  // no Food team: nobody would read a rating, so none is taken
  await ok('the Food team is deactivated', '/services/' + fsvc.id, { ...A, method: 'PATCH', body: { is_active: 0 } });
  check('without an active Food team feedback is not taken', (await fb({ location_id: L1, meal: 'breakfast', rating: 4 })).status === 404);
  await ok('(and activated again)', '/services/' + fsvc.id, { ...A, method: 'PATCH', body: { is_active: 1 } });
  // reports
  const rep = (per, qs = '', key = 'food-report-key-0123456789') => fetch(`${API}/reports/food/${per}?tenant=alpha&format=json${qs}`, { headers: { 'x-report-key': key } });
  check('report endpoints need the report key', (await rep('daily', '', 'wrong-key-wrong-key-wrong-k')).status === 401);
  const daily = (await (await rep('daily')).json()).data;
  check('daily report: score per meal, ratings chart, top issues, comments, link, sent to the food providers', !daily.empty && daily.to.includes('pavan@example.com') && /Score per meal/.test(daily.html)
    && /\/api\/food-chart\/[^"]+\.png/.test(daily.html) && /Top 3 issues/.test(daily.html) && /Rice was cold/.test(daily.html) && /View full report/.test(daily.html), daily.subject);
  check('the food report carries the same header as every email: the logo and the “Learn · Live · Grow” line', daily.html.includes('Learn · Live · Grow') && /<img src="[^"]+\/logo\.png"/.test(daily.html), daily.html.slice(0, 900));
  const png = await fetch(APP + daily.html.match(/\/api\/food-chart\/[^"]+\.png/)[0]);
  check('charts are real PNG images (for Outlook)', png.status === 200 && png.headers.get('content-type') === 'image/png' && (await png.arrayBuffer()).byteLength > 200);
  check('a tampered chart link is refused', (await fetch(APP + daily.html.match(/\/api\/food-chart\/[^"]+\.png/)[0].replace(/\.[^.]+\.png$/, '.AAAAAAAAAAAAAAAAAAAAAA.png'))).status === 404);
  // yesterday and last month, to see trends
  const day = (n) => { const d = new Date(daily.from + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  await run("INSERT INTO food_feedback (id, tenant_id, location_id, meal, rating, chips, meal_date, created_at) VALUES (gen_random_uuid()::text, ?, ?, 'lunch', 1, '{Taste}', ?, ?)", aid, L1, day(-2), new Date().toISOString());
  await run("INSERT INTO food_feedback (id, tenant_id, location_id, meal, rating, chips, meal_date, created_at) VALUES (gen_random_uuid()::text, ?, ?, 'lunch', 2, '{}', ?, ?)", aid, L1, day(-40), new Date().toISOString());
  const weekly = (await (await rep('weekly')).json()).data, monthly = (await (await rep('monthly')).json()).data;
  check('weekly report: 7 days, daily line chart per meal, best and worst meal, recurring issues', weekly.from === day(-6) && weekly.until === daily.from && /Daily score per meal/.test(weekly.html) && /Best: <b>/.test(weekly.html) && /Recurring issues/.test(weekly.html));
  check('monthly report: weekly trend, this vs last month with ▲/▼, improved/declined, repeated issues', monthly.from.endsWith('-01') && /Weekly trend per meal/.test(monthly.html) && /Last month/.test(monthly.html) && /Most repeated issues/.test(monthly.html));
  const empty = (await (await rep('daily', '&date=2020-01-01')).json()).data;
  check('no feedback in a period: still a short "No feedback received" report', empty.empty && /No feedback received/.test(empty.html));
  check('the HTML itself (for Power Automate) is served as a page', (await (await fetch(`${API}/reports/food/daily?tenant=alpha&key=food-report-key-0123456789`)).text()).startsWith('<!doctype html>'));
  ids.foodTicket = c1.ticket_no;
  }

  sec('Super admin from .env on a live database');
  const mustChange = async e => (await q('SELECT must_change_pw m FROM users WHERE email=?', e))[0]?.m;
  // email only (no password in .env): created with a generated temporary password, emailed; once
  { const mc = async e => (await q('SELECT must_change_pw m FROM users WHERE email=?', e))[0]?.m;
    await stop(); const s3 = await start({ SUPER_ADMIN_EMAIL: 'boss@example.com' });
    const inv = (await q("SELECT body FROM notifications WHERE recipient='boss@example.com' AND template_key='invite'"));
    const pw3 = inv[0]?.body.match(/Temporary password: (\S+)/)?.[1];
    check('SUPER_ADMIN_EMAIL alone: super admin created and the temporary password emailed', /boss@example.com: created/.test(s3.out()) && inv.length === 1 && !!pw3 && !!(await login('boss@example.com', pw3)) && await mc('boss@example.com') === 1, s3.out().slice(-400));
    await stop(); const s4 = await start({ SUPER_ADMIN_EMAIL: 'boss@example.com' });
    check('…and not again on the next deploy', /already set up/.test(s4.out()) && (await q("SELECT count(*)::int n FROM notifications WHERE recipient='boss@example.com'"))[0].n === 1 && !!(await login('boss@example.com', pw3))); }
  // the built-in owner (OWNER_EMAIL; in production the code's default): always an active super admin, temp password emailed and logged
  { await stop(); const so = await start({ OWNER_EMAIL: 'owner@smru.example.com' });
    const opw = so.out().match(/owner@smru.example.com: created;.*Temporary password: (\S+)/)?.[1];
    const inv = await q("SELECT 1 FROM notifications WHERE recipient='owner@smru.example.com' AND template_key='invite'");
    check('the built-in owner is created as super admin; the temporary password is emailed and in the server log', !!opw && inv.length === 1 && !!(await login('owner@smru.example.com', opw)), so.out().slice(-300));
    await q("UPDATE users SET role='provider', tenant_id=(SELECT id FROM tenants LIMIT 1) WHERE email='owner@smru.example.com'");
    await login('owner@smru.example.com', opw);
    check('the owner signs in as super admin even if someone changed their role', (await q("SELECT role, tenant_id FROM users WHERE email='owner@smru.example.com'"))[0].role === 'super_admin');
    // the owner has chosen their own password, and is (say) a campus admin when the deploy names them owner
    const otk = await login('owner@smru.example.com', opw); await ok('(the owner chooses their own password)', '/me/password', { token: otk, method: 'POST', body: { current: opw, password: 'Owner#Own2026' } });
    const mailsTo = async () => (await q("SELECT count(*)::int n FROM notifications WHERE recipient='owner@smru.example.com'"))[0].n, before = await mailsTo();
    await q("UPDATE users SET role='tenant_admin', tenant_id=(SELECT id FROM tenants LIMIT 1) WHERE email='owner@smru.example.com'");
    await stop(); const so1 = await start({ OWNER_EMAIL: 'owner@smru.example.com' });
    check('an existing campus admin with the owner email, who chose their own password, is made super admin on deploy: password unchanged, no email', /owner@smru.example.com: made super admin \(was tenant_admin\); password unchanged/.test(so1.out())
      && (await q("SELECT role, tenant_id FROM users WHERE email='owner@smru.example.com'"))[0].role === 'super_admin' && !!(await login('owner@smru.example.com', 'Owner#Own2026')) && await mailsTo() === before, so1.out().slice(-300));
    await stop(); const so2 = await start({ OWNER_EMAIL: 'owner@smru.example.com' });
    check('next deploy: already set up, no second email', /owner@smru.example.com: already set up/.test(so2.out()) && await mailsTo() === before);
    // …but a password somebody else issued (an account an admin created or reset, that never chose its own) is not trusted with every campus
    const oid = (await q("SELECT id FROM users WHERE email='owner@smru.example.com'"))[0].id, anyTeam = (await q('SELECT id, tenant_id FROM services WHERE is_active=1 LIMIT 1'))[0];
    await q("UPDATE users SET role='provider', tenant_id=?, must_change_pw=1 WHERE id=?", anyTeam.tenant_id, oid);
    await q('INSERT INTO service_members (id, tenant_id, service_id, user_id, created_at) VALUES (?, ?, ?, ?, ?)', 'own-team-row', anyTeam.tenant_id, anyTeam.id, oid, new Date().toISOString());
    await stop(); const so3 = await start({ OWNER_EMAIL: 'owner@smru.example.com' });
    check('an account with the owner email whose password an admin issued gets a fresh temporary password by email: whoever issued the old one cannot sign in as super admin', /owner@smru.example.com: temporary password set/.test(so3.out())
      && !(await login('owner@smru.example.com', 'Owner#Own2026')) && await mailsTo() === before + 1 && (await q("SELECT role FROM users WHERE id=?", oid))[0].role === 'super_admin', so3.out().slice(-300));
    check('…and it leaves its teams: a super admin belongs to no campus', (await q('SELECT count(*)::int n FROM service_members WHERE user_id=?', oid))[0].n === 0); }
  await stop(); let s2 = await start({ SUPER_ADMIN_EMAIL: 'second@example.com', SUPER_ADMIN_PASSWORD: 'SecondAdmin#2026' });
  let t2 = await login('second@example.com', 'SecondAdmin#2026');
  check('a new email in SUPER_ADMIN_* becomes another super admin, with a temporary password', /second@example.com: created/.test(s2.out()) && !!t2 && await mustChange('second@example.com') === 1 && !!(await login(SUPER.email, SUPER.password)));
  check('their sign-in details are emailed: welcome with the temporary password', (await q("SELECT body FROM notifications WHERE template_key='invite' AND recipient='second@example.com'"))[0]?.body.includes('SecondAdmin#2026'));
  check('the app says they must choose a new password', (await api('/me', { token: t2 })).data.user.must_change_pw === 1);
  await ok('first sign-in: they choose their own password', '/me/password', { token: t2, method: 'POST', body: { current: 'SecondAdmin#2026', password: 'MyOwnChoice2026' } });
  await stop(); s2 = await start({ SUPER_ADMIN_EMAIL: 'second@example.com', SUPER_ADMIN_PASSWORD: 'SecondAdmin#2026' });
  check('the same lines on later starts never undo the chosen password', !/SUPER_ADMIN_\*/.test(s2.out()) && !!(await login('second@example.com', 'MyOwnChoice2026')) && !(await login('second@example.com', 'SecondAdmin#2026')) && await mustChange('second@example.com') === 0);
  await stop(); s2 = await start({ SUPER_ADMIN_EMAIL: 'second@example.com', SUPER_ADMIN_PASSWORD: 'Forgotten#Reset1' });
  check('a reset is emailed too, with the new temporary password', (await q("SELECT body FROM notifications WHERE template_key='password_reset' AND recipient='second@example.com'"))[0]?.body.includes('Forgotten#Reset1'));
  check('a changed SUPER_ADMIN_PASSWORD is a reset: temporary again, others untouched', /temporary password set/.test(s2.out()) && !!(await login('second@example.com', 'Forgotten#Reset1')) && await mustChange('second@example.com') === 1 && !!(await login(SUPER.email, SUPER.password)));
  // a template saved before the joined timeline existed gets the block once; a later edit by the admin is left alone
  const tplBefore = (await q("SELECT value FROM app_settings WHERE key='mail_templates'"))[0]?.value;
  await run("INSERT INTO app_settings (key, value) VALUES ('mail_templates', ?) ON CONFLICT (key) DO UPDATE SET value=excluded.value", JSON.stringify({ status_in_progress: { subject: '[{{ticket_no}}] Started', body: 'Hi {{requestor_name}},\nWe started.\n{{ticket_details}}' }, status_rejected: { subject: '[{{ticket_no}}] No', body: 'Sorry.' }, note: { subject: 'x', body: 'Plain note.' } }));
  await run("DELETE FROM app_settings WHERE key='migr_timeline_v1'");
  await stop(); const sm = await start({ FOOD_REPORT_KEY: 'food-report-key-0123456789' });
  const tpl = async () => JSON.parse((await q("SELECT value FROM app_settings WHERE key='mail_templates'"))[0].value);
  check('saved templates get “Latest updates” once (before the ticket details, or at the end); others are untouched', (await tpl()).status_in_progress.body === 'Hi {{requestor_name}},\nWe started.\n{{timeline}}\n{{ticket_details}}' && (await tpl()).status_rejected.body === 'Sorry.\n{{timeline}}' && (await tpl()).note.body === 'Plain note.' && /added to 2 saved email templates/.test(sm.out()), JSON.stringify(await tpl()));
  await run("UPDATE app_settings SET value=? WHERE key='mail_templates'", JSON.stringify({ status_rejected: { subject: '[{{ticket_no}}] No', body: 'Sorry, no timeline here.' },
    transferred_requestor: { subject: 'Moved', body: 'Hi {{requestor_name}},\nMoved.\n{{note}}\n{{progress}}' }, reminder: { subject: '[{{ticket_no}}] Reminder: {{note}}', body: 'Hi,\n{{note}}\n{{progress}}\n[[Open the ticket|{{staff_link}}]]' },
    status_closed: { subject: 'Closed', body: 'Hi,\nDone.\n> {{note}}\nStill not fixed? You can ask to reopen it within {{reopen_days}} days.\n{{progress}}' }, note: { subject: 'x', body: 'My own wording.\n{{note}}' } }));
  // …a ticket several people reported (one key for all of them, in all their old emails), and two people who had become one record through a shared phone number
  const shared = (await q("SELECT t.id, t.tracking_token FROM tickets t WHERE EXISTS (SELECT 1 FROM ticket_requestors x WHERE x.ticket_id=t.id AND x.is_first=0) LIMIT 1"))[0];
  const alone = (await q("SELECT t.id, t.tracking_token, t.requestor_id, tr.contact FROM tickets t JOIN ticket_requestors tr ON tr.ticket_id=t.id AND tr.is_first=1 WHERE NOT EXISTS (SELECT 1 FROM ticket_requestors x WHERE x.ticket_id=t.id AND x.is_first=0) AND tr.contact LIKE '%@%' ORDER BY t.created_at LIMIT 1"))[0];
  await run("UPDATE requestors SET name='Took Over', email='took.over@example.com' WHERE id=?", alone.requestor_id);
  await run("DELETE FROM app_settings WHERE key IN ('migr_keys_v1','migr_requestors_v1','migr_mailtext_v2')");
  await stop(); const sk = await start({ FOOD_REPORT_KEY: 'food-report-key-0123456789' });
  check('…and never again: an admin who takes the block out keeps it out', (await tpl()).status_rejected.body === 'Sorry, no timeline here.');
  const tw = await tpl();
  check('saved templates get the wording fixes once: the note in its box, the reminder’s note out of the subject, the reopen offer once; an admin’s own lines are left alone', tw.transferred_requestor.body === 'Hi {{requestor_name}},\nMoved.\n> {{note}}\n{{progress}}'
    && tw.reminder.subject === '[{{ticket_no}}] Reminder: {{subject}}' && tw.reminder.body.includes('Status: {{status}}') && !tw.reminder.body.includes('{{progress}}') && !tw.status_closed.body.includes('Still not fixed') && tw.note.body === 'My own wording.\n{{note}}', JSON.stringify(tw));
  const shared2 = (await q('SELECT tracking_token FROM tickets WHERE id=?', shared.id))[0], alone2 = (await q('SELECT t.tracking_token, r.email, r.id FROM tickets t JOIN requestors r ON r.id=t.requestor_id WHERE t.id=?', alone.id))[0];
  check('a ticket several people reported gets a new key once (old emails then lead each person to their own page); other tickets keep theirs', shared2.tracking_token !== shared.tracking_token && alone2.tracking_token === alone.tracking_token && /New keys for \d+ ticket/.test(sk.out()), sk.out().slice(-400));
  check('a ticket whose requester record had been taken over through a shared phone number goes back to the person who raised it', alone2.email === alone.contact.toLowerCase() && alone2.id !== alone.requestor_id && /given back to the record/.test(sk.out()), JSON.stringify(alone2));
  if (tplBefore === undefined) await run("DELETE FROM app_settings WHERE key='mail_templates'"); else await run("UPDATE app_settings SET value=? WHERE key='mail_templates'", tplBefore);
  await stop(); await start({ FOOD_REPORT_KEY: 'food-report-key-0123456789' });

  // ======================= H. UI smoke test =======================
  await uiSmoke({ pavan: T.pavan, asha: T.asha, sa: T.sa }, { t1: ids.t1, alpha: ids.alpha, beta: ids.beta, k1: (await q("SELECT tracking_token k FROM tickets WHERE ticket_no='0001' AND tenant_id=?", ids.alpha))[0].k });
} catch (e) {
  failed++; failures.push(`${section}: test crashed — ${e.stack || e}`); console.error('\nTest crashed:', e);
} finally {
  await stop(); flowServer.close(); fs.rmSync(TMP, { recursive: true, force: true });
  await testDb.end(); await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME}`); await admin.end();
}
console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) console.log('Failures:\n  ' + failures.join('\n  '));
process.exit(failed ? 1 : 0);

// ---------- screens in headless Chrome ----------
async function uiSmoke(tok, id) {
  const CHROME = process.env.CHROME || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium'].find(p => fs.existsSync(p));
  if (!CHROME) { console.log('\n== UI smoke test skipped (no Chrome found; set CHROME=/path/to/chrome)'); return; }
  sec('Screens in headless Chrome');
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'onedesk-ui-')), port = 9350 + Math.floor(Math.random() * 100);
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, '--no-first-run', '--no-default-browser-check', '--mute-audio', 'about:blank'], { stdio: 'ignore' });
  try {
    let page; for (let i = 0; i < 50 && !page; i++) { await sleep(200); try { page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => t.type === 'page'); } catch { /* starting */ } }
    if (!page) { check('Chrome started', false, 'debugging port not reachable'); return; }
    const ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
    let seq = 0; const pend = new Map(), errors = [];
    ws.onmessage = e => { const m = JSON.parse(e.data);
      if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
      else if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
      else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map(a => a.value || a.description).join(' ')); };
    const send = (method, params = {}) => new Promise((res, rej) => { const i = ++seq; pend.set(i, m => m.error ? rej(new Error(m.error.message)) : res(m.result)); ws.send(JSON.stringify({ id: i, method, params })); });
    const js = async src => (await send('Runtime.evaluate', { expression: `(async()=>{${src}})()`, awaitPromise: true, returnByValue: true })).result.value;
    await send('Page.enable'); await send('Page.addScriptToEvaluateOnNewDocument', { source: FAKE_TTS }); // the guide's voice is the stand-in
    await send('Page.enable'); await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: APP + '/' }); await sleep(600);
    const pwa = await js(`const sw = await Promise.race([navigator.serviceWorker.ready.then(r => !!r.active), new Promise(z => setTimeout(() => z(false), 6000))]);
      const m = await (await fetch('manifest.webmanifest')).json(); return { sw, name: m.short_name, display: m.display, icons: m.icons.length };`);
    check('installable app: service worker active, manifest with icons', pwa.sw && pwa.name === 'ONE Desk' && pwa.display === 'standalone' && pwa.icons >= 2, JSON.stringify(pwa));
    await send('Network.enable'); await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await send('Page.navigate', { url: APP + '/' }); await sleep(1200);
    check('app opens without a connection (from the offline cache)', await js(`return document.title === 'ONE Desk' && !!document.querySelector('#app')`));
    await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    const visit = async (name, route, token, probe) => {
      await js(`localStorage.clear(); sessionStorage.clear(); ${token ? `localStorage.setItem('tok', ${JSON.stringify(token)});` : ''}`);
      errors.length = 0;
      await send('Page.navigate', { url: `${APP}/?t=${Date.now()}#${route}` });
      let found = false; // wait for the screen to render (up to 6 s), then give late script errors a moment to arrive
      for (let i = 0; i < 24 && !found; i++) { await sleep(250); found = await js(`return !!document.querySelector(${JSON.stringify(probe)});`).catch(() => false); }
      await sleep(400);
      const tags = found ? await js(`return (document.body.innerText.match(/\\((optional|required)\\)/gi) || []).join(' ')`) : '';
      check(`${name}`, found && !errors.length && !tags, !found ? `missing ${probe}` : tags ? `shows ${tags}` : errors.join(' | ').slice(0, 200));
    };
    await visit('campus picker', '/', null, 'a.svc');
    await visit('campus intro, with the first-visit guide card', '/d/alpha', null, '.guidecard a[href="guide/requestor.html"]');
    await visit('service list', '/d/alpha/raise', null, 'a.svc[href*="ELEC"]');
    await visit('raise form (location type)', '/d/alpha/raise/ELEC', null, '#f [name=fd_loc_block]');
    check('other teams open straight into the problem form: no suggestion choice (that is Food only)', await js(`return !document.querySelector('.kindcard') && !document.querySelector('.kindsw:not([hidden])') && !/suggestion/i.test(document.querySelector('.wrap').innerText.replace(/\\s+/g, ' ').split('Your name')[0]) && /Raise ticket/.test(document.querySelector('#raiseBtn').textContent)`));
    await visit('raise form (student type)', '/d/alpha/raise/EXAM', null, '#f [name=fd_stu_id]');
    await visit('track page', '/d/alpha/track', null, '#f [name=no]');
    await visit('requestor ticket page (from the link in their email)', `/d/alpha/t/0001?k=${id.k1}`, null, '.stamps li');
    await visit('a ticket link without its key shows where the ticket stands, the number already filled in', '/d/alpha/t/0001', null, '#trres .stub');
    check('…nothing anybody typed is on that screen', await js(`const t = document.querySelector('#trres').textContent; return /Electrical/.test(t) && !/Ria|Room 214|Ticket from/.test(t) && document.querySelector('#trno').value === '0001';`));
    check('…and typing the email on the ticket sends the link there (the ticket does not open from the number and an email)', await js(`document.querySelector('#trem').value = 'r1@example.com'; document.querySelector('#f button').click();
      for (let i = 0; i < 30 && !/Check your email/.test(document.querySelector('#trres')?.textContent || ''); i++) await new Promise(r => setTimeout(r, 150));
      return /Check your email/.test(document.querySelector('#trres').textContent) && !/[?&]k=/.test(location.hash) && !document.querySelector('.stamps li');`));
    await visit('staff login', '/login', null, '#f [name=password]');
    await visit('provider home with ticket cards', '/c', tok.pavan, '.tcard');
    check('staff screens offer no guide card (the guide is for requestors)', !(await js("return !!document.querySelector('.guidecard')")));
    await visit('provider ticket workspace', '/c/t/' + id.t1, tok.pavan, '#act #to');
    await visit('new ticket form', '/c/new', tok.pavan, '#f [name=channel]');
    await visit('provider profile', '/c/me', tok.pavan, '.profile');
    await visit('admin services', '/c/services', tok.asha, 'div.svc [data-e]');
    await visit('admin people', '/c/users', tok.asha, '.trow .uact');
    await visit('admin SLA & points', '/c/sla', tok.asha, '#sf [name=esc_days]');
    await visit('admin attention', '/c/attention', tok.asha, '#main .attp .att');
    await visit('admin reports', '/c/reports', tok.asha, '.kpi2');
    await visit('admin audit', '/c/audit', tok.asha, '#main table');
    await visit('super admin email page', '/c/email', tok.sa, '#cf [name=url]');
    await visit('campus admin: the Email page has the morning brief card and its “send now” button', '/c/email', tok.asha, '#briefNow');
    // a staff link from an email (it carries the campus) opens the ticket for a super admin who had another campus selected
    await js(`localStorage.clear(); sessionStorage.clear(); localStorage.setItem('tok', ${JSON.stringify(tok.sa)}); localStorage.setItem('tid', ${JSON.stringify(id.beta)});`);
    await send('Page.navigate', { url: `${APP}/?t=${Date.now()}#/c/t/${id.t1}?c=${id.alpha}` });
    let opened = false; for (let i = 0; i < 24 && !opened; i++) { await sleep(250); opened = await js(`return !!document.querySelector('#act #to') && localStorage.getItem('tid') === ${JSON.stringify(id.alpha)};`).catch(() => false); }
    check('a super admin with another campus selected: the ticket link from an email switches to the ticket’s campus and opens it', opened);
    await visit('super admin tenants', '/c/tenants', tok.sa, '#main table');
    // the guide inside the app: Voice on/off, a close button back to the app, and Start opens step 1 with room around the outline
    errors.length = 0; await send('Page.navigate', { url: `${APP}/guide/requestor.html` });
    let gok = false; for (let i = 0; i < 24 && !gok; i++) { await sleep(250); gok = await js(`return !!document.querySelector('.card[data-id="start"] [data-voice="on"]') && !!document.querySelector('a.closeg[href="../"]');`).catch(() => false); }
    const g1 = gok && await js(`document.querySelector('[data-voice="off"]').click(); document.querySelector('.card[data-id="start"] .big').click(); await new Promise(r => setTimeout(r, 700));
      const c = document.querySelector('.card[data-id="open"]'), h = c.querySelector('.hl'), img = c.querySelector('.frame img').getBoundingClientRect(), b = h.getBoundingClientRect();
      const shot = { shown: !c.hidden, on: h.classList.contains('on'), roomy: b.height > img.height * 0.22 + 8 };
      return shot;`);
    check('guide in the app opens; Start shows step 1 with the outline clear of the words', gok && g1?.shown && g1.on && g1.roomy && !errors.length, JSON.stringify(g1) + errors.join(' | ').slice(0, 200));
    // every kind of email button, opened the way Gmail opens it: the address travels encoded in a redirect link
    const mails = await q('SELECT recipient, html FROM notifications'), hrefsOf = h => [...String(h || '').matchAll(/href="([^"]+)"/g)].map(m => m[1].replace(/&amp;/g, '&'));
    const hrefs = [...new Set(mails.flatMap(n => hrefsOf(n.html)))], big = Math.max(...mails.map(n => String(n.html || '').length));
    const ours = h => h.startsWith(APP + '/') || h === 'https://claude.ai/artifact/XwZ2wYi78wQ7t8PcCMpHhv'; // the provider guide is a shared claude.ai page
    check('every link in every email is a full address of this site (or the provider guide)', hrefs.length > 0 && hrefs.every(ours), hrefs.filter(h => !ours(h)).slice(0, 3).join(' '));
    check("every email stays under Gmail's 102 KB clipping limit", big < 100000, big);
    const find = re => hrefs.find(h => re.test(h)), mine = mails.filter(n => n.recipient === 'pavan@example.com').flatMap(n => hrefsOf(n.html)).find(h => /#\/c\/t\//.test(h));
    const open = async (href, probe, token) => { await js(`localStorage.clear(); sessionStorage.clear(); ${token ? `localStorage.setItem('tok', ${JSON.stringify(token)});` : ''}`);
      errors.length = 0; await send('Page.navigate', { url: GMAIL(href) });
      for (let i = 0; i < 24; i++) { await sleep(250); if (await js(`return !!document.querySelector(${JSON.stringify(probe)});`).catch(() => false)) return !errors.length; }
      return false; };
    // links of the active campus (the other one is switched off earlier, so its links rightly stop opening)
    const tk = find(/#\/d\/alpha\/t\/[^?]+\?k=/), pt = find(/#\/d\/alpha$/), gd = find(/\/guide\/\w+\.html$/), lg = find(/#\/login$/);
    check('Gmail click: "View your ticket" opens the requestor\'s ticket', !!tk && await open(tk, '.stamps li'), tk);
    check('Gmail click: "Raise a new ticket" opens the campus page', !!pt && await open(pt, 'a.svc[href*="raise"]'), pt);
    check('Gmail click: the guide button opens the guide', !!gd && await open(gd, '.card[data-id="start"]'), gd);
    check('Gmail click: "Sign in" opens sign-in, or the desk when already signed in', !!lg && await open(lg, '#f [name=password]') && await open(lg, '.home .greet', tok.pavan), lg);
    check('Gmail click: "Open the ticket" opens it for a signed-in provider', !!mine && await open(mine, '#act #to', tok.pavan), mine);
    const via = !!mine && await open(mine, '#f [name=password]') && await js(`const f = document.querySelector('#f'); f.email.value = 'pavan@example.com'; f.password.value = 'Pavan2026ok'; f.requestSubmit();
      for (let i = 0; i < 40 && !document.querySelector('#act #to'); i++) await new Promise(r => setTimeout(r, 150));
      return !!document.querySelector('#act #to') && location.hash === ${JSON.stringify(mine.slice(mine.indexOf('#')))};`);
    check('Gmail click: "Open the ticket" when signed out → sign in → that ticket, not Home', via, mine);
    // the guide talks by itself in English, in step with the screens (?tts=ok = arriving from the app with a tap)
    await js('localStorage.clear(); sessionStorage.clear();'); errors.length = 0;
    await send('Page.navigate', { url: `${APP}/guide/requestor.html?tts=ok` });
    let talk = null; for (let i = 0; i < 60 && !talk?.done; i++) { await sleep(250); talk = await js(`const s = window.__said || [];
      return { first: s[0]?.t, openSubs: s.filter(x => x.at === '#open').map(x => x.sub), open: [...document.querySelectorAll('.card[data-id="open"] [data-line]')].map(b => b.textContent),
        cards: [...new Set(s.map(x => x.at))].length, list: [...new Set(s.map(x => x.at))].join(' '), done: s.at(-1)?.at === '#done' && !speechSynthesis.speaking };`).catch(() => null); }
    check('the guide starts talking on its own: the opening line, then step 1', /^Raise and track a ticket\./.test(talk?.first || '') && talk.openSubs.length === talk.open.length, JSON.stringify(talk)?.slice(0, 300));
    check('each sentence is read while its own line shows; the steps move on with the voice to the end', !!talk?.done && JSON.stringify(talk.openSubs) === JSON.stringify(talk.open) && talk.cards >= 15 && !errors.length,
      JSON.stringify({ list: talk?.list, done: talk?.done, cards: talk?.cards, subs: talk?.openSubs?.length, lines: talk?.open?.length, same: JSON.stringify(talk?.openSubs) === JSON.stringify(talk?.open), errors }).slice(0, 400));
    // in Telugu: a Telugu voice reads the Telugu text, its English words said the Telugu way (Tenglish), in step line by line
    await js("localStorage.clear(); localStorage.setItem('guide-lang', 'te');"); errors.length = 0;
    await send('Page.navigate', { url: `${APP}/guide/requestor.html?tts=ok` });
    let te = null; for (let i = 0; i < 60 && !te?.done; i++) { await sleep(250); te = await js(`const s = window.__said || [];
      return { first: s[0]?.t, open: s.filter(x => x.at === '#open'), lines: [...document.querySelectorAll('.card[data-id="open"] [data-line]')].map(b => b.textContent),
        done: s.at(-1)?.at === '#done' && !speechSynthesis.speaking };`).catch(() => null); }
    const latin = (te?.open || []).filter(x => /[A-Za-z]/.test(x.t));
    check('in Telugu the guide talks in Telugu, its English words said the Telugu way', !!te?.done && /[\u0C00-\u0C7F]/.test(te.first || '') && te.open.length === te.lines.length
      && !latin.length && te.open.some(x => x.t.includes('వన్ డెస్క్')), JSON.stringify({ first: te?.first, latin: latin.map(x => x.t).slice(0, 2) }));
    check('each Telugu sentence is read while its own line shows', !!te && JSON.stringify(te.open.map(x => x.sub)) === JSON.stringify(te.lines) && !errors.length, JSON.stringify(te?.open?.map(x => x.sub))?.slice(0, 200));
    // a phone without a Telugu voice: a note says how to add one (or listen in English), and nothing is read
    await send('Page.navigate', { url: `${APP}/guide/requestor.html?tts=ok&te=none` }); await sleep(2500);
    const nov = await js(`const r = { note: document.querySelector('.vnote')?.textContent || '', said: window.__said.length, listen: !document.querySelector('#listen').hidden };
      localStorage.removeItem('guide-lang'); return r;`);
    check('no Telugu voice on the phone: a note explains, and nothing is read', /తెలుగు వాయిస్ లేదు/.test(nov.note) && nov.said === 0 && nov.listen, JSON.stringify(nov));
    // where sound needs a tap first (iPhone, a page opened from an email): the guide waits, and one tap starts the voice
    await send('Page.navigate', { url: `${APP}/guide/requestor.html` }); await sleep(3200);
    const wait1 = await js(`const t = document.querySelector('#tapvoice'); return { pill: !!t && !t.hidden, said: window.__said.length, at: location.hash };`);
    const [px, py] = await js(`const r = document.querySelector('#tapvoice').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2];`);
    for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: px, y: py, button: 'left', clickCount: 1 });
    await sleep(700);
    const wait2 = await js(`return { pill: !document.querySelector('#tapvoice').hidden, said: window.__said.length };`);
    check('if sound needs a tap first: a "Tap to hear the guide" button, and the guide waits', wait1.pill && wait1.said === 0 && wait1.at === '#start', JSON.stringify(wait1));
    check('one tap on it starts the voice', !wait2.pill && wait2.said > 0, JSON.stringify(wait2));
    await send('Page.navigate', { url: `${APP}/guide/` }); let gi = false;
    for (let i = 0; i < 20 && !gi; i++) { await sleep(250); gi = await js(`return location.pathname.endsWith('/guide/requestor.html') && !!document.querySelector('.card[data-id="start"]');`).catch(() => false); }
    check('/guide/ opens the requestor guide', gi);
    // the bot window: on the campus page, a tap on a quick choice gets an answer
    await visit('campus page with the bot button', '/d/alpha', null, '#botbtn');
    const chat = await js(`document.querySelector('#botbtn').click();
      for (let i = 0; i < 20 && !document.querySelector('.bchips [data-q]'); i++) await new Promise(r => setTimeout(r, 150));
      document.querySelector('.bchips [data-q="How to raise a ticket"]').click();
      for (let i = 0; i < 20 && !/To raise a ticket/.test(document.querySelector('#botlog').textContent); i++) await new Promise(r => setTimeout(r, 150));
      return { open: !document.querySelector('#botp').hidden, answered: /To raise a ticket/.test(document.querySelector('#botlog').textContent) };`);
    check('the bot opens and answers a quick choice', chat.open && chat.answered, JSON.stringify(chat));
    await visit('staff desk with the bot', '/c', tok.pavan, '#botbtn');
    check('staff get their own bot (queue questions)', await js(`document.querySelector('#botbtn').click();
      for (let i = 0; i < 20 && !document.querySelector('.bchips [data-q]'); i++) await new Promise(r => setTimeout(r, 150));
      return !!document.querySelector('.bchips [data-q="Overdue"]');`));
    // a merged ticket: the requestor sees the known-issue note; the provider sees every requestor
    const mt = (await q("SELECT id, ticket_no, affected_count, tracking_token FROM tickets WHERE location_key='hostel block:203' AND problem_key='fan'"))[0];
    await visit('requestor ticket page of a merged ticket', `/d/alpha/t/${mt.ticket_no}?k=${mt.tracking_token}`, null, '.stamps li');
    check('it says how many others reported it', await js(`return /Known issue: ${mt.affected_count - 1} others reported this too/.test(document.querySelector('.knownissue')?.textContent || '')`));
    await visit('provider workspace of a merged ticket', '/c/t/' + mt.id, tok.pavan, '#act #to');
    check('the provider sees every requestor, and a "close earlier" choice when closing', await js(`document.querySelector('#to').value = 'closed'; document.querySelector('#to').dispatchEvent(new Event('change'));
      return document.querySelectorAll('.rqrow').length === ${mt.affected_count} && !document.querySelector('#earlyrow').hidden;`));
    // photos: a converted HEIC shows as a picture on the ticket page; photos picked in the form are shrunk on the phone
    const ht = (await q("SELECT t.ticket_no, t.tracking_token FROM tickets t JOIN attachments a ON a.ticket_id=t.id WHERE a.file_name='IMG20261029145618.jpg'"))[0];
    await visit('requestor ticket page with photos', `/d/alpha/t/${ht.ticket_no}?k=${ht.tracking_token}`, null, '.thumbs img');
    await sleep(500);
    check('photos show as pictures on the ticket (no broken images)', await js(`const i = [...document.querySelectorAll('.thumbs img')]; return i.length >= 2 && i.every(x => x.complete && x.naturalWidth > 0) && !document.querySelector('.thumbs .fchip');`));
    const bigW = 3000, bigH = 2250, pix = Buffer.alloc(bigW * bigH * 4);
    for (let i = 0; i < pix.length; i += 4) { const n = (i * 2654435761) >>> 24; pix[i] = n; pix[i + 1] = (n * 7) & 255; pix[i + 2] = (n * 13) & 255; pix[i + 3] = 255; }
    const bigFile = path.join(TMP, 'phone-photo.jpg'); fs.writeFileSync(bigFile, jpeg.encode({ data: pix, width: bigW, height: bigH }, 92).data);
    // food screens
    await visit('food: the service list says "Rate meals or report a problem"', '/d/alpha/raise', null, 'a.svc[href*="FOODX"]');
    check('food card subtitle', await js(`return /Rate meals or report a problem/.test(document.querySelector('a.svc[href*="FOODX"]').textContent)`));
    await visit('food: one screen with two stacked cards', '/d/alpha/raise/FOODX', null, '.foodkind');
    check('"Feedback / suggestion" first and open (its form below), "Report a complaint" stacked under it', await js(`const c = [...document.querySelectorAll('.foodkind label')];
      return c.length === 2 && /Share feedback/.test(c[0].textContent) && /Report a problem/.test(c[1].textContent) && c[1].getBoundingClientRect().top > c[0].getBoundingClientRect().bottom - 1
        && document.querySelector('[name=fkind]:checked').value === 'rate' && !!document.querySelector('#f .stars')`));
    check('tapping Report a complaint opens the complaint form on the same screen', await js(`document.querySelector('[name=fkind][value=report]').click(); await new Promise(r => setTimeout(r, 1500));
      return !!document.querySelector('#f .fcats') && document.querySelector('[name=fkind]:checked').value === 'report' && /optional/i.test(document.querySelector('#f').textContent)`));
    await visit('food: rate your meal', '/d/alpha/raise/FOODX?flow=rate', null, '.stars');
    check('the meal defaults to the one by the time of day', await js(`const m = await import('/shared.js'); const f = await (await fetch('/api/public/alpha/food')).json();
      const hm = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
      return document.querySelector('#fmeal').value === f.data.meal_now && document.querySelector('[name=dayk]:checked').value === f.data.day_now`));
    await visit('food: report a serious problem', '/d/alpha/raise/FOODX?flow=report', null, '.fcats');
    check('"Something else" shows the feedback-instead hint with Switch to feedback, carrying the text', await js(`const f = document.querySelector('#f'); const hidden = document.querySelector('#else').hidden;
      f.querySelector('[name=category][value=other]').click(); f.description.value = 'Too salty today';
      const shown = !document.querySelector('#else').hidden; document.querySelector('#toRate').click(); await new Promise(r => setTimeout(r, 1200));
      return hidden && shown && document.querySelector('[name=fkind]:checked')?.value === 'rate' && !!document.querySelector('#f .stars') && document.querySelector('[name=comment]').value === 'Too salty today'`));
    const foodPng = path.join(TMP, 'food.png'); fs.writeFileSync(foodPng, Buffer.from(PNG.split(',')[1], 'base64'));
    await visit('food: Report a complaint form', '/d/alpha/raise/FOODX?flow=report', null, '.fcats');
    { const { root: r0 } = await send('DOM.getDocument'), { nodeId: n0 } = await send('DOM.querySelector', { nodeId: r0.nodeId, selector: 'input.f-food[data-source="gallery"]' });
      await send('DOM.setFileInputFiles', { nodeId: n0, files: [foodPng] }); }
    check('Report a complaint raises a ticket straight away (same flow as other services, no "send as feedback" detour)', await js(`const f = document.querySelector('#f');
      f.location_id.value = f.location_id.options[1].value; f.querySelector('[name=category][value=spoiled]').click(); f.description.value = 'Curd smelled bad ticket';
      f.name.value = 'Ui ticket'; f.email.value = 'ui-ticket@food.example.com'; f.phone.value = '9000055555';
      f.querySelector('button.primary').click(); await new Promise(r => setTimeout(r, 2500));
      return !document.querySelector('dialog.sheet') && document.querySelector('h1').textContent === 'Ticket raised' && !!document.querySelector('.stub .no')`));
    check('the complaint is a ticket', (await q("SELECT count(*)::int n FROM tickets WHERE description LIKE 'Curd smelled bad%'"))[0].n === 1);
    await visit('kitchen dashboard: Feedback & Scores', '/c/food', tok.pavan, '.fsplit .fov');
    check('dashboard: overall + one card per meal, complaints apart, line chart, bars, and the Complaints tab', await js(`const ok = document.querySelectorAll('.fsplit .fmeal').length >= 3 && !!document.querySelector('.fcomp .fc-n') && !!document.querySelector('svg.fchart polyline') && document.querySelectorAll('.hbar').length >= 4;
      document.querySelector('.fmeal[data-meal]').click(); await new Promise(r => setTimeout(r, 1500)); const mv = !!document.querySelector('.mv-h') && !!document.querySelector('.mv-sum .sdist') && document.querySelectorAll('.mv-row').length >= 1;
      document.querySelector('#mvb').click(); await new Promise(r => setTimeout(r, 1500)); const backOk = !!document.querySelector('.fsplit');
      document.querySelector('[data-t=complaints]').click(); await new Promise(r => setTimeout(r, 1500)); return ok && mv && backOk && document.querySelectorAll('.tcard').length >= 1`));
    await visit('admin: food settings', '/c/food', tok.asha, '.fsplit');
    check('admin edits the feedback tags: add, remove, reorder, save; the form shows them', await js(`document.querySelector('[data-t=settings]').click(); await new Promise(r => setTimeout(r, 1500));
      const before = [...document.querySelectorAll('#tags .tagc')].map(x => x.dataset.tag);
      document.querySelector('#tagnew').value = 'Too spicy'; document.querySelector('#tagaddb').click();
      document.querySelector('#tags .tagc [data-x]').click(); // remove the first
      const last = [...document.querySelectorAll('#tags .tagc')].at(-1); last.querySelector('[data-l]').click(); // Too spicy one step left
      const want = [...document.querySelectorAll('#tags .tagc')].map(x => x.dataset.tag);
      document.querySelector('#fset button.primary').click(); await new Promise(r => setTimeout(r, 1500));
      const got = (await (await fetch('/api/public/alpha/food')).json()).data.chips;
      await fetch('/api/food/settings', { method: 'PUT', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + localStorage.getItem('tok') }, body: JSON.stringify({ chips: before }) });
      return before.length > 2 && want.includes('Too spicy') && !want.includes(before[0]) && want.at(-2) === 'Too spicy' && JSON.stringify(got) === JSON.stringify(want)`));
    await visit('raise form for photo upload', '/d/alpha/raise/ELEC', null, '#f [name=fd_loc_block]');
    const { root } = await send('DOM.getDocument'), { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input.f-raise[data-source="gallery"]' });
    await send('DOM.setFileInputFiles', { nodeId, files: [bigFile, HEIC_FILE] });
    await js(`const f = document.querySelector('#f');
      for (let pass = 0; pass < 2; pass++) for (const el of f.querySelectorAll('input[required], select[required], textarea[required]')) {
        if (el.offsetParent === null || el.type === 'file') continue;
        if (el.tagName === 'SELECT') { if (!el.value) { el.value = [...el.options].find(o => o.value && !/^other/i.test(o.value))?.value || ''; el.dispatchEvent(new Event('change', { bubbles: true })); } }
        else if (!el.value) el.value = el.type === 'email' ? 'shrink@example.com' : el.name === 'phone' ? '9000077777' : 'Test value';
      }
      f.requestSubmit();`);
    let raised = false; for (let i = 0; i < 60 && !raised; i++) { await sleep(250); raised = await js(`return !!document.querySelector('.stub .no');`).catch(() => false); }
    const up = await q("SELECT a.* FROM attachments a JOIN tickets t ON t.id=a.ticket_id JOIN requestors r ON r.id=t.requestor_id WHERE r.email='shrink@example.com' ORDER BY a.file_name");
    const bigUp = up.find(a => a.file_name === 'phone-photo.jpg'), dims = bigUp && jpeg.decode(fs.readFileSync(path.join(UPLOADS, bigUp.storage_key)), { useTArray: true });
    check(`a ${(fs.statSync(bigFile).size / 1048576).toFixed(1)} MB phone photo goes up shrunk: JPEG, at most 1920 px, under 1.5 MB`, raised && bigUp?.mime_type === 'image/jpeg' && Math.max(dims.width, dims.height) <= 1920 && bigUp.size_bytes < 1.5e6,
      JSON.stringify({ raised, bigUp: bigUp && { size: bigUp.size_bytes, w: dims.width, h: dims.height } }) + errors.join(' | ').slice(0, 200));
    check('a HEIC picked in Chrome goes up as it is and comes back a JPEG', up.some(a => a.file_name === 'photo.jpg' && a.mime_type === 'image/jpeg'), JSON.stringify(up.map(a => [a.file_name, a.mime_type])));
    // notice board: the card on the campus page, and the team's notice before a ticket
    const examId = (await q("SELECT id FROM services WHERE code='EXAM' AND tenant_id=(SELECT id FROM tenants WHERE slug='alpha')"))[0].id;
    const uiN = (await api('/notices', { token: tok.asha, method: 'POST', body: { service_id: examId, title: 'Hall tickets from Monday', body: 'Collect them at the exam cell from Monday.', important: true, status: 'published' } })).data;
    await visit('campus page with the notice board', '/d/alpha', null, '.nboard .ntrow');
    check('the notice board shows the notice, important on top, with its team', await js(`const r = document.querySelector('.nboard .ntrow'); return r.classList.contains('imp') && /Hall tickets from Monday/.test(r.textContent) && /Examination/i.test(r.textContent)`));
    await visit('raising for that team: its notice pops up first', '/d/alpha/raise/EXAM', null, 'dialog.ngate');
    check('the pop-up: the notice, “This answers my question” and “I still need to raise a ticket”', await js(`const d = document.querySelector('dialog.ngate');
      return /Hall tickets from Monday/.test(d.textContent) && !!d.querySelector('[data-a=answered]') && !!d.querySelector('[data-a=raise]') && !document.querySelector('#f')`));
    check('“I still need to raise a ticket” opens the form', await js(`document.querySelector('dialog.ngate [data-a=raise]').click(); await new Promise(r => setTimeout(r, 1500));
      return !document.querySelector('dialog.ngate') && !!document.querySelector('#f [name=fd_stu_id]')`));
    await js(`const f = document.querySelector('#f');
      for (let pass = 0; pass < 2; pass++) for (const el of f.querySelectorAll('input[required], select[required], textarea[required]')) {
        if (el.offsetParent === null || el.type === 'file') continue;
        if (el.tagName === 'SELECT') { if (!el.value) { el.value = [...el.options].find(o => o.value && !/^other/i.test(o.value))?.value || ''; el.dispatchEvent(new Event('change', { bubbles: true })); } }
        else if (!el.value) el.value = el.type === 'email' ? 'notice-ui@example.com' : el.name === 'phone' ? '9000066001' : 'Notice test';
      }
      f.requestSubmit();`);
    let raisedN = false; for (let i = 0; i < 60 && !raisedN; i++) { await sleep(250); raisedN = await js(`return !!document.querySelector('.stub .no');`).catch(() => false); }
    const seenEv = await q("SELECT e.body, e.is_internal FROM ticket_events e JOIN tickets t ON t.id=e.ticket_id JOIN requestors r ON r.id=t.requestor_id WHERE r.email='notice-ui@example.com' AND e.event_type='notice_seen'");
    check('the ticket records that the requester read the notice (staff only), and the notice counts it', raisedN && seenEv.length === 1 && seenEv[0].is_internal === 1 && /Hall tickets from Monday/.test(seenEv[0].body)
      && (await q('SELECT views, raised FROM notices WHERE id=?', uiN.id))[0].raised === 1, JSON.stringify({ raisedN, seenEv }) + errors.join(' | ').slice(0, 200));
    await visit('staff Notices page', '/c/notices', tok.pavan, '#main .tabs');
    check('a provider outside the team sees no notices of that team and can post for their own', await js(`return !/Hall tickets from Monday/.test(document.querySelector('#main').textContent) && !!document.querySelector('#ntNew')`));
    await api('/notices/' + uiN.id, { token: tok.asha, method: 'DELETE' });
    ws.close();
  } finally { chrome.kill(); await sleep(400); fs.rmSync(prof, { recursive: true, force: true }); }
}
