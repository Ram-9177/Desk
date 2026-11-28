// Canteen: students order food from a campus link and collect it at the counter with a token (#047).
// The super admin switches the canteen on for a campus and picks one or two desk providers as canteen managers.
// Managers build the menu, open the canteen for the day (sold-out per item), accept or reject orders (a reason is
// required), mark them ready and then collected; collected orders feed the canteen reports.
// Students browse without logging in; the first order on a device verifies their email with a one-time code.
// Self-contained: own tables, own routes; wired from server.js with one call.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { kindOf, heicToJpeg, SHOWN } from './images.js';
import { campusOn } from './public/shared.js';
// qrcode is loaded only when a QR code is asked for: if the package is missing (npm ci not run after a deploy),
// only the QR image fails, with a clear message, and the rest of ONE Desk keeps running
let qrLib = null;
const qrSvg = async text => { if (!qrLib) { try { qrLib = (await import('qrcode')).default; } catch { console.error('QR code: the "qrcode" package is not installed. Run: npm ci --omit=dev'); const e = new Error('QR codes need the qrcode package. Run npm ci on the server.'); e.status = 503; e.code = 'QR_MISSING'; throw e; } }
  return qrLib.toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#0F172A', light: '#FFFFFF' } }); };
import { pool, one, all, run, uid, now, tx } from './db.js';
import fsp from 'node:fs/promises'; // the menu upload reads files with promises; photos use the plain fs above
import { Worker } from 'node:worker_threads';

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
ALTER TABLE canteen_items ADD COLUMN IF NOT EXISTS image_key TEXT;
-- a person's own permissions (JSON list of features); NULL = their job's defaults
ALTER TABLE canteen_managers ADD COLUMN IF NOT EXISTS perms TEXT;
-- inventory: raw stock (rice, oil, milk, gas …) with every change kept
CREATE TABLE IF NOT EXISTS canteen_inv_items (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), name TEXT NOT NULL, unit TEXT NOT NULL, category TEXT,
  qty DOUBLE PRECISION NOT NULL DEFAULT 0, min_qty DOUBLE PRECISION NOT NULL DEFAULT 0, cost_paise INT NOT NULL DEFAULT 0, active INT DEFAULT 1, created_at TEXT, updated_at TEXT);
CREATE INDEX IF NOT EXISTS cinv_t ON canteen_inv_items(tenant_id, active);
ALTER TABLE canteen_inv_items ALTER COLUMN cost_paise TYPE DOUBLE PRECISION; -- per gram or ml the cost is a fraction of a paisa
-- inventory categories (Grains, Dairy, Vegetables …): their own list; an item keeps the category's id and, for reading, its name
CREATE TABLE IF NOT EXISTS canteen_inv_categories (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), name TEXT NOT NULL, sort_order INT DEFAULT 0, created_at TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS cinvc_name ON canteen_inv_categories(tenant_id, lower(name));
ALTER TABLE canteen_inv_items ADD COLUMN IF NOT EXISTS category_id TEXT;
-- categories typed on items before this list existed become real categories
INSERT INTO canteen_inv_categories (id, tenant_id, name, sort_order, created_at)
  SELECT md5(tenant_id || ':' || lower(category)), tenant_id, min(category), 0, now()::text FROM canteen_inv_items WHERE category IS NOT NULL AND category_id IS NULL GROUP BY tenant_id, lower(category) ON CONFLICT DO NOTHING;
UPDATE canteen_inv_items i SET category_id = c.id FROM canteen_inv_categories c WHERE i.category_id IS NULL AND i.category IS NOT NULL AND c.tenant_id = i.tenant_id AND lower(c.name) = lower(i.category);
CREATE TABLE IF NOT EXISTS canteen_inv_moves (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, item_id TEXT NOT NULL REFERENCES canteen_inv_items(id), kind TEXT NOT NULL CHECK (kind IN ('in','use','waste','count')),
  qty DOUBLE PRECISION NOT NULL, before_qty DOUBLE PRECISION, after_qty DOUBLE PRECISION, cost_paise INT DEFAULT 0, note TEXT, user_id TEXT, user_name TEXT, created_at TEXT);
CREATE INDEX IF NOT EXISTS cinvm_t ON canteen_inv_moves(tenant_id, created_at);
-- the counter (POS): walk-in sales by counter staff (kind='counter'), cash received / change, and printed bills and KOTs
ALTER TABLE canteen_orders ADD COLUMN IF NOT EXISTS channel TEXT DEFAULT 'online';
ALTER TABLE canteen_orders ADD COLUMN IF NOT EXISTS cash_tendered_paise INT;
ALTER TABLE canteen_orders ADD COLUMN IF NOT EXISTS bill_prints INT DEFAULT 0;
ALTER TABLE canteen_orders ADD COLUMN IF NOT EXISTS kot_prints INT DEFAULT 0;
-- a running bill number per canteen (given when the payment is taken), dine in / takeaway with a table number at the counter
ALTER TABLE canteen_orders ADD COLUMN IF NOT EXISTS bill_no INT;
ALTER TABLE canteen_orders ADD COLUMN IF NOT EXISTS service TEXT;
ALTER TABLE canteen_orders ADD COLUMN IF NOT EXISTS table_no TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS cord_bill ON canteen_orders(tenant_id, bill_no) WHERE bill_no IS NOT NULL;
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
const PAY_DEFAULT = { cash: true, upi_id: '', upi_name: '', delivery: false, delivery_fee: 0, delivery_note: '', pay_window_min: 20, delivery_blocks: [], paper: '80', auto_kot: false, auto_bill: true, bill_footer: 'Thanks for choosing us', tagline: '', delivery_cash: false, kot_at_counter: true, prep_sla_min: 15, delivery_sla_min: 20 }; // the canteen's own SLA (minutes), separate from the ticket desk's // one printer at the counter: the KOT prints there right after the bill // delivery is paid by UPI unless the manager allows cash (the student pays at the counter first)
const FLOORS = ['Ground floor', '1st floor', '2nd floor', '3rd floor', '4th floor', '5th floor', '6th floor'];
export const payOf = tn => { try { return { ...PAY_DEFAULT, ...JSON.parse(tn.canteen_pay || '{}') }; } catch { return { ...PAY_DEFAULT }; } };
const UPI_ID = /^[\w.\-]{2,60}@[A-Za-z][\w.\-]{1,40}$/, UTR = /^[A-Za-z0-9]{6,30}$/;
const upiLink = (p, o) => `upi://pay?${new URLSearchParams({ pa: p.upi_id, pn: p.upi_name || 'Canteen', am: (o.total_paise / 100).toFixed(2), cu: 'INR', tn: `Canteen order ${tokenLabel(o.token_no)}` })}`;
export const DEAL_KINDS = { discount: 'Discount', flash: 'Flash sale', eod: 'End-of-day sale' };
// an item's live deal and the price a student pays now
export const dealOf = it => it.deal_pct > 0 && it.deal_kind && (!it.deal_until || it.deal_until > new Date().toISOString()) ? { pct: it.deal_pct, kind: it.deal_kind, until: it.deal_until } : null;
const priceNow = it => { const d = dealOf(it); return d ? Math.round(it.price_paise * (100 - d.pct) / 100) : it.price_paise; };
// ---- permissions: one list of features; each canteen job has defaults, and a person can be given their own set ----
export const FEATURES = [['pos', 'Counter (POS): sell to walk-in customers'], ['orders', 'Orders: take payments, reject, ready, hand over'], ['openclose', 'Open / close the canteen for the day'],
  ['stock', 'Mark items sold out / back in stock'], ['kitchen', 'Kitchen KOT screen'], ['menu', 'Menu: items, prices, photos, deals, categories'], ['settings', 'Name, timings, payments, delivery, printing'],
  ['reports', 'Reports and CSV'], ['inventory', 'Inventory: stock of ingredients']];
