// Canteen: students order food from a campus link and collect it at the counter with a token (#047).
// The super admin switches the canteen on for a campus and picks one or two desk providers as canteen managers.
// Managers build the menu, open the canteen for the day (sold-out per item), accept or reject orders (a reason is
// required), mark them ready and then collected; collected orders feed the canteen reports.
// Students browse without logging in; the first order on a device verifies their email with a one-time code.
// Self-contained: own tables, own routes; wired from server.js with one call.
import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { pool, one, all, run, uid, now } from './db.js';

await pool.query(`
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS canteen_on INT DEFAULT 0;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS canteen_open_day TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS canteen_stock_day TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS canteen_name TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS canteen_hours TEXT;
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
-- payment before the kitchen (cash at the counter, or UPI to the canteen's own UPI ID with the student's reference number), and door delivery
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS canteen_pay TEXT;
ALTER TABLE canteen_orders ADD COLUMN IF NOT EXISTS pay_mode TEXT DEFAULT 'cash';
ALTER TABLE canteen_orders ADD COLUMN IF NOT EXISTS pay_status TEXT DEFAULT 'unpaid';
ALTER TABLE canteen_orders ADD COLUMN IF NOT EXISTS upi_ref TEXT;
ALTER TABLE canteen_orders ADD COLUMN IF NOT EXISTS paid_at TEXT;
ALTER TABLE canteen_orders ADD COLUMN IF NOT EXISTS paid_by TEXT;
ALTER TABLE canteen_orders ADD COLUMN IF NOT EXISTS fulfil TEXT DEFAULT 'pickup';
ALTER TABLE canteen_orders ADD COLUMN IF NOT EXISTS deliver_to TEXT;
ALTER TABLE canteen_orders ADD COLUMN IF NOT EXISTS deliver_addr TEXT;
-- kitchen staff (kind='kitchen') sit in the same table as the managers; the kitchen works the KOT: start cooking, then ready
ALTER TABLE canteen_managers ADD COLUMN IF NOT EXISTS kind TEXT DEFAULT 'manager';
ALTER TABLE canteen_orders ADD COLUMN IF NOT EXISTS kot_started_at TEXT;
ALTER TABLE canteen_orders ADD COLUMN IF NOT EXISTS kot_by TEXT;
ALTER TABLE canteen_orders ADD COLUMN IF NOT EXISTS has_booked INT DEFAULT 0;
-- deals on an item: a plain discount, a flash sale or an end-of-day sale, as % off, until a time (NULL = until ended)
ALTER TABLE canteen_items ADD COLUMN IF NOT EXISTS deal_pct INT DEFAULT 0;
ALTER TABLE canteen_items ADD COLUMN IF NOT EXISTS deal_kind TEXT;
ALTER TABLE canteen_items ADD COLUMN IF NOT EXISTS deal_until TEXT;
ALTER TABLE canteen_orders ADD COLUMN IF NOT EXISTS delivery_fee_paise INT DEFAULT 0;
ALTER TABLE canteen_orders ADD COLUMN IF NOT EXISTS out_at TEXT;
ALTER TABLE canteen_orders DROP CONSTRAINT IF EXISTS canteen_orders_status_check;
ALTER TABLE canteen_orders ADD CONSTRAINT canteen_orders_status_check CHECK (status IN ('placed','accepted','rejected','ready','out','collected','cancelled'));
CREATE UNIQUE INDEX IF NOT EXISTS cord_upi ON canteen_orders(tenant_id, upper(upi_ref)) WHERE upi_ref IS NOT NULL;
`);

export const STATUS = { placed: 'Waiting for payment', accepted: 'Being prepared', rejected: 'Rejected', ready: 'Ready to collect', out: 'Out for delivery', collected: 'Collected', cancelled: 'Cancelled' };
// placed = waiting for payment; accepted = paid and in the kitchen (only staff confirming the payment moves it there)
const NEXT = { placed: ['accepted', 'rejected'], accepted: ['ready', 'rejected'], ready: ['collected', 'out', 'rejected'], out: ['collected', 'rejected'] }; // ready/out → rejected: never collected
const LIVE = "('placed','accepted','ready','out')";
// Payments and delivery, per campus. Defaults: cash only, pickup only, 20 minutes to pay.
const PAY_DEFAULT = { cash: true, upi_id: '', upi_name: '', delivery: false, delivery_fee: 0, delivery_note: '', pay_window_min: 20, delivery_blocks: [] };
const FLOORS = ['Ground floor', '1st floor', '2nd floor', '3rd floor', '4th floor', '5th floor', '6th floor'];
export const payOf = tn => { try { return { ...PAY_DEFAULT, ...JSON.parse(tn.canteen_pay || '{}') }; } catch { return { ...PAY_DEFAULT }; } };
const UPI_ID = /^[\w.\-]{2,60}@[A-Za-z][\w.\-]{1,40}$/, UTR = /^[A-Za-z0-9]{6,30}$/;
const upiLink = (p, o) => `upi://pay?${new URLSearchParams({ pa: p.upi_id, pn: p.upi_name || 'Canteen', am: (o.total_paise / 100).toFixed(2), cu: 'INR', tn: `Canteen order ${tokenLabel(o.token_no)}` })}`;
export const DEAL_KINDS = { discount: 'Discount', flash: 'Flash sale', eod: 'End-of-day sale' };
// an item's live deal and the price a student pays now
export const dealOf = it => it.deal_pct > 0 && it.deal_kind && (!it.deal_until || it.deal_until > new Date().toISOString()) ? { pct: it.deal_pct, kind: it.deal_kind, until: it.deal_until } : null;
const priceNow = it => { const d = dealOf(it); return d ? Math.round(it.price_paise * (100 - d.pct) / 100) : it.price_paise; };
const MAX_KITCHEN = 10, MAX_MANAGERS = 2, MAX_LINES = 30, MAX_QTY = 20, MAX_OPEN_PER_DEVICE = 3, OTP_MIN = 10, DEVICE_DAYS = 180;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const str = (v, max) => String(v ?? '').trim().slice(0, max);
const sha = v => crypto.createHash('sha256').update(String(v)).digest('hex');
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const rupees = p => '₹' + (p / 100).toFixed(p % 100 ? 2 : 0);
export const tokenLabel = n => '#' + String(n).padStart(3, '0');
const dayOf = (tz, d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'Asia/Kolkata' }).format(d);
export const canteenName = tn => tn.canteen_name || `${tn.name} Canteen`;
const isOpen = tn => !!tn.canteen_on && tn.canteen_open_day === dayOf(tn.timezone); // opened by a manager today
// Timings: serving hours, days and last-order cut-off set by the managers. No timings saved = no time limit.
const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
export const hoursOf = tn => { try { const h = JSON.parse(tn.canteen_hours || 'null'); if (h && HM.test(h.open) && HM.test(h.close)) return h; } catch { /* none */ } return null; };
const localNow = tz => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz || 'Asia/Kolkata', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()).map(x => [x.type, x.value]));
  return { dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday), min: +p.hour * 60 + +p.minute }; };
