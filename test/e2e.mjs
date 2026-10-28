// End-to-end test. Starts ONE Desk on a throwaway Postgres database (created and dropped here; set TEST_DATABASE_URL
// to a server you can CREATE DATABASE on, default postgres://localhost/postgres) and a temp uploads folder (no email flow connected, so
// nothing is sent), runs every role's flow through the API, then loads each screen in headless Chrome
// when one is installed. Run with: npm test
import { spawn } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import http from 'node:http';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

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
const ENV = { NODE_ENV: 'production', JWT_SECRET: 'e2e-' + 'x'.repeat(40) };
const SUPER = { email: 'super@example.com', password: 'SuperSecret123' };
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- tiny harness ----------
let passed = 0, failed = 0, section = ''; const failures = [];
const sec = s => { section = s; console.log(`\n== ${s}`); };
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(`${section}: ${name}${detail ? ' — ' + detail : ''}`); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
async function api(p, { method = 'GET', body, token, tenant, raw } = {}) {
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
  if (req.headers['x-desk-key'] !== flow.key) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"error":"bad key"}'); }
  flow.received.push(JSON.parse(b)); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); }); });
await new Promise(r => flowServer.listen(0, '127.0.0.1', r));
const FLOW_URL = `http://localhost:${flowServer.address().port}/flow`;

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
  T.sa = await login(SUPER.email, SUPER.password); check('super admin can sign in', !!T.sa);
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
  check('invite emails were queued', (await q("SELECT count(*) n FROM notifications WHERE template_key='invite'"))[0].n === 4);

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
  await fails('more than two providers is rejected', `/services/${elec.id}/members`, { ...A, method: 'PUT', body: { user_ids: [pavan.id, lata.id, asha.id] } }, 400);
  await fails('a provider from another campus is rejected', `/services/${elec.id}/members`, { ...A, method: 'PUT', body: { user_ids: [bina.id] } }, 404);
  const svcs = await ok('list services', '/services', A);
  check('service list shows members, form type and escalation person', svcs.find(x => x.code === 'ELEC')?.members[0]?.name === 'Pavan Provider' && svcs.find(x => x.code === 'ELEC')?.form_schema.form_type === 'location' && svcs.find(x => x.code === 'ELEC')?.escalation_user?.name === 'Lata Lead');
  const pub = await ok('public campus page', '/public/alpha');
  check('portal lists active services with provider first names', pub.services.length === 4 && pub.services.find(x => x.code === 'ELEC').providers[0] === 'Pavan');

  sec('SLA and escalation rules');
  await fails('end before start is rejected', '/sla', { ...A, method: 'PUT', body: { work_start: '17:00', work_end: '09:00', work_days: [1], hold_reasons: [{ label: 'x', hours: 1 }] } }, 400);
  await ok('save SLA: 9–5, Mon–Sat, escalate after 0 days', '/sla', { ...A, method: 'PUT', body: { work_start: '09:00', work_end: '17:00', work_days: [1, 2, 3, 4, 5, 6],
    targets: { critical: 3, high: 5, medium: 8, low: 24 }, hold_reasons: [{ key: 'parts', label: 'Waiting for parts', hours: 16 }, { label: 'Waiting for exam cell', hours: 4 }], escalate_after_days: 0, escalate_holds: true } });
  const sla = await ok('read SLA', '/sla', A);
  check('SLA saved as sent', sla.targets.critical === 3 && sla.hold_reasons.length === 2 && sla.hold_reasons[1].key === 'waiting_for_exam_cell' && sla.escalate_after_days === 0 && sla.escalate_holds === true);

  // ======================= C. requestor =======================
  sec('Requestor raises tickets');
  const raise = (slug, body) => api(`/public/${slug}/tickets`, { method: 'POST', body });
  const elecBody = (n, email, extra = {}) => ({ service_id: elec.id, name: n, email, subject: `Ticket from ${n}`, description: 'Something is broken.',
    form_data: { loc_block: 'Main block', loc_floor: '2nd floor', loc_room: 'Room 214', issue: 'Fan' }, ...extra });
  let r = await raise('alpha', { ...elecBody('Ria', ''), phone: '9000000001' });
  check('email is required', r.status === 400 && /email/i.test(r.error.message), r.error?.message);
  r = await raise('alpha', { ...elecBody('Spam', 'spam@example.com'), website: 'http://spam' });
  check('honeypot rejects bots', r.status === 400);
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
  r = await raise('alpha', { service_id: exam.id, name: 'Sam', email: 's1@example.com', subject: 'Hall ticket missing', form_data: { stu_branch: 'BPT', stu_id: '23BPT014', stu_dept: 'Physio', what_do_you_need: 'Hall ticket' } });
  check('student ticket 0002 raised', r.data?.ticket_no === '0002', r.error?.message);
  r = await raise('alpha', { service_id: trans.id, name: 'Tom', email: 't1@example.com', subject: 'Bus late' });
  check('general service needs a location', r.status === 400 && /location/i.test(r.error.message));
  r = await raise('alpha', { service_id: trans.id, name: 'Tom', email: 't1@example.com', subject: 'Bus late', location: 'Gate 2' });
  check('general ticket 0003 raised', r.data?.ticket_no === '0003');
  r = await raise('beta', { service_id: gen.id, name: 'Ben', email: 'b1@example.com', subject: 'Beta ticket', location: 'Office' });
  check('each campus numbers from 0001', r.data?.ticket_no === '0001');
  const p1 = await ok('track 0001 by number only', `/public/alpha/tickets/1`);
  check('ticket page shows provider, location and the stamped photo', p1.providers[0].name === 'Pavan Provider' && p1.location === 'Main block · 2nd floor · Room 214' && p1.events[0].files?.length === 1 && !!p1.events[0].files[0].stamped_at);
  const img = await fetch(`${APP}/api/files/${p1.events[0].files[0].storage_key}`);
  check('photo is served', img.status === 200 && img.headers.get('content-type')?.includes('image/png'));
  check('student answers saved on the requestor', (await q("SELECT r.identifier, r.department, r.requestor_type FROM tickets t JOIN requestors r ON r.id=t.requestor_id WHERE t.ticket_no='0002' AND t.tenant_id=?", alpha.id))[0]?.identifier === '23BPT014');
  await fails('unknown number is 404', '/public/alpha/tickets/0099', {}, 404);
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
  await fails('weak password rejected', '/me/password', { token: tok, method: 'POST', body: { password: 'abcdefgh' } }, 400);
  await ok('sets own password', '/me/password', { token: tok, method: 'POST', body: { password: 'Pavan2026ok' } });
  T.pavan = await login(pavan.email, 'Pavan2026ok'); check('new password works', !!T.pavan);
  check('old temporary password no longer works', !(await login(pavan.email, pavan.temp)));
  await fails('later changes need the current password', '/me/password', { token: T.pavan, method: 'POST', body: { password: 'Another2026' } }, 400, 'current');
  for (const [u, pw] of [[lata, 'Lata2026ok'], [asha, 'Asha2026ok'], [bina, 'Bina2026ok']]) { const t0 = await login(u.email, u.temp); await api('/me/password', { token: t0, method: 'POST', body: { password: pw } }); T[u.name.split(' ')[0].toLowerCase()] = await login(u.email, pw); }
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
  const rp = await ok('requestor reopens within the window', '/public/alpha/tickets/0001/reopen', { method: 'POST', body: { reason: 'Noisy again' } });
  check('ticket is open again', rp.status === 'open' && rp.reopen_count === 1);
  check('reopen costs the closer 5 points', (await api('/points', { token: T.pavan })).data.me === 5);
  check('providers emailed about the reopen', (await mailsFor('0001')).some(m => m.k === 'reopened' && m.recipient === 'pavan@example.com'));
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
  check('escalation emails: escalation person + provider, and the requestor acknowledgement', mA.some(m => m.k === 'escalated' && m.recipient === 'lata@example.com') && mA.some(m => m.k === 'escalated' && m.recipient === 'pavan@example.com') && mA.some(m => m.k === 'escalated_requestor' && m.recipient === 'r6@example.com'));
  check('requestor timeline says who it went to', (await api(`/public/alpha/tickets/${noA}`)).data.events.some(e => e.event_type === 'escalated' && e.to_value === 'Lata Lead'));
  r = await act(ids.tA, { to: 'closed', note: 'Fixed by the lead' }, T.lata); check('escalation person can close it', r.status === 200);
  await ok('requestor reopens it', `/public/alpha/tickets/${noA}/reopen`, { method: 'POST', body: { reason: 'Still broken' } });
  check('reopen clears the escalation', !(await q('SELECT escalated_at FROM tickets WHERE id=?', ids.tA))[0].escalated_at);
  await run('UPDATE tickets SET due_at=? WHERE id=?', past, wi.id); // make the walk-in ticket overdue
  const att = await ok('attention list', '/attention', { token: T.asha });
  check('attention: no-provider service, escalated and overdue lists', att.no_provider.some(s => s.code === 'TRANS') && att.escalated.some(t => t.ticket_no === noB) && att.overdue.length >= 1);

  // ======================= F. emails =======================
  sec('Email connection, delivery, templates');
  T.sa = await login(SUPER.email, SUPER.password);
  const cfg0 = await ok('super admin reads mail config', '/mail/config', { token: T.sa });
  check('17 email steps listed, none connected yet', cfg0.events.length === 17 && !cfg0.url);
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
  check('flow accepted it', tst2.ok === true && tst2.status === 200 && flow.received.at(-1)?.to === 'me@example.com' && /Test email/.test(flow.received.at(-1)?.subject));
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
    assign: { DHELP: { providers: ['dev@example.com'], escalation: 'esha@example.com' }, DEXAM: { providers: ['dev@example.com', 'esha@example.com'] } } }));
  await stop(); await start();
  const delta = (await q("SELECT id FROM tenants WHERE code='DELTA'"))[0];
  check('campus created from the file', !!delta && (await api('/public/delta')).data?.services.length === 2);
  const dsv = delta ? (await api('/services', { token: T.sa, tenant: delta.id })).data : [];
  check('services added; a bad one is skipped', dsv.length === 2 && !dsv.some(x => x.name === 'Broken'));
  check('staff added as providers who must set a password', (await q("SELECT count(*) n FROM users WHERE email IN ('dev@example.com','esha@example.com') AND role='provider' AND must_change_pw=1"))[0].n === 2);
  check('an existing email is not duplicated or moved', (await q("SELECT count(*) n FROM users WHERE lower(email)='pavan@example.com'"))[0].n === 1 && (await q("SELECT tenant_id FROM users WHERE lower(email)='pavan@example.com'"))[0].tenant_id === alpha.id);
  check('providers and escalation person assigned', dsv.find(x => x.code === 'DHELP')?.members[0]?.email === 'dev@example.com' && dsv.find(x => x.code === 'DHELP')?.escalation_user?.name === 'Esha Lead' && dsv.find(x => x.code === 'DEXAM')?.members.length === 2);
  check('invites are held, not sent', (await q("SELECT status FROM notifications WHERE template_key='invite' AND recipient IN ('dev@example.com','esha@example.com')")).every(n => n.status === 'logged'));
  await ok('admin removes DEXAM’s providers', `/services/${dsv.find(x => x.code === 'DEXAM').id}/members`, { token: T.sa, tenant: delta.id, method: 'PUT', body: { user_ids: [] } });
  await ok('admin renames DHELP', `/services/${dsv.find(x => x.code === 'DHELP').id}`, { token: T.sa, tenant: delta.id, method: 'PATCH', body: { name: 'Delta helpdesk' } });
  await stop(); await start();
  const dsv2 = (await api('/services', { token: T.sa, tenant: delta.id })).data;
  check('restart: nothing duplicated, admin changes kept', dsv2.length === 2 && dsv2.find(x => x.code === 'DHELP')?.name === 'Delta helpdesk' && dsv2.find(x => x.code === 'DEXAM')?.members.length === 0
    && (await q("SELECT count(*) n FROM users WHERE email IN ('dev@example.com','esha@example.com')"))[0].n === 2);
  check('provisioning is in the audit log', (await q("SELECT count(*) n FROM audit_logs WHERE action='provision'"))[0].n >= 1);
  fs.rmSync(PDIR, { recursive: true, force: true });

  // ======================= H. UI smoke test =======================
  await uiSmoke({ pavan: T.pavan, asha: T.asha, sa: T.sa }, { t1: ids.t1 });
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
    await send('Page.enable'); await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: APP + '/' }); await sleep(600);
    const visit = async (name, route, token, probe) => {
      await js(`localStorage.clear(); sessionStorage.clear(); ${token ? `localStorage.setItem('tok', ${JSON.stringify(token)});` : ''}`);
      errors.length = 0;
      await send('Page.navigate', { url: `${APP}/?t=${Date.now()}#${route}` });
      let found = false; // wait for the screen to render (up to 6 s), then give late script errors a moment to arrive
      for (let i = 0; i < 24 && !found; i++) { await sleep(250); found = await js(`return !!document.querySelector(${JSON.stringify(probe)});`).catch(() => false); }
      await sleep(400);
      check(`${name}`, found && !errors.length, !found ? `missing ${probe}` : errors.join(' | ').slice(0, 200));
    };
    await visit('campus picker', '/', null, 'a.svc');
    await visit('campus intro', '/d/alpha', null, 'a.svc[href*="raise"]');
    await visit('service list', '/d/alpha/raise', null, 'a.svc[href*="ELEC"]');
    await visit('raise form (location type)', '/d/alpha/raise/ELEC', null, '#f [name=fd_loc_block]');
    await visit('raise form (student type)', '/d/alpha/raise/EXAM', null, '#f [name=fd_stu_id]');
    await visit('track page', '/d/alpha/track', null, '#f [name=no]');
    await visit('requestor ticket page', '/d/alpha/t/0001', null, '.stamps li');
    await visit('staff login', '/login', null, '#f [name=password]');
    await visit('provider home with ticket cards', '/c', tok.pavan, '.tcard');
    await visit('provider ticket workspace', '/c/t/' + id.t1, tok.pavan, '#act #to');
    await visit('new ticket form', '/c/new', tok.pavan, '#f [name=channel]');
    await visit('provider profile', '/c/me', tok.pavan, '.profile');
    await visit('admin services', '/c/services', tok.asha, 'div.svc [data-e]');
    await visit('admin people', '/c/users', tok.asha, '.trow .uact');
    await visit('admin SLA & points', '/c/sla', tok.asha, '#sf [name=esc_days]');
    await visit('admin attention', '/c/attention', tok.asha, '#main h2');
    await visit('admin reports', '/c/reports', tok.asha, '.kpi');
    await visit('admin audit', '/c/audit', tok.asha, '#main table');
    await visit('super admin email page', '/c/email', tok.sa, '#cf [name=url]');
    await visit('super admin tenants', '/c/tenants', tok.sa, '#main table');
    ws.close();
  } finally { chrome.kill(); await sleep(400); fs.rmSync(prof, { recursive: true, force: true }); }
}
