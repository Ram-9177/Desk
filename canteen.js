// Canteen: students order food from a campus link and collect it at the counter with a token (#047).
// The super admin switches the canteen on for a campus and picks one or two desk providers as canteen managers.
// Managers build the menu, open the canteen for the day (sold-out per item), accept or reject orders (a reason is
// required), mark them ready and then collected; collected orders feed the canteen reports.
// Students browse without logging in; the first order on a device verifies their email with a one-time code.
// Self-contained: own tables, own routes; wired from server.js with one call.
import crypto from 'node:crypto';
import { pool, one, all, run, uid, now } from './db.js';

await pool.query(`
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS canteen_on INT DEFAULT 0;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS canteen_open_day TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS canteen_stock_day TEXT;
CREATE TABLE IF NOT EXISTS canteen_managers (tenant_id TEXT NOT NULL REFERENCES tenants(id), user_id TEXT NOT NULL REFERENCES users(id), created_at TEXT, PRIMARY KEY (tenant_id, user_id));
CREATE TABLE IF NOT EXISTS canteen_categories (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), name TEXT NOT NULL, sort_order INT DEFAULT 0, created_at TEXT);
CREATE TABLE IF NOT EXISTS canteen_items (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), category_id TEXT REFERENCES canteen_categories(id),
  name TEXT NOT NULL, description TEXT, price_paise INT NOT NULL CHECK (price_paise >= 0), is_veg INT DEFAULT 1, sold_out INT DEFAULT 0, active INT DEFAULT 1,
  sort_order INT DEFAULT 0, created_at TEXT);
CREATE INDEX IF NOT EXISTS ci_t ON canteen_items(tenant_id, category_id);
CREATE TABLE IF NOT EXISTS canteen_otps (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, email TEXT NOT NULL, code_hash TEXT NOT NULL, expires_at TEXT NOT NULL,
  attempts INT DEFAULT 0, used_at TEXT, created_at TEXT);
CREATE INDEX IF NOT EXISTS co_e ON canteen_otps(tenant_id, email, created_at);
CREATE TABLE IF NOT EXISTS canteen_devices (token_hash TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, email TEXT NOT NULL, created_at TEXT, last_used_at TEXT);
CREATE TABLE IF NOT EXISTS canteen_orders (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), day TEXT NOT NULL, token_no INT NOT NULL,
  view_key TEXT NOT NULL, device_hash TEXT, email TEXT NOT NULL, name TEXT NOT NULL, phone TEXT, note TEXT, items TEXT NOT NULL, total_paise INT NOT NULL,
  status TEXT NOT NULL DEFAULT 'placed' CHECK (status IN ('placed','accepted','rejected','ready','collected','cancelled')), reject_reason TEXT,
  created_at TEXT, accepted_at TEXT, ready_at TEXT, collected_at TEXT, closed_at TEXT, handled_by TEXT, UNIQUE (tenant_id, day, token_no));
CREATE INDEX IF NOT EXISTS cord_day ON canteen_orders(tenant_id, day, status);
CREATE INDEX IF NOT EXISTS cord_dev ON canteen_orders(device_hash, created_at);
`);