const toMin = hm => +hm.slice(0, 2) * 60 + +hm.slice(3);
const hm = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
// What students see: can they order now, and why not
export function stateOf(tn) {
  const h = hoursOf(tn), opened = isOpen(tn), base = { hours: h };
  if (!tn.canteen_on) return { ...base, accepting: false, why: 'off' };
  if (!h) return { ...base, accepting: opened, why: opened ? 'open' : 'closed' };
  const { dow, min } = localNow(tn.timezone), today = h.days.includes(dow), o = toMin(h.open), c = toMin(h.close), last = c - (h.last_order_min || 0);
  if (!today) return { ...base, accepting: false, why: 'not_today' };
  if (min < o) return { ...base, accepting: false, why: 'later', opens_at: h.open };
  if (min >= c) return { ...base, accepting: false, why: 'over' };
  if (min >= last) return { ...base, accepting: false, why: 'last_orders_done', closes_at: h.close };
  if (!opened) return { ...base, accepting: false, why: 'closed' };
  return { ...base, accepting: true, why: 'open', closes_at: h.close, last_order_at: hm(last), mins_left: last - min };
}
const addDays = (ymd, n) => { const d = new Date(ymd + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const parsePrice = v => { const n = Number(String(v ?? '').replace(/[₹,\s]/g, '')); if (!Number.isFinite(n) || n < 0 || n > 100000) return null; return Math.round(n * 100); };

export function canteen(d) {
  const { app, P, S, wrap, bad, notFound, HttpErr, limit, tenantBySlug, tenantRow, base, sendMail, SECRET } = d;
  const forbid = () => new HttpErr(403, 'FORBIDDEN', 'Only the canteen managers can do this');
  const otpHash = (tid, email, code) => crypto.createHmac('sha256', SECRET).update(`${tid}\n${email}\n${code}`).digest('hex');

  // ---------- who may do what ----------
  async function access(req) {
    const u = req.user, tid = req.tenantId; if (!tid) return { tenant: null, setup: u.role === 'super_admin', manage: false };
    const tn = await tenantRow(tid), row = await one('SELECT kind FROM canteen_managers WHERE tenant_id=? AND user_id=?', tid, u.id), mgr = row?.kind === 'manager' || (row && !row.kind);
    const manage = !!tn?.canteen_on && (mgr || u.role !== 'provider');
    return { tenant: tn, setup: u.role === 'super_admin', manage, manager: mgr, kitchen: !!tn?.canteen_on && (manage || row?.kind === 'kitchen'), cook: row?.kind === 'kitchen', req_admin: u.role === 'tenant_admin' && !!tn?.canteen_on };
  }
  const need = async req => { const a = await access(req); if (!a.tenant) throw bad('Pick a campus first'); if (!a.manage) throw forbid(); return a; };
  const needKitchen = async req => { const a = await access(req); if (!a.tenant) throw bad('Pick a campus first'); if (!a.kitchen) throw new HttpErr(403, 'FORBIDDEN', 'Only the kitchen and canteen managers can do this'); return a; };

  const menuOf = async (tid, all_ = false) => {
    const cats = await all('SELECT id, name, sort_order FROM canteen_categories WHERE tenant_id=? ORDER BY sort_order, name', tid);
    const items = (await all(`SELECT id, category_id, name, description, price_paise, is_veg, sold_out, active, sort_order, deal_pct, deal_kind, deal_until FROM canteen_items WHERE tenant_id=? ${all_ ? '' : 'AND active=1'} ORDER BY sort_order, name`, tid))
      .map(({ deal_pct, deal_kind, deal_until, ...i }) => { const deal = dealOf({ deal_pct, deal_kind, deal_until }); return { ...i, deal, price_now: deal ? priceNow({ ...i, deal_pct, deal_kind, deal_until }) : i.price_paise }; });
    return { categories: cats.map(c => ({ ...c, items: items.filter(i => i.category_id === c.id) })).filter(c => all_ || c.items.length),
      uncategorised: items.filter(i => !i.category_id || !cats.some(c => c.id === i.category_id)) };
  };
  const pub = o => ({ id: o.id, token: tokenLabel(o.token_no), token_no: o.token_no, day: o.day, status: o.status, status_text: STATUS[o.status], reject_reason: o.reject_reason,
    items: JSON.parse(o.items), total_paise: o.total_paise, total: rupees(o.total_paise), name: o.name, note: o.note, created_at: o.created_at,
    accepted_at: o.accepted_at, ready_at: o.ready_at, collected_at: o.collected_at, out_at: o.out_at, kot_started_at: o.kot_started_at, has_booked: !!o.has_booked,
    pay_mode: o.pay_mode || 'cash', pay_status: o.pay_status || 'unpaid', upi_ref: o.upi_ref, paid_at: o.paid_at,
    fulfil: o.fulfil || 'pickup', deliver_to: o.deliver_to, deliver_addr: (() => { try { return JSON.parse(o.deliver_addr || 'null'); } catch { return null; } })(), delivery_fee_paise: o.delivery_fee_paise || 0,
    status_text: o.status === 'placed' ? (o.pay_mode === 'upi' ? (o.pay_status === 'claimed' ? 'Payment being checked' : 'Waiting for UPI payment') : 'Pay at the counter')
      : o.status === 'accepted' ? (o.kot_started_at ? 'Being cooked' : 'Sent to the kitchen')
      : o.status === 'collected' && o.fulfil === 'delivery' ? 'Delivered' : STATUS[o.status] });
  const deviceOf = async (tid, token) => {
    if (!token || typeof token !== 'string' || token.length > 100) return null;
    const r = await one('SELECT * FROM canteen_devices WHERE token_hash=? AND tenant_id=?', sha(token), tid);
    if (!r || Date.parse(r.created_at) < Date.now() - DEVICE_DAYS * 864e5) return null;
    return r;
  };
  const mail = async (tn, to, key, subject, lines, link) => {
    const html = `<div style="font-family:Arial,sans-serif;font-size:15px;color:#1f2937;max-width:520px">${lines.map(l => `<p>${l}</p>`).join('')}${link ? `<p><a href="${esc(link)}" style="display:inline-block;background:#1E4B8F;color:#fff;padding:10px 18px;border-radius:10px;text-decoration:none">Open my order</a></p>` : ''}<p style="color:#6b7280;font-size:13px">${esc(canteenName(tn))} · ONE Desk</p></div>`;
    const text = lines.map(l => l.replace(/<[^>]+>/g, '')).join('\n\n') + (link ? `\n\n${link}` : '');
    try { await sendMail(tn.id, [to], key, subject, html, text); } catch (e) { console.error('canteen mail', e.message); }
  };
  // typical minutes from accepted to ready over the last week (for "about N min")
  // where the canteen delivers: the manager's own list, else every Block the campus's ticket forms already use
  const blocksOf = async tn => { const own = payOf(tn).delivery_blocks; if (own?.length) return own;
    const set = new Set(); for (const r of await all('SELECT form_schema FROM services WHERE tenant_id=? AND is_active=1', tn.id)) { try { (JSON.parse(r.form_schema || '{}').lists?.block || []).forEach(b => b && set.add(String(b).trim())); } catch { /* skip */ } }
    return [...set].sort((a, b) => a.localeCompare(b)); };
  // unpaid orders past the payment window are cancelled (an order with a UPI reference waits for staff to check it)
  const expire = async tn => { const p = payOf(tn), cut = new Date(Date.now() - p.pay_window_min * 6e4).toISOString();
    await run(`UPDATE canteen_orders SET status='cancelled', closed_at=?, reject_reason='Not paid in time' WHERE tenant_id=? AND status='placed' AND coalesce(pay_status,'unpaid')='unpaid' AND created_at < ?`, now(), tn.id, cut); };
  const prepMin = async tid => { const r = await one(`SELECT avg(EXTRACT(EPOCH FROM (ready_at::timestamptz - accepted_at::timestamptz)) / 60) m FROM canteen_orders WHERE tenant_id=? AND ready_at IS NOT NULL AND accepted_at IS NOT NULL AND created_at > ?`, tid, new Date(Date.now() - 7 * 864e5).toISOString());
    return r?.m == null ? null : Math.max(1, Math.round(r.m)); };
  const shortLink = tn => `${base()}/${tn.slug}/cafeteria`;
  const orderLink = (tn, o) => `${base()}/#/d/${tn.slug}/canteen/o/${o.id}?k=${o.view_key}`;

  // ================= short link + QR =================
  // https://<site>/<campus>/cafeteria opens the canteen menu (the link printed under the QR code at the counter)
  {
    app.get(['/:slug/cafeteria', '/desk/:slug/cafeteria'], async (req, res) => {
      const slug = String(req.params.slug).toLowerCase(), tn = await one('SELECT slug FROM tenants WHERE slug=? AND is_active=1', slug).catch(() => null);
      res.redirect(302, tn ? `${req.path.startsWith('/desk/') ? '/desk' : ''}/#/d/${tn.slug}/canteen` : '/');
    });
    app.get('/api/canteen-qr/:slug.svg', async (req, res, next) => { try {
      const tn = await one('SELECT slug FROM tenants WHERE slug=? AND is_active=1', String(req.params.slug).toLowerCase()); if (!tn) throw notFound();
      const svg = await QRCode.toString(shortLink(tn), { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#0F172A', light: '#FFFFFF' } });
      res.set({ 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=3600' }).send(svg); } catch (e) { next(e); } });
  }
  // ================= student (public, no login to browse) =================
  P.get('/:slug/canteen', wrap(async req => {
    const tn = await tenantBySlug(req.params.slug);
    if (!tn.canteen_on) return { on: false, campus: tn.name, name: canteenName(tn) };
    await expire(tn); const st = stateOf(tn), since = addDays(dayOf(tn.timezone), -6), pop = {}, pay = payOf(tn);
    for (const o of await all(`SELECT items FROM canteen_orders WHERE tenant_id=? AND day>=? AND status='collected'`, tn.id, since)) for (const it of JSON.parse(o.items)) pop[it.id] = (pop[it.id] || 0) + it.qty;
    // fast moving: the items ordered most today (at least 5 each), up to 5
    const fastQ = {}; for (const o of await all(`SELECT items FROM canteen_orders WHERE tenant_id=? AND day=? AND status NOT IN ('cancelled','rejected')`, tn.id, dayOf(tn.timezone))) for (const it of JSON.parse(o.items)) fastQ[it.id] = (fastQ[it.id] || 0) + it.qty;
    const fast = Object.entries(fastQ).filter(x => x[1] >= 5).sort((a, b) => b[1] - a[1]).slice(0, 5).map(x => x[0]);
    const busy = (await one(`SELECT count(*) n FROM canteen_orders WHERE tenant_id=? AND day=? AND status IN ('placed','accepted')`, tn.id, dayOf(tn.timezone))).n;
    return { on: true, open: st.accepting, state: st, busy, pay: { cash: pay.cash, upi: !!pay.upi_id, delivery: pay.delivery, blocks: pay.delivery ? await blocksOf(tn) : [], floors: FLOORS, delivery_fee_paise: Math.round(pay.delivery_fee * 100), delivery_note: pay.delivery_note, pay_window_min: pay.pay_window_min }, wait_min: await prepMin(tn.id), popular: Object.entries(pop).sort((a, b) => b[1] - a[1]).slice(0, 3).filter(x => x[1] >= 2).map(x => x[0]),
      fast, campus: tn.name, name: canteenName(tn), day: dayOf(tn.timezone), ...(await menuOf(tn.id)) };
  }));
  // step 1 of the first order on a device: email a six-digit code
  P.post('/:slug/canteen/otp', wrap(async req => {
    const tn = await tenantBySlug(req.params.slug); if (!tn.canteen_on) throw notFound();
    const email = str(req.body.email, 120).toLowerCase(); if (!EMAIL.test(email)) throw bad('Please enter a valid email address');
    limit('cotp-ip:' + req.ip, 20); limit('cotp:' + tn.id + email, 5);
    const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
    await run('UPDATE canteen_otps SET used_at=? WHERE tenant_id=? AND email=? AND used_at IS NULL', now(), tn.id, email);
    await run('INSERT INTO canteen_otps (id, tenant_id, email, code_hash, expires_at, created_at) VALUES (?,?,?,?,?,?)', uid(), tn.id, email, otpHash(tn.id, email, code), new Date(Date.now() + OTP_MIN * 6e4).toISOString(), now());
    await mail(tn, email, 'canteen_otp', `Your canteen code: ${code}`, [`Your code to order from ${esc(canteenName(tn))} is <b style="font-size:22px;letter-spacing:4px">${code}</b>`, `It works for ${OTP_MIN} minutes. If you did not ask for it, ignore this email.`]);
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
    const st = stateOf(tn);
    if (!st.accepting) throw bad(st.why === 'later' ? `The canteen opens at ${st.opens_at}.` : st.why === 'last_orders_done' ? `Last orders are over for today (closes at ${st.closes_at}).` : 'The canteen is not taking orders right now.');
    const dv = await deviceOf(tn.id, b.device); if (!dv) throw new HttpErr(401, 'VERIFY', 'Please verify your email first');
    limit('cord:' + dv.token_hash, 20);
    const name = str(b.name, 80); if (!name) throw bad('Please enter your name');
    const lines = Array.isArray(b.items) ? b.items.slice(0, MAX_LINES + 1) : [];
    if (!lines.length) throw bad('Your cart is empty'); if (lines.length > MAX_LINES) throw bad('Too many different items in one order');
    const pay = payOf(tn), mode = b.pay_mode === 'upi' ? 'upi' : 'cash', fulfil = b.fulfil === 'delivery' ? 'delivery' : 'pickup';
    if (mode === 'upi' && !pay.upi_id) throw bad('UPI payment is not set up here. Please choose cash.');
    if (mode === 'cash' && !pay.cash) throw bad('This canteen takes UPI only.');
    if (fulfil === 'delivery' && !pay.delivery) throw bad('Delivery is not available. Please choose pickup.');
    // delivery address: Block (from the campus list, or typed when the campus has none / "Other"), floor, room, landmark
    let deliverTo = null, addr = null;
    if (fulfil === 'delivery') {
      const a = b.addr && typeof b.addr === 'object' ? b.addr : null;
      if (a) { const blocks = await blocksOf(tn);
        addr = { block: str(a.block, 60), floor: str(a.floor, 30), room: str(a.room, 40), landmark: str(a.landmark, 80) };
        if (!addr.block) throw bad('Please pick your block / building');
        if (blocks.length && !blocks.includes(addr.block) && !a.other) throw bad('We do not deliver to that block. Please pick one from the list.');
        if (!addr.room) throw bad('Please enter your room or class number');
        deliverTo = [addr.block, addr.floor, 'Room ' + addr.room, addr.landmark && `near ${addr.landmark}`].filter(Boolean).join(', ');
      } else { deliverTo = str(b.deliver_to, 120); if (deliverTo.length < 3) throw bad('Please say where to deliver (block, floor, room)'); }
    }
    if (fulfil === 'delivery' && !str(b.phone, 20)) throw bad('Please give a phone number so the delivery person can reach you');
    await expire(tn);
    const open = await one(`SELECT count(*) n FROM canteen_orders WHERE device_hash=? AND status IN ${LIVE}`, dv.token_hash);
    if (open.n >= MAX_OPEN_PER_DEVICE) throw bad(`You already have ${open.n} orders in progress. Please collect them first.`);
    const ids = [...new Set(lines.map(l => String(l.id)))];
    const rows = await all(`SELECT * FROM canteen_items WHERE tenant_id=? AND id = ANY(?::text[])`, tn.id, ids);
    const out = [], cats = await all('SELECT id, name FROM canteen_categories WHERE tenant_id=?', tn.id);
    for (const l of lines) {
      const it = rows.find(r => r.id === String(l.id)), qty = Math.floor(Number(l.qty));
      if (!it || !it.active) throw bad('Something in your cart is no longer on the menu. Please refresh.');
      // out of stock: still bookable; the manager confirms it can be made before the order goes to the kitchen
      if (!(qty >= 1 && qty <= MAX_QTY)) throw bad(`Quantity for ${it.name} must be 1 to ${MAX_QTY}`);
      const prev = out.find(x => x.id === it.id); if (prev) { prev.qty = Math.min(MAX_QTY, prev.qty + qty); continue; }
      const d = dealOf(it), cat = cats.find(c => c.id === it.category_id)?.name || null;
      out.push({ id: it.id, name: it.name, price_paise: priceNow(it), qty, ...(d ? { mrp_paise: it.price_paise, deal: d.kind, pct: d.pct } : {}), ...(cat ? { category: cat } : {}), ...(it.sold_out ? { booked: true } : {}) });
    }
    const fee = fulfil === 'delivery' ? Math.round(pay.delivery_fee * 100) : 0, total = out.reduce((s, x) => s + x.price_paise * x.qty, 0) + fee, day = dayOf(tn.timezone);
    await run('UPDATE canteen_devices SET last_used_at=? WHERE token_hash=?', now(), dv.token_hash);
    for (let i = 0; i < 5; i++) { // the next token of the day; a race on the unique index just takes the next one
      const n = ((await one('SELECT max(token_no) m FROM canteen_orders WHERE tenant_id=? AND day=?', tn.id, day)).m || 0) + 1;
      const o = { id: uid(), tenant_id: tn.id, day, token_no: n, view_key: crypto.randomBytes(12).toString('base64url'), device_hash: dv.token_hash, email: dv.email, name,
        phone: str(b.phone, 20) || null, note: str(b.note, 200) || null, items: JSON.stringify(out), total_paise: total, status: 'placed', created_at: now(), pay_mode: mode, pay_status: 'unpaid', fulfil, has_booked: out.some(x => x.booked) ? 1 : 0, deliver_to: deliverTo, deliver_addr: addr ? JSON.stringify(addr) : null, delivery_fee_paise: fee };
      try {
        await run(`INSERT INTO canteen_orders (${Object.keys(o).join(',')}) VALUES (${Object.keys(o).map(() => '?').join(',')})`, ...Object.values(o));
        return { ...pub(o), key: o.view_key };
      } catch (e) { if (e.code !== '23505') throw e; }
    }
    throw new HttpErr(503, 'BUSY', 'The canteen is busy, please try again');
  }));
  const orderByKey = async req => {
    const tn = await tenantBySlug(req.params.slug); if (!tn.canteen_on) throw notFound(); const o = await one('SELECT * FROM canteen_orders WHERE id=? AND tenant_id=?', req.params.id, tn.id);
    const k = String(req.query.k || req.body?.k || '');
    if (!o || k.length !== o.view_key.length || !crypto.timingSafeEqual(Buffer.from(k), Buffer.from(o.view_key))) throw notFound();
    return { tn, o };
  };
  P.get('/:slug/canteen/orders/:id', wrap(async req => { let { tn, o } = await orderByKey(req);
    if (o.status === 'placed') { await expire(tn); o = await one('SELECT * FROM canteen_orders WHERE id=?', o.id); }
    const pay = payOf(tn), upi = o.status === 'placed' && o.pay_mode === 'upi' && pay.upi_id ? { link: upiLink(pay, o), id: pay.upi_id, name: pay.upi_name } : null;
    const pay_by = o.status === 'placed' && o.pay_status === 'unpaid' ? new Date(Date.parse(o.created_at) + pay.pay_window_min * 6e4).toISOString() : null;
    const ahead = ['placed', 'accepted'].includes(o.status) ? (await one(`SELECT count(*) n FROM canteen_orders WHERE tenant_id=? AND day=? AND token_no<? AND status='accepted'`, tn.id, o.day, o.token_no)).n : 0;
    return { ...pub(o), canteen: canteenName(tn), ahead, wait_min: await prepMin(tn.id), upi, pay_by }; }));
  // the student paid by UPI: they send the reference number (UTR) from their UPI app; staff check it and send the order to the kitchen
  P.post('/:slug/canteen/orders/:id/upi-ref', wrap(async req => {
    const { tn, o } = await orderByKey(req); limit('cupi:' + o.id, 10);
    const ref = str(req.body.ref, 40).replace(/\s/g, ''); if (!UTR.test(ref)) throw bad('Enter the UPI reference number (UTR) from your UPI app: 6 to 30 letters or digits');
    if (o.status !== 'placed' || o.pay_mode !== 'upi') throw bad('This order is not waiting for a UPI payment');
    if (await one('SELECT 1 FROM canteen_orders WHERE tenant_id=? AND upper(upi_ref)=upper(?) AND id<>?', tn.id, ref, o.id)) throw bad('That reference number is already used on another order');
    await run(`UPDATE canteen_orders SET upi_ref=?, pay_status='claimed' WHERE id=? AND status='placed'`, ref, o.id);
    return { ok: true, pay_status: 'claimed' };
  }));
  // the same UPI payment as a QR code (for paying from another phone or a laptop screen)
  P.get('/:slug/canteen/orders/:id/upi.svg', async (req, res, next) => { try { const { tn, o } = await orderByKey(req), pay = payOf(tn);
    if (!pay.upi_id || o.pay_mode !== 'upi') throw notFound();
    res.set('Content-Type', 'image/svg+xml').send(await QRCode.toString(upiLink(pay, o), { type: 'svg', margin: 1, errorCorrectionLevel: 'M' })); } catch (e) { next(e); } });
  P.post('/:slug/canteen/orders/:id/cancel', wrap(async req => {
    const { o } = await orderByKey(req);
    if (o.pay_status === 'claimed') throw bad('You sent a UPI payment for this order. Please ask at the counter.');
    const r = await run(`UPDATE canteen_orders SET status='cancelled', closed_at=? WHERE id=? AND status='placed' AND coalesce(pay_status,'unpaid')='unpaid'`, now(), o.id);
    if (!r.changes) throw bad('The canteen has already taken this order, so it can no longer be cancelled.');
    return pub({ ...o, status: 'cancelled' });
  }));
  // this device's recent orders (the last 3 days), for "My orders"
  P.post('/:slug/canteen/mine', wrap(async req => {
    const tn = await tenantBySlug(req.params.slug), dv = await deviceOf(tn.id, req.body.device); if (!dv) return []; await expire(tn);
    const rows = await all('SELECT * FROM canteen_orders WHERE device_hash=? AND tenant_id=? AND day>=? ORDER BY created_at DESC LIMIT 20', dv.token_hash, tn.id, addDays(dayOf(tn.timezone), -2));
    return rows.map(o => ({ ...pub(o), key: o.view_key }));
  }));

  // ================= canteen desk (signed in) =================
  S.get('/canteen/access', wrap(async req => { const a = await access(req);
    return { setup: a.setup, manage: a.manage, manager: !!a.manager, kitchen: !!a.kitchen, cook: !!a.cook, rename: a.setup || !!a.manager || a.req_admin, on: !!a.tenant?.canteen_on, open: a.tenant ? isOpen(a.tenant) : false, name: a.tenant ? canteenName(a.tenant) : null }; }));
  // super admin: switch on for the campus, pick 1–2 desk providers as managers
  S.get('/canteen/setup', wrap(async req => {
    if (req.user.role !== 'super_admin') throw forbid(); if (!req.tenantId) throw bad('Pick a campus first');
    const tn = await tenantRow(req.tenantId);
    return { on: !!tn.canteen_on, slug: tn.slug, name: tn.canteen_name || '', default_name: `${tn.name} Canteen`, managers: (await all(`SELECT user_id FROM canteen_managers WHERE tenant_id=? AND coalesce(kind,'manager')='manager'`, req.tenantId)).map(r => r.user_id),
      kitchen: (await all(`SELECT user_id FROM canteen_managers WHERE tenant_id=? AND kind='kitchen'`, req.tenantId)).map(r => r.user_id), max_kitchen: MAX_KITCHEN,
      providers: await all(`SELECT id, name, email FROM users WHERE tenant_id=? AND role='provider' AND is_active=1 ORDER BY name`, req.tenantId), max: MAX_MANAGERS };
  }));
  S.put('/canteen/setup', wrap(async req => {
    if (req.user.role !== 'super_admin') throw forbid(); if (!req.tenantId) throw bad('Pick a campus first');
    const on = !!req.body.on, ids = [...new Set((req.body.managers || []).map(String))];
    if (ids.length > MAX_MANAGERS) throw bad(`Pick at most ${MAX_MANAGERS} canteen managers`);
    if (on && !ids.length) throw bad('Pick at least one desk provider as canteen manager');
    const ok = await all(`SELECT id FROM users WHERE tenant_id=? AND role='provider' AND is_active=1 AND id = ANY(?::text[])`, req.tenantId, ids);
    if (ok.length !== ids.length) throw bad('Canteen managers must be active service providers on this campus');
    const kit = req.body.kitchen === undefined ? null : [...new Set((req.body.kitchen || []).map(String))];
    if (kit) { if (kit.length > MAX_KITCHEN) throw bad(`Pick at most ${MAX_KITCHEN} kitchen staff`);
      if (kit.some(id => ids.includes(id))) throw bad('A person is either a canteen manager or kitchen staff, not both');
      const ok2 = await all(`SELECT id FROM users WHERE tenant_id=? AND role='provider' AND is_active=1 AND id = ANY(?::text[])`, req.tenantId, kit);
      if (ok2.length !== kit.length) throw bad('Kitchen staff must be active service providers on this campus'); }
    await run('UPDATE tenants SET canteen_on=?, canteen_name=? WHERE id=?', on ? 1 : 0, str(req.body.name, 60) || null, req.tenantId);
    if (!on) await run('UPDATE tenants SET canteen_open_day=NULL WHERE id=?', req.tenantId); // switched off: closed too
    await run(`DELETE FROM canteen_managers WHERE tenant_id=? ${kit ? '' : "AND coalesce(kind,'manager')='manager'"}`, req.tenantId);
    if (!kit) await run('DELETE FROM canteen_managers WHERE tenant_id=? AND user_id = ANY(?::text[])', req.tenantId, ids); // made a manager: no longer kitchen
    for (const id of ids) await run(`INSERT INTO canteen_managers (tenant_id, user_id, created_at, kind) VALUES (?,?,?,'manager')`, req.tenantId, id, now());
    for (const id of kit || []) await run(`INSERT INTO canteen_managers (tenant_id, user_id, created_at, kind) VALUES (?,?,?,'kitchen')`, req.tenantId, id, now());
    return { on, managers: ids, kitchen: kit };
  }));

  // rename: the super admin, the canteen managers and the campus admin (not other providers)
  S.put('/canteen/name', wrap(async req => { const a = await need(req); if (!(a.setup || a.manager || req.user.role === 'tenant_admin')) throw forbid();
    const name = str(req.body.name, 60); if (name && name.length < 2) throw bad('The name is too short');
    await run('UPDATE tenants SET canteen_name=? WHERE id=?', name || null, req.tenantId); return { name: canteenName({ ...a.tenant, canteen_name: name || null }) }; }));
  S.put('/canteen/hours', wrap(async req => { const a = await need(req); if (!(a.setup || a.manager || req.user.role === 'tenant_admin')) throw forbid();
    const b = req.body; if (b.clear) { await run('UPDATE tenants SET canteen_hours=NULL WHERE id=?', req.tenantId); return { hours: null }; }
    if (!HM.test(b.open || '') || !HM.test(b.close || '')) throw bad('Enter opening and closing times');
    if (toMin(b.close) <= toMin(b.open)) throw bad('Closing time must be after opening time');
    const days = [...new Set((b.days || []).map(Number))].filter(d => d >= 0 && d <= 6).sort(); if (!days.length) throw bad('Pick at least one day');
    const last = Math.max(0, Math.min(120, Math.floor(Number(b.last_order_min) || 0))); if (last >= toMin(b.close) - toMin(b.open)) throw bad('The last-order cut-off is longer than the opening hours');
    const h = { open: b.open, close: b.close, days, last_order_min: last };
    await run('UPDATE tenants SET canteen_hours=? WHERE id=?', JSON.stringify(h), req.tenantId); return { hours: h }; }));
  // payments and delivery (same people as the name and timings)
  S.put('/canteen/payments', wrap(async req => { const a = await need(req); if (!(a.setup || a.manager || req.user.role === 'tenant_admin')) throw forbid();
    const b = req.body, p = { cash: !!b.cash, upi_id: str(b.upi_id, 100), upi_name: str(b.upi_name, 60), delivery: !!b.delivery,
      delivery_fee: Number(b.delivery_fee) || 0, delivery_note: str(b.delivery_note, 120), pay_window_min: Math.floor(Number(b.pay_window_min) || 20),
      delivery_blocks: [...new Set((Array.isArray(b.delivery_blocks) ? b.delivery_blocks : String(b.delivery_blocks || '').split('\n')).map(x => str(x, 60)).filter(Boolean))].slice(0, 100) };
    if (p.upi_id && !UPI_ID.test(p.upi_id)) throw bad('Enter a UPI ID like canteen@okhdfcbank');
    if (!p.cash && !p.upi_id) throw bad('Turn on cash or add a UPI ID: students need a way to pay');
    if (p.delivery_fee < 0 || p.delivery_fee > 500) throw bad('Delivery charge must be ₹0 to ₹500');
    if (p.pay_window_min < 5 || p.pay_window_min > 120) throw bad('Time to pay must be 5 to 120 minutes');
    await run('UPDATE tenants SET canteen_pay=? WHERE id=?', JSON.stringify(p), req.tenantId); return p; }));
  // ---- menu ----
  S.get('/canteen/menu', wrap(async req => { const a = await need(req); return { campus_blocks: await blocksOf({ ...a.tenant, canteen_pay: null }), pay: payOf(a.tenant), link: shortLink(a.tenant), hours: hoursOf(a.tenant), state: stateOf(a.tenant), name: canteenName(a.tenant), open: isOpen(a.tenant), day: dayOf(a.tenant.timezone), slug: a.tenant.slug, ...(await menuOf(req.tenantId, true)) }; }));
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
    if (b.deal_pct !== undefined) { const pct = Math.floor(Number(b.deal_pct) || 0);
      if (pct === 0) Object.assign(f, { deal_pct: 0, deal_kind: null, deal_until: null });
      else { if (pct < 1 || pct > 90) throw bad('Discount must be 1% to 90%'); if (!DEAL_KINDS[b.deal_kind]) throw bad('Pick discount, flash sale or end-of-day sale');
        const mins = Math.floor(Number(b.deal_minutes) || 0); if (b.deal_kind !== 'discount' && !(mins >= 5 && mins <= 1440)) throw bad('A flash or end-of-day sale needs a time: 5 minutes to 24 hours');
        Object.assign(f, { deal_pct: pct, deal_kind: b.deal_kind, deal_until: mins ? new Date(Date.now() + mins * 6e4).toISOString() : null }); } }
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

  // end-of-day sale on everything still in stock (or a flash sale on all), and ending every deal at once
  S.post('/canteen/deals/all', wrap(async req => { await need(req); const b = req.body, pct = Math.floor(Number(b.pct) || 0), mins = Math.floor(Number(b.minutes) || 0), kind = b.kind === 'flash' ? 'flash' : 'eod';
    if (pct < 1 || pct > 90) throw bad('Discount must be 1% to 90%'); if (mins < 5 || mins > 1440) throw bad('Pick how long: 5 minutes to 24 hours');
    const r = await run('UPDATE canteen_items SET deal_pct=?, deal_kind=?, deal_until=? WHERE tenant_id=? AND active=1 AND sold_out=0', pct, kind, new Date(Date.now() + mins * 6e4).toISOString(), req.tenantId);
    return { items: r.changes }; }));
  S.delete('/canteen/deals', wrap(async req => { await need(req); const r = await run('UPDATE canteen_items SET deal_pct=0, deal_kind=NULL, deal_until=NULL WHERE tenant_id=? AND deal_pct>0', req.tenantId); return { ended: r.changes }; }));

  // ---- open / close for the day ----
  S.post('/canteen/open', wrap(async req => { const a = await need(req), day = dayOf(a.tenant.timezone);
    if (a.tenant.canteen_stock_day !== day) await run('UPDATE canteen_items SET sold_out=0 WHERE tenant_id=?', req.tenantId); // a fresh day: everything back in stock (reopening the same day keeps the marks)
    await run('UPDATE tenants SET canteen_open_day=?, canteen_stock_day=? WHERE id=?', day, day, req.tenantId); return { open: true, day }; }));
  S.post('/canteen/close', wrap(async req => { await need(req); await run('UPDATE tenants SET canteen_open_day=NULL WHERE id=?', req.tenantId);
    const p = await one(`SELECT count(*) n FROM canteen_orders WHERE tenant_id=? AND status IN ${LIVE}`, req.tenantId); return { open: false, pending: p.n }; }));

  // ---- orders ----
  S.get('/canteen/orders', wrap(async req => { const a0 = await need(req); await expire(a0.tenant); const a = a0, day = /^\d{4}-\d{2}-\d{2}$/.test(req.query.day || '') ? req.query.day : dayOf(a.tenant.timezone);
    const rows = await all(`SELECT * FROM canteen_orders WHERE tenant_id=? AND (day=? OR (day<? AND status IN ${LIVE})) ORDER BY day DESC, token_no DESC`, req.tenantId, day, day);
    return { day, open: isOpen(a.tenant), state: stateOf(a.tenant), name: canteenName(a.tenant), orders: rows.map(o => ({ ...pub(o), email: o.email, phone: o.phone, earlier: o.day !== day })) }; }));
  S.post('/canteen/orders/:id/:to(accepted|rejected|ready|out|collected)', wrap(async req => {
    const to = req.params.to, a = to === 'ready' ? await needKitchen(req) : await need(req), o = await one('SELECT * FROM canteen_orders WHERE id=? AND tenant_id=?', req.params.id, req.tenantId);
    if (!o) throw notFound();
    if (!(NEXT[o.status] || []).includes(to)) throw bad(`This order is ${STATUS[o.status].toLowerCase()}; it can't be marked ${to}.`);
    const reason = str(req.body.reason, 200); if (to === 'rejected' && reason.length < 3) throw bad('Please give the student a reason for rejecting');
    if (to === 'out' && o.fulfil !== 'delivery') throw bad('This order is for pickup at the counter');
    if (to === 'accepted') { // payment confirmed by staff: cash taken at the counter, or the UPI payment seen in the canteen's UPI app
      const r0 = await run(`UPDATE canteen_orders SET pay_status='paid', paid_at=?, paid_by=? WHERE id=? AND status='placed'`, now(), req.user.id, o.id); if (!r0.changes) throw bad('Someone else just updated this order. Please refresh.'); }
    const col = { accepted: 'accepted_at', ready: 'ready_at', out: 'out_at', collected: 'collected_at', rejected: 'closed_at' }[to];
    const r = await run(`UPDATE canteen_orders SET status=?, ${col}=?, ${to === 'collected' ? 'closed_at=?,' : ''} reject_reason=?, handled_by=? WHERE id=? AND status=?`,
      to, now(), ...(to === 'collected' ? [now()] : []), to === 'rejected' ? reason : o.reject_reason, req.user.id, o.id, o.status);
    if (!r.changes) throw bad('Someone else just updated this order. Please refresh.');
    const n = { ...o, status: to, reject_reason: to === 'rejected' ? reason : o.reject_reason }, tk = tokenLabel(o.token_no);
    if (to === 'ready' && o.fulfil !== 'delivery') await mail(a.tenant, o.email, 'canteen_ready', `Order ${tk} is ready to collect`, [`Hi ${esc(o.name)},`, `Your order <b>${tk}</b> is ready. Show the token at the counter to collect it.`], orderLink(a.tenant, o));
    if (to === 'out') await mail(a.tenant, o.email, 'canteen_out', `Order ${tk} is on its way`, [`Hi ${esc(o.name)},`, `Your order <b>${tk}</b> is out for delivery to ${esc(o.deliver_to)}.`], orderLink(a.tenant, o));
    if (to === 'rejected') await mail(a.tenant, o.email, 'canteen_rejected', `Order ${tk} could not be accepted`, [`Hi ${esc(o.name)},`, `Sorry, the canteen could not take your order <b>${tk}</b>.`, `Reason: ${esc(reason)}`,
      ...(o.pay_status === 'paid' || o.pay_status === 'claimed' ? [`If you already paid ${rupees(o.total_paise)}, please collect your refund at the counter with this token.`] : [])], orderLink(a.tenant, o));
    return pub(n);
  }));

  // ---- kitchen: KOTs (paid orders) ----
  S.get('/canteen/kitchen', wrap(async req => { const a = await needKitchen(req);
    const rows = await all(`SELECT * FROM canteen_orders WHERE tenant_id=? AND (status='accepted' OR (status IN ('ready','out','collected') AND ready_at > ?)) ORDER BY accepted_at`, req.tenantId, new Date(Date.now() - 2 * 3600e3).toISOString());
    return { name: canteenName(a.tenant), cook: !!a.cook, kots: rows.filter(o => o.status === 'accepted').map(pub), done: rows.filter(o => o.status !== 'accepted').reverse().slice(0, 20).map(pub) }; }));
  S.post('/canteen/kitchen/:id/start', wrap(async req => { await needKitchen(req);
    const r = await run(`UPDATE canteen_orders SET kot_started_at=?, kot_by=? WHERE id=? AND tenant_id=? AND status='accepted' AND kot_started_at IS NULL`, now(), req.user.id, req.params.id, req.tenantId);
    if (!r.changes) throw bad('This KOT was already started or is no longer in the kitchen. Please refresh.'); return { ok: true }; }));

  // ---- reports: collected orders ----
  S.get('/canteen/report', wrap(async req => { const a = await need(req), today = dayOf(a.tenant.timezone);
    const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : addDays(today, -6), to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : today;
    const rows = await all('SELECT * FROM canteen_orders WHERE tenant_id=? AND day>=? AND day<=? ORDER BY day, token_no', req.tenantId, from, to);
    const done = rows.filter(o => o.status === 'collected'), items = {}, cats = {}, hours = Array.from({ length: 24 }, (_, h) => ({ hour: h, orders: 0, paise: 0 })), kinds = {};
    const catNow = Object.fromEntries((await all('SELECT i.id, c.name FROM canteen_items i LEFT JOIN canteen_categories c ON c.id=i.category_id WHERE i.tenant_id=?', req.tenantId)).map(r => [r.id, r.name]));
    const hourOf = iso => +new Intl.DateTimeFormat('en-GB', { timeZone: a.tenant.timezone || 'Asia/Kolkata', hour: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
    let discount = 0;
    for (const o of done) { const h = hours[hourOf(o.created_at)]; h.orders++; h.paise += o.total_paise;
      for (const it of JSON.parse(o.items)) { const e = items[it.name] ||= { name: it.name, category: it.category || catNow[it.id] || 'No category', qty: 0, paise: 0, discount_paise: 0 }; e.qty += it.qty; e.paise += it.qty * it.price_paise;
        const c = cats[e.category] ||= { category: e.category, qty: 0, paise: 0 }; c.qty += it.qty; c.paise += it.qty * it.price_paise;
        if (it.mrp_paise) { const off = (it.mrp_paise - it.price_paise) * it.qty; discount += off; e.discount_paise += off; const k = kinds[it.deal] ||= { kind: it.deal, name: DEAL_KINDS[it.deal] || it.deal, qty: 0, paise: 0, discount_paise: 0 }; k.qty += it.qty; k.paise += it.qty * it.price_paise; k.discount_paise += off; } } }
    const per = {}; for (const o of done) per[o.email] = (per[o.email] || 0) + 1;
    const days = []; for (let d = from; d <= to && days.length < 92; d = addDays(d, 1)) { const x = done.filter(o => o.day === d);
      days.push({ day: d, orders: x.length, paise: x.reduce((s, o) => s + o.total_paise, 0), rejected: rows.filter(o => o.day === d && o.status === 'rejected').length }); }
    const prep = done.filter(o => o.accepted_at && o.ready_at).map(o => (Date.parse(o.ready_at) - Date.parse(o.accepted_at)) / 6e4);
    const revenue = done.reduce((s, o) => s + o.total_paise, 0);
    return { from, to, collected: done.length, revenue_paise: revenue, aov_paise: done.length ? Math.round(revenue / done.length) : 0, discount_paise: discount,
      customers: Object.keys(per).length, repeat_customers: Object.values(per).filter(n => n > 1).length, pickups: done.filter(o => o.fulfil !== 'delivery').length,
      delivery_fee_paise: done.reduce((s, o) => s + (o.delivery_fee_paise || 0), 0), hours: hours.filter(h => h.orders), categories: Object.values(cats).sort((x, y) => y.paise - x.paise),
      items_all: Object.values(items).sort((x, y) => y.paise - x.paise), deals: Object.values(kinds),
      rejected: rows.filter(o => o.status === 'rejected').length, cancelled: rows.filter(o => o.status === 'cancelled').length,
      avg_prep_min: prep.length ? Math.round(prep.reduce((x, y) => x + y, 0) / prep.length) : null,
      reasons: Object.entries(rows.filter(o => o.status === 'rejected').reduce((m, o) => (m[o.reject_reason] = (m[o.reject_reason] || 0) + 1, m), {})).map(([reason, count]) => ({ reason, count })).sort((x, y) => y.count - x.count).slice(0, 8),
      top: Object.values(items).sort((x, y) => y.qty - x.qty).slice(0, 15), days,
      cash_paise: done.filter(o => (o.pay_mode || 'cash') === 'cash').reduce((s, o) => s + o.total_paise, 0), upi_paise: done.filter(o => o.pay_mode === 'upi').reduce((s, o) => s + o.total_paise, 0),
      deliveries: done.filter(o => o.fulfil === 'delivery').length, not_paid: rows.filter(o => o.reject_reason === 'Not paid in time').length,
      refunds: rows.filter(o => o.status === 'rejected' && ['paid', 'claimed'].includes(o.pay_status)).map(o => ({ token: tokenLabel(o.token_no), day: o.day, name: o.name, paise: o.total_paise, mode: o.pay_mode, ref: o.upi_ref })) };
  }));
  // every order in the period as a spreadsheet (one row per order)
  S.get('/canteen/orders.csv', async (req, res, next) => { try { const a = await need(req), today = dayOf(a.tenant.timezone);
    const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : addDays(today, -6), to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : today;
    const rows = await all('SELECT * FROM canteen_orders WHERE tenant_id=? AND day>=? AND day<=? ORDER BY day, token_no', req.tenantId, from, to);
    const q = v => { const t = String(v ?? ''); return /[",\n]/.test(t) || /^[=+\-@]/.test(t) ? `"${t.replace(/^([=+\-@])/, "'$1").replace(/"/g, '""')}"` : t; };
    const ist = iso => iso ? new Date(iso).toLocaleString('en-IN', { timeZone: a.tenant.timezone || 'Asia/Kolkata' }) : '';
    const head = ['Day', 'Order', 'Status', 'Name', 'Email', 'Phone', 'Items', 'Qty', 'Discount (₹)', 'Delivery fee (₹)', 'Total (₹)', 'Payment', 'Paid', 'UTR', 'Pickup / delivery', 'Deliver to', 'Placed', 'Paid at', 'Ready', 'Done', 'Reason'];
    const lines = rows.map(o => { const it = JSON.parse(o.items), sh = pub(o); return [o.day, tokenLabel(o.token_no), sh.status_text, o.name, o.email, o.phone, it.map(i => `${i.qty} x ${i.name}`).join('; '), it.reduce((n, i) => n + i.qty, 0),
      (it.reduce((n, i) => n + ((i.mrp_paise || i.price_paise) - i.price_paise) * i.qty, 0) / 100).toFixed(2), ((o.delivery_fee_paise || 0) / 100).toFixed(2), (o.total_paise / 100).toFixed(2), o.pay_mode === 'upi' ? 'UPI' : 'Cash', o.pay_status === 'paid' ? 'Yes' : 'No', o.upi_ref,
      o.fulfil === 'delivery' ? 'Delivery' : 'Pickup', o.deliver_to, ist(o.created_at), ist(o.paid_at), ist(o.ready_at), ist(o.collected_at || o.closed_at), o.reject_reason].map(q).join(','); });
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="canteen-orders-${from}-to-${to}.csv"` }).send('\ufeff' + [head.join(','), ...lines].join('\r\n'));
  } catch (e) { next(e); } });
}