const FKEYS = FEATURES.map(f => f[0]);
export const JOBS = { manager: FKEYS, counter: ['pos', 'orders', 'openclose', 'stock'], kitchen: ['kitchen', 'stock'], owner: ['reports'], inventory: ['inventory'] };
const permsOf = row => { if (!row) return []; try { const p = JSON.parse(row.perms || 'null'); if (Array.isArray(p)) return p.filter(f => FKEYS.includes(f)); } catch { /* default */ } return JOBS[row.kind || 'manager'] || []; };
const MAX_KITCHEN = 10, MAX_MANAGERS = 2, MAX_LINES = 30, MAX_QTY = 20, MAX_OPEN_PER_DEVICE = 3, OTP_MIN = 10, DEVICE_DAYS = 180;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const str = (v, max) => String(v ?? '').trim().slice(0, max);
const sha = v => crypto.createHash('sha256').update(String(v)).digest('hex');
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const rupees = p => '₹' + (p / 100).toFixed(p % 100 ? 2 : 0);
export const tokenLabel = n => '#' + String(n).padStart(3, '0');
const dayOf = (tz, d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'Asia/Kolkata' }).format(d);
export const canteenName = tn => tn.canteen_name || `${tn.name} Canteen`;
export const canteenLive = tn => !!tn?.canteen_on && campusOn(tn, 'canteen'); // Canteen → Set up on, and the campus has Canteen on (Tenants → Features)
const isOpen = tn => canteenLive(tn) && tn.canteen_open_day === dayOf(tn.timezone); // opened by a manager today
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
  if (!canteenLive(tn)) return { ...base, accepting: false, why: 'off' };
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
// One rule for "the same item": a name is unique across a campus's menu (its active items), compared without case, outer spaces
// or repeated inner spaces ("Masala  Dosa " = "masala dosa"), é typed either way. Used by Add item, Edit item, the import and its category names.
export const nameKey = v => String(v ?? '').normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
// a downloaded menu file: a cell with a comma, quote or newline is quoted; typed text starting = + - @ (or a tab or CR) gets a ' so a spreadsheet
// shows it instead of running it (the upload takes that ' off again: see unq)
const csvCell = (v, text) => { let s = String(v ?? ''); if (text && /^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const unq = s => /^'[=+\-@\t\r]/.test(s) ? s.slice(1) : s;
// minutes left on a running deal as the file writes them (5 to 1440, what the upload accepts)
const dealMinutesLeft = until => Math.min(1440, Math.max(5, Math.ceil((Date.parse(until) - Date.now()) / 6e4)));
// The rules for an item's own fields, shared by Add / Edit item and the menu upload (no database: the category is checked by the caller).
// Returns { f } with the columns to save, or { error } with the message a manager sees.
export function itemRules(b, partial) {
  const f = {};
  if (!partial || b.name !== undefined) { f.name = str(b.name, 80).replace(/\s+/g, ' '); if (!f.name) return { error: 'Item name required' }; } // stored with repeated spaces collapsed
  if (!partial || b.price !== undefined) { f.price_paise = parsePrice(b.price); if (f.price_paise == null) return { error: 'Enter a price in rupees, e.g. 40 or 12.50' }; }
  if (b.description !== undefined) f.description = str(b.description, 200) || null;
  if (b.is_veg !== undefined) f.is_veg = b.is_veg ? 1 : 0;
  if (b.sold_out !== undefined) f.sold_out = b.sold_out ? 1 : 0;
  if (b.active !== undefined) f.active = b.active ? 1 : 0;
  if (Number.isInteger(b.sort_order)) f.sort_order = b.sort_order;
  if (b.deal_pct !== undefined) { const pct = Math.floor(Number(b.deal_pct) || 0);
    if (pct === 0) Object.assign(f, { deal_pct: 0, deal_kind: null, deal_until: null });
    else { if (pct < 1 || pct > 90) return { error: 'Discount must be 1% to 90%' }; if (!DEAL_KINDS[b.deal_kind]) return { error: 'Pick discount, flash sale or end-of-day sale' };
      const mins = Math.floor(Number(b.deal_minutes) || 0); if (b.deal_kind !== 'discount' && !(mins >= 5 && mins <= 1440)) return { error: 'A flash or end-of-day sale needs a time: 5 minutes to 24 hours' };
      Object.assign(f, { deal_pct: pct, deal_kind: b.deal_kind, deal_until: mins ? new Date(Date.now() + mins * 6e4).toISOString() : null }); } }
  return { f };
}
// ---- menu upload: what a file column can map to, and turning one file row (text cells) into what itemRules takes ----
export const MENU_FIELDS = ['category', 'name', 'price', 'description', 'is_veg', 'sold_out', 'active', 'sort_order', 'deal_pct', 'deal_kind', 'deal_minutes'];
const MAX_UPLOAD_ROWS = 500, MAX_UPLOAD_COLS = 50, MAX_UPLOAD_BYTES = 5 * 1024 * 1024, MAX_ITEMS = 500, MAX_CATS = 50;
// an .xlsx is unpacked, counted and read in a small worker, one at a time (xlsx-worker.js): one cell at XFD200000 in a 1.5 KB file would otherwise take all the memory
const XLSX_WORKER_MB = 48, XLSX_RSS_MB = 96, XLSX_TIMEOUT_MS = 5000, XLSX_WAIT_MS = 4000, XLSX_QUEUE = 2, XLSX_READS_PER_HOUR = 40;
const FLAG = { 1: 1, yes: 1, y: 1, true: 1, veg: 1, 0: 0, no: 0, n: 0, false: 0, nonveg: 0 };
const FLAG_NAME = { is_veg: 'Veg', sold_out: 'Sold out', active: 'Shown on the menu' };
const KIND_OF = Object.fromEntries(Object.entries(DEAL_KINDS).flatMap(([k, l]) => [[k, k], [l.toLowerCase(), k]])); // 'flash' or the label 'Flash sale'
export function uploadRow(r) {
  const t = k => String(r?.[k] ?? '').trim(), b = { name: unq(t('name')), price: t('price') };
  if (b.name && !b.price) return { error: 'Enter a price in rupees, e.g. 40 or 12.50' }; // an empty cell is not ₹0
  if (t('description')) b.description = unq(t('description'));
  for (const k of ['is_veg', 'sold_out', 'active']) if (t(k)) { const v = FLAG[t(k).toLowerCase().replace(/[\s_-]/g, '')];
    if (v === undefined) return { error: `${FLAG_NAME[k]}: use yes or no (not “${t(k).slice(0, 20)}”)` }; b[k] = !!v; }
  if (t('sort_order')) { if (!/^-?\d{1,6}$/.test(t('sort_order'))) return { error: 'Order must be a whole number' }; b.sort_order = +t('sort_order'); }
  if (t('deal_pct')) { b.deal_pct = t('deal_pct').replace(/\s*%$/, ''); if (!/^\d+(\.\d+)?$/.test(b.deal_pct) || (+b.deal_pct > 0 && +b.deal_pct < 1)) return { error: 'Deal % must be a number from 1 to 90' }; // 0.5 would floor to 0 and clear a deal
    b.deal_kind = KIND_OF[t('deal_kind').toLowerCase()] || t('deal_kind'); b.deal_minutes = t('deal_minutes'); }
  return itemRules(b, false);
}
// a CSV as Excel and Google Sheets save it: comma, semicolon or tab (whichever the header row has most of), "quoted" cells with "" inside
// Returns the non-blank records as { cells, line } (line = the row number in the file), trailing empty cells dropped.
function parseCsv(text) {
  const head = text.slice(0, text.search(/\r|\n|$/)).replace(/"[^"]*"/g, ''), delim = [',', ';', '\t'].reduce((a, d) => head.split(d).length > head.split(a).length ? d : a, ',');
  const recs = []; let row = [], cell = '', q = false, cells = 0, line = 0;
  const big = () => Object.assign(new Error('big'), { big: true });
  const end = () => { line++; row.push(cell); const c = row.map(cellText); let n = c.length; while (n && !c[n - 1]) n--; row = []; cell = '';
    if (!n) return; // a blank row: skipped, not counted
    if (recs.length >= 5000 || (cells += n) > 100000) throw big(); recs.push({ cells: c.slice(0, n), line }); };
  for (let i = 0; i < text.length; i++) { const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"' && !cell.trim()) { q = true; cell = ''; }
    else if (c === delim) { row.push(cell); cell = ''; if (row.length > 1000) throw Object.assign(new Error('wide'), { wide: true }); } // stop early: 200,000 commas are not a menu
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; end(); }
    else cell += c; }
  if (cell || row.length) end();
  return recs;
}
const cellText = v => v == null ? '' : v instanceof Date ? v.toISOString().slice(0, 10) : typeof v === 'number' ? String(+v.toPrecision(12)) : String(v).trim(); // 20.499999999 from a formula reads 20.5

export function canteen(d) {
  const { app, P, S, wrap, bad, notFound, HttpErr, limit, tenantBySlug, tenantRow, base, sendMail, SECRET } = d;
  // ---- anti-fake receipt: a colour for the day (same for students and staff) and a check code per order; the band shows the canteen's name ----
  const COLORS = [['Teal', '#0F766E'], ['Purple', '#7E22CE'], ['Orange', '#EA580C'], ['Blue', '#1D4ED8'], ['Pink', '#DB2777'], ['Green', '#15803D'], ['Brown', '#92400E'], ['Red', '#B91C1C'], ['Indigo', '#4338CA'], ['Olive', '#4D7C0F']];
  const WORDS = ['MANGO', 'LOTUS', 'TIGER', 'RIVER', 'PEARL', 'CEDAR', 'MAPLE', 'COMET', 'EAGLE', 'JASMINE', 'MONSOON', 'SAFFRON', 'GINGER', 'NEEM', 'BANYAN', 'COCONUT', 'PEACOCK', 'TULSI', 'CARDAMOM', 'LYCHEE'];
  const hmac = v => crypto.createHmac('sha256', SECRET).update(v).digest();
  const dayCheck = (tid, day) => { const h = hmac(`canteen-day\n${tid}\n${day}`); const c = COLORS[h[0] % COLORS.length]; return { color: c[0], hex: c[1], word: WORDS[h[1] % WORDS.length], day }; };
  const checkCode = o => String(hmac(`canteen-order\n${o.id}`).readUInt32BE(0) % 9000 + 1000);
  // ---- item photos: kept beside the desk's other uploads, shown on screens (menu, counter, kitchen), never printed ----
  const UP = process.env.UPLOAD_DIR || 'data/uploads', IMG = /^canteen-[a-f0-9]{24}\.(jpg|png|gif|webp)$/;
  var imgUrl = k => k && IMG.test(k) ? `/api/canteen-img/${k}` : null;
  app.get('/api/canteen-img/:key', (req, res, next) => { if (!IMG.test(req.params.key)) return next(notFound());
    const f = path.resolve(UP, req.params.key); if (!fs.existsSync(f)) return next(notFound());
    res.set('Cache-Control', 'public, max-age=86400').sendFile(f); });
  const forbid = () => new HttpErr(403, 'FORBIDDEN', 'Only the canteen managers can do this');
  const otpHash = (tid, email, code) => crypto.createHmac('sha256', SECRET).update(`${tid}\n${email}\n${code}`).digest('hex');

  // ---------- who may do what ----------
  async function access(req) {
    const u = req.user, tid = req.tenantId; if (!tid) return { tenant: null, setup: u.role === 'super_admin', can: {} };
    const tn = await tenantRow(tid), on = canteenLive(tn), admin = u.role !== 'provider'; // campus and super admins can do everything
    const row = u.role === 'provider' ? await one('SELECT kind, perms FROM canteen_managers WHERE tenant_id=? AND user_id=?', tid, u.id) : null, job = row ? row.kind || 'manager' : null;
    const list = admin ? FKEYS : permsOf(row), can = Object.fromEntries(FKEYS.map(f => [f, on && list.includes(f)]));
    return { tenant: tn, setup: u.role === 'super_admin', can, job, admin, manage: can.menu, manager: job === 'manager', kitchen: can.kitchen, counter: can.pos || can.orders,
      reports: can.reports, rename: can.settings, req_admin: u.role === 'tenant_admin' && on, cook: job === 'kitchen', cashier: job === 'counter', owner: job === 'owner' && on, storekeeper: job === 'inventory' && on };
  }
  // the route needs one of these features
  const needCan = async (req, ...feats) => { const a = await access(req); if (!a.tenant) throw bad('Pick a campus first');
    if (!feats.some(f => a.can[f])) throw new HttpErr(403, 'FORBIDDEN', canteenLive(a.tenant) ? 'Your canteen job does not include this. Ask the super admin to give you access.' : 'The canteen is switched off for this campus'); return a; };
  const need = req => needCan(req, 'menu');
  const needReports = req => needCan(req, 'reports');
  const needCounter = req => needCan(req, 'pos', 'orders');
  const needKitchen = req => needCan(req, 'kitchen');

  const menuOf = async (tid, all_ = false) => {
    const cats = await all('SELECT id, name, sort_order FROM canteen_categories WHERE tenant_id=? ORDER BY sort_order, name', tid);
    const items = (await all(`SELECT id, category_id, name, description, price_paise, is_veg, sold_out, active, sort_order, image_key, deal_pct, deal_kind, deal_until FROM canteen_items WHERE tenant_id=? ${all_ ? '' : 'AND active=1'} ORDER BY sort_order, name`, tid))
      .map(({ deal_pct, deal_kind, deal_until, image_key, ...i }) => { const deal = dealOf({ deal_pct, deal_kind, deal_until }); return { ...i, img: imgUrl(image_key), deal, price_now: deal ? priceNow({ ...i, deal_pct, deal_kind, deal_until }) : i.price_paise }; });
    return { categories: cats.map(c => ({ ...c, items: items.filter(i => i.category_id === c.id) })).filter(c => all_ || c.items.length),
      uncategorised: items.filter(i => !i.category_id || !cats.some(c => c.id === i.category_id)) };
  };
  const pub = o => ({ id: o.id, token: tokenLabel(o.token_no), token_no: o.token_no, day: o.day, status: o.status, status_text: STATUS[o.status], reject_reason: o.reject_reason,
    items: JSON.parse(o.items), total_paise: o.total_paise, total: rupees(o.total_paise), name: o.name, note: o.note, created_at: o.created_at,
    accepted_at: o.accepted_at, ready_at: o.ready_at, collected_at: o.collected_at, out_at: o.out_at, kot_started_at: o.kot_started_at, has_booked: !!o.has_booked, channel: o.channel || 'online', cash_tendered_paise: o.cash_tendered_paise, bill_prints: o.bill_prints || 0, kot_prints: o.kot_prints || 0, bill_no: o.bill_no, service: o.service || (o.fulfil === 'delivery' ? 'delivery' : o.channel === 'counter' ? 'takeaway' : 'pickup'), table_no: o.table_no, cashier: o.cashier_name || null,
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
    if (!to) return; // a walk-in at the counter left no email
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
  // the next bill number for the canteen (a race on the unique index just takes the next one)
  const giveBill = async (tid, id) => { for (let i = 0; i < 6; i++) { try {
      const r = await one(`UPDATE canteen_orders SET bill_no=(SELECT coalesce(max(bill_no),0)+1 FROM canteen_orders WHERE tenant_id=?) WHERE id=? AND bill_no IS NULL RETURNING bill_no`, tid, id);
      return r?.bill_no ?? (await one('SELECT bill_no FROM canteen_orders WHERE id=?', id)).bill_no; } catch (e) { if (e.code !== '23505') throw e; } } throw new HttpErr(503, 'BUSY', 'Busy, please try again'); };
  const withCashier = async rows => { const ids = [...new Set(rows.map(o => o.paid_by).filter(Boolean))], n = ids.length ? Object.fromEntries((await all('SELECT id, name FROM users WHERE id = ANY(?::text[])', ids)).map(u => [u.id, u.name])) : {};
    return rows.map(o => ({ ...o, cashier_name: n[o.paid_by] || null })); };
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
      const svg = await qrSvg(shortLink(tn));
      res.set({ 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=3600' }).send(svg); } catch (e) { next(e); } });
  }
  // ================= student (public, no login to browse) =================
  P.get('/:slug/canteen', wrap(async req => {
    const tn = await tenantBySlug(req.params.slug);
    if (!canteenLive(tn)) return { on: false, campus: tn.name, name: canteenName(tn) };
    await expire(tn); const st = stateOf(tn), since = addDays(dayOf(tn.timezone), -6), pop = {}, pay = payOf(tn);
    for (const o of await all(`SELECT items FROM canteen_orders WHERE tenant_id=? AND day>=? AND status='collected'`, tn.id, since)) for (const it of JSON.parse(o.items)) pop[it.id] = (pop[it.id] || 0) + it.qty;
    // fast moving: the items ordered most today (at least 5 each), up to 5
    const fastQ = {}; for (const o of await all(`SELECT items FROM canteen_orders WHERE tenant_id=? AND day=? AND status NOT IN ('cancelled','rejected')`, tn.id, dayOf(tn.timezone))) for (const it of JSON.parse(o.items)) fastQ[it.id] = (fastQ[it.id] || 0) + it.qty;
    const fast = Object.entries(fastQ).filter(x => x[1] >= 5).sort((a, b) => b[1] - a[1]).slice(0, 5).map(x => x[0]);
    const busy = (await one(`SELECT count(*) n FROM canteen_orders WHERE tenant_id=? AND day=? AND status IN ('placed','accepted')`, tn.id, dayOf(tn.timezone))).n;
    return { on: true, open: st.accepting, state: st, busy, pay: { cash: pay.cash, upi: !!pay.upi_id, delivery: pay.delivery && (!!pay.upi_id || (pay.delivery_cash && pay.cash)), delivery_cash: !!pay.delivery_cash, blocks: pay.delivery ? await blocksOf(tn) : [], floors: FLOORS, delivery_fee_paise: Math.round(pay.delivery_fee * 100), delivery_note: pay.delivery_note, pay_window_min: pay.pay_window_min }, wait_min: await prepMin(tn.id), popular: Object.entries(pop).sort((a, b) => b[1] - a[1]).slice(0, 3).filter(x => x[1] >= 2).map(x => x[0]),
      fast, campus: tn.name, name: canteenName(tn), day: dayOf(tn.timezone), ...(await menuOf(tn.id)) };
  }));
  // step 1 of the first order on a device: email a six-digit code
  P.post('/:slug/canteen/otp', wrap(async req => {
    const tn = await tenantBySlug(req.params.slug); if (!canteenLive(tn)) throw notFound();
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
    const tn = await tenantBySlug(req.params.slug); if (!canteenLive(tn)) throw notFound();
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
    if (!canteenLive(tn)) throw notFound();
    const st = stateOf(tn);
    if (!st.accepting) throw bad(st.why === 'later' ? `The canteen opens at ${st.opens_at}.` : st.why === 'last_orders_done' ? `Last orders are over for today (closes at ${st.closes_at}).` : 'The canteen is not taking orders right now.');
    const dv = await deviceOf(tn.id, b.device); if (!dv) throw new HttpErr(401, 'VERIFY', 'Please verify your email first');
    limit('cord:' + dv.token_hash, 40); // orders per phone per hour
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
    if (fulfil === 'delivery' && mode === 'cash' && !pay.delivery_cash) throw bad('Delivery orders are paid by UPI. Please choose UPI, or pick up at the counter to pay cash.');
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
      out.push({ id: it.id, name: it.name, price_paise: priceNow(it), qty, ...(it.image_key ? { img: imgUrl(it.image_key) } : {}), ...(d ? { mrp_paise: it.price_paise, deal: d.kind, pct: d.pct } : {}), ...(cat ? { category: cat } : {}), ...(it.sold_out ? { booked: true } : {}) });
    }
    const fee = fulfil === 'delivery' ? Math.round(pay.delivery_fee * 100) : 0, total = out.reduce((s, x) => s + x.price_paise * x.qty, 0) + fee, day = dayOf(tn.timezone);
    // the student saw a total; if a deal ended or a price changed meanwhile, say so instead of charging a different amount
    if (b.expect_paise != null && Number(b.expect_paise) !== total) throw new HttpErr(409, 'PRICE_CHANGED', `Prices changed while you were ordering. The total is now ${rupees(total)}. Please check your cart and order again.`);
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
    const tn = await tenantBySlug(req.params.slug); if (!canteenLive(tn)) throw notFound(); const o = await one('SELECT * FROM canteen_orders WHERE id=? AND tenant_id=?', req.params.id, tn.id);
    const k = String(req.query.k || req.body?.k || '');
    if (!o || Buffer.byteLength(k) !== Buffer.byteLength(o.view_key) || !crypto.timingSafeEqual(Buffer.from(k), Buffer.from(o.view_key))) throw notFound();
    return { tn, o };
  };
  P.get('/:slug/canteen/orders/:id', wrap(async req => { let { tn, o } = await orderByKey(req);
    if (o.status === 'placed') { await expire(tn); o = await one('SELECT * FROM canteen_orders WHERE id=?', o.id); }
    const pay = payOf(tn), upi = o.status === 'placed' && o.pay_mode === 'upi' && pay.upi_id ? { link: upiLink(pay, o), id: pay.upi_id, name: pay.upi_name } : null;
    const pay_by = o.status === 'placed' && o.pay_status === 'unpaid' ? new Date(Date.parse(o.created_at) + pay.pay_window_min * 6e4).toISOString() : null;
    const ahead = ['placed', 'accepted'].includes(o.status) ? (await one(`SELECT count(*) n FROM canteen_orders WHERE tenant_id=? AND day=? AND token_no<? AND status='accepted'`, tn.id, o.day, o.token_no)).n : 0;
    return { ...pub(o), canteen: canteenName(tn), ahead, wait_min: await prepMin(tn.id), upi, pay_by, server_time: now(), check: o.pay_status === 'paid' ? { ...dayCheck(tn.id, dayOf(tn.timezone)), code: checkCode(o) } : null }; }));
  // the student paid by UPI: they send the reference number (UTR) from their UPI app; staff check it and send the order to the kitchen
  P.post('/:slug/canteen/orders/:id/upi-ref', wrap(async req => {
    const { tn } = await orderByKey(req); await expire(tn); const o = await one('SELECT * FROM canteen_orders WHERE id=?', req.params.id); // past the pay time: already cancelled
    limit('cupi:' + o.id, 10);
    const ref = str(req.body.ref, 40).replace(/\s/g, ''); if (!UTR.test(ref)) throw bad('Enter the UPI reference number (UTR) from your UPI app: 6 to 30 letters or digits');
    if (o.status !== 'placed' || o.pay_mode !== 'upi') throw bad('This order is not waiting for a UPI payment');
    if (await one('SELECT 1 FROM canteen_orders WHERE tenant_id=? AND upper(upi_ref)=upper(?) AND id<>?', tn.id, ref, o.id)) throw bad('That reference number is already used on another order');
    const ru = await run(`UPDATE canteen_orders SET upi_ref=?, pay_status='claimed' WHERE id=? AND status='placed' AND coalesce(pay_status,'unpaid')<>'paid'`, ref, o.id);
    if (!ru.changes) throw bad('This order is no longer waiting for payment. Please refresh.');
    return { ok: true, pay_status: 'claimed' };
  }));
  // the same UPI payment as a QR code (for paying from another phone or a laptop screen)
  P.get('/:slug/canteen/orders/:id/upi.svg', async (req, res, next) => { try { const { tn, o } = await orderByKey(req), pay = payOf(tn);
    if (!pay.upi_id || o.pay_mode !== 'upi') throw notFound();
    res.set('Content-Type', 'image/svg+xml').send(await qrSvg(upiLink(pay, o))); } catch (e) { next(e); } });
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
    // canteen-only staff (a canteen job, no ticket team) open straight on the canteen; anyone in a desk team still sees their team's tickets
    const desk = req.user.role !== 'provider' || !a.job || !!(await one('SELECT 1 FROM service_members WHERE user_id=? LIMIT 1', req.user.id));
    return { desk, can: a.can || {}, job: a.job || null, setup: a.setup, manage: !!a.manage, manager: !!a.manager, kitchen: !!a.kitchen, cook: !!a.cook, counter: !!a.counter, cashier: !!a.cashier, owner: !!a.owner, storekeeper: !!a.storekeeper,
      reports: !!a.reports, inventory: !!a.can?.inventory, rename: !!a.rename, on: canteenLive(a.tenant), open: a.tenant ? isOpen(a.tenant) : false, name: a.tenant ? canteenName(a.tenant) : null }; }));
  // super admin: switch on for the campus, pick 1–2 desk providers as managers
  S.get('/canteen/setup', wrap(async req => {
    if (req.user.role !== 'super_admin') throw forbid(); if (!req.tenantId) throw bad('Pick a campus first');
    const tn = await tenantRow(req.tenantId);
    return { on: !!tn.canteen_on, slug: tn.slug, name: tn.canteen_name || '', default_name: `${tn.name} Canteen`, managers: (await all(`SELECT user_id FROM canteen_managers WHERE tenant_id=? AND coalesce(kind,'manager')='manager'`, req.tenantId)).map(r => r.user_id),
      kitchen: (await all(`SELECT user_id FROM canteen_managers WHERE tenant_id=? AND kind='kitchen'`, req.tenantId)).map(r => r.user_id),
      owner: (await all(`SELECT user_id FROM canteen_managers WHERE tenant_id=? AND kind='owner'`, req.tenantId)).map(r => r.user_id),
      counter: (await all(`SELECT user_id FROM canteen_managers WHERE tenant_id=? AND kind='counter'`, req.tenantId)).map(r => r.user_id), max_kitchen: MAX_KITCHEN,
      inventory: (await all(`SELECT user_id FROM canteen_managers WHERE tenant_id=? AND kind='inventory'`, req.tenantId)).map(r => r.user_id),
      perms: Object.fromEntries((await all('SELECT user_id, kind, perms FROM canteen_managers WHERE tenant_id=?', req.tenantId)).map(r => [r.user_id, permsOf(r)])),
      custom: (await all('SELECT user_id FROM canteen_managers WHERE tenant_id=? AND perms IS NOT NULL', req.tenantId)).map(r => r.user_id), features: FEATURES, jobs: JOBS,
      providers: await all(`SELECT id, name, email FROM users WHERE tenant_id=? AND role='provider' AND is_active=1 ORDER BY name`, req.tenantId), max: MAX_MANAGERS };
  }));
  S.put('/canteen/setup', wrap(async req => {
    if (req.user.role !== 'super_admin') throw forbid(); if (!req.tenantId) throw bad('Pick a campus first');
    const on = !!req.body.on, ids = [...new Set((req.body.managers || []).map(String))];
    if (ids.length > MAX_MANAGERS) throw bad(`Pick at most ${MAX_MANAGERS} canteen managers`);
    if (on && !ids.length) throw bad('Pick at least one desk provider as canteen manager');
    const ok = await all(`SELECT id FROM users WHERE tenant_id=? AND role='provider' AND is_active=1 AND id = ANY(?::text[])`, req.tenantId, ids);
    if (ok.length !== ids.length) throw bad('Canteen managers must be active service providers on this campus');
    // kitchen and counter staff: sent together with the managers (leaving one out keeps that list as it is)
    const list = k => req.body[k] === undefined ? null : [...new Set((req.body[k] || []).map(String))];
    const kit = list('kitchen'), ctr = list('counter'), own = list('owner'), inv = list('inventory');
    for (const [l, what] of [[kit, 'kitchen staff'], [ctr, 'counter staff'], [own, 'owners'], [inv, 'inventory staff']]) if (l) { if (l.length > MAX_KITCHEN) throw bad(`Pick at most ${MAX_KITCHEN} ${what}`);
      const ok2 = await all(`SELECT id FROM users WHERE tenant_id=? AND role='provider' AND is_active=1 AND id = ANY(?::text[])`, req.tenantId, l);
      if (ok2.length !== l.length) throw bad(`${what[0].toUpperCase() + what.slice(1)} must be active service providers on this campus`); }
    const all3 = [...ids, ...(kit || []), ...(ctr || []), ...(own || []), ...(inv || [])]; if (new Set(all3).size !== all3.length) throw bad('A person can have one canteen job: manager, kitchen staff or counter staff, not both');
    if (!on) { const live = (await one(`SELECT count(*) n FROM canteen_orders WHERE tenant_id=? AND status IN ${LIVE}`, req.tenantId)).n; // checked before anything is saved
      if (live) throw bad(`${live} order${live === 1 ? ' is' : 's are'} still in progress (waiting for payment, in the kitchen or on the way). Finish or reject ${live === 1 ? 'it' : 'them'} first, then switch the canteen off.`); }
    const kinds = ['manager', ...(kit ? ['kitchen'] : []), ...(ctr ? ['counter'] : []), ...(own ? ['owner'] : []), ...(inv ? ['inventory'] : [])];
    // a person's own permissions: sent as { userId: [features] }, null = back to the job's defaults; not sent = kept (when the job stays the same)
    const before = Object.fromEntries((await all('SELECT user_id, kind, perms FROM canteen_managers WHERE tenant_id=?', req.tenantId)).map(r => [r.user_id, r]));
    const sent = req.body.perms && typeof req.body.perms === 'object' ? req.body.perms : {};
    const permsFor = (id, kind) => { if (Object.hasOwn(sent, id)) { const l = Array.isArray(sent[id]) ? [...new Set(sent[id].filter(f => FKEYS.includes(f)))] : null;
        if (!l) return null; if (!l.length) throw bad('Give each person at least one feature, or remove their canteen job');
        // every feature must have a screen to use it on
        if (!l.some(f => ['pos', 'orders', 'kitchen', 'inventory', 'menu', 'reports'].includes(f))) throw bad('Give at least one screen too: Counter, Orders, Kitchen, Inventory, Menu or Reports');
        if (l.includes('settings') && !l.includes('menu')) throw bad('Name, timings and payments are on the Menu tab: give Menu too');
        if (l.includes('openclose') && !l.some(f => f === 'orders' || f === 'pos')) throw bad('Open / close is on the Orders and Counter screens: give one of them too');
        if (l.includes('stock') && !l.some(f => ['pos', 'kitchen', 'menu'].includes(f))) throw bad('Sold out is marked on the Counter, Kitchen or Menu screens: give one of them too');
        return [...l].sort().join() === [...JOBS[kind]].sort().join() ? null : JSON.stringify(l); }
      return before[id] && (before[id].kind || 'manager') === kind ? before[id].perms : null; };
    const rowsIn = [[ids, 'manager'], [kit || [], 'kitchen'], [ctr || [], 'counter'], [own || [], 'owner'], [inv || [], 'inventory']].flatMap(([l, k]) => l.map(id => [id, k, permsFor(id, k)])); // checked before anything is changed
    const fullSets = rowsIn.filter(([, k, pp]) => k === 'manager' || (pp && FKEYS.every(f => JSON.parse(pp).includes(f)))).length; // anyone with every feature counts as a manager
    if (fullSets > MAX_MANAGERS) throw bad(`At most ${MAX_MANAGERS} people can have every canteen feature (managers)`);
    await tx(async () => { // all or nothing
    await run('UPDATE tenants SET canteen_on=?, canteen_name=? WHERE id=?', on ? 1 : 0, str(req.body.name, 60) || null, req.tenantId);
    if (!on) await run('UPDATE tenants SET canteen_open_day=NULL WHERE id=?', req.tenantId); // switched off: closed too
    await run(`DELETE FROM canteen_managers WHERE tenant_id=? AND coalesce(kind,'manager') = ANY(?::text[])`, req.tenantId, kinds);
    await run('DELETE FROM canteen_managers WHERE tenant_id=? AND user_id = ANY(?::text[])', req.tenantId, all3); // one job each: a new job replaces the old
    for (const [l, k] of [[ids, 'manager'], [kit || [], 'kitchen'], [ctr || [], 'counter'], [own || [], 'owner'], [inv || [], 'inventory']]) for (const id of l) await run('INSERT INTO canteen_managers (tenant_id, user_id, created_at, kind, perms) VALUES (?,?,?,?,?)', req.tenantId, id, now(), k, rowsIn.find(r => r[0] === id)[2]);
    });
    return { on, managers: ids, kitchen: kit, counter: ctr, owner: own, inventory: inv };
  }));

  // rename: the super admin, the canteen managers and the campus admin (not other providers)
  S.put('/canteen/name', wrap(async req => { const a = await needCan(req, 'settings');
    const name = str(req.body.name, 60); if (name && name.length < 2) throw bad('The name is too short');
    await run('UPDATE tenants SET canteen_name=? WHERE id=?', name || null, req.tenantId); return { name: canteenName({ ...a.tenant, canteen_name: name || null }) }; }));
  S.put('/canteen/hours', wrap(async req => { const a = await needCan(req, 'settings');
    const b = req.body; if (b.clear) { await run('UPDATE tenants SET canteen_hours=NULL WHERE id=?', req.tenantId); return { hours: null }; }
    if (!HM.test(b.open || '') || !HM.test(b.close || '')) throw bad('Enter opening and closing times');
    if (toMin(b.close) <= toMin(b.open)) throw bad('Closing time must be after opening time');
    const days = [...new Set((b.days || []).map(Number))].filter(d => d >= 0 && d <= 6).sort(); if (!days.length) throw bad('Pick at least one day');
    const last = Math.max(0, Math.min(120, Math.floor(Number(b.last_order_min) || 0))); if (last >= toMin(b.close) - toMin(b.open)) throw bad('The last-order cut-off is longer than the opening hours');
    const h = { open: b.open, close: b.close, days, last_order_min: last };
    await run('UPDATE tenants SET canteen_hours=? WHERE id=?', JSON.stringify(h), req.tenantId); return { hours: h }; }));
  // payments and delivery (same people as the name and timings)
  S.put('/canteen/payments', wrap(async req => { const a = await needCan(req, 'settings');
    const b = req.body, p = { cash: !!b.cash, upi_id: str(b.upi_id, 100), upi_name: str(b.upi_name, 60), delivery: !!b.delivery,
      delivery_fee: Number(b.delivery_fee) || 0, delivery_note: str(b.delivery_note, 120), pay_window_min: Math.floor(Number(b.pay_window_min) || 20),
      delivery_blocks: [...new Set((Array.isArray(b.delivery_blocks) ? b.delivery_blocks : String(b.delivery_blocks || '').split('\n')).map(x => str(x, 60)).filter(Boolean))].slice(0, 100),
      tagline: str(b.tagline, 80), delivery_cash: !!b.delivery_cash, kot_at_counter: b.kot_at_counter === undefined ? true : !!b.kot_at_counter, prep_sla_min: Math.floor(Number(b.prep_sla_min) || 15), delivery_sla_min: Math.floor(Number(b.delivery_sla_min) || 20), paper: b.paper === '58' ? '58' : '80', auto_kot: !!b.auto_kot && !b.kot_at_counter, /* KOTs print in one place */ auto_bill: b.auto_bill === undefined ? true : !!b.auto_bill, bill_footer: b.bill_footer === undefined ? PAY_DEFAULT.bill_footer : str(b.bill_footer, 120) };
    if (p.upi_id && !UPI_ID.test(p.upi_id)) throw bad('Enter a UPI ID like canteen@okhdfcbank');
    if (p.prep_sla_min < 1 || p.prep_sla_min > 180) throw bad('Kitchen target must be 1 to 180 minutes');
    if (p.delivery_sla_min < 1 || p.delivery_sla_min > 180) throw bad('Delivery target must be 1 to 180 minutes');
    if (!p.cash && !p.upi_id) throw bad('Turn on cash or add a UPI ID: students need a way to pay');
    if (p.delivery_fee < 0 || p.delivery_fee > 500) throw bad('Delivery charge must be ₹0 to ₹500');
    if (p.pay_window_min < 5 || p.pay_window_min > 120) throw bad('Time to pay must be 5 to 120 minutes');
    await run('UPDATE tenants SET canteen_pay=? WHERE id=?', JSON.stringify(p), req.tenantId); return p; }));
  // ---- menu ----
  S.get('/canteen/menu', wrap(async req => { const a = await need(req); return { campus_blocks: await blocksOf({ ...a.tenant, canteen_pay: null }), pay: payOf(a.tenant), link: shortLink(a.tenant), hours: hoursOf(a.tenant), state: stateOf(a.tenant), name: canteenName(a.tenant), open: isOpen(a.tenant), day: dayOf(a.tenant.timezone), slug: a.tenant.slug, ...(await menuOf(req.tenantId, true)) }; }));
  // menu changes that count or match (imports, Add item, Add category) run one at a time per campus, so two at once can't pass a cap together
  const menuLock = tid => one("SELECT pg_advisory_xact_lock(hashtext('canteen-menu:' || ?::text))", tid);
  S.post('/canteen/categories', wrap(async req => { await need(req); const name = str(req.body.name, 60); if (!name) throw bad('Category name required'); return tx(async () => { await menuLock(req.tenantId);
    const n = (await one('SELECT count(*) n FROM canteen_categories WHERE tenant_id=?', req.tenantId)).n; if (n >= MAX_CATS) throw bad('Up to 50 categories');
    const id = uid(); await run('INSERT INTO canteen_categories (id, tenant_id, name, sort_order, created_at) VALUES (?,?,?,?,?)', id, req.tenantId, name, n, now()); return { id, name }; }); }));
  S.patch('/canteen/categories/:id', wrap(async req => { await need(req); const name = str(req.body.name, 60);
    const sets = [], args = []; if (name) { sets.push('name=?'); args.push(name); } if (Number.isInteger(req.body.sort_order)) { sets.push('sort_order=?'); args.push(req.body.sort_order); }
    if (!sets.length) throw bad('Nothing to change');
    const r = await run(`UPDATE canteen_categories SET ${sets.join(',')} WHERE id=? AND tenant_id=?`, ...args, req.params.id, req.tenantId); if (!r.changes) throw notFound(); return { ok: true }; }));
  S.delete('/canteen/categories/:id', wrap(async req => { await need(req);
    if ((await one('SELECT count(*) n FROM canteen_items WHERE category_id=? AND tenant_id=? AND active=1', req.params.id, req.tenantId)).n) throw bad('Move or remove the items in this category first');
    await run('UPDATE canteen_items SET category_id=NULL WHERE category_id=? AND tenant_id=?', req.params.id, req.tenantId);
    const r = await run('DELETE FROM canteen_categories WHERE id=? AND tenant_id=?', req.params.id, req.tenantId); if (!r.changes) throw notFound(); return { ok: true }; }));
  const itemFields = async (req, partial) => {
    const b = req.body, { f, error } = itemRules(b, partial); if (error) throw bad(error);
    if (b.category_id !== undefined) { f.category_id = b.category_id || null;
      if (f.category_id && !(await one('SELECT 1 FROM canteen_categories WHERE id=? AND tenant_id=?', f.category_id, req.tenantId))) throw bad('Pick a category'); }
    return f;
  };
  // another active item with the same name (nameKey), oldest first; called under menuLock so two changes can't both pass
  const nameTaken = async (tid, name, exceptId) => { const k = nameKey(name);
    return (await all('SELECT id, name FROM canteen_items WHERE tenant_id=? AND active=1 ORDER BY created_at, id', tid)).find(i => i.id !== exceptId && nameKey(i.name) === k); };
  const onMenu = i => bad(`"${i.name}" is already on the menu`);
  S.post('/canteen/items', wrap(async req => { await need(req); const f = await itemFields(req, false); return tx(async () => { await menuLock(req.tenantId);
    if ((await one('SELECT count(*) n FROM canteen_items WHERE tenant_id=?', req.tenantId)).n >= MAX_ITEMS) throw bad('Up to 500 items');
    if (f.active !== 0) { const t = await nameTaken(req.tenantId, f.name); if (t) throw onMenu(t); }
    const o = { id: uid(), tenant_id: req.tenantId, is_veg: 1, created_at: now(), ...f };
    await run(`INSERT INTO canteen_items (${Object.keys(o).join(',')}) VALUES (${Object.keys(o).map(() => '?').join(',')})`, ...Object.values(o)); return { id: o.id }; }); }));
  // a new name, or bringing a removed item back, must not repeat a name on the menu; the item's own name (any case) and a price-only
  // change never trip it, so a name that was on the menu twice before the rule can still be edited
  S.patch('/canteen/items/:id', wrap(async req => { await need(req); const f = await itemFields(req, true); if (!Object.keys(f).length) throw bad('Nothing to change');
    return tx(async () => { await menuLock(req.tenantId);
      const cur = await one('SELECT name, active FROM canteen_items WHERE id=? AND tenant_id=?', req.params.id, req.tenantId); if (!cur) throw notFound();
      const name = f.name ?? cur.name, active = f.active ?? cur.active;
      if (active && (nameKey(name) !== nameKey(cur.name) || !cur.active)) { const t = await nameTaken(req.tenantId, name, req.params.id); if (t) throw onMenu(t); }
      await run(`UPDATE canteen_items SET ${Object.keys(f).map(k => k + '=?').join(',')} WHERE id=? AND tenant_id=?`, ...Object.values(f), req.params.id, req.tenantId);
      return { ok: true }; }); }));
  // counter and kitchen staff mark an item sold out / back in stock during the shift (only that; prices stay with the managers)
  S.post('/canteen/items/:id/stock', wrap(async req => { await needCan(req, 'stock', 'menu');
    const r = await run('UPDATE canteen_items SET sold_out=? WHERE id=? AND tenant_id=? AND active=1', req.body.sold_out ? 1 : 0, req.params.id, req.tenantId); if (!r.changes) throw notFound(); return { ok: true }; }));
  S.get('/canteen/stock', wrap(async req => { await needCan(req, 'stock', 'menu');
    return (await all('SELECT id, name, sold_out FROM canteen_items WHERE tenant_id=? AND active=1 ORDER BY name', req.tenantId)); }));
  // an item's photo: a JPEG/PNG/GIF/WebP (iPhone HEIC is turned into JPEG), up to 4 MB; replacing or removing deletes the old file
  S.put('/canteen/items/:id/photo', wrap(async req => { await need(req);
    const it = await one('SELECT id, image_key FROM canteen_items WHERE id=? AND tenant_id=?', req.params.id, req.tenantId); if (!it) throw notFound();
    let buf = Buffer.from(String(req.body.data || '').split(',').pop(), 'base64'), kind = kindOf(buf);
    if (kind === 'heic') try { buf = await heicToJpeg(buf); kind = 'jpeg'; } catch { throw bad('This photo could not be read. Please try a JPEG or PNG.'); }
    if (!SHOWN[kind]) throw bad('Please choose a photo (JPEG, PNG, GIF or WebP)'); if (buf.length > 4e6) throw bad('That photo is too big (up to 4 MB)');
    const key = `canteen-${crypto.randomBytes(12).toString('hex')}.${kind === 'jpeg' ? 'jpg' : kind}`;
    fs.mkdirSync(UP, { recursive: true }); fs.writeFileSync(path.join(UP, key), buf);
    await run('UPDATE canteen_items SET image_key=? WHERE id=?', key, it.id);
    if (it.image_key && IMG.test(it.image_key)) fs.rm(path.join(UP, it.image_key), { force: true }, () => {});
    return { img: imgUrl(key) }; }));
  S.delete('/canteen/items/:id/photo', wrap(async req => { await need(req);
    const it = await one('SELECT id, image_key FROM canteen_items WHERE id=? AND tenant_id=?', req.params.id, req.tenantId); if (!it) throw notFound();
    await run('UPDATE canteen_items SET image_key=NULL WHERE id=?', it.id); if (it.image_key && IMG.test(it.image_key)) fs.rm(path.join(UP, it.image_key), { force: true }, () => {});
    return { ok: true }; }));
  // removing an item hides it (old orders keep their copy of the name and price)
  S.delete('/canteen/items/:id', wrap(async req => { await need(req);
    const r = await run('UPDATE canteen_items SET active=0 WHERE id=? AND tenant_id=?', req.params.id, req.tenantId); if (!r.changes) throw notFound(); return { ok: true }; }));

  // ---- menu upload (CSV or Excel): read the file, then preview (dry run) and import the mapped rows ----
  // the template and the sample: UTF-8 with a BOM so Excel shows ₹ and Telugu; the sample is the file the tests import
  const csvOut = (res, name, body) => res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"` }).send(body);
  S.get('/canteen/menu-template.csv', async (req, res, next) => { try { await need(req); csvOut(res, 'canteen-menu-template.csv', '\ufeff' + MENU_FIELDS.join(',') + '\r\nSnacks,Samosa,15,Two pieces with chutney,1,0,1,1,,,\r\n'); } catch (e) { next(e); } });
  // the menu as it is now, in the template's columns: edit it and upload it back (each name updates its item). Active items only,
  // prices in rupees (12.5, 30), a deal only while it runs, in menu order (categories, then items; no category last)
  S.get('/canteen/menu-export.csv', async (req, res, next) => { try { const a = await need(req);
    // a name on the menu twice (from before names were unique): only the oldest copy, the one an upload of this file updates
    const first = new Set(), keys = new Set(); for (const i of await all('SELECT id, name FROM canteen_items WHERE tenant_id=? AND active=1 ORDER BY created_at, id', req.tenantId)) { const k = nameKey(i.name); if (!keys.has(k)) { keys.add(k); first.add(i.id); } }
    const items = (await all(`SELECT i.id, c.name cat, i.name, i.price_paise, i.description, i.is_veg, i.sold_out, i.sort_order, i.deal_pct, i.deal_kind, i.deal_until FROM canteen_items i
      LEFT JOIN canteen_categories c ON c.id=i.category_id AND c.tenant_id=i.tenant_id WHERE i.tenant_id=? AND i.active=1 ORDER BY (c.id IS NULL), c.sort_order, c.name, c.id, i.sort_order, i.name, i.created_at, i.id`, req.tenantId)).filter(i => first.has(i.id));
    const line = i => { const d = dealOf(i);
      return [[i.cat, 1], [i.name, 1], [i.price_paise / 100], [i.description, 1], [i.is_veg === 0 ? 0 : 1], [i.sold_out ? 1 : 0], [1], [i.sort_order ?? 0],
        [d ? d.pct : ''], [d ? d.kind : ''], [d?.until ? dealMinutesLeft(d.until) : '']].map(([v, text]) => csvCell(v, text)).join(','); };
    csvOut(res, `canteen-menu-${a.tenant.slug}.csv`, '\ufeff' + [MENU_FIELDS.join(','), ...items.map(line)].join('\r\n') + '\r\n'); } catch (e) { next(e); } });
  S.get('/canteen/menu-sample.csv', async (req, res, next) => { try { await need(req); csvOut(res, 'canteen-menu-sample.csv', await fsp.readFile(new URL('./samples/canteen-menu-sample.csv', import.meta.url))); } catch (e) { next(e); } });
  // read-excel-file is loaded only for an .xlsx (as qrcode is for QR codes): if it is missing, CSV uploads still work
  let xlsxOk = null;
  const tooWide = n => bad(`Too many columns: the file has ${n >= 1000 ? 'over 1,000' : n || `more than ${MAX_UPLOAD_COLS}`}, a menu needs at most ${MAX_UPLOAD_COLS}. Delete the extra columns and save again`);
  const tooLarge = () => bad(`This sheet is too large or not readable: keep it under ${MAX_UPLOAD_ROWS} rows and ${MAX_UPLOAD_COLS} columns`);
  const unreadable = () => bad('Could not read this Excel file. Save it as .xlsx or .csv and try again');
  const tooMany = () => bad(`Up to ${MAX_UPLOAD_ROWS} rows in one file`);
  const busy = () => new HttpErr(429, 'BUSY', 'The server is busy reading another file. Try again in a moment.');
  // one .xlsx is read at a time (a worker costs real memory on a 1 GB server); two more may wait a few seconds, the rest are told to retry
  let xlsxBusy = false; const xlsxWaiting = [];
  const xlsxSlot = () => new Promise((resolve, reject) => { if (!xlsxBusy) { xlsxBusy = true; return resolve(); }
    if (xlsxWaiting.length >= XLSX_QUEUE) return reject(busy());
    const w = { resolve, t: setTimeout(() => { xlsxWaiting.splice(xlsxWaiting.indexOf(w), 1); reject(busy()); }, XLSX_WAIT_MS) }; xlsxWaiting.push(w); });
  const xlsxFree = () => { const w = xlsxWaiting.shift(); if (w) { clearTimeout(w.t); w.resolve(); } else xlsxBusy = false; };
  // the worker gets the raw file and answers with menu-sized records or a reason; memory, time, a crash or an early exit are all "too large"
  const readInWorker = data => new Promise(resolve => {
    const w = new Worker(new URL('./xlsx-worker.js', import.meta.url), { workerData: data, resourceLimits: { maxOldGenerationSizeMb: XLSX_WORKER_MB, maxYoungGenerationSizeMb: 16 } });
    let settled = false; const end = m => { if (settled) return; settled = true; clearTimeout(timer); clearInterval(watch); w.terminate().catch(() => {}).finally(() => resolve(m)); }; // the slot frees once the worker is gone
    const timer = setTimeout(() => end({ big: true }), XLSX_TIMEOUT_MS);
    // resourceLimits cap the worker's heap, not V8's large-object space: the reader's 16,384-cell rows went to 8 GB of RSS under a 48 MB
    // limit. So the server's own memory is watched too, every 10 ms: 96 MB above where it started ends the worker (a menu needs a few MB).
    const base = process.memoryUsage.rss(), watch = setInterval(() => { if (process.memoryUsage.rss() - base > XLSX_RSS_MB * 1048576) end({ big: true }); }, 10);
    w.on('message', end); w.on('error', () => end({ big: true })); w.on('exit', () => end({ big: true })); });
  const readXlsx = async (req, buf) => {
    if (xlsxOk === null) { try { await import('fflate'); await import('read-excel-file/node'); xlsxOk = true; } catch { console.error('Menu upload: the "read-excel-file" package is not installed. Run: npm ci --omit=dev'); } }
    if (!xlsxOk) { xlsxOk = null; throw new HttpErr(503, 'XLSX_MISSING', 'Excel files need the read-excel-file package. Run npm ci on the server, or upload a .csv'); }
    limit('menu-xlsx:' + req.user.id, XLSX_READS_PER_HOUR);
    await xlsxSlot(); let m; try { m = await readInWorker(buf); } finally { xlsxFree(); }
    if (m.recs) return m.recs; throw m.wide ? tooWide() : m.many ? tooMany() : m.bad ? unreadable() : tooLarge(); };
  S.post('/canteen/menu/read', wrap(async req => { await need(req);
    const name = str(req.body.name, 200), m = /^data:[^,]*;base64,/.exec(typeof req.body.data === 'string' ? req.body.data : '');
    if (!m) throw bad('Choose a .csv or .xlsx file');
    if (req.body.data.length > Math.ceil(MAX_UPLOAD_BYTES * 4 / 3) + 200) throw bad('The file is bigger than 5 MB: a menu file is usually a few KB'); // before decoding
    const ext = (/\.([a-z0-9]+)$/i.exec(name)?.[1] || '').toLowerCase();
    if (ext === 'xls') throw bad('This is an old Excel file (.xls). Save it as .xlsx or .csv and upload that');
    if (ext !== 'csv' && ext !== 'xlsx') throw bad('Choose a .csv or .xlsx file');
    const buf = Buffer.from(req.body.data.slice(m[0].length), 'base64');
    if (buf.length > MAX_UPLOAD_BYTES) throw bad('The file is bigger than 5 MB: a menu file is usually a few KB');
    let recs; // the non-blank rows as { cells, line }
    if (ext === 'xlsx') recs = await readXlsx(req, buf);
    else { if (buf.includes(0) || buf.subarray(0, 2).toString('latin1') === 'PK') throw bad("This doesn't look like a CSV file. Save it as .csv or .xlsx and try again");
      let text; try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { text = new TextDecoder('windows-1252').decode(buf); } // older Excel saves "CSV" in the Windows code page
      try { recs = parseCsv(text.replace(/^\ufeff/, '')); } catch (e) { if (e.wide) throw tooWide(1000); if (e.big) throw bad(`This file is too large: keep it under ${MAX_UPLOAD_ROWS} rows and ${MAX_UPLOAD_COLS} columns`); throw e; } }
    if (!recs.length) throw bad('The file is empty');
    const [head, ...body] = recs; if (!body.length) throw bad('The file has only the header row: add one menu item per row under it');
    if (body.length > MAX_UPLOAD_ROWS) throw bad(`Up to ${MAX_UPLOAD_ROWS} rows in one file (this one has ${body.length})`);
    const width = Math.max(...recs.map(r => r.cells.length)); if (width > MAX_UPLOAD_COLS) throw tooWide(width); // trailing empty cells are already gone
    const pad = c => Array.from({ length: width }, (_, i) => c[i] ?? '');
    return { columns: pad(head.cells).map((c, i) => str(c, 80) || `Column ${i + 1}`), rows: body.map(r => pad(r.cells)), lines: body.map(r => r.line), total: body.length };
  }));
  // Same rules as Add item, per row. A name is one item across the whole menu (nameKey): an active item with that name, in any category,
  // is updated and, when the file gives another category, moved there (an empty category cell leaves it where it is); otherwise the row
  // adds an item. A name twice in one file is rejected the second time. A missing category is created. Names already on the menu twice
  // (from before this rule) update the oldest and are listed in `duplicates`. Rejected rows are skipped and listed; nothing is saved
  // unless dry_run is false, then all in one go.
  S.post('/canteen/menu/import', wrap(async req => { await need(req); const tid = req.tenantId, list = req.body.rows, dry = req.body.dry_run !== false;
    if (!Array.isArray(list) || !list.length) throw bad('No rows to import');
    if (list.length > MAX_UPLOAD_ROWS) throw bad(`Up to ${MAX_UPLOAD_ROWS} rows in one file`);
    return tx(async () => { await menuLock(tid); // one menu change at a time per campus: the caps and the name matching stay true
      const cats = await all('SELECT id, name FROM canteen_categories WHERE tenant_id=? ORDER BY sort_order, name', tid), catId = new Map();
      for (const c of cats) if (!catId.has(nameKey(c.name))) catId.set(nameKey(c.name), c.id);
      const have = new Map(), twice = new Map(); // name key → the oldest active item; the names on the menu more than once
      for (const i of await all('SELECT i.id, i.name, c.name cat, i.deal_pct, i.deal_kind, i.deal_until FROM canteen_items i LEFT JOIN canteen_categories c ON c.id=i.category_id AND c.tenant_id=i.tenant_id WHERE i.tenant_id=? AND i.active=1 ORDER BY i.created_at, i.id', tid)) {
        const k = nameKey(i.name); if (!have.has(k)) have.set(k, i); else if (!twice.has(k)) twice.set(k, have.get(k).name); }
      const newCats = new Map(), seen = new Map(), rejected = [], adds = [], updates = [];
      list.forEach((r, i) => { const row = Number.isInteger(r?.row) ? r.row : i + 2, v = uploadRow(r); if (v.error) return rejected.push({ row, reason: v.error });
        const nk = nameKey(v.f.name); if (seen.has(nk)) return rejected.push({ row, reason: `Same item as row ${seen.get(nk)}` }); seen.set(nk, row);
        const cn = unq(str(r.category, 60)), ck = nameKey(cn), cid = cn ? catId.get(ck) : null, old = have.get(nk);
        const move = !!old && !!cn && ck !== nameKey(old.cat); // the category it is in already (by name), or an empty cell: it stays put
        if (cn && !cid && !newCats.has(ck) && (!old || move)) newCats.set(ck, cn);
        if (!old) return adds.push({ cid, ck, f: v.f });
        // the item's own deal (same % and type, e.g. a downloaded menu uploaded back) is left alone: a running sale keeps its end, an ended
        // one stays ended. Only another % or type starts a new deal from the file's minutes.
        if (v.f.deal_pct && v.f.deal_pct === old.deal_pct && v.f.deal_kind === old.deal_kind) { delete v.f.deal_pct; delete v.f.deal_kind; delete v.f.deal_until; }
        updates.push({ id: old.id, move, cid, ck, f: v.f }); });
      const nItems = (await one('SELECT count(*) n FROM canteen_items WHERE tenant_id=?', tid)).n;
      if (nItems + adds.length > MAX_ITEMS) throw bad(`The menu holds up to ${MAX_ITEMS} items: it has ${nItems} and this file adds ${adds.length}. Remove old items or rows and try again`);
      if (cats.length + newCats.size > MAX_CATS) throw bad(`Up to ${MAX_CATS} categories: there are ${cats.length} and this file adds ${newCats.size}`);
      if (!dry) {
        let so = cats.length; for (const [ck, name] of newCats) { const id = uid(); catId.set(ck, id); await run('INSERT INTO canteen_categories (id, tenant_id, name, sort_order, created_at) VALUES (?,?,?,?,?)', id, tid, name, so++, now()); }
        for (const a of adds) { const o = { id: uid(), tenant_id: tid, is_veg: 1, created_at: now(), category_id: a.cid === null ? null : a.cid || catId.get(a.ck), ...a.f };
          await run(`INSERT INTO canteen_items (${Object.keys(o).join(',')}) VALUES (${Object.keys(o).map(() => '?').join(',')})`, ...Object.values(o)); }
        for (const u of updates) { const set = u.move ? { ...u.f, category_id: u.cid || catId.get(u.ck) } : u.f;
          await run(`UPDATE canteen_items SET ${Object.keys(set).map(k => k + '=?').join(',')} WHERE id=? AND tenant_id=?`, ...Object.values(set), u.id, tid); }
      }
      // updated counts every matched item, moved the ones of them that change category
      return { dry_run: dry, added: adds.length, updated: updates.length, moved: updates.filter(u => u.move).length, categories_created: newCats.size, rejected,
        duplicates: { count: twice.size, names: [...twice.values()].slice(0, 5) } };
    });
  }));

  // end-of-day sale on everything still in stock (or a flash sale on all), and ending every deal at once
  S.post('/canteen/deals/all', wrap(async req => { await need(req); const b = req.body, pct = Math.floor(Number(b.pct) || 0), mins = Math.floor(Number(b.minutes) || 0), kind = b.kind === 'flash' ? 'flash' : 'eod';
    if (pct < 1 || pct > 90) throw bad('Discount must be 1% to 90%'); if (mins < 5 || mins > 1440) throw bad('Pick how long: 5 minutes to 24 hours');
    const r = await run('UPDATE canteen_items SET deal_pct=?, deal_kind=?, deal_until=? WHERE tenant_id=? AND active=1 AND sold_out=0 AND NOT (deal_pct >= ? AND deal_kind IS NOT NULL AND (deal_until IS NULL OR deal_until > ?))', pct, kind, new Date(Date.now() + mins * 6e4).toISOString(), req.tenantId, pct, now()); // an item with a bigger live deal keeps it
    return { items: r.changes }; }));
  S.delete('/canteen/deals', wrap(async req => { await need(req); const r = await run('UPDATE canteen_items SET deal_pct=0, deal_kind=NULL, deal_until=NULL WHERE tenant_id=? AND deal_pct>0', req.tenantId); return { ended: r.changes }; }));

  // ---- open / close for the day ----
  S.post('/canteen/open', wrap(async req => { const a = await needCan(req, 'openclose'), day = dayOf(a.tenant.timezone);
    if (a.tenant.canteen_stock_day !== day) await run('UPDATE canteen_items SET sold_out=0 WHERE tenant_id=?', req.tenantId); // a fresh day: everything back in stock (reopening the same day keeps the marks)
    await run('UPDATE tenants SET canteen_open_day=?, canteen_stock_day=? WHERE id=?', day, day, req.tenantId); return { open: true, day }; }));
  S.post('/canteen/close', wrap(async req => { await needCan(req, 'openclose'); await run('UPDATE tenants SET canteen_open_day=NULL WHERE id=?', req.tenantId);
    const p = await one(`SELECT count(*) n FROM canteen_orders WHERE tenant_id=? AND status IN ${LIVE}`, req.tenantId); return { open: false, pending: p.n }; }));

  // ---- orders ----
  S.get('/canteen/orders', wrap(async req => { const a0 = await needCan(req, 'orders'); await expire(a0.tenant); const a = a0, day = /^\d{4}-\d{2}-\d{2}$/.test(req.query.day || '') ? req.query.day : dayOf(a.tenant.timezone);
    const rows = await all(`SELECT * FROM canteen_orders WHERE tenant_id=? AND (day=? OR (day<? AND status IN ${LIVE})) ORDER BY day DESC, token_no DESC`, req.tenantId, day, day);
    const pr = payOf(a.tenant);
    return { sla: { prep: pr.prep_sla_min, delivery: pr.delivery_sla_min }, print: { paper: pr.paper, auto_bill: pr.auto_bill, kot_at_counter: pr.kot_at_counter, footer: pr.bill_footer, tagline: pr.tagline }, day, open: isOpen(a.tenant), state: stateOf(a.tenant), name: canteenName(a.tenant), today_check: dayCheck(req.tenantId, day), orders: (await withCashier(rows)).map(o => ({ ...pub(o), check_code: checkCode(o), email: o.email, phone: o.phone, earlier: o.day !== day })) }; }));
  S.post('/canteen/orders/:id/:to(accepted|rejected|ready|out|collected)', wrap(async req => {
    const to = req.params.to, a = to === 'ready' ? await needCan(req, 'orders', 'kitchen', 'pos') : await needCan(req, 'orders', ...(to === 'collected' ? ['pos'] : [])), o = await one('SELECT * FROM canteen_orders WHERE id=? AND tenant_id=?', req.params.id, req.tenantId);
    if (!o) throw notFound();
    if (!(NEXT[o.status] || []).includes(to)) throw bad(`This order is ${STATUS[o.status].toLowerCase()}; it can't be marked ${to}.`);
    const reason = str(req.body.reason, 200); if (to === 'rejected' && reason.length < 3) throw bad('Please give the student a reason for rejecting');
    if (to === 'out' && o.fulfil !== 'delivery') throw bad('This order is for pickup at the counter');
    if (to === 'accepted') { // payment confirmed by staff: cash taken at the counter, or the UPI payment seen in the canteen's UPI app
      const r0 = await run(`UPDATE canteen_orders SET pay_status='paid', paid_at=?, paid_by=?, status='accepted', accepted_at=?, handled_by=? WHERE id=? AND status='placed'`, now(), req.user.id, now(), req.user.id, o.id); if (!r0.changes) throw bad('Someone else just updated this order. Please refresh.');
      o.bill_no = await giveBill(req.tenantId, o.id); Object.assign(o, { pay_status: 'paid', paid_at: now(), paid_by: req.user.id, cashier_name: req.user.name, status: 'accepted', accepted_at: now() }); }
    const col = { accepted: 'accepted_at', ready: 'ready_at', out: 'out_at', collected: 'collected_at', rejected: 'closed_at' }[to];
    const r = to === 'accepted' ? { changes: 1 } : await run(`UPDATE canteen_orders SET status=?, ${col}=?, ${to === 'collected' ? 'closed_at=?,' : ''} reject_reason=?, handled_by=? WHERE id=? AND status=?`,
      to, now(), ...(to === 'collected' ? [now()] : []), to === 'rejected' ? reason : o.reject_reason, req.user.id, o.id, o.status);
    if (!r.changes) throw bad('Someone else just updated this order. Please refresh.');
    const n = { ...o, status: to, reject_reason: to === 'rejected' ? reason : o.reject_reason }, tk = tokenLabel(o.token_no);
    if (to === 'ready' && o.fulfil !== 'delivery') await mail(a.tenant, o.email, 'canteen_ready', `Order ${tk} is ready to collect`, [`Hi ${esc(o.name)},`, `Your order <b>${tk}</b> is ready. Show the token at the counter to collect it.`], orderLink(a.tenant, o));
    if (to === 'out') await mail(a.tenant, o.email, 'canteen_out', `Order ${tk} is on its way`, [`Hi ${esc(o.name)},`, `Your order <b>${tk}</b> is out for delivery to ${esc(o.deliver_to)}.`], orderLink(a.tenant, o));
    if (to === 'rejected') await mail(a.tenant, o.email, 'canteen_rejected', `Order ${tk} could not be accepted`, [`Hi ${esc(o.name)},`, `Sorry, the canteen could not take your order <b>${tk}</b>.`, `Reason: ${esc(reason)}`,
      ...(o.pay_status === 'paid' || o.pay_status === 'claimed' ? [`If you already paid ${rupees(o.total_paise)}, please collect your refund at the counter with this token.`] : [])], orderLink(a.tenant, o));
    return pub(n);
  }));

  // ---- the counter (POS): a walk-in customer pays in person, the order goes straight to the kitchen ----
  // a walk-in paying by UPI: a QR for the exact bill, shown on the counter screen; the order is made only after the cashier sees the money
  S.get('/canteen/pos/upi.svg', async (req, res, next) => { try { const a = await needCan(req, 'pos'), p = payOf(a.tenant), amt = Math.round(Number(req.query.amount));
    if (!p.upi_id) throw bad('UPI is not set up for this canteen'); if (!(amt > 0 && amt <= 10000000)) throw bad('Amount needed');
    const link = `upi://pay?${new URLSearchParams({ pa: p.upi_id, pn: p.upi_name || canteenName(a.tenant), am: (amt / 100).toFixed(2), cu: 'INR', tn: `${canteenName(a.tenant)} counter bill` })}`;
    res.set({ 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' }).send(await qrSvg(link)); } catch (e) { next(e); } });
  S.get('/canteen/pos', wrap(async req => { const a = await needCan(req, 'pos'), p = payOf(a.tenant);
    return { name: canteenName(a.tenant), open: isOpen(a.tenant), upi: !!p.upi_id, upi_id: p.upi_id, cash: true, print: { paper: p.paper, auto_bill: p.auto_bill, kot_at_counter: p.kot_at_counter, footer: p.bill_footer, tagline: p.tagline }, ...(await menuOf(req.tenantId)) }; }));
  S.post('/canteen/pos', wrap(async req => { const a = await needCan(req, 'pos'), tn = a.tenant, b = req.body;
    if (!isOpen(tn)) throw bad('Open the canteen for the day first');
    const mode = b.pay_mode === 'upi' ? 'upi' : 'cash', lines = Array.isArray(b.items) ? b.items.slice(0, MAX_LINES + 1) : [];
    if (!lines.length) throw bad('Add at least one item'); if (lines.length > MAX_LINES) throw bad('Too many different items in one bill');
    if (mode === 'upi' && !payOf(tn).upi_id) throw bad('UPI is not set up for this canteen');
    const rows = await all(`SELECT * FROM canteen_items WHERE tenant_id=? AND id = ANY(?::text[])`, tn.id, [...new Set(lines.map(l => String(l.id)))]), cats = await all('SELECT id, name FROM canteen_categories WHERE tenant_id=?', tn.id), out = [];
    for (const l of lines) { const it = rows.find(r => r.id === String(l.id)), qty = Math.floor(Number(l.qty));
      if (!it || !it.active) throw bad('An item is no longer on the menu. Please refresh.');
      if (it.sold_out) throw bad(`${it.name} is marked sold out. Remove it, or mark it back in stock (Stock button on this screen).`);
      if (!(qty >= 1 && qty <= 99)) throw bad(`Quantity for ${it.name} must be 1 to 99`);
      const prev = out.find(x => x.id === it.id); if (prev) { prev.qty = Math.min(99, prev.qty + qty); continue; }
      const d = dealOf(it), cat = cats.find(c => c.id === it.category_id)?.name || null;
      out.push({ id: it.id, name: it.name, price_paise: priceNow(it), qty, ...(it.image_key ? { img: imgUrl(it.image_key) } : {}), ...(d ? { mrp_paise: it.price_paise, deal: d.kind, pct: d.pct } : {}), ...(cat ? { category: cat } : {}) }); }
    const total = out.reduce((s, x) => s + x.price_paise * x.qty, 0);
    if (b.expect_paise != null && Number(b.expect_paise) !== total) throw new HttpErr(409, 'PRICE_CHANGED', `Prices changed (a deal ended or a price was edited). The bill is now ${rupees(total)}: check it with the customer and charge again.`);
    let tendered = null, ref = null;
    if (mode === 'cash') { tendered = Math.round(Number(b.tendered) * 100); if (!Number.isFinite(tendered) || b.tendered === '' || b.tendered == null) tendered = total; // nothing typed: exact amount
      if (tendered < total) throw bad(`Cash received (${rupees(tendered)}) is less than the bill (${rupees(total)})`); if (tendered > total + 200000) throw bad('That cash amount looks wrong'); }
    else { ref = str(b.upi_ref, 40).replace(/\s/g, '') || null; if (ref && !UTR.test(ref)) throw bad('A UPI reference number is 6 to 30 letters or digits');
      if (ref && await one('SELECT 1 FROM canteen_orders WHERE tenant_id=? AND upper(upi_ref)=upper(?)', tn.id, ref)) throw bad('That UPI reference is already used on another order'); }
    const day = dayOf(tn.timezone), t = now();
    for (let i = 0; i < 5; i++) {
      const n = ((await one('SELECT max(token_no) m FROM canteen_orders WHERE tenant_id=? AND day=?', tn.id, day)).m || 0) + 1;
      const o = { id: uid(), tenant_id: tn.id, day, token_no: n, view_key: crypto.randomBytes(12).toString('base64url'), device_hash: null, email: '', name: str(b.name, 80) || 'Walk-in',
        phone: str(b.phone, 20) || null, note: str(b.note, 200) || null, items: JSON.stringify(out), total_paise: total, status: 'accepted', created_at: t, accepted_at: t,
        pay_mode: mode, pay_status: 'paid', paid_at: t, paid_by: req.user.id, upi_ref: ref, fulfil: 'pickup', channel: 'counter', cash_tendered_paise: tendered, handled_by: req.user.id,
        service: b.service === 'dine_in' ? 'dine_in' : 'takeaway', table_no: b.service === 'dine_in' ? str(b.table_no, 10) || null : null };
      try { await run(`INSERT INTO canteen_orders (${Object.keys(o).join(',')}) VALUES (${Object.keys(o).map(() => '?').join(',')})`, ...Object.values(o)); }
      catch (e) { if (e.code !== '23505') throw e; if (/upi/.test(e.constraint || '')) throw bad('That UPI reference is already used on another order'); continue; }
      o.bill_no = await giveBill(tn.id, o.id);
      return { ...pub({ ...o, cashier_name: req.user.name }), change_paise: tendered != null ? tendered - total : 0 };
    }
    throw new HttpErr(503, 'BUSY', 'Busy, please try again');
  }));
  // a bill or KOT was printed: counts reprints, so a second copy says DUPLICATE
  S.post('/canteen/orders/:id/printed', wrap(async req => { const kind = req.body.kind === 'kot' ? 'kot' : 'bill'; await needCan(req, 'pos', 'orders', ...(kind === 'kot' ? ['kitchen'] : []));
    const o = await one('SELECT status, pay_status FROM canteen_orders WHERE id=? AND tenant_id=?', req.params.id, req.tenantId); if (!o) throw notFound();
    if (kind === 'bill' && o.pay_status !== 'paid') throw bad('A bill is printed once the order is paid');
    const r = await one(`UPDATE canteen_orders SET ${kind}_prints = coalesce(${kind}_prints,0) + 1 WHERE id=? RETURNING ${kind}_prints n`, req.params.id);
    return { prints: r.n, duplicate: r.n > 1 }; }));
  // the cashier's shift: what this person took today (cash drawer check)
  S.get('/canteen/shift', wrap(async req => { const a = await needCounter(req), day = dayOf(a.tenant.timezone);
    const rows = (await all(`SELECT * FROM canteen_orders WHERE tenant_id=? AND paid_by=? AND pay_status='paid' AND paid_at > ?`, req.tenantId, req.user.id, new Date(Date.now() - 40 * 3600e3).toISOString())).filter(o => dayOf(a.tenant.timezone, new Date(o.paid_at)) === day); // paid today, whatever day it was ordered
    const keep = rows.filter(o => o.status !== 'rejected'), refunds = rows.filter(o => o.status === 'rejected');
    return { day, orders: keep.length, cash_paise: keep.filter(o => o.pay_mode !== 'upi').reduce((s, o) => s + o.total_paise, 0), upi_paise: keep.filter(o => o.pay_mode === 'upi').reduce((s, o) => s + o.total_paise, 0),
      counter_orders: keep.filter(o => o.channel === 'counter').length, refunds_paise: refunds.reduce((s, o) => s + o.total_paise, 0) }; }));

  // ---- kitchen: KOTs (paid orders) ----
  S.get('/canteen/kitchen', wrap(async req => { const a = await needKitchen(req);
    const rows = await all(`SELECT * FROM canteen_orders WHERE tenant_id=? AND (status='accepted' OR (status IN ('ready','out','collected') AND ready_at > ?)) ORDER BY accepted_at`, req.tenantId, new Date(Date.now() - 2 * 3600e3).toISOString());
    const pr = payOf(a.tenant);
    return { sla: { prep: pr.prep_sla_min }, print: { paper: pr.paper, auto_kot: pr.auto_kot }, name: canteenName(a.tenant), cook: !!a.cook, kots: rows.filter(o => o.status === 'accepted').map(pub), done: rows.filter(o => o.status !== 'accepted').reverse().slice(0, 20).map(pub) }; }));
  S.post('/canteen/kitchen/:id/start', wrap(async req => { await needKitchen(req);
    const r = await run(`UPDATE canteen_orders SET kot_started_at=?, kot_by=? WHERE id=? AND tenant_id=? AND status='accepted' AND kot_started_at IS NULL`, now(), req.user.id, req.params.id, req.tenantId);
    if (!r.changes) throw bad('This KOT was already started or is no longer in the kitchen. Please refresh.'); return { ok: true }; }));

  // ---- inventory: raw stock (rice, oil, milk, gas …), every change kept with who and why ----
  const UNITS = ['kg', 'g', 'litre', 'ml', 'pcs', 'packet', 'dozen', 'tray', 'bottle', 'can', 'box', 'cylinder', 'bag'];
  const num = (v, what, min = 0) => { if (v === undefined || v === null || String(v).trim() === '') throw bad(`Enter the ${what}`); const n = Number(String(v).replace(/,/g, '')); if (!Number.isFinite(n) || n < min || n > 1e7) throw bad(`Enter a valid ${what}`); return Math.round(n * 1000) / 1000; };
  const invRow = r => ({ id: r.id, name: r.name, unit: r.unit, category: r.category, category_id: r.category_id, qty: r.qty, min_qty: r.min_qty, cost_paise: r.cost_paise, active: !!r.active, low: r.active && r.qty <= r.min_qty, out: r.active && r.qty <= 0, value_paise: Math.round(Math.max(0, r.qty) * r.cost_paise), updated_at: r.updated_at });
  S.get('/canteen/inventory', wrap(async req => { await needCan(req, 'inventory');
    const items = (await all('SELECT * FROM canteen_inv_items WHERE tenant_id=? ORDER BY active DESC, category NULLS LAST, name', req.tenantId)).map(invRow), live = items.filter(i => i.active);
    const moves = await all(`SELECT m.*, i.name item, i.unit FROM canteen_inv_moves m JOIN canteen_inv_items i ON i.id=m.item_id WHERE m.tenant_id=? ORDER BY m.created_at DESC LIMIT 60`, req.tenantId);
    const cats = (await all('SELECT id, name, sort_order FROM canteen_inv_categories WHERE tenant_id=? ORDER BY sort_order, lower(name)', req.tenantId)).map(c => { const its = live.filter(i => i.category_id === c.id);
      return { ...c, items: its.length, low: its.filter(i => i.low).length, value_paise: its.reduce((x, i) => x + i.value_paise, 0) }; });
    return { cats, units: UNITS, items, low: live.filter(i => i.low).length, out: live.filter(i => i.out).length, value_paise: live.reduce((s, i) => s + i.value_paise, 0), categories: [...new Set(live.map(i => i.category).filter(Boolean))].sort(), moves }; }));
  const invFields = async (req, b, partial) => { const f = {};
    if (!partial || b.name !== undefined) { f.name = str(b.name, 80); if (!f.name) throw bad('Name required'); }
    if (!partial || b.unit !== undefined) { f.unit = str(b.unit, 20).toLowerCase(); if (!UNITS.includes(f.unit)) throw bad('Pick a unit from the list'); }
    if (b.category_id !== undefined) { if (!b.category_id) Object.assign(f, { category_id: null, category: null });
      else { const c = await one('SELECT id, name FROM canteen_inv_categories WHERE id=? AND tenant_id=?', String(b.category_id), req.tenantId); if (!c) throw bad('Pick a category from the list'); Object.assign(f, { category_id: c.id, category: c.name }); } }
    else if (b.category !== undefined) { const name = str(b.category, 40); // a category by name: the existing one, or a new one
      if (!name) Object.assign(f, { category_id: null, category: null }); else { const c = await invCat(req.tenantId, name); Object.assign(f, { category_id: c.id, category: c.name }); } }
    if (b.min_qty !== undefined) f.min_qty = String(b.min_qty).trim() === '' ? 0 : num(b.min_qty, 'minimum level');
    if (b.cost !== undefined) f.cost_paise = String(b.cost).trim() === '' ? 0 : num(b.cost, 'cost per unit') * 100;
    if (b.active !== undefined) f.active = b.active ? 1 : 0;
    return f; };
  const invCat = async (tid, name) => { const c = await one('SELECT id, name FROM canteen_inv_categories WHERE tenant_id=? AND lower(name)=lower(?)', tid, name); if (c) return c;
    if ((await one('SELECT count(*) n FROM canteen_inv_categories WHERE tenant_id=?', tid)).n >= 100) throw bad('Up to 100 inventory categories');
    const id = uid(), n = (await one('SELECT coalesce(max(sort_order),0)+1 n FROM canteen_inv_categories WHERE tenant_id=?', tid)).n;
    await run('INSERT INTO canteen_inv_categories (id, tenant_id, name, sort_order, created_at) VALUES (?,?,?,?,?) ON CONFLICT DO NOTHING', id, tid, name, n, now());
    return one('SELECT id, name FROM canteen_inv_categories WHERE tenant_id=? AND lower(name)=lower(?)', tid, name); };
  // ---- inventory categories: add, rename, reorder, delete (items move to another category or to none) ----
  S.post('/canteen/inventory/categories', wrap(async req => { await needCan(req, 'inventory'); const name = str(req.body.name, 40); if (!name) throw bad('Category name required');
    if (await one('SELECT 1 FROM canteen_inv_categories WHERE tenant_id=? AND lower(name)=lower(?)', req.tenantId, name)) throw bad('That category already exists');
    return invCat(req.tenantId, name); }));
  S.patch('/canteen/inventory/categories/:id', wrap(async req => { await needCan(req, 'inventory');
    const c = await one('SELECT * FROM canteen_inv_categories WHERE id=? AND tenant_id=?', req.params.id, req.tenantId); if (!c) throw notFound();
    if (req.body.name !== undefined) { const name = str(req.body.name, 40); if (!name) throw bad('Category name required');
      if (await one('SELECT 1 FROM canteen_inv_categories WHERE tenant_id=? AND lower(name)=lower(?) AND id<>?', req.tenantId, name, c.id)) throw bad('Another category already has that name');
      await tx(async () => { await run('UPDATE canteen_inv_categories SET name=? WHERE id=?', name, c.id); await run('UPDATE canteen_inv_items SET category=? WHERE category_id=?', name, c.id); }); }
    if (req.body.move === 'up' || req.body.move === 'down') { // swap places with the neighbour
      const list = await all('SELECT id FROM canteen_inv_categories WHERE tenant_id=? ORDER BY sort_order, lower(name)', req.tenantId), i = list.findIndex(x => x.id === c.id), j = req.body.move === 'up' ? i - 1 : i + 1;
      if (j >= 0 && j < list.length) { [list[i], list[j]] = [list[j], list[i]]; await tx(async () => { for (const [k, x] of list.entries()) await run('UPDATE canteen_inv_categories SET sort_order=? WHERE id=?', k, x.id); }); } }
    return { ok: true }; }));
  S.delete('/canteen/inventory/categories/:id', wrap(async req => { await needCan(req, 'inventory');
    const c = await one('SELECT * FROM canteen_inv_categories WHERE id=? AND tenant_id=?', req.params.id, req.tenantId); if (!c) throw notFound();
    const n = (await one('SELECT count(*) n FROM canteen_inv_items WHERE category_id=?', c.id)).n, to = req.body?.move_to;
    if (n && to === undefined) throw new HttpErr(409, 'HAS_ITEMS', `${n} stock item${n === 1 ? ' is' : 's are'} in ${c.name}. Pick where to move ${n === 1 ? 'it' : 'them'} first.`);
    const dest = to ? await one('SELECT id, name FROM canteen_inv_categories WHERE id=? AND tenant_id=? AND id<>?', String(to), req.tenantId, c.id) : null; if (to && !dest) throw bad('Pick another category to move the items to');
    await tx(async () => { await run('UPDATE canteen_inv_items SET category_id=?, category=?, updated_at=? WHERE category_id=?', dest?.id ?? null, dest?.name ?? null, now(), c.id); await run('DELETE FROM canteen_inv_categories WHERE id=?', c.id); });
    return { moved: n, to: dest?.name ?? null }; }));
  S.post('/canteen/inventory', wrap(async req => { const a = await needCan(req, 'inventory'), f = await invFields(req, req.body, false), qty = num(req.body.qty ?? 0, 'opening stock');
    if ((await one('SELECT count(*) n FROM canteen_inv_items WHERE tenant_id=?', req.tenantId)).n >= 1000) throw bad('Up to 1000 stock items');
    if (await one('SELECT 1 FROM canteen_inv_items WHERE tenant_id=? AND lower(name)=lower(?) AND active=1', req.tenantId, f.name)) throw bad('That item is already in the inventory');
    const id = uid(), t = now(); await run(`INSERT INTO canteen_inv_items (id, tenant_id, name, unit, category, category_id, qty, min_qty, cost_paise, active, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,1,?,?)`,
      id, req.tenantId, f.name, f.unit, f.category ?? null, f.category_id ?? null, qty, f.min_qty ?? 0, f.cost_paise ?? 0, t, t);
    if (qty) await run(`INSERT INTO canteen_inv_moves (id, tenant_id, item_id, kind, qty, before_qty, after_qty, cost_paise, note, user_id, user_name, created_at) VALUES (?,?,?,'count',?,0,?,0,'Opening stock',?,?,?)`, uid(), req.tenantId, id, qty, qty, req.user.id, req.user.name, t);
    return invRow(await one('SELECT * FROM canteen_inv_items WHERE id=?', id)); }));
  S.patch('/canteen/inventory/:id', wrap(async req => { await needCan(req, 'inventory'); const f = await invFields(req, req.body, true); if (!Object.keys(f).length) throw bad('Nothing to change');
    const cur = await one('SELECT name, active FROM canteen_inv_items WHERE id=? AND tenant_id=?', req.params.id, req.tenantId); if (!cur) throw notFound();
    if ((f.active ?? cur.active) && await one('SELECT 1 FROM canteen_inv_items WHERE tenant_id=? AND lower(name)=lower(?) AND active=1 AND id<>?', req.tenantId, f.name ?? cur.name, req.params.id)) throw bad('Another stock item already has that name');
    const r = await run(`UPDATE canteen_inv_items SET ${Object.keys(f).map(k => k + '=?').join(',')}, updated_at=? WHERE id=? AND tenant_id=?`, ...Object.values(f), now(), req.params.id, req.tenantId); if (!r.changes) throw notFound(); return { ok: true }; }));
  // a stock change: in (bought, with its cost), use (to the kitchen), waste (spoiled, spilt), count (the physical count: sets the level)
  S.post('/canteen/inventory/:id/move', wrap(async req => { await needCan(req, 'inventory'); const b = req.body, kind = ['in', 'use', 'waste', 'count'].includes(b.kind) ? b.kind : null; if (!kind) throw bad('Pick in, use, waste or count');
    const qty = num(b.qty, 'quantity'); if (kind !== 'count' && qty <= 0) throw bad('Enter a quantity above 0');
    const note = str(b.note, 200) || null; if (kind === 'waste' && !note) throw bad('Say why it was wasted');
    const cost = kind === 'in' && b.cost !== undefined && b.cost !== '' ? Math.round(num(b.cost, 'total cost') * 100) : 0;
    for (let i = 0; i < 3; i++) { const it = await one('SELECT * FROM canteen_inv_items WHERE id=? AND tenant_id=? AND active=1', req.params.id, req.tenantId); if (!it) throw notFound();
      const after = Math.round((kind === 'count' ? qty : kind === 'in' ? it.qty + qty : it.qty - qty) * 1000) / 1000;
      if (after < 0) throw bad(`Only ${it.qty} ${it.unit} in stock: you can't take out ${qty}. Do a count if the stock is wrong.`);
      const unitCost = kind === 'in' && cost ? cost / qty : null; // the latest purchase price becomes the cost per unit
      const done = await tx(async () => { const r = await run(`UPDATE canteen_inv_items SET qty=?, updated_at=?${unitCost != null ? ', cost_paise=?' : ''} WHERE id=? AND qty=?`, after, now(), ...(unitCost != null ? [unitCost] : []), it.id, it.qty);
      if (!r.changes) return false; // someone changed it at the same moment: read again
      await run(`INSERT INTO canteen_inv_moves (id, tenant_id, item_id, kind, qty, before_qty, after_qty, cost_paise, note, user_id, user_name, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        uid(), req.tenantId, it.id, kind, kind === 'count' ? Math.round((after - it.qty) * 1000) / 1000 : qty, it.qty, after, cost || (kind !== 'in' ? Math.round(Math.abs(after - it.qty) * it.cost_paise) : 0), note, req.user.id, req.user.name, now()); return true; });
      if (!done) continue;
      return invRow(await one('SELECT * FROM canteen_inv_items WHERE id=?', it.id)); }
    throw new HttpErr(409, 'BUSY', 'The stock just changed. Please try again.'); }));
  S.delete('/canteen/inventory/:id', wrap(async req => { await needCan(req, 'inventory'); const r = await run('UPDATE canteen_inv_items SET active=0, updated_at=? WHERE id=? AND tenant_id=?', now(), req.params.id, req.tenantId); if (!r.changes) throw notFound(); return { ok: true }; }));
  // purchases, use and waste over a period (inventory staff, managers and anyone with reports)
  S.get('/canteen/inventory/report', wrap(async req => { const a = await needCan(req, 'inventory', 'reports'), today = dayOf(a.tenant.timezone), back = { day: 0, week: 6, month: 29 }[req.query.range] ?? 6;
    const from = addDays(today, -back), tz = a.tenant.timezone || 'Asia/Kolkata';
    const moves = (await all(`SELECT m.*, i.name item, i.unit, i.category FROM canteen_inv_moves m JOIN canteen_inv_items i ON i.id=m.item_id WHERE m.tenant_id=? AND m.created_at > ? ORDER BY m.created_at`, req.tenantId, new Date(Date.parse(from + 'T00:00:00Z') - 86400e3).toISOString()))
      .filter(m => dayOf(tz, new Date(m.created_at)) >= from);
    const by = {}; for (const m of moves) { const e = by[m.item_id] ||= { item: m.item, category: m.category || 'No category', unit: m.unit, in: 0, use: 0, waste: 0, adjust: 0, bought_paise: 0, waste_paise: 0 };
      if (m.kind === 'in') { e.in += m.qty; e.bought_paise += m.cost_paise; } else if (m.kind === 'use') e.use += m.qty; else if (m.kind === 'waste') { e.waste += m.qty; e.waste_paise += m.cost_paise; } else e.adjust += m.qty; }
    const rows = Object.values(by).sort((x, y) => y.bought_paise - x.bought_paise || x.item.localeCompare(y.item));
    const by_category = Object.values(rows.reduce((m, r) => { const e = m[r.category] ||= { category: r.category, bought_paise: 0, waste_paise: 0, items: 0 }; e.bought_paise += r.bought_paise; e.waste_paise += r.waste_paise; e.items++; return m; }, {})).sort((x, y) => y.bought_paise - x.bought_paise);
    return { from, to: today, rows, by_category, bought_paise: rows.reduce((s, r) => s + r.bought_paise, 0), waste_paise: rows.reduce((s, r) => s + r.waste_paise, 0), moves: moves.length,
      by_person: Object.values(moves.reduce((m, x) => { const e = m[x.user_id] ||= { name: x.user_name || 'Someone', changes: 0 }; e.changes++; return m; }, {})) }; }));
  S.get('/canteen/inventory.csv', async (req, res, next) => { try { const a = await needCan(req, 'inventory', 'reports'), tzc = a.tenant.timezone || 'Asia/Kolkata';
    const rows = await all(`SELECT m.*, i.name item, i.unit FROM canteen_inv_moves m JOIN canteen_inv_items i ON i.id=m.item_id WHERE m.tenant_id=? ORDER BY m.created_at DESC LIMIT 20000`, req.tenantId);
    const q = v => { if (typeof v === 'number') return String(v); const t = String(v ?? ''); return /[",\r\n]/.test(t) || /^[=+\-@\t\r]/.test(t) ? `"${t.replace(/^([=+\-@\t\r])/, "'$1").replace(/"/g, '""')}"` : t; };
    const K = { in: 'Stock in', use: 'Used', waste: 'Wasted', count: 'Count correction' };
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="canteen-inventory.csv"' }).send('﻿' + [['When', 'Item', 'Change', 'Quantity', 'Unit', 'Before', 'After', 'Cost (₹)', 'Note', 'By'].join(','),
      ...rows.map(m => [new Date(m.created_at).toLocaleString('en-IN', { timeZone: tzc }), m.item, K[m.kind], m.qty, m.unit, m.before_qty, m.after_qty, (m.cost_paise / 100).toFixed(2), m.note, m.user_name].map(q).join(','))].join('\r\n'));
  } catch (e) { next(e); } });

  // ---- reports: collected orders ----
  S.get('/canteen/report', wrap(async req => { const a = await needReports(req), today = dayOf(a.tenant.timezone);
    const back = { day: 0, week: 6, month: 29 }[req.query.range]; // a range is worked out on the campus's own calendar
    const from = back != null ? addDays(today, -back) : /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : addDays(today, -6), to = back != null ? today : /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : today;
    const rows = await all('SELECT * FROM canteen_orders WHERE tenant_id=? AND day>=? AND day<=? ORDER BY day, token_no', req.tenantId, from, to);
    const done = rows.filter(o => o.status === 'collected'), items = {}, cats = {}, hours = Array.from({ length: 24 }, (_, h) => ({ hour: h, orders: 0, paise: 0 })), kinds = {};
    const catNow = Object.fromEntries((await all('SELECT i.id, c.name FROM canteen_items i LEFT JOIN canteen_categories c ON c.id=i.category_id WHERE i.tenant_id=?', req.tenantId)).map(r => [r.id, r.name]));
    const hourOf = iso => +new Intl.DateTimeFormat('en-GB', { timeZone: a.tenant.timezone || 'Asia/Kolkata', hour: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
    let discount = 0;
    for (const o of done) { const h = hours[hourOf(o.created_at)]; h.orders++; h.paise += o.total_paise;
      for (const it of JSON.parse(o.items)) { const e = items[it.name] ||= { name: it.name, category: it.category || catNow[it.id] || 'No category', qty: 0, paise: 0, discount_paise: 0 }; e.qty += it.qty; e.paise += it.qty * it.price_paise;
        const c = cats[e.category] ||= { category: e.category, qty: 0, paise: 0 }; c.qty += it.qty; c.paise += it.qty * it.price_paise;
        if (it.mrp_paise) { const off = (it.mrp_paise - it.price_paise) * it.qty; discount += off; e.discount_paise += off; const k = kinds[it.deal] ||= { kind: it.deal, name: DEAL_KINDS[it.deal] || it.deal, qty: 0, paise: 0, discount_paise: 0 }; k.qty += it.qty; k.paise += it.qty * it.price_paise; k.discount_paise += off; } } }
    const per = {}; for (const o of done) if (o.email) per[o.email] = (per[o.email] || 0) + 1;
    const days = []; for (let d = from; d <= to && days.length < 92; d = addDays(d, 1)) { const x = done.filter(o => o.day === d);
      days.push({ day: d, orders: x.length, paise: x.reduce((s, o) => s + o.total_paise, 0), rejected: rows.filter(o => o.day === d && o.status === 'rejected').length }); }
    const prep = done.filter(o => o.accepted_at && o.ready_at).map(o => (Date.parse(o.ready_at) - Date.parse(o.accepted_at)) / 6e4);
    const revenue = done.reduce((s, o) => s + o.total_paise, 0), taken = rows.filter(o => o.pay_status === 'paid' && !['rejected', 'cancelled'].includes(o.status));
    return { tz: a.tenant.timezone || 'Asia/Kolkata', today, from, to, collected: done.length, revenue_paise: revenue, aov_paise: done.length ? Math.round(revenue / done.length) : 0, discount_paise: discount,
      customers: Object.keys(per).length, repeat_customers: Object.values(per).filter(n => n > 1).length, pickups: done.filter(o => o.fulfil !== 'delivery').length,
      delivery_fee_paise: done.reduce((s, o) => s + (o.delivery_fee_paise || 0), 0), hours: hours.filter(h => h.orders), categories: Object.values(cats).sort((x, y) => y.paise - x.paise),
      items_all: Object.values(items).sort((x, y) => y.paise - x.paise), deals: Object.values(kinds),
      rejected: rows.filter(o => o.status === 'rejected').length, cancelled: rows.filter(o => o.status === 'cancelled').length,
      sla: (() => { const pr = payOf(a.tenant), dl = done.filter(o => o.fulfil === 'delivery' && o.out_at && o.collected_at).map(o => (Date.parse(o.collected_at) - Date.parse(o.out_at)) / 6e4);
        return { prep_target: pr.prep_sla_min, delivery_target: pr.delivery_sla_min, prep_total: prep.length, prep_on_time: prep.filter(m => m <= pr.prep_sla_min).length,
          delivery_total: dl.length, delivery_on_time: dl.filter(m => m <= pr.delivery_sla_min).length, avg_delivery_min: dl.length ? Math.round(dl.reduce((x, y) => x + y, 0) / dl.length) : null }; })(),
      avg_prep_min: prep.length ? Math.round(prep.reduce((x, y) => x + y, 0) / prep.length) : null,
      reasons: Object.entries(rows.filter(o => o.status === 'rejected').reduce((m, o) => (m[o.reject_reason] = (m[o.reject_reason] || 0) + 1, m), {})).map(([reason, count]) => ({ reason, count })).sort((x, y) => y.count - x.count).slice(0, 8),
      top: Object.values(items).sort((x, y) => y.qty - x.qty).slice(0, 15), days,
      cash_paise: taken.filter(o => (o.pay_mode || 'cash') === 'cash').reduce((s, o) => s + o.total_paise, 0), upi_paise: taken.filter(o => o.pay_mode === 'upi').reduce((s, o) => s + o.total_paise, 0), // money taken: paid and not refunded, like the cash drawer
      deliveries: done.filter(o => o.fulfil === 'delivery').length, not_paid: rows.filter(o => o.reject_reason === 'Not paid in time').length,
      refunds: rows.filter(o => o.status === 'rejected' && ['paid', 'claimed'].includes(o.pay_status)).map(o => ({ token: tokenLabel(o.token_no), day: o.day, name: o.name, paise: o.total_paise, mode: o.pay_mode, ref: o.upi_ref })),
      channels: ['online', 'counter'].map(c => { const x = done.filter(o => (o.channel || 'online') === c); return { channel: c, orders: x.length, paise: x.reduce((s, o) => s + o.total_paise, 0) }; }),
      staff: await (async () => { const paid = rows.filter(o => o.pay_status === 'paid' && o.paid_by && o.status !== 'rejected'), by = {};
        for (const o of paid) { const e = by[o.paid_by] ||= { id: o.paid_by, orders: 0, cash_paise: 0, upi_paise: 0, counter: 0 }; e.orders++; e[o.pay_mode === 'upi' ? 'upi_paise' : 'cash_paise'] += o.total_paise; if (o.channel === 'counter') e.counter++; }
        const names = Object.fromEntries((await all('SELECT id, name FROM users WHERE id = ANY(?::text[])', Object.keys(by))).map(u => [u.id, u.name]));
        return Object.values(by).map(e => ({ ...e, name: names[e.id] || 'Someone' })).sort((x, y) => (y.cash_paise + y.upi_paise) - (x.cash_paise + x.upi_paise)); })(),
      reprints: rows.reduce((s, o) => s + Math.max(0, (o.bill_prints || 0) - 1), 0) };
  }));
  // every order in the period as a spreadsheet (one row per order)
  S.get('/canteen/orders.csv', async (req, res, next) => { try { const a = await needReports(req), today = dayOf(a.tenant.timezone);
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