export const STATUS = { placed: 'Waiting for the canteen', accepted: 'Being prepared', rejected: 'Rejected', ready: 'Ready to collect', collected: 'Collected', cancelled: 'Cancelled' };
const NEXT = { placed: ['accepted', 'rejected'], accepted: ['ready', 'rejected'], ready: ['collected'] };
const MAX_MANAGERS = 2, MAX_LINES = 30, MAX_QTY = 20, MAX_OPEN_PER_DEVICE = 3, OTP_MIN = 10, DEVICE_DAYS = 180;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const str = (v, max) => String(v ?? '').trim().slice(0, max);
const sha = v => crypto.createHash('sha256').update(String(v)).digest('hex');
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const rupees = p => '₹' + (p / 100).toFixed(p % 100 ? 2 : 0);
export const tokenLabel = n => '#' + String(n).padStart(3, '0');
const dayOf = (tz, d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'Asia/Kolkata' }).format(d);
const isOpen = tn => !!tn.canteen_on && tn.canteen_open_day === dayOf(tn.timezone);
const addDays = (ymd, n) => { const d = new Date(ymd + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const parsePrice = v => { const n = Number(String(v ?? '').replace(/[₹,\s]/g, '')); if (!Number.isFinite(n) || n < 0 || n > 100000) return null; return Math.round(n * 100); };

export function canteen(d) {
  const { P, S, wrap, bad, notFound, HttpErr, limit, tenantBySlug, tenantRow, base, sendMail, SECRET } = d;
  const forbid = () => new HttpErr(403, 'FORBIDDEN', 'Only the canteen managers can do this');
  const otpHash = (tid, email, code) => crypto.createHmac('sha256', SECRET).update(`${tid}\n${email}\n${code}`).digest('hex');

  // ---------- who may do what ----------
  async function access(req) {
    const u = req.user, tid = req.tenantId; if (!tid) return { tenant: null, setup: u.role === 'super_admin', manage: false };
    const tn = await tenantRow(tid), mgr = !!(await one('SELECT 1 FROM canteen_managers WHERE tenant_id=? AND user_id=?', tid, u.id));
    return { tenant: tn, setup: u.role === 'super_admin', manage: !!tn?.canteen_on && (mgr || u.role !== 'provider'), manager: mgr };
  }
  const need = async req => { const a = await access(req); if (!a.tenant) throw bad('Pick a campus first'); if (!a.manage) throw forbid(); return a; };

  const menuOf = async (tid, all_ = false) => {
    const cats = await all('SELECT id, name, sort_order FROM canteen_categories WHERE tenant_id=? ORDER BY sort_order, name', tid);
    const items = await all(`SELECT id, category_id, name, description, price_paise, is_veg, sold_out, active, sort_order FROM canteen_items WHERE tenant_id=? ${all_ ? '' : 'AND active=1'} ORDER BY sort_order, name`, tid);
    return { categories: cats.map(c => ({ ...c, items: items.filter(i => i.category_id === c.id) })).filter(c => all_ || c.items.length),
      uncategorised: items.filter(i => !i.category_id || !cats.some(c => c.id === i.category_id)) };
  };
  const pub = o => ({ id: o.id, token: tokenLabel(o.token_no), token_no: o.token_no, day: o.day, status: o.status, status_text: STATUS[o.status], reject_reason: o.reject_reason,
    items: JSON.parse(o.items), total_paise: o.total_paise, total: rupees(o.total_paise), name: o.name, note: o.note, created_at: o.created_at,
    accepted_at: o.accepted_at, ready_at: o.ready_at, collected_at: o.collected_at });
  const deviceOf = async (tid, token) => {
    if (!token || typeof token !== 'string' || token.length > 100) return null;
    const r = await one('SELECT * FROM canteen_devices WHERE token_hash=? AND tenant_id=?', sha(token), tid);
    if (!r || Date.parse(r.created_at) < Date.now() - DEVICE_DAYS * 864e5) return null;
    return r;
  };
  const mail = async (tn, to, key, subject, lines, link) => {
    const html = `<div style="font-family:Arial,sans-serif;font-size:15px;color:#1f2937;max-width:520px">${lines.map(l => `<p>${l}</p>`).join('')}${link ? `<p><a href="${esc(link)}" style="display:inline-block;background:#1E4B8F;color:#fff;padding:10px 18px;border-radius:10px;text-decoration:none">Open my order</a></p>` : ''}<p style="color:#6b7280;font-size:13px">${esc(tn.name)} canteen · ONE Desk</p></div>`;
    const text = lines.map(l => l.replace(/<[^>]+>/g, '')).join('\n\n') + (link ? `\n\n${link}` : '');
    try { await sendMail(tn.id, [to], key, subject, html, text); } catch (e) { console.error('canteen mail', e.message); }
  };
  const orderLink = (tn, o) => `${base()}/#/d/${tn.slug}/canteen/o/${o.id}?k=${o.view_key}`;

  // ================= student (public, no login to browse) =================
  P.get('/:slug/canteen', wrap(async req => {
    const tn = await tenantBySlug(req.params.slug);
    if (!tn.canteen_on) return { on: false, campus: tn.name };
    return { on: true, open: isOpen(tn), campus: tn.name, day: dayOf(tn.timezone), ...(await menuOf(tn.id)) };
  }));
  // step 1 of the first order on a device: email a six-digit code
  P.post('/:slug/canteen/otp', wrap(async req => {
    const tn = await tenantBySlug(req.params.slug); if (!tn.canteen_on) throw notFound();
    const email = str(req.body.email, 120).toLowerCase(); if (!EMAIL.test(email)) throw bad('Please enter a valid email address');
    limit('cotp-ip:' + req.ip, 20); limit('cotp:' + tn.id + email, 5);
    const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
    await run('UPDATE canteen_otps SET used_at=? WHERE tenant_id=? AND email=? AND used_at IS NULL', now(), tn.id, email);
    await run('INSERT INTO canteen_otps (id, tenant_id, email, code_hash, expires_at, created_at) VALUES (?,?,?,?,?,?)', uid(), tn.id, email, otpHash(tn.id, email, code), new Date(Date.now() + OTP_MIN * 6e4).toISOString(), now());
    await mail(tn, email, 'canteen_otp', `Your canteen code: ${code}`, [`Your code to order from the ${esc(tn.name)} canteen is <b style="font-size:22px;letter-spacing:4px">${code}</b>`, `It works for ${OTP_MIN} minutes. If you did not ask for it, ignore this email.`]);
    return { sent: true, minutes: OTP_MIN };
  }));
  // step 2: check the code; this device is remembered (a device key kept in the browser), so later orders need no code
  P.post('/:slug/canteen/verify', wrap(async req => {
    const tn = await tenantBySlug(req.params.slug); if (!tn.canteen_on) throw notFound();
    const email = str(req.body.email, 120).toLowerCase(), code = str(req.body.code, 10);
    limit('cver-ip:' + req.ip, 40);
    const o = await one('SELECT * FROM canteen_otps WHERE tenant_id=? AND email=? AND used_at IS NULL ORDER BY created_at DESC LIMIT 1', tn.id, email);
    if (!o || o.expires_at < now()) throw bad('That code has expired. Please ask for a new one.');
    if (o.attempts >= 5) throw bad('Too many wrong tries. Please ask for a new code.');
    const want = otpHash(tn.id, email, code);
    if (!/^\d{6}$/.test(code) || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(o.code_hash))) {
      await run('UPDATE canteen_otps SET attempts=attempts+1 WHERE id=?', o.id); throw bad('That code is not right. Please check the email and try again.'); }
    await run('UPDATE canteen_otps SET used_at=? WHERE id=?', now(), o.id);
    const device = crypto.randomBytes(24).toString('base64url');
    await run('INSERT INTO canteen_devices (token_hash, tenant_id, email, created_at, last_used_at) VALUES (?,?,?,?,?)', sha(device), tn.id, email, now(), now());
    return { device, email };
  }));
  P.post('/:slug/canteen/device', wrap(async req => { // is this device still verified?
    const tn = await tenantBySlug(req.params.slug), dv = await deviceOf(tn.id, req.body.device);
    return dv ? { ok: true, email: dv.email } : { ok: false };
  }));
  P.post('/:slug/canteen/orders', wrap(async req => {
    const tn = await tenantBySlug(req.params.slug), b = req.body;
    if (!tn.canteen_on) throw notFound();
    if (!isOpen(tn)) throw bad('The canteen is not taking orders right now.');
    const dv = await deviceOf(tn.id, b.device); if (!dv) throw new HttpErr(401, 'VERIFY', 'Please verify your email first');
    limit('cord:' + dv.token_hash, 20);
    const name = str(b.name, 80); if (!name) throw bad('Please enter your name');
    const lines = Array.isArray(b.items) ? b.items.slice(0, MAX_LINES + 1) : [];
    if (!lines.length) throw bad('Your cart is empty'); if (lines.length > MAX_LINES) throw bad('Too many different items in one order');
    const open = await one(`SELECT count(*) n FROM canteen_orders WHERE device_hash=? AND status IN ('placed','accepted','ready')`, dv.token_hash);
    if (open.n >= MAX_OPEN_PER_DEVICE) throw bad(`You already have ${open.n} orders in progress. Please collect them first.`);
    const ids = [...new Set(lines.map(l => String(l.id)))];
    const rows = await all(`SELECT * FROM canteen_items WHERE tenant_id=? AND id = ANY(?::text[])`, tn.id, ids);
    const out = [];
    for (const l of lines) {
      const it = rows.find(r => r.id === String(l.id)), qty = Math.floor(Number(l.qty));
      if (!it || !it.active) throw bad('Something in your cart is no longer on the menu. Please refresh.');
      if (it.sold_out) throw bad(`${it.name} just sold out. Please remove it from your cart.`);
      if (!(qty >= 1 && qty <= MAX_QTY)) throw bad(`Quantity for ${it.name} must be 1 to ${MAX_QTY}`);
      const prev = out.find(x => x.id === it.id); if (prev) { prev.qty = Math.min(MAX_QTY, prev.qty + qty); continue; }
      out.push({ id: it.id, name: it.name, price_paise: it.price_paise, qty });
    }
    const total = out.reduce((s, x) => s + x.price_paise * x.qty, 0), day = dayOf(tn.timezone);
    await run('UPDATE canteen_devices SET last_used_at=? WHERE token_hash=?', now(), dv.token_hash);
    for (let i = 0; i < 5; i++) { // the next token of the day; a race on the unique index just takes the next one
      const n = ((await one('SELECT max(token_no) m FROM canteen_orders WHERE tenant_id=? AND day=?', tn.id, day)).m || 0) + 1;
      const o = { id: uid(), tenant_id: tn.id, day, token_no: n, view_key: crypto.randomBytes(12).toString('base64url'), device_hash: dv.token_hash, email: dv.email, name,
        phone: str(b.phone, 20) || null, note: str(b.note, 200) || null, items: JSON.stringify(out), total_paise: total, status: 'placed', created_at: now() };
      try {
        await run(`INSERT INTO canteen_orders (${Object.keys(o).join(',')}) VALUES (${Object.keys(o).map(() => '?').join(',')})`, ...Object.values(o));
        return { ...pub(o), key: o.view_key };
      } catch (e) { if (e.code !== '23505') throw e; }
    }
    throw new HttpErr(503, 'BUSY', 'The canteen is busy, please try again');
  }));
  const orderByKey = async req => {
    const tn = await tenantBySlug(req.params.slug), o = await one('SELECT * FROM canteen_orders WHERE id=? AND tenant_id=?', req.params.id, tn.id);
    const k = String(req.query.k || req.body?.k || '');
    if (!o || k.length !== o.view_key.length || !crypto.timingSafeEqual(Buffer.from(k), Buffer.from(o.view_key))) throw notFound();
    return { tn, o };
  };
  P.get('/:slug/canteen/orders/:id', wrap(async req => { const { o } = await orderByKey(req); return pub(o); }));
  P.post('/:slug/canteen/orders/:id/cancel', wrap(async req => {
    const { o } = await orderByKey(req);
    const r = await run(`UPDATE canteen_orders SET status='cancelled', closed_at=? WHERE id=? AND status='placed'`, now(), o.id);
    if (!r.changes) throw bad('The canteen has already accepted this order, so it can no longer be cancelled.');
    return pub({ ...o, status: 'cancelled' });
  }));
  // this device's recent orders (the last 3 days), for "My orders"
  P.post('/:slug/canteen/mine', wrap(async req => {
    const tn = await tenantBySlug(req.params.slug), dv = await deviceOf(tn.id, req.body.device); if (!dv) return [];
    const rows = await all('SELECT * FROM canteen_orders WHERE device_hash=? AND tenant_id=? AND day>=? ORDER BY created_at DESC LIMIT 20', dv.token_hash, tn.id, addDays(dayOf(tn.timezone), -2));
    return rows.map(o => ({ ...pub(o), key: o.view_key }));
  }));

  // ================= canteen desk (signed in) =================
  S.get('/canteen/access', wrap(async req => { const a = await access(req);
    return { setup: a.setup, manage: a.manage, manager: !!a.manager, on: !!a.tenant?.canteen_on, open: a.tenant ? isOpen(a.tenant) : false }; }));
  // super admin: switch on for the campus, pick 1–2 desk providers as managers
  S.get('/canteen/setup', wrap(async req => {
    if (req.user.role !== 'super_admin') throw forbid(); if (!req.tenantId) throw bad('Pick a campus first');
    const tn = await tenantRow(req.tenantId);
    return { on: !!tn.canteen_on, slug: tn.slug, managers: (await all('SELECT user_id FROM canteen_managers WHERE tenant_id=?', req.tenantId)).map(r => r.user_id),
      providers: await all(`SELECT id, name, email FROM users WHERE tenant_id=? AND role='provider' AND is_active=1 ORDER BY name`, req.tenantId), max: MAX_MANAGERS };
  }));
  S.put('/canteen/setup', wrap(async req => {
    if (req.user.role !== 'super_admin') throw forbid(); if (!req.tenantId) throw bad('Pick a campus first');
    const on = !!req.body.on, ids = [...new Set((req.body.managers || []).map(String))];
    if (ids.length > MAX_MANAGERS) throw bad(`Pick at most ${MAX_MANAGERS} canteen managers`);
    if (on && !ids.length) throw bad('Pick at least one desk provider as canteen manager');
    const ok = await all(`SELECT id FROM users WHERE tenant_id=? AND role='provider' AND is_active=1 AND id = ANY(?::text[])`, req.tenantId, ids);
    if (ok.length !== ids.length) throw bad('Canteen managers must be active service providers on this campus');
    await run('UPDATE tenants SET canteen_on=? WHERE id=?', on ? 1 : 0, req.tenantId);
    await run('DELETE FROM canteen_managers WHERE tenant_id=?', req.tenantId);
    for (const id of ids) await run('INSERT INTO canteen_managers (tenant_id, user_id, created_at) VALUES (?,?,?)', req.tenantId, id, now());
    return { on, managers: ids };
  }));

  // ---- menu ----
  S.get('/canteen/menu', wrap(async req => { const a = await need(req); return { open: isOpen(a.tenant), day: dayOf(a.tenant.timezone), slug: a.tenant.slug, ...(await menuOf(req.tenantId, true)) }; }));
  S.post('/canteen/categories', wrap(async req => { await need(req); const name = str(req.body.name, 60); if (!name) throw bad('Category name required');
    const n = (await one('SELECT count(*) n FROM canteen_categories WHERE tenant_id=?', req.tenantId)).n; if (n >= 50) throw bad('Up to 50 categories');
    const id = uid(); await run('INSERT INTO canteen_categories (id, tenant_id, name, sort_order, created_at) VALUES (?,?,?,?,?)', id, req.tenantId, name, n, now()); return { id, name }; }));
  S.patch('/canteen/categories/:id', wrap(async req => { await need(req); const name = str(req.body.name, 60);
    const sets = [], args = []; if (name) { sets.push('name=?'); args.push(name); } if (Number.isInteger(req.body.sort_order)) { sets.push('sort_order=?'); args.push(req.body.sort_order); }
    if (!sets.length) throw bad('Nothing to change');
    const r = await run(`UPDATE canteen_categories SET ${sets.join(',')} WHERE id=? AND tenant_id=?`, ...args, req.params.id, req.tenantId); if (!r.changes) throw notFound(); return { ok: true }; }));
  S.delete('/canteen/categories/:id', wrap(async req => { await need(req);
    if ((await one('SELECT count(*) n FROM canteen_items WHERE category_id=? AND active=1', req.params.id)).n) throw bad('Move or remove the items in this category first');
    await run('UPDATE canteen_items SET category_id=NULL WHERE category_id=? AND tenant_id=?', req.params.id, req.tenantId);
    const r = await run('DELETE FROM canteen_categories WHERE id=? AND tenant_id=?', req.params.id, req.tenantId); if (!r.changes) throw notFound(); return { ok: true }; }));
  const itemFields = async (req, partial) => {
    const b = req.body, f = {};
    if (!partial || b.name !== undefined) { f.name = str(b.name, 80); if (!f.name) throw bad('Item name required'); }
    if (!partial || b.price !== undefined) { f.price_paise = parsePrice(b.price); if (f.price_paise == null) throw bad('Enter a price in rupees, e.g. 40 or 12.50'); }
    if (b.description !== undefined) f.description = str(b.description, 200) || null;
    if (b.is_veg !== undefined) f.is_veg = b.is_veg ? 1 : 0;
    if (b.sold_out !== undefined) f.sold_out = b.sold_out ? 1 : 0;
    if (b.active !== undefined) f.active = b.active ? 1 : 0;
    if (Number.isInteger(b.sort_order)) f.sort_order = b.sort_order;
    if (b.category_id !== undefined) { f.category_id = b.category_id || null;
      if (f.category_id && !(await one('SELECT 1 FROM canteen_categories WHERE id=? AND tenant_id=?', f.category_id, req.tenantId))) throw bad('Pick a category'); }
    return f;
  };
  S.post('/canteen/items', wrap(async req => { await need(req); const f = await itemFields(req, false);
    if ((await one('SELECT count(*) n FROM canteen_items WHERE tenant_id=?', req.tenantId)).n >= 500) throw bad('Up to 500 items');
    const o = { id: uid(), tenant_id: req.tenantId, is_veg: 1, created_at: now(), ...f };
    await run(`INSERT INTO canteen_items (${Object.keys(o).join(',')}) VALUES (${Object.keys(o).map(() => '?').join(',')})`, ...Object.values(o)); return { id: o.id }; }));
  S.patch('/canteen/items/:id', wrap(async req => { await need(req); const f = await itemFields(req, true); if (!Object.keys(f).length) throw bad('Nothing to change');
    const r = await run(`UPDATE canteen_items SET ${Object.keys(f).map(k => k + '=?').join(',')} WHERE id=? AND tenant_id=?`, ...Object.values(f), req.params.id, req.tenantId);
    if (!r.changes) throw notFound(); return { ok: true }; }));
  // removing an item hides it (old orders keep their copy of the name and price)
  S.delete('/canteen/items/:id', wrap(async req => { await need(req);
    const r = await run('UPDATE canteen_items SET active=0 WHERE id=? AND tenant_id=?', req.params.id, req.tenantId); if (!r.changes) throw notFound(); return { ok: true }; }));

  // ---- open / close for the day ----
  S.post('/canteen/open', wrap(async req => { const a = await need(req), day = dayOf(a.tenant.timezone);
    if (a.tenant.canteen_stock_day !== day) await run('UPDATE canteen_items SET sold_out=0 WHERE tenant_id=?', req.tenantId); // a fresh day: everything back in stock (reopening the same day keeps the marks)
    await run('UPDATE tenants SET canteen_open_day=?, canteen_stock_day=? WHERE id=?', day, day, req.tenantId); return { open: true, day }; }));
  S.post('/canteen/close', wrap(async req => { await need(req); await run('UPDATE tenants SET canteen_open_day=NULL WHERE id=?', req.tenantId); return { open: false }; }));

  // ---- orders ----
  S.get('/canteen/orders', wrap(async req => { const a = await need(req), day = /^\d{4}-\d{2}-\d{2}$/.test(req.query.day || '') ? req.query.day : dayOf(a.tenant.timezone);
    const rows = await all('SELECT * FROM canteen_orders WHERE tenant_id=? AND day=? ORDER BY token_no DESC', req.tenantId, day);
    return { day, open: isOpen(a.tenant), orders: rows.map(o => ({ ...pub(o), email: o.email, phone: o.phone })) }; }));
  S.post('/canteen/orders/:id/:to(accepted|rejected|ready|collected)', wrap(async req => {
    const a = await need(req), to = req.params.to, o = await one('SELECT * FROM canteen_orders WHERE id=? AND tenant_id=?', req.params.id, req.tenantId);
    if (!o) throw notFound();
    if (!(NEXT[o.status] || []).includes(to)) throw bad(`This order is ${STATUS[o.status].toLowerCase()}; it can't be marked ${to}.`);
    const reason = str(req.body.reason, 200); if (to === 'rejected' && reason.length < 3) throw bad('Please give the student a reason for rejecting');
    const col = { accepted: 'accepted_at', ready: 'ready_at', collected: 'collected_at', rejected: 'closed_at' }[to];
    const r = await run(`UPDATE canteen_orders SET status=?, ${col}=?, ${to === 'collected' ? 'closed_at=?,' : ''} reject_reason=?, handled_by=? WHERE id=? AND status=?`,
      to, now(), ...(to === 'collected' ? [now()] : []), to === 'rejected' ? reason : o.reject_reason, req.user.id, o.id, o.status);
    if (!r.changes) throw bad('Someone else just updated this order. Please refresh.');
    const n = { ...o, status: to, reject_reason: to === 'rejected' ? reason : o.reject_reason }, tk = tokenLabel(o.token_no);
    if (to === 'ready') await mail(a.tenant, o.email, 'canteen_ready', `Order ${tk} is ready to collect`, [`Hi ${esc(o.name)},`, `Your order <b>${tk}</b> is ready. Show the token at the counter and pay ${rupees(o.total_paise)}.`], orderLink(a.tenant, o));
    if (to === 'rejected') await mail(a.tenant, o.email, 'canteen_rejected', `Order ${tk} could not be accepted`, [`Hi ${esc(o.name)},`, `Sorry, the canteen could not accept your order <b>${tk}</b>.`, `Reason: ${esc(reason)}`], orderLink(a.tenant, o));
    return pub(n);
  }));

  // ---- reports: collected orders ----
  S.get('/canteen/report', wrap(async req => { const a = await need(req), today = dayOf(a.tenant.timezone);
    const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : addDays(today, -6), to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : today;
    const rows = await all('SELECT * FROM canteen_orders WHERE tenant_id=? AND day>=? AND day<=? ORDER BY day, token_no', req.tenantId, from, to);
    const done = rows.filter(o => o.status === 'collected'), items = {};
    for (const o of done) for (const it of JSON.parse(o.items)) { const e = items[it.name] ||= { name: it.name, qty: 0, paise: 0 }; e.qty += it.qty; e.paise += it.qty * it.price_paise; }
    const days = []; for (let d = from; d <= to && days.length < 92; d = addDays(d, 1)) { const x = done.filter(o => o.day === d);
      days.push({ day: d, orders: x.length, paise: x.reduce((s, o) => s + o.total_paise, 0), rejected: rows.filter(o => o.day === d && o.status === 'rejected').length }); }
    const prep = done.filter(o => o.accepted_at && o.ready_at).map(o => (Date.parse(o.ready_at) - Date.parse(o.accepted_at)) / 6e4);
    return { from, to, collected: done.length, revenue_paise: done.reduce((s, o) => s + o.total_paise, 0),
      rejected: rows.filter(o => o.status === 'rejected').length, cancelled: rows.filter(o => o.status === 'cancelled').length,
      avg_prep_min: prep.length ? Math.round(prep.reduce((x, y) => x + y, 0) / prep.length) : null,
      reasons: Object.entries(rows.filter(o => o.status === 'rejected').reduce((m, o) => (m[o.reject_reason] = (m[o.reject_reason] || 0) + 1, m), {})).map(([reason, count]) => ({ reason, count })).sort((x, y) => y.count - x.count).slice(0, 8),
      top: Object.values(items).sort((x, y) => y.qty - x.qty).slice(0, 15), days };
  }));
}
