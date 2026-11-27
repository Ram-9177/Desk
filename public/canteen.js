// Canteen screens. Student side (#/d/<campus>/canteen…): browse the menu without logging in, verify email once per device,
// order, get a token, watch the status refresh by itself, collect at the counter. Desk side (#/c/canteen): canteen managers
// open the canteen for the day, run the order board, build the menu and see reports; the super admin sets it up.
// app.js hands in its helpers so this file looks and behaves like the rest of ONE Desk.
let H; // { api, esc, toast, I, dlg, app }
export const initCanteen = h => { H = h; };
const rupees = p => '₹' + (p / 100).toFixed(p % 100 ? 2 : 0);
const ls = { get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } } };
const STEPS = [['placed', 'Placed'], ['accepted', 'Preparing'], ['ready', 'Ready'], ['collected', 'Collected']];
let timer = null, S_find = '', kotSeen = null, posCart = {}, posLast = null, openDone = false;
const every = (ms, fn, hash) => { clearInterval(timer); timer = setInterval(() => { if (location.hash.split('?')[0] !== hash) return clearInterval(timer); if (!document.hidden) fn(); }, ms); };
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const t12 = hm => { if (!hm) return ''; const [h, m] = hm.split(':').map(Number); return `${(h % 12) || 12}${m ? ':' + String(m).padStart(2, '0') : ''} ${h < 12 ? 'AM' : 'PM'}`; };
const daysText = d => d.length === 7 ? 'every day' : d.join() === '1,2,3,4,5,6' ? 'Mon–Sat' : d.join() === '1,2,3,4,5' ? 'Mon–Fri' : d.map(x => DAYS[x]).join(', ');
export const hoursText = h => h ? `${t12(h.open)} – ${t12(h.close)}, ${daysText(h.days)}${h.last_order_min ? ` · last orders ${h.last_order_min} min before closing` : ''}` : '';
// One line for the student banner, from the server's state
const stateLine = st => ({ open: `<b>Open now.</b> ${st.mins_left != null && st.mins_left <= 30 ? `Hurry, last orders in ${st.mins_left} min.` : st.closes_at ? `Order until ${t12(st.last_order_at)}.` : 'Order ahead, collect with your token.'}`,
  later: `<b>Opens at ${t12(st.opens_at)}.</b> Look at the menu now, order once it opens.`, closed: '<b>Closed right now.</b> Ordering starts when the canteen opens.',
  over: '<b>Closed for today.</b> See you tomorrow!', last_orders_done: `<b>Last orders are over.</b> The counter closes at ${t12(st.closes_at)}.`, not_today: '<b>Closed today.</b>', off: '<b>Closed.</b>' })[st.why] || '<b>Closed right now.</b>';
// a short chime + buzz when the order is ready (if the phone allows sound)
const chime = () => { try { navigator.vibrate?.([200, 100, 200]); const a = new (window.AudioContext || window.webkitAudioContext)(), o = a.createOscillator(), g = a.createGain();
  o.connect(g); g.connect(a.destination); o.frequency.value = 880; g.gain.setValueAtTime(.2, a.currentTime); g.gain.exponentialRampToValueAtTime(.001, a.currentTime + .8); o.start(); o.stop(a.currentTime + .8); } catch { /* no sound */ } };
// deal and speed badges, shared by the student menu and the manager's list
const minsLeft = iso => iso ? Math.max(0, Math.ceil((Date.parse(iso) - Date.now()) / 6e4)) : null;
const left = iso => { const m = minsLeft(iso); return m == null ? '' : m >= 60 ? ` · ${Math.floor(m / 60)}h ${m % 60 ? (m % 60) + 'm ' : ''}left` : ` · ${m} min left`; };
const dealBadge = d => !d ? '' : d.kind === 'flash' ? `<span class="cn-deal flash">⚡ Flash sale −${d.pct}%${left(d.until)}</span>` : d.kind === 'eod' ? `<span class="cn-deal eod">🌙 End-of-day −${d.pct}%${left(d.until)}</span>` : `<span class="cn-deal">−${d.pct}% off${left(d.until)}</span>`;
const priceHtml = it => it.deal ? `<s class="muted">${rupees(it.price_paise)}</s> ${rupees(it.price_now)}` : rupees(it.price_paise);
// ---- small charts for the reports (inline SVG, no library) ----
const CH = ['#1E4B8F', '#16A34A', '#F59E0B', '#7C3AED', '#DC2626', '#0891B2'];
// ring chart with a legend: parts = [[label, value, shown]]
const donut = (title, parts) => { const tot = parts.reduce((s, p) => s + p[1], 0); let a = 0; const r = 42, c = 2 * Math.PI * r;
  const arcs = tot ? parts.map((p, i) => { const len = p[1] / tot * c, el = `<circle r="${r}" cx="60" cy="60" fill="none" stroke="${CH[i % CH.length]}" stroke-width="18" stroke-dasharray="${len} ${c - len}" stroke-dashoffset="${-a}" transform="rotate(-90 60 60)"><title>${p[0]}: ${p[2]}</title></circle>`; a += len; return el; }).join('') : `<circle r="${r}" cx="60" cy="60" fill="none" stroke="#E5E7EB" stroke-width="18"/>`;
  return `<div class="card cn-chart"><b>${title}</b><div class="cn-donut"><svg viewBox="0 0 120 120" width="120" height="120" role="img" aria-label="${title}">${arcs}</svg>
    <ul>${parts.map((p, i) => `<li><i style="background:${CH[i % CH.length]}"></i>${p[0]}<b>${p[2]}</b><span class="muted small">${tot ? Math.round(p[1] / tot * 100) : 0}%</span></li>`).join('')}</ul></div></div>`; };
// horizontal bars: rows = [[label, value, shown]]
const hbars = (title, rows, empty) => { const m = Math.max(1, ...rows.map(r => r[1]));
  return `<div class="card cn-chart"><b>${title}</b>${rows.length ? `<div class="cn-hb">${rows.map((r, i) => `<div class="cn-hbr"><span class="l" title="${r[0]}">${r[0]}</span><span class="t"><i style="width:${Math.max(2, Math.round(r[1] / m * 100))}%;background:${CH[i % CH.length]}"></i></span><b>${r[2]}</b></div>`).join('')}</div>` : `<p class="muted small">${empty}</p>`}</div>`; };
// sold out / back in stock during the shift (counter, kitchen and managers)
const stockDialog = async redraw => { const list = await H.api('/canteen/stock');
  const d = H.dlg(`<h3>Stock</h3><p class="muted small">Tick what has run out. Students and the counter see it at once; it resets when the canteen opens on a new day.</p>
    <div class="cn-stock">${list.map(i => `<label class="chk"><input type="checkbox" data-sid="${i.id}" ${i.sold_out ? 'checked' : ''}> ${H.esc(i.name)}</label>`).join('') || '<p class="muted small">No items on the menu.</p>'}</div>`, async () => {});
  d.querySelectorAll('[data-sid]').forEach(c => c.onchange = async () => { try { await H.api(`/canteen/items/${c.dataset.sid}/stock`, { method: 'POST', body: { sold_out: c.checked } }); H.toast(c.checked ? 'Marked sold out' : 'Back in stock'); } catch (e) { c.checked = !c.checked; H.toast(e.message); } });
  d.addEventListener('close', () => redraw && redraw()); };
// ---- printing: bills and KOTs on a 58 mm or 80 mm thermal printer (or any printer) through the browser's print ----
// For printing with no dialog at the counter, open Chrome with --kiosk-printing and set the thermal printer as the default.
const pesc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const slip = (paper, title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${pesc(title)}</title><style>@page{size:${paper}mm auto;margin:0}*{box-sizing:border-box}
  body{font:${paper === '58' ? 11 : 12.5}px/1.35 ui-monospace,Menlo,Consolas,monospace;margin:0;padding:3mm;width:${paper}mm;color:#000}h1{font-size:1.45em;margin:0;text-align:center}.c{text-align:center}
  table{width:100%;border-collapse:collapse}td{padding:1px 0;vertical-align:top}td.r{text-align:right;white-space:nowrap;padding-left:6px}td.q{font-weight:700;font-size:1.5em;width:2.2em}hr{border:0;border-top:1px dashed #000;margin:4px 0}hr.s{border-top-style:solid;border-top-width:1.5px}.sm{font-size:.85em}td.it{font-size:1.15em;padding:3px 0}.b{font-weight:700}.big{font-size:1.4em;font-weight:700}.dup{border:1px solid #000;text-align:center;font-weight:700;margin:3px 0}</style></head><body>${body}</body></html>`;
const when = iso => { const d = new Date(iso || Date.now()), p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d).map(x => [x.type, x.value]));
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`; };
const serviceText = o => o.service === 'dine_in' ? `Dine In${o.table_no ? ': ' + pesc(o.table_no) : ''}` : o.service === 'delivery' || o.fulfil === 'delivery' ? 'Delivery' : o.channel === 'counter' ? 'Takeaway' : 'Online · Pickup';
const amt = p => (p / 100).toFixed(2);
// the bill, laid out like a counter receipt: name, tagline, customer, date / type, cashier / bill no, token, items, totals, how it was paid
export const billHtml = (o, name, pr, dup) => slip(pr.paper, `Bill ${o.bill_no || o.token}`, `<h1>${pesc(name)}</h1>${pr.tagline ? `<div class="c">${pesc(pr.tagline)}</div>` : ''}${dup ? '<div class="dup">DUPLICATE COPY</div>' : ''}<hr class="s">
  <div>Name: ${o.name && o.name !== 'Walk-in' ? pesc(o.name) : ''}</div><hr class="s">
  <table><tr><td>Date: ${when(o.paid_at || o.created_at)}</td><td class="r b">${serviceText(o)}</td></tr><tr><td>Cashier: ${pesc(o.cashier || '')}</td><td class="r">Bill No.: ${o.bill_no ?? ''}</td></tr><tr><td class="b">Token No.: ${o.token_no}</td><td class="r">${o.channel === 'counter' ? 'Counter' : 'Online'}</td></tr></table>
  ${o.fulfil === 'delivery' ? `<div>Deliver to: ${pesc(o.deliver_to)}</div>` : ''}<hr class="s">
  <table><tr class="b"><td>Item</td><td class="r">Qty.</td><td class="r">Price</td><td class="r">Amount</td></tr><tr><td colspan="4"><hr class="s"></td></tr>${o.items.map(i => `<tr><td>${pesc(i.name)}</td><td class="r">${i.qty}</td><td class="r">${amt(i.price_paise)}</td><td class="r">${amt(i.qty * i.price_paise)}</td></tr>`).join('')}</table><hr class="s">
  <table><tr><td>Total Qty: ${o.items.reduce((n, i) => n + i.qty, 0)}</td><td class="r">Sub Total ${amt(o.items.reduce((n, i) => n + i.qty * i.price_paise, 0))}</td></tr>
  ${o.items.some(i => i.mrp_paise) ? `<tr><td colspan="2" class="r">You saved ${amt(o.items.reduce((s, i) => s + ((i.mrp_paise || i.price_paise) - i.price_paise) * i.qty, 0))}</td></tr>` : ''}${o.delivery_fee_paise ? `<tr><td colspan="2" class="r">Delivery ${amt(o.delivery_fee_paise)}</td></tr>` : ''}</table><hr class="s">
  <table><tr class="big"><td class="r">Grand Total</td><td class="r">₹${amt(o.total_paise)}</td></tr></table>
  <div class="sm">Paid via ${o.pay_mode === 'upi' ? 'UPI' : 'Cash'}${o.pay_mode === 'upi' && o.upi_ref ? ' · UTR ' + pesc(o.upi_ref) : ''}${o.cash_tendered_paise != null && o.pay_mode !== 'upi' && o.cash_tendered_paise > o.total_paise ? ` · received ${amt(o.cash_tendered_paise)} · change ${amt(o.cash_tendered_paise - o.total_paise)}` : ''}</div><hr class="s">
  <div class="c">${pesc(pr.footer || '')}</div>`);
// the KOT, like a kitchen ticket: date, KOT number, dine in / takeaway / delivery, item · special note · qty
export const kotHtml = (o, name, pr, dup) => slip(pr.paper, `KOT ${o.token_no}`, `<div class="c">${when(o.accepted_at)}</div><div class="c big">KOT - ${o.token_no}</div><div class="c b">${serviceText(o)}</div>${dup ? '<div class="dup">REPRINT</div>' : ''}
  ${o.fulfil === 'delivery' ? `<div class="c">${pesc(o.deliver_to)}</div>` : ''}<hr>
  <table><tr><td>Item</td><td class="c">Special Note</td><td class="r">Qty.</td></tr>${o.items.map((i, k) => `<tr><td class="b it">${pesc(i.name)}</td><td class="c">${k === 0 && o.note ? pesc(o.note) : '--'}</td><td class="r b">${i.qty}</td></tr>`).join('')}</table>
  <hr><div class="c sm">${pesc(name)} · ${o.channel === 'counter' ? 'Counter' : 'Online'} · items ${o.items.reduce((n, i) => n + i.qty, 0)}</div>`);
// print through a hidden frame (no pop-up to allow); the page is removed after printing
export const printHtml = html => new Promise(res => { const f = document.createElement('iframe'); f.setAttribute('aria-hidden', 'true'); f.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
  document.body.append(f); const d = f.contentWindow.document; d.open(); d.write(html); d.close();
  setTimeout(() => { try { f.contentWindow.focus(); f.contentWindow.print(); } catch { /* blocked */ } setTimeout(() => { f.remove(); res(); }, 1500); }, 250); });
// record the print (so a second copy is marked), then print
const printOrder = async (kind, o, name, pr) => { let dup = false; try { dup = (await H.api(`/canteen/orders/${o.id}/printed`, { method: 'POST', body: { kind } })).duplicate; } catch (e) { H.toast(e.message); return; }
  await printHtml(kind === 'kot' ? kotHtml(o, name, pr, dup) : billHtml(o, name, pr, dup)); };
const vegDot = v => `<i class="cn-veg ${v ? 'v' : 'nv'}" title="${v ? 'Veg' : 'Non-veg'}" aria-label="${v ? 'Veg' : 'Non-veg'}"></i>`;

// ================= student =================
// A card on the campus home when the canteen is on
export async function canteenCard(slug, el) {
  try { const c = await H.api(`/public/${slug}/canteen`); if (!c.on || !el) return;
    el.innerHTML = `<a class="svc" href="#/d/${slug}/canteen"><span class="chip c3">${H.I('utensils', 22)}</span><span class="t"><b>Order from ${H.esc(c.name)}</b><span class="muted small">${c.open ? 'Open now · order ahead, collect with your token' : 'Closed right now · see the menu'}</span></span><span class="chev">${H.I('chev')}</span></a>`;
  } catch { /* no canteen */ }
}

export async function studentCanteen(slug, view, id, q) {
  document.body.className = '';
  const { app, I, esc } = H, cartKey = 'canteen-cart:' + slug, devKey = 'canteen-dev:' + slug;
  const back = (href, title) => `<div class="head"><a class="iconbtn" href="${href}" aria-label="Back">${I('back')}</a><h1>${title}</h1></div>`;
  if (view === 'o') return orderPage(slug, id, q.get('k'));
  if (view === 'mine') return minePage(slug);
  const c = await H.api(`/public/${slug}/canteen`);
  document.title = `${c.name} · ${c.campus}`;
  if (!c.on) { app.innerHTML = `<div class="wrap">${back(`#/d/${slug}`, esc(c.name))}<div class="card empty"><span class="et">No canteen ordering here yet</span><span>${esc(c.campus)} has not started canteen orders on ONE Desk.</span></div></div>`; return; }
  const items = new Map([...c.categories.flatMap(x => x.items), ...c.uncategorised].map(i => [i.id, i]));
  let cart = ls.get(cartKey, {}); for (const k of Object.keys(cart)) if (!items.has(k)) delete cart[k];
  const save = () => ls.set(cartKey, cart), count = () => Object.values(cart).reduce((s, n) => s + n, 0), total = () => Object.entries(cart).reduce((s, [k, n]) => s + items.get(k).price_now * n, 0);
  const mine = ls.get('canteen-mine:' + slug, []).length, pop = new Set(c.popular || []), fast = new Set(c.fast || []);
  const stepper = it => !c.open ? (it.sold_out ? '<span class="cn-so">Out of stock</span>' : '') : !cart[it.id] && it.sold_out ? `<button type="button" class="btn cn-add cn-book" data-inc="${it.id}" title="Out of stock: book it and the canteen confirms">Book</button>` : cart[it.id]
    ? `<span class="cn-step"><button type="button" data-dec="${it.id}" aria-label="One less ${esc(it.name)}">−</button><b>${cart[it.id]}</b><button type="button" data-inc="${it.id}" aria-label="One more ${esc(it.name)}">+</button></span>`
    : `<button type="button" class="btn soft cn-add" data-inc="${it.id}">Add</button>`;
  const row = it => `<div class="cn-item ${it.sold_out ? 'off' : ''}" data-name="${esc((it.name + ' ' + (it.description || '')).toLowerCase())}" data-veg="${it.is_veg ? 1 : 0}" data-price="${it.price_now}" data-deal="${it.deal ? 1 : 0}" data-i="${it.sort_order ?? 0}"><div class="cn-in">${vegDot(it.is_veg)}<div><b>${esc(it.name)}</b>${it.sold_out ? ' <span class="cn-oos">Out of stock</span>' : ''}${fast.has(it.id) ? ' <span class="cn-fast">🔥 Fast moving</span>' : pop.has(it.id) ? ' <span class="cn-pop">★ Popular</span>' : ''}${it.deal ? ' ' + dealBadge(it.deal) : ''}${it.description ? `<div class="muted small">${esc(it.description)}</div>` : ''}<div class="cn-price">${priceHtml(it)}</div></div></div><div id="st-${it.id}">${stepper(it)}</div></div>`;
  const groups = [...c.categories, ...(c.uncategorised.length ? [{ id: 'x', name: c.categories.length ? 'More' : 'Menu', items: c.uncategorised }] : [])];
  const bar = () => { const n = count(), b = document.getElementById('cnbar'); if (!b) return;
    b.hidden = !n || !c.open; b.innerHTML = `<a class="btn primary big" href="#/d/${slug}/canteen/cart">${I('utensils', 18)} ${n} item${n === 1 ? '' : 's'} · ${rupees(total())} <span style="margin-left:auto">View cart ${I('chev', 16)}</span></a>`; };
  if (view === 'cart') return cartPage();
  app.innerHTML = `<div class="wrap cn-wrap">${back(`#/d/${slug}`, esc(c.name))}
    <div class="cn-banner ${c.open ? 'on' : ''}">${I(c.open ? 'ccheck' : 'clock', 18)}<span>${stateLine(c.state)}${c.state.hours ? `<span class="cn-hrs">${I('clock', 13)} ${hoursText(c.state.hours)}</span>` : ''}${c.open && c.busy ? `<span class="cn-hrs">${c.busy} order${c.busy === 1 ? '' : 's'} in the kitchen${c.wait_min ? ` · usually ready in about ${c.wait_min} min` : ''}</span>` : ''}</span></div>
    <div id="cnlive"></div>
    ${c.popular?.length && c.open ? `<div class="cn-picks"><b>Popular this week</b><div>${c.popular.map(k => items.get(k)).filter(Boolean).map(it => `<button type="button" class="cn-pick" ${it.sold_out ? 'disabled' : `data-inc="${it.id}"`}><b>${esc(it.name)}</b><span>${it.sold_out ? 'Sold out' : rupees(it.price_now) + ' · Add'}</span></button>`).join('')}</div></div>` : ''}
    <div class="cn-search">${I('search', 18)}<input id="cnq" type="search" placeholder="Search the menu" aria-label="Search the menu" autocomplete="off"></div>
    <div class="cn-filters" role="group" aria-label="Filters">${[...items.values()].some(i => i.deal) ? '<button type="button" class="tab cn-offf" data-f="deal">🏷️ Offers</button>' : ''}<button type="button" class="tab" data-f="veg">🟢 Veg only</button><button type="button" class="tab" data-f="cheap">Under ₹50</button><button type="button" class="tab" data-f="avail">Available now</button><button type="button" class="tab" data-f="sort">Price: low to high</button></div>
    ${mine ? `<a class="svc" href="#/d/${slug}/canteen/mine"><span class="chip c2">${I('ticket', 22)}</span><span class="t"><b>My orders</b><span class="muted small">Tokens and live status</span></span><span class="chev">${I('chev')}</span></a>` : ''}
    ${groups.length > 1 ? `<div class="tabs cn-cats">${groups.map(g => `<a class="tab" href="#" data-go="${g.id}">${esc(g.name)}</a>`).join('')}</div>` : ''}
    <p class="muted" id="cnnone" hidden ${groups.length ? '' : 'data-empty="1"'}>Nothing on the menu matches. Try clearing a filter.</p>
    ${groups.map(g => `<section class="cn-cat" id="cat-${g.id}"><h2>${esc(g.name)} <span class="muted small">${g.items.length} item${g.items.length === 1 ? '' : 's'}</span></h2><div class="card cn-list">${g.items.map(row).join('')}</div></section>`).join('') || '<div class="card empty"><span class="et">The menu is being prepared</span><span>Please check back soon.</span></div>'}
    </div><div class="cn-bar" id="cnbar" hidden></div>`;
  app.querySelectorAll('[data-go]').forEach(a => a.onclick = e => { e.preventDefault(); document.getElementById('cat-' + a.dataset.go)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
  app.onclick = e => { const inc = e.target.closest('[data-inc]'), dec = e.target.closest('[data-dec]'); if (!inc && !dec) return;
    const k = (inc || dec).dataset.inc || (inc || dec).dataset.dec; cart[k] = Math.max(0, Math.min(20, (cart[k] || 0) + (inc ? 1 : -1))); if (!cart[k]) delete cart[k]; save();
    const st_ = document.getElementById('st-' + k); if (st_) st_.innerHTML = stepper(items.get(k)); bar(); if (inc && cart[k] === 1) H.toast(items.get(k).sold_out ? `${items.get(k).name} booked: the canteen confirms before cooking` : `${items.get(k).name} added`, items.get(k).sold_out ? 3000 : 1500); };
  bar();
  // search (name and description) + filters (veg, under ₹50, available) + sort by price, all together; the choices are remembered
  const F = new Set(ls.get('canteen-filters', [])), qi = document.getElementById('cnq');
  const apply = () => { const v = qi.value.trim().toLowerCase();
    app.querySelectorAll('[data-f]').forEach(b => b.classList.toggle('on', F.has(b.dataset.f)));
    app.querySelectorAll('.cn-cat').forEach(sec => { let any = false; const list = sec.querySelector('.cn-list');
      [...list.children].sort((a, b) => F.has('sort') ? a.dataset.price - b.dataset.price : a.dataset.i - b.dataset.i || a.dataset.name.localeCompare(b.dataset.name)).forEach(r => list.append(r));
      list.querySelectorAll('.cn-item').forEach(r => { const hit = (!v || r.dataset.name.includes(v)) && (!F.has('veg') || r.dataset.veg === '1') && (!F.has('cheap') || +r.dataset.price < 5000) && (!F.has('avail') || !r.classList.contains('off')) && (!F.has('deal') || r.dataset.deal === '1'); r.hidden = !hit; any ||= hit; });
      sec.hidden = !any; });
    const nm = document.getElementById('cnnone'); if (nm) nm.hidden = !!nm.dataset.empty || !!app.querySelector('.cn-cat:not([hidden])'); };
  // a pop-up for a live flash or end-of-day sale, once per sale on this phone
  const sale = [...items.values()].filter(i => i.deal && i.deal.kind !== 'discount' && !i.sold_out), sk = sale.length ? 'canteen-sale:' + slug + ':' + sale[0].deal.kind + sale[0].deal.until : '';
  if (sale.length && c.open && !ls.get(sk, false)) { ls.set(sk, true); const best = Math.max(...sale.map(i => i.deal.pct)), d = sale[0].deal, pop_ = document.createElement('div');
    pop_.className = 'cn-popup ' + d.kind; pop_.setAttribute('role', 'dialog'); pop_.setAttribute('aria-label', 'Offer');
    pop_.innerHTML = `<button type="button" class="cn-px" aria-label="Close">${I('x', 18)}</button><b>${d.kind === 'flash' ? '⚡ Flash sale!' : '🌙 End-of-day sale!'}</b><span>Up to ${best}% off on ${sale.length} item${sale.length === 1 ? '' : 's'}${left(d.until)}</span>
      <div class="cn-pi">${sale.slice(0, 3).map(i => `<span>${esc(i.name)} <b>${rupees(i.price_now)}</b></span>`).join('')}</div><button type="button" class="btn primary" id="cnseeoff">See offers</button>`;
    document.body.append(pop_); const shut = () => { pop_.remove(); removeEventListener('hashchange', shut); }; addEventListener('hashchange', shut); pop_.querySelector('.cn-px').onclick = shut; setTimeout(shut, 15000);
    pop_.querySelector('#cnseeoff').onclick = () => { shut(); F.add('deal'); ls.set('canteen-filters', [...F]); apply(); document.querySelector('.cn-filters')?.scrollIntoView({ behavior: 'smooth' }); }; }
  if (sale.length) every(60000, () => !count() && !document.getElementById('cnq')?.value && document.activeElement?.id !== 'cnq' && studentCanteen(slug, view, id, q), location.hash.split('?')[0]); // keep countdowns fresh (not while a cart is being built)
  qi.oninput = apply; app.querySelectorAll('[data-f]').forEach(b => b.onclick = () => { F.has(b.dataset.f) ? F.delete(b.dataset.f) : F.add(b.dataset.f); ls.set('canteen-filters', [...F]); apply(); }); apply();
  // a live order on this phone sits on top; the last collected one can be ordered again in one tap
  const dev0 = localStorage.getItem(devKey);
  if (dev0) H.api(`/public/${slug}/canteen/mine`, { method: 'POST', body: { device: dev0 } }).then(rows => { const el = document.getElementById('cnlive'); if (!el) return;
    const live = rows.filter(o => ['placed', 'accepted', 'ready', 'out'].includes(o.status)), last = rows.find(o => o.status === 'collected');
    el.innerHTML = live.map(o => `<a class="cn-livecard s-${o.status}" href="#/d/${slug}/canteen/o/${o.id}?k=${o.key}"><span class="cn-tk s-${o.status}">${o.token}</span><span><b>${esc(o.status_text)}</b><span class="muted small">${o.status === 'placed' ? (o.pay_mode === 'cash' ? `Pay ${o.total} at the counter with this token` : o.pay_status === 'claimed' ? 'Payment being checked' : `Pay ${o.total} by UPI`) : o.status === 'ready' && o.fulfil !== 'delivery' ? 'Show the token at the counter' : 'Tap to follow it live'}</span></span>${I('chev', 18)}</a>`).join('')
      + (last && c.open ? `<button type="button" class="cn-again" id="cnagain">${I('history', 18)}<span><b>Order again</b><span class="muted small">${last.items.map(i => `${i.qty}× ${esc(i.name)}`).join(', ')}</span></span></button>` : '');
    const ag = document.getElementById('cnagain'); if (ag) ag.onclick = () => { let n = 0; for (const i of last.items) { const it = items.get(i.id); if (it && !it.sold_out) { cart[i.id] = Math.min(20, (cart[i.id] || 0) + i.qty); n++; } }
      save(); if (!n) return H.toast('Those items are not available right now'); location.hash = `#/d/${slug}/canteen/cart`; };
  }).catch(() => {});

  function cartPage() {
    app.onclick = null;
    if (!count() || !c.open) { if (!c.open) H.toast(`${c.name} is closed right now`); location.replace(`#/d/${slug}/canteen`); return; }
    const who = ls.get('canteen-who', {}), dev = localStorage.getItem(devKey), ad = who.addr || {};
    app.innerHTML = `<div class="wrap">${back(`#/d/${slug}/canteen`, 'Your order')}
      <div class="card cn-list">${Object.entries(cart).map(([k, n]) => { const it = items.get(k); return `<div class="cn-item"><div class="cn-in">${vegDot(it.is_veg)}<div><b>${esc(it.name)}</b>${it.sold_out ? ' <span class="cn-oos">Out of stock · booked</span>' : ''}<div class="muted small">${n} × ${priceHtml(it)}${it.deal ? ' ' + dealBadge(it.deal) : ''}</div></div></div><b>${rupees(n * it.price_now)}</b></div>`; }).join('')}
        ${Object.keys(cart).some(k => items.get(k).sold_out) ? '<div class="cn-note">Some items are out of stock right now. You can still book them: the canteen confirms they can make them before cooking, or rejects with a reason (any payment is refunded at the counter).</div>' : ''}
        <div class="cn-item" id="feerow" hidden><span>Delivery</span><b>${rupees(c.pay.delivery_fee_paise)}</b></div>
        <div class="cn-item cn-tot"><b>Total</b><b id="cntot">${rupees(total())}</b></div></div>
      <form id="cnf" class="card">
        ${c.pay.delivery ? `<b>How do you want it?</b><div class="cn-opts"><label class="cn-opt"><input type="radio" name="fulfil" value="pickup" ${who.fulfil !== 'delivery' ? 'checked' : ''}><span>${I('utensils', 18)}<b>Pickup</b><small>Collect at the counter</small></span></label>
          <label class="cn-opt"><input type="radio" name="fulfil" value="delivery" ${who.fulfil === 'delivery' ? 'checked' : ''}><span>${I('pin', 18)}<b>Deliver to me</b><small>${c.pay.delivery_fee_paise ? rupees(c.pay.delivery_fee_paise) + ' delivery' : 'Free delivery'}</small></span></label></div>
          <div id="dbox" class="cn-addr" hidden><b>Delivery address</b>${c.pay.delivery_note ? `<div class="muted small">${esc(c.pay.delivery_note)}</div>` : ''}
            <label>Block / building</label>${c.pay.blocks.length ? `<select name="a_block"><option value="">Pick your block</option>${c.pay.blocks.map(x => `<option ${ad.block === x ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select>` : `<input name="a_block" maxlength="60" value="${esc(ad.block || '')}" placeholder="e.g. Boys hostel B, Main block">`}
            <div class="cn-hgrid2"><div><label>Floor</label><select name="a_floor"><option value="">—</option>${c.pay.floors.map(x => `<option ${ad.floor === x ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></div>
            <div><label>Room / class no.</label><input name="a_room" maxlength="40" value="${esc(ad.room || '')}" placeholder="e.g. 214"></div></div>
            <label>Landmark <span class="muted small">(optional)</span></label><input name="a_landmark" maxlength="80" value="${esc(ad.landmark || '')}" placeholder="e.g. next to the lift, Lab 3"></div>` : ''}
        <b style="display:block;margin-top:12px">How will you pay?</b><div class="cn-opts">
          ${c.pay.cash ? `<label class="cn-opt"><input type="radio" name="pay_mode" value="cash" ${who.pay_mode !== 'upi' || !c.pay.upi ? 'checked' : ''}><span>${I('cash', 18)}<b>Cash at the counter</b><small>Pay first, then it goes to the kitchen</small></span></label>` : ''}
          ${c.pay.upi ? `<label class="cn-opt"><input type="radio" name="pay_mode" value="upi" ${who.pay_mode === 'upi' || !c.pay.cash ? 'checked' : ''}><span>${I('phone', 18)}<b>UPI</b><small>GPay, PhonePe, Paytm…</small></span></label>` : ''}</div>
        <div class="muted small" id="paynote"></div>
        <label>Your name</label><input name="name" required maxlength="80" value="${esc(who.name || '')}" autocomplete="name">
        <label>Phone <span class="muted small" id="phopt">(optional)</span></label><input name="phone" type="tel" maxlength="20" value="${esc(who.phone || '')}" autocomplete="tel">
        <label>Note for the canteen <span class="muted small">(optional)</span></label><input name="note" maxlength="200" placeholder="e.g. less spicy">
        <div id="vbox"></div><div class="err" id="cnerr"></div>
        <button class="btn primary big" id="cnplace">${I('check', 18)} Place order</button></form></div>`;
    const f = document.getElementById('cnf'), err = document.getElementById('cnerr'), vbox = document.getElementById('vbox');
    const sync = () => { const del = f.fulfil && f.fulfil.value === 'delivery'; const db = document.getElementById('dbox'); if (db) db.hidden = !del; if (f.a_block) { f.a_block.required = del; f.a_room.required = del; }
      f.phone.required = del; document.getElementById('phopt').textContent = del ? '(for the delivery person)' : '(optional)';
      document.getElementById('feerow').hidden = !del; document.getElementById('cntot').textContent = rupees(total() + (del ? c.pay.delivery_fee_paise : 0));
      const cashR = f.querySelector('[name=pay_mode][value=cash]'), upiR = f.querySelector('[name=pay_mode][value=upi]');
      if (cashR) { const no = del && !c.pay.delivery_cash; cashR.disabled = no; cashR.closest('.cn-opt').classList.toggle('dis', no); if (no && cashR.checked && upiR) upiR.checked = true; }
      const pm = f.querySelector('[name=pay_mode]:checked')?.value; document.getElementById('paynote').textContent = del && !c.pay.delivery_cash ? 'Delivery orders are paid by UPI. After placing the order you pay with your UPI app and enter the reference number; the canteen checks it, then starts cooking.' : pm === 'upi' ? 'After placing the order you pay with your UPI app and enter the reference number. The canteen checks it, then starts cooking.'
        : `Go to the counter and pay with your token. The order goes to the kitchen once you have paid${c.pay.pay_window_min ? ` (within ${c.pay.pay_window_min} min)` : ''}.`; };
    f.onchange = sync; sync();
    let verified = false;
    const verifyUI = () => { vbox.innerHTML = `<div class="cn-otp"><b>Verify your email</b><div class="muted small">Only for your first order on this phone. We send a 6-digit code; the canteen emails you when your food is ready.</div>
        <label>Email</label><div class="row"><input name="email" type="email" required maxlength="120" value="${esc(who.email || '')}" autocomplete="email" style="flex:1"><button type="button" class="btn soft" id="sendc">Send code</button></div>
        <div id="cbox" hidden><label>Code from the email</label><input name="code" inputmode="numeric" maxlength="6" pattern="\\d{6}" autocomplete="one-time-code" placeholder="6 digits"></div></div>`;
      document.getElementById('sendc').onclick = async () => { err.textContent = ''; const email = f.email.value.trim();
        try { const r = await H.api(`/public/${slug}/canteen/otp`, { method: 'POST', body: { email } }); document.getElementById('cbox').hidden = false; f.code.focus();
          H.toast(`Code sent to ${email}. It works for ${r.minutes} minutes.`); document.getElementById('sendc').textContent = 'Send again'; } catch (e) { err.textContent = e.message; } }; };
    if (dev) H.api(`/public/${slug}/canteen/device`, { method: 'POST', body: { device: dev } }).then(r => { verified = r.ok; if (!r.ok) { localStorage.removeItem(devKey); verifyUI(); } else vbox.innerHTML = `<p class="muted small">${I('ccheck', 14)} Verified as ${esc(r.email)}</p>`; }).catch(verifyUI);
    else verifyUI();
    f.onsubmit = async e => { e.preventDefault(); err.textContent = ''; const btn = document.getElementById('cnplace'); btn.disabled = true;
      try {
        if (!verified) { if (!f.code || f.code.closest('[hidden]')) throw new Error('Tap “Send code” and enter the code from your email');
          const r = await H.api(`/public/${slug}/canteen/verify`, { method: 'POST', body: { email: f.email.value.trim(), code: f.code.value.trim() } });
          localStorage.setItem(devKey, r.device); verified = true; ls.set('canteen-who', { ...ls.get('canteen-who', {}), email: r.email }); }
        const fulfil = f.fulfil?.value || 'pickup', pay_mode = f.querySelector('[name=pay_mode]:checked')?.value || 'cash';
        const addr = fulfil === 'delivery' ? { block: f.a_block.value.trim(), floor: f.a_floor.value, room: f.a_room.value.trim(), landmark: f.a_landmark.value.trim(), other: !c.pay.blocks.length } : undefined;
        ls.set('canteen-who', { ...ls.get('canteen-who', {}), name: f.name.value.trim(), phone: f.phone.value.trim(), fulfil, pay_mode, ...(addr ? { addr } : {}) });
        const o = await H.api(`/public/${slug}/canteen/orders`, { method: 'POST', body: { device: localStorage.getItem(devKey), name: f.name.value, phone: f.phone.value, note: f.note.value, fulfil, pay_mode, addr, expect_paise: total() + (fulfil === 'delivery' ? c.pay.delivery_fee_paise : 0), items: Object.entries(cart).map(([id, qty]) => ({ id, qty })) } });
        cart = {}; save(); ls.set('canteen-mine:' + slug, [{ id: o.id, key: o.key }, ...ls.get('canteen-mine:' + slug, [])].slice(0, 20));
        location.hash = `#/d/${slug}/canteen/o/${o.id}?k=${o.key}&new=1`;
      } catch (e2) { err.textContent = e2.message; if (e2.code === 'PRICE_CHANGED') { H.toast(e2.message, 7000); setTimeout(() => studentCanteen(slug, 'cart', id, q), 1500); return; } if (e2.code === 'VERIFY') { localStorage.removeItem(devKey); verified = false; verifyUI(); } btn.disabled = false; } };
  }
}

async function orderPage(slug, id, key) {
  const { app, I, esc } = H, hash = location.hash.split('?')[0]; let prev = null;
  const draw = async () => {
    if (document.activeElement?.id === 'cnutr' || document.getElementById('cnutr')?.value || document.querySelector('.cn-qrpay[open]')) return; // keep a typed reference and an open UPI QR
    let o; try { o = await H.api(`/public/${slug}/canteen/orders/${id}?k=${encodeURIComponent(key || '')}`); } catch (e) { app.innerHTML = `<div class="wrap"><h1>Order not found</h1><p class="muted">${esc(e.message)}</p><a href="#/d/${slug}/canteen">Back to the menu</a></div>`; return clearInterval(timer); }
    const del = o.fulfil === 'delivery', steps = [['placed', o.status === 'placed' ? 'Payment' : 'Paid'], ['accepted', 'Preparing'], del ? ['out', 'On the way'] : ['ready', 'Ready'], ['collected', del ? 'Delivered' : 'Collected']];
    const rank = { placed: 0, accepted: 1, ready: del ? 1.5 : 2, out: 2, collected: 3 }[o.status] ?? -1, end = ['rejected', 'cancelled'].includes(o.status);
    const mins = o.pay_by ? Math.max(0, Math.ceil((Date.parse(o.pay_by) - Date.now()) / 6e4)) : null;
    const payBox = o.status !== 'placed' ? '' : o.pay_mode === 'cash'
      ? `<div class="card cn-pay"><b>${I('cash', 18)} Pay ${o.total} at the counter</b><p>Show token <b>${o.token}</b> and pay in cash. Your order goes to the kitchen as soon as you have paid.</p>${mins != null ? `<p class="muted small">Please pay within ${mins} min, or the order is cancelled.</p>` : ''}</div>`
      : o.pay_status === 'claimed'
        ? `<div class="card cn-pay ok"><b>${I('ccheck', 18)} Payment sent</b><p>The canteen is checking UPI reference <b>${esc(o.upi_ref)}</b>. Your order goes to the kitchen once it is confirmed.</p></div>`
        : `<div class="card cn-pay"><b>${I('cash', 18)} Pay ${o.total} with UPI</b>
            ${o.upi ? `<a class="btn primary big" href="${esc(o.upi.link)}">Pay with GPay / PhonePe / Paytm</a>
            <details class="cn-qrpay"><summary>Paying from another phone? Show the UPI QR</summary><img src="/api/public/${slug}/canteen/orders/${id}/upi.svg?k=${encodeURIComponent(key)}" alt="UPI QR code" width="200" height="200"><div class="muted small">UPI ID: ${esc(o.upi.id)}</div></details>` : ''}
            <form id="cnutrf"><label>After paying, enter the UPI reference number (UTR)</label><div class="row"><input id="cnutr" inputmode="text" maxlength="30" placeholder="e.g. 412345678901" autocomplete="off" style="flex:1" required><button class="btn">Send</button></div>
            <div class="muted small">You find it in your UPI app under the payment's details. The order goes to the kitchen once the canteen sees your payment.</div><div class="err" id="cnutre"></div></form>
            ${mins != null ? `<p class="muted small">Please pay within ${mins} min, or the order is cancelled.</p>` : ''}</div>`;
    const msg = { accepted: 'Paid. Your food is being prepared; this page refreshes by itself.', ready: del ? 'Packed and waiting for the delivery person.' : 'Show this token at the counter to collect.', out: `On its way to ${esc(o.deliver_to || '')}.`,
      collected: del ? 'Delivered. Enjoy your food!' : 'Collected. Enjoy your food!' }[o.status];
    app.innerHTML = `<div class="wrap"><div class="head"><a class="iconbtn" href="#/d/${slug}/canteen" aria-label="Back">${I('back')}</a><h1>Your order</h1></div><p class="muted small">${esc(o.canteen)} · ${del ? `Delivery to ${esc(o.deliver_to)}` : 'Pickup at the counter'} · ${o.pay_mode === 'upi' ? 'UPI' : 'Cash'}</p>
      <div class="card cn-token s-${o.status}"><span class="muted small">Token</span><b>${o.token}</b><span class="cn-stat">${esc(o.status_text)}</span>${msg ? `<p>${msg}</p>` : ''}
        ${o.status === 'accepted' ? `<p class="cn-eta">${o.ahead ? `${o.ahead} order${o.ahead === 1 ? '' : 's'} ahead of you` : 'You are next'}${o.wait_min ? ` · usually about ${o.wait_min} min` : ''}</p>` : ''}
        ${end && o.reject_reason ? `<p class="err">${o.status === 'cancelled' ? '' : 'Reason: '}${esc(o.reject_reason)}</p>` : ''}${o.status === 'rejected' && ['paid', 'claimed'].includes(o.pay_status) ? '<p>If you paid, collect your refund at the counter with this token.</p>' : ''}</div>
      ${payBox}
      ${end ? '' : `<ol class="cn-steps">${steps.map(([k, l], i) => `<li class="${i < rank ? 'done' : i === Math.floor(rank) || (o.status === 'placed' && i === 0) ? 'now' : ''}"><i></i>${l}</li>`).join('')}</ol>`}
      <div class="card cn-list">${o.items.map(it => `<div class="cn-item"><span>${it.qty} × ${esc(it.name)}</span><b>${rupees(it.qty * it.price_paise)}</b></div>`).join('')}
        ${o.delivery_fee_paise ? `<div class="cn-item"><span>Delivery</span><b>${rupees(o.delivery_fee_paise)}</b></div>` : ''}
        <div class="cn-item cn-tot"><b>Total${o.pay_status === 'paid' ? ' · paid' : ''}</b><b>${o.total}</b></div>${o.note ? `<div class="muted small" style="padding-top:8px">Note: ${esc(o.note)}</div>` : ''}</div>
      ${o.status === 'placed' && o.pay_status === 'unpaid' ? '<p><button class="btn danger" id="cncancel">Cancel order</button></p>' : ''}
      <p><a class="btn" href="#/d/${slug}/canteen">${I('utensils', 18)} Back to the menu</a></p></div>`;
    const cb = document.getElementById('cncancel');
    if (cb) cb.onclick = async () => { if (!confirm('Cancel this order?')) return; try { await H.api(`/public/${slug}/canteen/orders/${id}/cancel`, { method: 'POST', body: { k: key } }); H.toast('Order cancelled'); draw(); } catch (e) { H.toast(e.message); draw(); } };
    const uf = document.getElementById('cnutrf');
    if (uf) uf.onsubmit = async e => { e.preventDefault(); const v = document.getElementById('cnutr').value; document.getElementById('cnutr').blur();
      try { await H.api(`/public/${slug}/canteen/orders/${id}/upi-ref`, { method: 'POST', body: { k: key, ref: v } }); H.toast('Thanks! The canteen will check your payment.'); draw(); }
      catch (er) { document.getElementById('cnutre').textContent = er.message; } };
    const done = del ? 'out' : 'ready';
    if (o.status === done && prev && prev !== done) { chime(); H.toast(del ? `Your order ${o.token} is on its way!` : `Your order ${o.token} is ready!`, 6000); }
    if (o.status === 'accepted' && prev === 'placed') H.toast('Payment confirmed. Your order is in the kitchen.', 5000);
    document.title = o.status === 'ready' && !del ? `✅ ${o.token} ready · ${o.canteen}` : o.status === 'out' ? `🛵 ${o.token} on its way` : `${o.token} · ${o.canteen}`; prev = o.status;
    if (['collected', 'rejected', 'cancelled'].includes(o.status)) clearInterval(timer);
    return o;
  };
  const o = await draw(); if (o && new URLSearchParams(location.hash.split('?')[1]).get('new')) H.toast(`Order placed. Your token is ${o.token}.`);
  if (o && !['collected', 'rejected', 'cancelled'].includes(o.status)) every(8000, draw, hash);
}

async function minePage(slug) {
  const { app, I, esc } = H, hash = location.hash.split('?')[0];
  const draw = async () => {
    const rows = await H.api(`/public/${slug}/canteen/mine`, { method: 'POST', body: { device: localStorage.getItem('canteen-dev:' + slug) } }).catch(() => []);
    app.innerHTML = `<div class="wrap"><div class="head"><a class="iconbtn" href="#/d/${slug}/canteen" aria-label="Back">${I('back')}</a><h1>My orders</h1></div>
      ${rows.map(o => `<a class="svc" href="#/d/${slug}/canteen/o/${o.id}?k=${o.key}"><span class="cn-tk s-${o.status}">${o.token}</span><span class="t"><b>${esc(o.status_text)}</b><span class="muted small">${o.items.map(i => `${i.qty}× ${esc(i.name)}`).join(', ')} · ${o.total}</span></span><span class="chev">${I('chev')}</span></a>`).join('')
        || '<div class="card empty"><span class="et">No recent orders on this phone</span></div>'}</div>`;
  };
  await draw(); every(15000, draw, hash);
}

// ================= canteen desk =================
let stateFor = null;
export async function canteenPage(main, { sa }) {
  clearInterval(timer); // a poller from another campus or screen stops here
  const tid = localStorage.getItem('tid') || ''; if (stateFor !== tid) { stateFor = tid; posCart = {}; posLast = null; kotSeen = null; S_find = ''; openDone = false; }
  const { I, esc, api, toast, dlg } = H, acc = await api('/canteen/access');
  const tabKey = 'canteen-tab' + (acc.cashier ? '-counter' : acc.cook ? '-kitchen' : ''), st = ls.get(tabKey, acc.cashier ? 'counter' : 'orders'), hash = '#/c/canteen';
  const tabs = [acc.counter && ['counter', 'Counter (POS)'], acc.counter && ['orders', 'Orders'], acc.kitchen && ['kitchen', 'Kitchen (KOT)'], acc.manage && ['menu', 'Menu'], acc.manage && ['report', 'Reports'], acc.setup && ['setup', 'Set up']].filter(Boolean);
  let tab = tabs.some(t => t[0] === st) ? st : tabs[0]?.[0];
  if (!tab) { main.innerHTML = '<div class="card empty"><span class="et">Canteen is not set up for you</span><span>The super admin switches the canteen on and picks the canteen managers.</span></div>'; return; }
  const head = () => `<div class="tabs">${tabs.map(([k, l]) => `<button class="tab ${tab === k ? 'on' : ''}" data-t="${k}">${l}</button>`).join('')}</div>`;
  const wire = () => main.querySelectorAll('[data-t]').forEach(b => b.onclick = () => { tab = b.dataset.t; ls.set(tabKey, tab); clearInterval(timer); draw(); });
  // a screen that fails: say why in plain words; after an update the usual cause is a server that was not restarted
  const draw = async () => { try { await ({ counter, orders, kitchen, menu, report, setup })[tab](); } catch (e) {
    const v = await fetch('/api/version', { cache: 'no-store' }).then(r => r.json()).catch(() => null), stale = v?.restart_needed || e instanceof TypeError;
    main.innerHTML = head() + (stale ? `<div class="card cn-warn" style="display:block"><b>This screen could not load.</b> ${v?.restart_needed ? `The server has new code (${esc(v.on_disk)}) but is still running the old version (${esc(v.commit)}).` : 'The server may be running an older version than this page.'}
      <div style="margin-top:6px">On the server, in the app folder, run <code>npm ci --omit=dev</code> and then <code>pm2 restart one-desk</code>, then reload this page.</div><div class="muted small" style="margin-top:4px">Details: ${esc(e.message)}</div></div>`
      : `<p class="err">${esc(e.message)}</p>`); wire(); } };
  await draw();

  async function orders() {
    const d = await api('/canteen/orders'), by = s => d.orders.filter(o => s.includes(o.status));
    const card = o => `<div class="card cn-oc s-${o.status}" data-tk="${o.token_no}"><div class="cn-oh"><span class="cn-tk s-${o.status}">${o.token}</span><div><b>${esc(o.name)}</b>${o.earlier ? ` <span class="cn-so">from ${esc(o.day)}</span>` : ''}<div class="muted small">${new Date(o.created_at).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' })}${o.phone ? ' · ' + esc(o.phone) : ''}</div></div><b class="cn-amt">${o.total}</b></div>
      <div class="cn-sum"><span><small>Order</small><b>${o.token}</b></span><span><small>Amount</small><b>${o.total}</b></span><span><small>${o.pay_mode === 'upi' ? 'UTR' : 'Payment'}</small><b class="mono">${o.pay_mode === 'upi' ? (o.upi_ref ? esc(o.upi_ref) : '—') : 'Cash'}</b></span></div>
      ${o.has_booked && o.status === 'placed' ? `<div class="cn-warn">${I('alert', 14)} Has out-of-stock items: confirm you can make them before sending to the kitchen.</div>` : ''}
      <div class="cn-badges">${o.channel === 'counter' ? '<span class="cn-b ctr">Counter</span>' : ''}<span class="cn-b ${o.pay_status}">${o.pay_mode === 'upi' ? 'UPI' : 'Cash'} · ${o.pay_status === 'paid' ? 'paid' : o.pay_status === 'claimed' ? `ref ${esc(o.upi_ref)}` : 'not paid yet'}</span>${o.fulfil === 'delivery' ? `<span class="cn-b del">${I('pin', 12)} ${esc(o.deliver_to)}</span>` : '<span class="cn-b">Pickup</span>'}</div>
      <table class="cn-itab"><thead><tr><th>Item</th><th>Qty</th><th>Amount</th></tr></thead><tbody>${o.items.map(i => `<tr><td>${esc(i.name)}${i.booked ? ' <span class="cn-oos">out of stock</span>' : ''}</td><td>${i.qty}</td><td>${rupees(i.qty * i.price_paise)}</td></tr>`).join('')}
        ${o.delivery_fee_paise ? `<tr><td>Delivery</td><td></td><td>${rupees(o.delivery_fee_paise)}</td></tr>` : ''}</tbody><tfoot><tr><td>Total</td><td>${o.items.reduce((n, i) => n + i.qty, 0)}</td><td>${o.total}</td></tr></tfoot></table>${o.kot_started_at && o.status === 'accepted' ? '<div class="cn-b paid" style="margin-top:6px;display:inline-flex">Kitchen is cooking</div>' : ''}${o.status === 'accepted' && o.accepted_at && (Date.now() - Date.parse(o.accepted_at)) / 6e4 > (d.sla?.prep || 15) ? `<div class="cn-b unpaid" style="margin-top:6px;display:inline-flex">Past the ${d.sla?.prep || 15}-min kitchen target</div>` : ''}${o.status === 'out' && o.out_at && (Date.now() - Date.parse(o.out_at)) / 6e4 > (d.sla?.delivery || 20) ? `<div class="cn-b unpaid" style="margin-top:6px;display:inline-flex">Past the ${d.sla?.delivery || 20}-min delivery target</div>` : ''}${o.note ? `<div class="cn-note">${I('pencil', 13)} ${esc(o.note)}</div>` : ''}
      ${o.status === 'rejected' ? `<div class="muted small">Rejected: ${esc(o.reject_reason)}</div>` : ''}
      ${o.pay_status === 'paid' && !['rejected', 'cancelled'].includes(o.status) ? `<p class="cn-prow"><button class="btn" data-bill="${o.id}">${I('file', 15)} ${o.bill_prints ? 'Reprint bill' : 'Print bill'}</button><button class="btn" data-kotp="${o.id}">KOT</button></p>` : ''}
      <div class="fact">${o.status === 'placed' ? `<button class="btn ${o.pay_mode === 'cash' || o.pay_status === 'claimed' ? 'primary' : ''}" data-a="accepted" data-id="${o.id}" data-pay="${o.pay_mode}" data-ref="${esc(o.upi_ref || '')}" data-amt="${o.total}" data-booked="${o.has_booked ? 1 : ''}">${I('check', 16)} ${o.pay_mode === 'cash' ? 'Cash received' : 'UPI verified'} · to kitchen</button><button class="btn danger" data-a="rejected" data-id="${o.id}">Reject</button>`
        : o.status === 'accepted' ? `<button class="btn primary" data-a="ready" data-id="${o.id}">${I('bell', 16)} ${o.fulfil === 'delivery' ? 'Packed' : 'Mark ready'}</button><button class="btn danger" data-a="rejected" data-id="${o.id}">Reject</button>`
        : o.status === 'ready' ? (o.fulfil === 'delivery' ? `<button class="btn primary" data-a="out" data-id="${o.id}">${I('send', 16)} Out for delivery</button>` : `<button class="btn primary" data-a="collected" data-id="${o.id}">${I('ccheck', 16)} Collected</button>`) + `<button class="btn danger" data-a="rejected" data-id="${o.id}">Not collected</button>`
        : o.status === 'out' ? `<button class="btn primary" data-a="collected" data-id="${o.id}">${I('ccheck', 16)} Delivered</button><button class="btn danger" data-a="rejected" data-id="${o.id}">Not delivered</button>` : ''}</div></div>`;
    const col = (t, list, empty) => `<section class="cn-col"><h3>${t} <span class="cnt">${list.length}</span></h3>${list.map(card).join('') || `<p class="muted small">${empty}</p>`}</section>`;
    const done = by(['collected', 'rejected', 'cancelled']), pend = by(['placed', 'accepted', 'ready', 'out']).length;
    main.innerHTML = `${head()}<div class="card cn-openbar ${d.open ? 'on' : ''}"><div>${I(d.open ? 'ccheck' : 'clock', 18)} <b>${esc(d.name)}: ${d.open ? 'open for orders today' : 'closed'}</b><div class="muted small">${d.open && d.state && !d.state.accepting ? 'Opened, but outside the canteen timings: students can order once the timings allow. ' : ''}${d.state?.hours ? hoursText(d.state.hours) + ' · ' : ''}${d.open ? 'Students can order now. Mark items sold out with the Stock button.' : 'Open the canteen to start taking orders. Sold-out marks reset each new day.'}</div></div>
      <input id="cnfind" class="cn-find" inputmode="numeric" placeholder="Find token, e.g. 47" aria-label="Find token"><button class="btn ${d.open ? '' : 'primary'}" id="cnopen">${d.open ? 'Close for today' : 'Open canteen for the day'}</button></div>
      <div class="cn-board">${col('Waiting for payment', by(['placed']).reverse(), 'Nobody waiting to pay')}${col('In the kitchen', by(['accepted']).reverse(), 'Nothing being prepared')}${col('Ready', by(['ready']).reverse(), 'Nothing waiting')}${col('Out for delivery', by(['out']).reverse(), 'No deliveries on the way')}</div>
      <details class="card cn-done" ${openDone ? 'open' : ''}><summary><b>Done today</b> · ${done.length} (${by(['collected']).length} collected)</summary>${done.map(o => `<div class="cn-item"><span><span class="cn-tk sm s-${o.status}">${o.token}</span> ${esc(o.name)} · ${o.items.map(i => `${i.qty}× ${esc(i.name)}`).join(', ')}</span><span class="muted small">${o.status === 'rejected' ? (['paid', 'claimed'].includes(o.pay_status) ? 'Rejected · refund ' + o.total : 'Rejected') : o.status === 'cancelled' ? esc(o.reject_reason || 'Cancelled by student') : o.total + (o.fulfil === 'delivery' ? ' · delivered' : '')}</span></div>`).join('') || '<p class="muted small">Nothing yet.</p>'}</details>`;
    wire();
    document.getElementById('cnopen').onclick = async () => { try { if (d.open && !confirm(`Close the canteen? Students can no longer place orders.${pend ? ` ${pend} order${pend === 1 ? ' is' : 's are'} still in progress: you can still finish ${pend === 1 ? 'it' : 'them'}.` : ''}`)) return; await api(d.open ? '/canteen/close' : '/canteen/open', { method: 'POST' }); toast(d.open ? 'Canteen closed' : 'Canteen open for today'); } catch (e) { toast(e.message); } draw(); };
    const fi = document.getElementById('cnfind'); fi.value = S_find; fi.oninput = () => { S_find = fi.value.replace(/\D/g, ''); filt(); }; const filt = () => main.querySelectorAll('.cn-oc').forEach(c => { c.hidden = !!S_find && +c.dataset.tk !== +S_find; }); filt();
    main.querySelectorAll('.cn-done').forEach(x => x.ontoggle = () => { openDone = x.open; });
    const find = id => d.orders.find(x => x.id === id);
    main.querySelectorAll('[data-bill]').forEach(b => b.onclick = async () => { await printOrder('bill', find(b.dataset.bill), d.name, d.print); draw(); });
    main.querySelectorAll('[data-kotp]').forEach(b => b.onclick = () => printOrder('kot', find(b.dataset.kotp), d.name, d.print));
    main.querySelectorAll('[data-a]').forEach(b => b.onclick = async () => {
      const go = async body => { const r = await api(`/canteen/orders/${b.dataset.id}/${b.dataset.a}`, { method: 'POST', body }); draw(); return r; };
      if (b.dataset.a === 'accepted' && b.dataset.booked && !confirm('This order has out-of-stock items. Can the kitchen make them? If not, press Cancel and reject the order.')) return;
      if (b.dataset.a === 'accepted' && !confirm(b.dataset.pay === 'cash' ? `Did you receive ${b.dataset.amt} in cash? The order goes to the kitchen.` : b.dataset.ref ? `Check your UPI app: is there a payment of ${b.dataset.amt} with reference ${b.dataset.ref}? The order goes to the kitchen.` : `The student has not sent a UPI reference yet. Only continue if you can see ${b.dataset.amt} received in your UPI app.`)) return;
      if (b.dataset.a !== 'rejected') { b.disabled = true; try { const r = await go({}); if (b.dataset.a === 'accepted') { if (d.print.auto_bill) await printOrder('bill', r, d.name, d.print); if (d.print.kot_at_counter) await printOrder('kot', r, d.name, d.print); } } catch (e) { toast(e.message); draw(); } return; }
      const reasons = ['Payment not received', 'Item sold out', 'Canteen closing', 'Too many orders right now', 'Not collected', 'Could not deliver'];
      const dd = dlg(`<h3>Reject order</h3><p class="muted small">The student sees this reason and gets an email.</p><div class="cn-chips">${reasons.map(r => `<button type="button" class="tab" data-r="${esc(r)}">${esc(r)}</button>`).join('')}</div>
        <label>Reason</label><textarea name="reason" required minlength="3" maxlength="200"></textarea>`, async f => { await go({ reason: f.reason.value }); toast('Order rejected'); });
      dd.querySelectorAll('[data-r]').forEach(x => x.onclick = () => { dd.querySelector('[name=reason]').value = x.dataset.r; });
    });
    every(10000, () => !document.querySelector('dialog') && document.activeElement?.id !== 'cnfind' && draw(), hash);
  }

  // Counter (POS): a walk-in customer at the counter. Tap items, take cash (change shown) or UPI, charge: the order is paid,
  // goes straight to the kitchen as a KOT, and the bill prints.
  async function counter() {
    const p = await api('/canteen/pos'), sh = await api('/canteen/shift'), list = [...p.categories.flatMap(c => c.items.map(i => ({ ...i, cat: c.name }))), ...p.uncategorised];
    const by = new Map(list.map(i => [i.id, i])); for (const k of Object.keys(posCart)) if (!by.has(k) || by.get(k).sold_out) delete posCart[k];
    const tot = () => Object.entries(posCart).reduce((s, [k, n]) => s + by.get(k).price_now * n, 0), n = () => Object.values(posCart).reduce((s, x) => s + x, 0);
    main.innerHTML = `${acc.cashier ? `<div class="tabs">${tabs.map(([k, l]) => `<button class="tab ${tab === k ? 'on' : ''}" data-t="${k}">${l}</button>`).join('')}</div>` : head()}
      ${p.open ? '' : `<div class="card cn-warn" style="margin:8px 0">${I('alert', 16)} The canteen is closed. <button class="btn soft" id="posopen" style="margin-left:auto">Open for the day</button></div>`}
      <div class="cn-pos"><div class="cn-posm"><div class="cn-search">${I('search', 18)}<input id="posq" type="search" placeholder="Find an item" aria-label="Find an item" autocomplete="off"></div>
        <div class="cn-posg">${list.map(i => `<button type="button" class="cn-pb ${i.sold_out ? 'off' : ''}" data-add="${i.id}" data-n="${esc(i.name.toLowerCase())}" ${i.sold_out ? 'disabled' : ''}><b>${esc(i.name)}</b><span>${i.sold_out ? 'Sold out' : priceHtml(i)}</span>${i.deal ? dealBadge(i.deal) : ''}</button>`).join('') || '<p class="muted">No items on the menu yet.</p>'}</div></div>
      <form class="card cn-posb" id="posf"><b>Bill</b><div class="cn-opts">${[['takeaway', 'Takeaway'], ['dine_in', 'Dine in']].map(([v, l], k) => `<label class="cn-opt"><input type="radio" name="svc" value="${v}" ${k ? '' : 'checked'}><span><b>${l}</b></span></label>`).join('')}</div>
        <div id="postab" hidden><label>Table no. <span class="muted small">(optional)</span></label><input name="table_no" maxlength="10" inputmode="numeric" autocomplete="off"></div><div id="posl"></div>
        <div class="cn-item cn-tot"><b>Total</b><b id="post">₹0</b></div>
        <div class="cn-opts">${['cash', ...(p.upi ? ['upi'] : [])].map(m => `<label class="cn-opt"><input type="radio" name="pm" value="${m}" ${m === 'cash' ? 'checked' : ''}><span>${I(m === 'cash' ? 'cash' : 'phone', 18)}<b>${m === 'cash' ? 'Cash' : 'UPI'}</b></span></label>`).join('')}</div>
        <div id="poscash"><label>Cash received (₹)</label><input name="tendered" inputmode="decimal" placeholder="Exact amount if empty" autocomplete="off"><div class="cn-quick" id="posqk"></div><div class="cn-change" id="posch"></div></div>
        <div id="posupi" hidden><label>UPI reference (UTR) <span class="muted small">(optional, from the canteen's UPI app)</span></label><input name="upi_ref" maxlength="30" autocomplete="off"></div>
        <details><summary class="muted small">Customer name / note</summary><label>Name</label><input name="name" maxlength="80" placeholder="Walk-in"><label>Note for the kitchen</label><input name="note" maxlength="200"></details>
        <div class="err" id="poserr"></div><button class="btn primary big" id="poscharge" disabled>Charge &amp; send to kitchen</button>
        <button type="button" class="btn" id="posclear">Clear</button><button type="button" class="btn" id="posstock">Stock (sold out)</button>${posLast ? `<button type="button" class="btn" id="posreb">${I('file', 15)} Reprint last bill ${posLast.token}</button>` : ''}</form></div>
      <a href="#posf" class="cn-posbar" id="posbar" hidden onclick="document.getElementById('posf').scrollIntoView({behavior:'smooth'});return false"></a>
      <div class="card cn-shift"><b>My shift today</b><span>${sh.orders} paid order${sh.orders === 1 ? '' : 's'}</span><span>Cash <b>${rupees(sh.cash_paise)}</b></span><span>UPI <b>${rupees(sh.upi_paise)}</b></span>${sh.refunds_paise ? `<span>Refunds <b>${rupees(sh.refunds_paise)}</b></span>` : ''}</div>`;
    wire();
    const f = document.getElementById('posf'), render = () => { const t = tot();
      document.getElementById('posl').innerHTML = Object.entries(posCart).map(([k, q]) => { const i = by.get(k); return `<div class="cn-item"><span>${esc(i.name)}<br><span class="muted small">${rupees(i.price_now)} each</span></span><span class="cn-step"><button type="button" data-pd="${k}" aria-label="One less">−</button><b>${q}</b><button type="button" data-pi="${k}" aria-label="One more">+</button></span><b>${rupees(i.price_now * q)}</b></div>`; }).join('') || '<p class="muted small">Tap items to add them.</p>';
      document.getElementById('post').textContent = rupees(t); const pb = document.getElementById('posbar'); pb.hidden = !n(); pb.textContent = `${n()} item${n() === 1 ? '' : 's'} · ${rupees(t)} · Go to bill ↓`; document.getElementById('poscharge').disabled = posBusy || !n() || !p.open; document.getElementById('poscharge').textContent = n() ? `Charge ${rupees(t)} & send to kitchen` : 'Charge & send to kitchen';
      document.getElementById('postab').hidden = f.svc.value !== 'dine_in'; const cash = f.pm.value === 'cash'; document.getElementById('poscash').hidden = !cash; document.getElementById('posupi').hidden = cash;
      const notes = [...new Set([t, Math.ceil(t / 5000) * 5000, Math.ceil(t / 10000) * 10000, Math.ceil(t / 50000) * 50000])].filter(x => x >= t && x > 0).slice(0, 4);
      document.getElementById('posqk').innerHTML = t ? notes.map(x => `<button type="button" class="tab" data-tq="${x / 100}">${rupees(x)}</button>`).join('') : '';
      const got = f.tendered.value === '' ? t : Math.round(Number(f.tendered.value) * 100), ch = document.getElementById('posch');
      ch.innerHTML = !t || !cash ? '' : !Number.isFinite(got) ? '<span class="err">Enter a number</span>' : got < t ? `<span class="err">Short by ${rupees(t - got)}</span>` : `Give change <b>${rupees(got - t)}</b>`; };
    const add = (k, d) => { posCart[k] = Math.max(0, Math.min(99, (posCart[k] || 0) + d)); if (!posCart[k]) delete posCart[k]; render(); };
    main.querySelectorAll('[data-add]').forEach(b => b.onclick = () => add(b.dataset.add, 1));
    f.onclick = e => { const i = e.target.closest('[data-pi]'), d = e.target.closest('[data-pd]'), q = e.target.closest('[data-tq]'); if (i) add(i.dataset.pi, 1); if (d) add(d.dataset.pd, -1); if (q) { f.tendered.value = q.dataset.tq; render(); } };
    f.oninput = render; f.onchange = render;
    document.getElementById('posq').oninput = e => { const v = e.target.value.trim().toLowerCase(); main.querySelectorAll('[data-add]').forEach(b => b.hidden = !!v && !b.dataset.n.includes(v)); };
    document.getElementById('posstock').onclick = () => stockDialog(draw);
    document.getElementById('posclear').onclick = () => { posCart = {}; f.reset(); render(); };
    const rb = document.getElementById('posreb'); if (rb) rb.onclick = () => printOrder('bill', posLast, p.name, p.print);
    const po = document.getElementById('posopen'); if (po) po.onclick = async () => { try { await api('/canteen/open', { method: 'POST' }); toast('Canteen open for today'); } catch (e) { toast(e.message); } draw(); };
    let posBusy = false;
    f.onsubmit = async e => { e.preventDefault(); if (posBusy) return; posBusy = true; const err = document.getElementById('poserr'), btn = document.getElementById('poscharge'); err.textContent = ''; btn.disabled = true;
      try { const o = await api('/canteen/pos', { method: 'POST', body: { items: Object.entries(posCart).map(([id, qty]) => ({ id, qty })), pay_mode: f.pm.value, tendered: f.tendered.value, upi_ref: f.upi_ref.value, expect_paise: tot(), name: f.name.value, note: f.note.value, service: f.svc.value, table_no: f.table_no.value } });
        posCart = {}; posLast = o; toast(`Paid · token ${o.token} sent to the kitchen${o.change_paise ? ` · give change ${rupees(o.change_paise)}` : ''}`, 6000);
        if (p.print.auto_bill) await printOrder('bill', o, p.name, p.print); if (p.print.kot_at_counter) await printOrder('kot', o, p.name, p.print); draw(); }
      catch (er) { posBusy = false; err.textContent = er.message; btn.disabled = false; if (er.code === 'PRICE_CHANGED') { const keep = posCart; await draw(); posCart = keep; } } };
    render();
  }

  // Kitchen: each paid order is a KOT (kitchen order ticket): items and quantities, start cooking, then ready
  async function kitchen() {
    const k = await api('/canteen/kitchen'), age = iso => Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 6e4));
    const ids = k.kots.map(o => o.id), fresh = kotSeen ? k.kots.filter(o => !kotSeen.includes(o.id)) : [];
    if (fresh.length) { chime(); toast('New KOT in the kitchen'); } kotSeen = ids;
    if (k.print.auto_kot) for (const o of k.kots) if (!o.kot_prints) { o.kot_prints = 1; await printOrder('kot', o, k.name, k.print); } // the kitchen printer catches every KOT not printed yet
    const kot = o => `<div class="card cn-kot ${o.kot_started_at ? 'cooking' : 'new'} ${age(o.accepted_at) > (k.sla?.prep || 15) ? 'late' : ''}" data-tk="${o.token_no}"><div class="cn-koth"><b>KOT ${o.token}</b><span>${o.fulfil === 'delivery' ? `${I('pin', 13)} Delivery` : 'Pickup'}</span><span class="cn-age">${age(o.accepted_at)} min</span></div>
      <table class="cn-ktab"><tbody>${o.items.map(i => `<tr><td class="q">${i.qty}</td><td>${esc(i.name)}${i.booked ? ' <span class="cn-oos">was out of stock</span>' : ''}</td></tr>`).join('')}</tbody></table>
      ${o.note ? `<div class="cn-note">${I('pencil', 13)} ${esc(o.note)}</div>` : ''}<div class="muted small">${esc(o.name)} · paid ${new Date(o.accepted_at).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' })}</div>
      <div class="fact">${o.kot_started_at ? `<button class="btn primary" data-k="ready" data-id="${o.id}">${I('bell', 16)} ${o.fulfil === 'delivery' ? 'Ready · packed' : 'Ready'}</button>` : `<button class="btn primary" data-k="start" data-id="${o.id}">${I('play', 16)} Start cooking</button>`}<button class="btn" data-print="${o.id}" aria-label="Print KOT ${o.token}">Print</button></div></div>`;
    main.innerHTML = `${acc.cook ? '' : head()}<div class="cn-kh"><b>${esc(k.name)} · Kitchen</b><span class="muted small">${k.kots.length} KOT${k.kots.length === 1 ? '' : 's'} · refreshes by itself</span><button type="button" class="btn soft" id="kstock">Stock (sold out)</button></div>
      <div class="cn-kots">${k.kots.map(kot).join('') || '<div class="card empty" style="grid-column:1/-1"><span class="et">No KOTs right now</span><span>Paid orders appear here as soon as the counter confirms the payment.</span></div>'}</div>
      <details class="card cn-done" ${openDone ? 'open' : ''}><summary><b>Done in the last 2 hours</b> · ${k.done.length}</summary>${k.done.map(o => `<div class="cn-item"><span><span class="cn-tk sm s-${o.status}">${o.token}</span> ${o.items.map(i => `${i.qty}× ${esc(i.name)}`).join(', ')}</span><span class="muted small">${esc(o.status_text)}</span></div>`).join('') || '<p class="muted small">Nothing yet.</p>'}</details>`;
    main.querySelectorAll('.cn-done').forEach(x => x.ontoggle = () => { openDone = x.open; });
    if (!acc.cook) wire(); document.getElementById('kstock').onclick = () => stockDialog(draw);
    main.querySelectorAll('[data-k]').forEach(b => b.onclick = async () => { b.disabled = true;
      try { await api(b.dataset.k === 'start' ? `/canteen/kitchen/${b.dataset.id}/start` : `/canteen/orders/${b.dataset.id}/ready`, { method: 'POST' }); toast(b.dataset.k === 'start' ? 'Cooking' : 'Marked ready'); } catch (e) { toast(e.message); } draw(); });
    main.querySelectorAll('[data-print]').forEach(b => b.onclick = () => printOrder('kot', k.kots.find(x => x.id === b.dataset.print), k.name, k.print));
    every(8000, () => !document.querySelector('dialog') && draw(), hash);
  }

  async function menu() {
    const m = await api('/canteen/menu'), cats = m.categories;
    const itemRow = it => `<div class="cn-item ${it.active ? '' : 'gone'}"><div class="cn-in">${vegDot(it.is_veg)}<div><b>${esc(it.name)}</b> ${it.active ? `<label class="cn-qp">₹<input inputmode="decimal" data-price="${it.id}" value="${it.price_paise / 100}" aria-label="Price of ${esc(it.name)} in rupees"></label>` : `<span class="cn-price">${rupees(it.price_paise)}</span>`}${it.deal ? ' ' + dealBadge(it.deal) + ` <b class="cn-price">${rupees(it.price_now)}</b>` : ''}${it.description ? `<div class="muted small">${esc(it.description)}</div>` : ''}</div></div>
      <div class="cn-acts">${it.active ? `<button class="iconbtn" data-deal="${it.id}" aria-label="Deal on ${esc(it.name)}" title="Discount / flash sale">🏷️</button><label class="chk cn-sw"><input type="checkbox" data-so="${it.id}" ${it.sold_out ? 'checked' : ''}> Sold out</label>
        <button class="iconbtn" data-edit="${it.id}" aria-label="Edit ${esc(it.name)}">${I('pencil', 16)}</button><button class="iconbtn" data-del="${it.id}" aria-label="Remove ${esc(it.name)}">${I('x', 16)}</button>`
        : `<button class="btn soft" data-back="${it.id}">Put back</button>`}</div></div>`;
    const all_ = [...cats.flatMap(c => c.items), ...m.uncategorised], groups = [...cats, ...(m.uncategorised.length ? [{ id: '', name: 'No category', items: m.uncategorised }] : [])];
    main.innerHTML = `${head()}<div class="card cn-openbar ${m.open ? 'on' : ''}"><img class="cn-qr" src="/api/canteen-qr/${esc(m.slug)}.svg" alt="QR code for the canteen menu" width="112" height="112"><div><b>Student link &amp; QR code</b><div class="muted small">Students scan the QR at the counter or open the link. No login needed to see the menu.</div><code class="cn-link">${esc(m.link)}</code>
      <p class="row" style="margin:8px 0 0"><button type="button" class="btn primary" id="cnposter">${I('download', 16)} Print QR poster</button><a class="btn" href="/api/canteen-qr/${esc(m.slug)}.svg" download="${esc(m.slug)}-cafeteria-qr.svg">Download QR</a></p></div>
      <button class="btn soft" id="cncopy">${I('copy', 16)} Copy</button></div>
      ${acc.rename ? `<details class="cn-set" ${m.hours ? '' : 'open'}><summary>${I('settings', 16)} Name, timings, payments, delivery &amp; printing <span class="muted small">${esc(m.name)}${m.hours ? ' · ' + hoursText(m.hours) : ' · no timings yet'}</span></summary>` : ''}${acc.rename ? `<form class="card cn-openbar" id="cnname"><div><b>Canteen name</b><div class="muted small">Students see it on the menu, the order page and emails.</div><input name="name" maxlength="60" value="${esc(m.name)}" required></div><button class="btn soft">Save name</button><button type="button" class="btn" id="cnnamex">Reset to default</button></form>` : ''}
      ${acc.rename ? `<form class="card" id="cnhrs"><b>Canteen timings</b><div class="muted small">Students see these and can only order inside them. You still open the canteen each day.${m.hours ? '' : ' No timings yet: orders are taken whenever the canteen is open.'}</div>
        <div class="cn-hgrid"><label>Opens<input type="time" name="open" value="${m.hours?.open || '08:00'}" required></label><label>Closes<input type="time" name="close" value="${m.hours?.close || '20:00'}" required></label>
        <label>Last orders (min before closing)<input type="number" name="last" min="0" max="120" value="${m.hours?.last_order_min ?? 15}"></label></div>
        <div class="cn-days">${DAYS.map((d, i) => `<label class="chk"><input type="checkbox" name="d" value="${i}" ${(m.hours?.days || [1, 2, 3, 4, 5, 6]).includes(i) ? 'checked' : ''}> ${d}</label>`).join('')}</div>
        <p class="row"><button class="btn soft">Save timings</button>${m.hours ? '<button type="button" class="btn" id="cnhclr">No time limit</button>' : ''}</p></form>
        <form class="card" id="cnpay"><b>Payments &amp; delivery</b><div class="muted small">No payment gateway: an order reaches the kitchen only after your staff confirm the payment (cash at the counter, or the UPI payment seen in the canteen's UPI app).</div>
          <label class="chk" style="margin-top:10px"><input type="checkbox" name="cash" ${m.pay.cash ? 'checked' : ''}> Cash at the counter</label>
          <div class="cn-hgrid"><label>Canteen UPI ID<input name="upi_id" value="${esc(m.pay.upi_id)}" placeholder="canteen@okhdfcbank" maxlength="100"></label><label>Name shown in UPI apps<input name="upi_name" value="${esc(m.pay.upi_name)}" placeholder="${esc(m.name)}" maxlength="60"></label>
          <label>Kitchen target (min, paid → ready)<input type="number" name="prep_sla_min" min="1" max="180" value="${m.pay.prep_sla_min ?? 15}"></label>
          <label>Delivery target (min, out → delivered)<input type="number" name="delivery_sla_min" min="1" max="180" value="${m.pay.delivery_sla_min ?? 20}"></label>
          <label>Minutes to pay before an order is cancelled<input type="number" name="pay_window_min" min="5" max="120" value="${m.pay.pay_window_min}"></label></div>
          <label class="chk" style="margin-top:10px"><input type="checkbox" name="delivery" ${m.pay.delivery ? 'checked' : ''}> Door delivery on campus</label> <label class="chk"><input type="checkbox" name="delivery_cash" ${m.pay.delivery_cash ? 'checked' : ''}> Also allow cash for delivery (the student pays at the counter first)</label>
          <div class="cn-hgrid"><label>Delivery charge (₹)<input type="number" name="delivery_fee" min="0" max="500" step="0.5" value="${m.pay.delivery_fee}"></label><label style="grid-column:span 2">Note for students<input name="delivery_note" maxlength="120" value="${esc(m.pay.delivery_note)}" placeholder="e.g. Hostels and academic blocks only"></label></div>
          <label>Blocks you deliver to <span class="muted small">(one per line; leave empty to use the campus's blocks${m.campus_blocks.length ? ': ' + esc(m.campus_blocks.slice(0, 6).join(', ')) + (m.campus_blocks.length > 6 ? '…' : '') : ''})</span></label><textarea name="delivery_blocks" rows="4" placeholder="Boys hostel A&#10;Girls hostel&#10;Main block">${esc((m.pay.delivery_blocks || []).join('\n'))}</textarea>
          <b style="display:block;margin-top:14px">Printing</b><div class="muted small">Bills and KOTs print on any printer the computer has, sized for thermal paper. For printing without the print window, start Chrome with <code>--kiosk-printing</code> and make the thermal printer the default.</div>
          <div class="cn-hgrid"><label>Paper width<select name="paper"><option value="80" ${m.pay.paper !== '58' ? 'selected' : ''}>80 mm</option><option value="58" ${m.pay.paper === '58' ? 'selected' : ''}>58 mm</option></select></label><label>Tagline on the bill<input name="tagline" maxlength="80" value="${esc(m.pay.tagline || '')}" placeholder="e.g. Good Food Good Fuel"></label><label>Bill footer<input name="bill_footer" maxlength="120" value="${esc(m.pay.bill_footer ?? '')}"></label></div>
          <label class="chk"><input type="checkbox" name="auto_bill" ${m.pay.auto_bill !== false ? 'checked' : ''}> Print the bill as soon as a payment is taken at the counter</label>
          <div class="muted small" style="margin-top:8px">Where do KOTs print?</div>
          <label class="chk"><input type="radio" name="kot_where" value="counter" ${m.pay.kot_at_counter !== false && !m.pay.auto_kot ? 'checked' : ''}> On the counter printer, right after the bill (one printer)</label>
          <label class="chk"><input type="radio" name="kot_where" value="kitchen" ${m.pay.auto_kot ? 'checked' : ''}> On a kitchen printer, from the kitchen screen</label>
          <label class="chk"><input type="radio" name="kot_where" value="none" ${m.pay.kot_at_counter === false && !m.pay.auto_kot ? 'checked' : ''}> Don't print KOTs (the kitchen works from the screen)</label>
          <p class="row"><button type="button" class="btn" id="cntestp">${I('file', 15)} Print test page</button></p>
          <p class="row"><button class="btn soft">Save payments, delivery &amp; printing</button></p></form></details>` : ''}
      <p class="row"><button class="btn primary" id="additem">${I('plus', 16)} Add item</button><button class="btn soft" id="addcat">${I('plus', 16)} Add category</button><button class="btn soft" id="eodall">🌙 Sale on everything</button>${all_.some(i => i.deal) ? '<button class="btn" id="enddeals">End all deals</button>' : ''}</p>
      ${groups.map(g => `<section class="cn-cat"><div class="cn-ch"><h2>${esc(g.name)}</h2>${g.id ? `<span><button class="iconbtn" data-up="${g.id}" aria-label="Move ${esc(g.name)} up" ${cats[0]?.id === g.id ? 'disabled' : ''}>▲</button><button class="iconbtn" data-ren="${g.id}" aria-label="Rename">${I('pencil', 15)}</button><button class="iconbtn" data-cdel="${g.id}" aria-label="Remove category">${I('x', 15)}</button></span>` : ''}</div>
        <div class="card cn-list">${g.items.map(itemRow).join('') || '<p class="muted small">No items yet.</p>'}</div></section>`).join('') || '<div class="card empty"><span class="et">Start your menu</span><span>Add a category (Snacks, Meals, Drinks…) and then its items with prices.</span></div>'}`;
    wire();
    const hf = document.getElementById('cnhrs'); if (hf) { hf.onsubmit = async e => { e.preventDefault(); try { await api('/canteen/hours', { method: 'PUT', body: { open: hf.open.value, close: hf.close.value, last_order_min: +hf.last.value, days: [...hf.querySelectorAll('[name=d]:checked')].map(x => +x.value) } }); toast('Timings saved'); draw(); } catch (er) { toast(er.message); } };
      const hc = document.getElementById('cnhclr'); if (hc) hc.onclick = async () => { try { await api('/canteen/hours', { method: 'PUT', body: { clear: true } }); toast('Time limit removed'); } catch (e) { toast(e.message); } draw(); }; }
    const pf = document.getElementById('cnpay'); if (pf) pf.onsubmit = async e => { e.preventDefault(); try { await api('/canteen/payments', { method: 'PUT', body: { cash: pf.cash.checked, upi_id: pf.upi_id.value.trim(), upi_name: pf.upi_name.value.trim(), pay_window_min: +pf.pay_window_min.value, delivery: pf.delivery.checked, delivery_fee: +pf.delivery_fee.value, delivery_note: pf.delivery_note.value, delivery_blocks: pf.delivery_blocks.value, paper: pf.paper.value, tagline: pf.tagline.value, delivery_cash: pf.delivery_cash.checked, bill_footer: pf.bill_footer.value, auto_bill: pf.auto_bill.checked, auto_kot: pf.kot_where.value === 'kitchen', kot_at_counter: pf.kot_where.value === 'counter', prep_sla_min: +pf.prep_sla_min.value, delivery_sla_min: +pf.delivery_sla_min.value } }); toast('Payments & delivery saved'); } catch (er) { toast(er.message); } };
    // a sample bill and KOT with the saved settings, to check the printer, paper width and layout (not recorded anywhere)
    const tp = document.getElementById('cntestp'); if (tp) tp.onclick = async () => { const pr = { paper: pf.paper.value, footer: pf.bill_footer.value, tagline: pf.tagline.value };
      const o = { token_no: 0, token: '#000', bill_no: 'TEST', name: 'Printer test', cashier: 'Test', channel: 'counter', service: 'takeaway', paid_at: new Date().toISOString(), accepted_at: new Date().toISOString(),
        items: [{ name: 'Test item (not a sale)', qty: 1, price_paise: 100 }], total_paise: 100, pay_mode: 'cash', note: 'printer test' };
      await printHtml(billHtml(o, m.name, pr, false)); if (pf.kot_where.value !== 'none') await printHtml(kotHtml(o, m.name, pr, false)); toast('Test page sent to the printer'); };
    const nx = document.getElementById('cnnamex'); if (nx) nx.onclick = async () => { if (!confirm('Remove the canteen name? Students will see the default name.')) return; try { const r = await api('/canteen/name', { method: 'PUT', body: { name: '' } }); toast(`Name reset to “${r.name}”`); draw(); } catch (er) { toast(er.message); } };
    const nf = document.getElementById('cnname'); if (nf) nf.onsubmit = async e => { e.preventDefault(); try { await api('/canteen/name', { method: 'PUT', body: { name: nf.name.value } }); toast('Name saved'); } catch (er) { toast(er.message); } };
    // an A4 poster for the counter or notice board: name, timings, big QR, the short link
    document.getElementById('cnposter').onclick = () => { const w = window.open('', '_blank'); if (!w) return toast('Allow pop-ups to print the poster');
      w.document.write(`<!doctype html><meta charset="utf-8"><title>${esc(m.name)} QR</title><style>body{font-family:Inter,Arial,sans-serif;text-align:center;margin:0;padding:48px 24px;color:#0F172A}h1{font-size:44px;margin:0 0 8px}p{font-size:20px;margin:6px 0;color:#475569}img{width:min(70vw,420px);height:auto;margin:28px auto;display:block}.u{font:600 22px ui-monospace,monospace;color:#1E4B8F}.s{display:flex;justify-content:center;gap:28px;margin-top:24px;font-size:18px}.s b{display:block;font-size:30px;color:#1E4B8F}@media print{button{display:none}}</style>
        <h1>${esc(m.name)}</h1><p>Scan to see the menu and order ahead</p>${m.hours ? `<p>${esc(hoursText(m.hours))}</p>` : ''}<img src="${location.origin}/api/canteen-qr/${esc(m.slug)}.svg" alt=""><div class="u">${esc(m.link)}</div>
        <div class="s"><div><b>1</b>Scan</div><div><b>2</b>Order</div><div><b>3</b>Get a token</div><div><b>4</b>Collect &amp; pay</div></div><p style="margin-top:28px"><button onclick="print()" style="font-size:18px;padding:10px 22px">Print</button></p>`);
      w.document.close(); };
    document.getElementById('cncopy').onclick = () => { navigator.clipboard?.writeText(main.querySelector('.cn-link').textContent).then(() => toast('Link copied'), () => toast('Copy the link from the box')); };
    const catForm = (n = '') => `<h3>${n ? 'Rename category' : 'New category'}</h3><label>Name</label><input name="name" required maxlength="60" value="${esc(n)}" placeholder="e.g. Snacks">`;
    document.getElementById('addcat').onclick = () => dlg(catForm(), async f => { await api('/canteen/categories', { method: 'POST', body: { name: f.name.value } }); draw(); });
    const itemForm = (it = {}) => `<h3>${it.id ? 'Edit item' : 'New item'}</h3><label>Name</label><input name="name" required maxlength="80" value="${esc(it.name || '')}" placeholder="e.g. Masala dosa">
      <label>Price (₹)</label><input name="price" required inputmode="decimal" value="${it.price_paise != null ? it.price_paise / 100 : ''}" placeholder="e.g. 40">
      <label>Category</label><select name="category_id"><option value="">No category</option>${cats.map(c => `<option value="${c.id}" ${c.id === it.category_id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
      <label>Description <span class="muted small">(optional)</span></label><input name="description" maxlength="200" value="${esc(it.description || '')}">
      <label class="chk"><input type="checkbox" name="is_veg" ${it.is_veg === 0 ? '' : 'checked'}> Vegetarian</label>`;
    const body = f => ({ name: f.name.value, price: f.price.value, category_id: f.category_id.value, description: f.description.value, is_veg: f.is_veg.checked });
    const dealForm = (t, kinds) => `<h3>${t}</h3><label>Type</label><select name="kind">${kinds.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select>
      <label>Discount (%)</label><input name="pct" type="number" min="1" max="90" required value="20"><label>For how long</label><select name="mins"><option value="15">15 minutes</option><option value="30" selected>30 minutes</option><option value="60">1 hour</option><option value="120">2 hours</option><option value="240">4 hours</option><option value="0">Until I end it (discount only)</option></select>
      <p class="muted small">Students see the badge and the new price straight away; a flash or end-of-day sale also pops up on their menu.</p>`;
    main.querySelectorAll('[data-deal]').forEach(b => b.onclick = () => { const it = all_.find(x => x.id === b.dataset.deal);
      const d = dlg(dealForm(`Deal on ${esc(it.name)} (${rupees(it.price_paise)})`, [['flash', '⚡ Flash sale'], ['eod', '🌙 End-of-day sale'], ['discount', 'Discount']]) + (it.deal ? '<p><button type="button" class="btn danger" id="nodeal">End this deal</button></p>' : ''),
        async f => { await api('/canteen/items/' + it.id, { method: 'PATCH', body: { deal_pct: +f.pct.value, deal_kind: f.kind.value, deal_minutes: +f.mins.value } }); toast('Deal is live'); draw(); });
      const nd = d.querySelector('#nodeal'); if (nd) nd.onclick = async () => { await api('/canteen/items/' + it.id, { method: 'PATCH', body: { deal_pct: 0 } }); d.close(); toast('Deal ended'); draw(); }; });
    document.getElementById('eodall').onclick = () => dlg(dealForm('Sale on everything in stock', [['eod', '🌙 End-of-day sale'], ['flash', '⚡ Flash sale']]), async f => { if (!+f.mins.value) throw new Error('Pick how long the sale runs');
      const r = await api('/canteen/deals/all', { method: 'POST', body: { pct: +f.pct.value, minutes: +f.mins.value, kind: f.kind.value } }); toast(`Sale on ${r.items} items`); draw(); });
    const ed = document.getElementById('enddeals'); if (ed) ed.onclick = async () => { if (!confirm('End every deal now?')) return; try { await api('/canteen/deals', { method: 'DELETE' }); toast('All deals ended'); } catch (e) { toast(e.message); } draw(); };
    document.getElementById('additem').onclick = () => dlg(itemForm({ category_id: cats[0]?.id }), async f => { await api('/canteen/items', { method: 'POST', body: body(f) }); toast('Item added'); draw(); });
    main.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => { const it = all_.find(x => x.id === b.dataset.edit); dlg(itemForm(it), async f => { await api('/canteen/items/' + it.id, { method: 'PATCH', body: body(f) }); draw(); }); });
    main.querySelectorAll('[data-so]').forEach(b => b.onchange = async () => { try { await api('/canteen/items/' + b.dataset.so, { method: 'PATCH', body: { sold_out: b.checked } }); toast(b.checked ? 'Marked sold out' : 'Back in stock'); } catch (e) { toast(e.message); b.checked = !b.checked; } });
    main.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => { if (!confirm('Remove this item from the menu?')) return; try { await api('/canteen/items/' + b.dataset.del, { method: 'DELETE' }); } catch (e) { toast(e.message); } draw(); });
    main.querySelectorAll('[data-back]').forEach(b => b.onclick = async () => { try { await api('/canteen/items/' + b.dataset.back, { method: 'PATCH', body: { active: true } }); } catch (e) { toast(e.message); } draw(); });
    main.querySelectorAll('[data-price]').forEach(inp => { const was = inp.value; inp.onchange = async () => { try { await api('/canteen/items/' + inp.dataset.price, { method: 'PATCH', body: { price: inp.value } }); toast('Price saved'); } catch (e) { toast(e.message); inp.value = was; } }; inp.onkeydown = e => { if (e.key === 'Enter') inp.blur(); }; });
    main.querySelectorAll('[data-up]').forEach(b => b.onclick = async () => { const i = cats.findIndex(c => c.id === b.dataset.up); if (i < 1) return; const order = cats.map(c => c.id); [order[i - 1], order[i]] = [order[i], order[i - 1]];
      try { for (const [k, id] of order.entries()) await api('/canteen/categories/' + id, { method: 'PATCH', body: { sort_order: k } }); } catch (e) { toast(e.message); } draw(); });
    main.querySelectorAll('[data-ren]').forEach(b => b.onclick = () => dlg(catForm(cats.find(c => c.id === b.dataset.ren).name), async f => { await api('/canteen/categories/' + b.dataset.ren, { method: 'PATCH', body: { name: f.name.value } }); draw(); }));
    main.querySelectorAll('[data-cdel]').forEach(b => b.onclick = async () => { if (!confirm('Remove this category?')) return; try { await api('/canteen/categories/' + b.dataset.cdel, { method: 'DELETE' }); draw(); } catch (e) { toast(e.message); } });
  }

  async function report() {
    const rr = ls.get('canteen-range', 'week'), today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
    const back = n => { const d = new Date(today + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
    const r = await api(`/canteen/report?range=${rr === 'day' ? 'day' : rr === 'month' ? 'month' : 'week'}`), from = r.from, to_ = r.to;
    const max = Math.max(1, ...r.days.map(x => x.paise));
    main.innerHTML = `${head()}<div class="tabs">${[['day', 'Today'], ['week', '7 days'], ['month', '30 days']].map(([k, l]) => `<button class="tab ${rr === k ? 'on' : ''}" data-rr="${k}">${l}</button>`).join('')}</div>
      <div class="cn-kpis">${[['Collected orders', r.collected], ['Sales', rupees(r.revenue_paise)], ['Avg. order', rupees(r.aov_paise)], ['Discounts given', rupees(r.discount_paise)], ['Customers', r.customers], ['Repeat customers', r.repeat_customers], ['Pickups', r.pickups], ['Counter sales', rupees(r.channels.find(c => c.channel === 'counter').paise)], ['Online sales', rupees(r.channels.find(c => c.channel === 'online').paise)], ['Bill reprints', r.reprints], ['Cash taken', rupees(r.cash_paise)], ['UPI taken', rupees(r.upi_paise)], ['Deliveries', r.deliveries], ['Not paid in time', r.not_paid], ['Kitchen on time', r.sla.prep_total ? `${Math.round(r.sla.prep_on_time / r.sla.prep_total * 100)}% <small class="muted">≤ ${r.sla.prep_target} min</small>` : '—'], ['Delivery on time', r.sla.delivery_total ? `${Math.round(r.sla.delivery_on_time / r.sla.delivery_total * 100)}% <small class="muted">≤ ${r.sla.delivery_target} min</small>` : '—'], ['Avg. delivery time', r.sla.avg_delivery_min == null ? '—' : r.sla.avg_delivery_min + ' min'], ['Avg. prep time', r.avg_prep_min == null ? '—' : r.avg_prep_min + ' min'], ['Rejected', r.rejected], ['Cancelled', r.cancelled]].map(([l, v]) => `<div class="card"><span class="muted small">${l}</span><b>${v}</b></div>`).join('')}</div>
      <p class="row"><button class="btn soft" id="cncsv">${I('download', 16)} Download orders (CSV)</button></p>
      <div class="card"><b>Sales by day</b> <span class="muted small">collected orders</span><div class="cn-bars">${r.days.map(x => `<div title="${x.day}: ${x.orders} orders, ${rupees(x.paise)}">${x.paise && r.days.length <= 14 ? `<em>${rupees(x.paise)}</em>` : ''}<i style="height:${Math.round(x.paise / max * 100)}%"></i><span>${x.day.slice(8)}</span></div>`).join('')}</div></div>
      ${r.hours.length ? `<div class="card"><b>Busy hours</b> <span class="muted small">orders by time placed</span><div class="cn-bars">${(() => { const hm = Math.max(1, ...r.hours.map(h => h.orders)); return r.hours.map(h => `<div title="${h.hour}:00 – ${h.orders} orders, ${rupees(h.paise)}"><em>${h.orders}</em><i style="height:${Math.round(h.orders / hm * 100)}%;background:#F59E0B"></i><span>${h.hour}:00</span></div>`).join(''); })()}</div></div>` : ''}
      <div class="cn-three">${donut('Payment mix', [['Cash', r.cash_paise, rupees(r.cash_paise)], ['UPI', r.upi_paise, rupees(r.upi_paise)]])}
        ${donut('Pickup vs delivery', [['Pickup', r.pickups, r.pickups], ['Delivery', r.deliveries, r.deliveries]])}
        ${donut('Online vs counter', r.channels.map(c => [c.channel === 'counter' ? 'Counter (walk-in)' : 'Online', c.paise, rupees(c.paise)]))}
        ${donut('Order outcomes', [['Collected', r.collected, r.collected], ['Rejected', r.rejected, r.rejected], ['Cancelled / not paid', r.cancelled, r.cancelled]])}</div>
      <div class="cn-two">${hbars('Sales by category', r.categories.map(t => [esc(t.category), t.paise, rupees(t.paise)]), 'No collected orders yet.')}
        ${hbars('Top items by quantity', r.top.slice(0, 8).map(t => [esc(t.name), t.qty, t.qty]), 'No collected orders yet.')}</div>
      <div class="card"><b>Cash drawer by staff</b><div class="muted small">Payments each person confirmed (counter sales and online orders), without refunded orders: match against the cash drawer and the UPI app.</div>
        <table class="cn-itab"><thead><tr><th>Staff</th><th>Orders</th><th>Counter</th><th>Cash</th><th>UPI</th></tr></thead><tbody>${r.staff.map(x => `<tr><td>${esc(x.name)}</td><td>${x.orders}</td><td>${x.counter}</td><td>${rupees(x.cash_paise)}</td><td>${rupees(x.upi_paise)}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">No payments yet.</td></tr>'}</tbody></table></div>
      <div class="cn-two"><div class="card"><b>Deals</b>${r.deals.map(t => `<div class="cn-item"><span>${esc(t.name)}</span><span><b>${t.qty}</b> sold <span class="muted small">· ${rupees(t.paise)} · −${rupees(t.discount_paise)}</span></span></div>`).join('') || '<p class="muted small">No deals sold in this period.</p>'}</div></div>
      <div class="card"><b>Every item</b><table class="cn-itab"><thead><tr><th>Item</th><th>Category</th><th>Qty</th><th>Sales</th><th>Discount</th></tr></thead><tbody>${r.items_all.map(t => `<tr><td>${esc(t.name)}</td><td>${esc(t.category)}</td><td>${t.qty}</td><td>${rupees(t.paise)}</td><td>${t.discount_paise ? '−' + rupees(t.discount_paise) : '—'}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">No collected orders yet.</td></tr>'}</tbody></table></div>
      <div class="cn-two">        ${r.refunds.length ? `<div class="card" style="grid-column:1/-1"><b>Refunds to give</b><div class="muted small">Paid orders that were then rejected: hand the money back at the counter.</div>${r.refunds.map(x => `<div class="cn-item"><span><span class="cn-tk sm">${x.token}</span> ${esc(x.name)} · ${esc(x.day)} · ${x.mode === 'upi' ? 'UPI ' + esc(x.ref || '') : 'Cash'}</span><b>${rupees(x.paise)}</b></div>`).join('')}</div>` : ''}
        <div class="card"><b>Why orders were rejected</b>${r.reasons.map(t => `<div class="cn-item"><span>${esc(t.reason)}</span><b>${t.count}</b></div>`).join('') || '<p class="muted small">None.</p>'}</div></div>`;
    wire(); main.querySelectorAll('[data-rr]').forEach(b => b.onclick = () => { ls.set('canteen-range', b.dataset.rr); draw(); });
    document.getElementById('cncsv').onclick = async () => { try { const res = await api(`/canteen/orders.csv?from=${from}&to=${to_}`, { raw: true }); if (!res.ok) throw new Error('Could not download');
      const a = document.createElement('a'); a.href = URL.createObjectURL(await res.blob()); a.download = `canteen-orders-${from}-to-${to_}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); } catch (e) { toast(e.message); } };
  }

  async function setup() {
    const s0 = await api('/canteen/setup'), arr = v => Array.isArray(v) ? v : [], s = { ...s0, managers: arr(s0.managers), kitchen: arr(s0.kitchen), counter: arr(s0.counter), providers: arr(s0.providers), max: s0.max || 2, max_kitchen: s0.max_kitchen || 10 };
    main.innerHTML = `${head()}<form id="cnset" class="card" style="max-width:640px"><b>Canteen for this campus</b>
      <label>Canteen name</label><input name="name" maxlength="60" value="${esc(s.name)}" placeholder="${esc(s.default_name)}">
      <label class="chk" style="margin:12px 0"><input type="checkbox" name="on" ${s.on ? 'checked' : ''}> Canteen ordering is on</label>
      <b>Canteen staff</b><div class="muted small">Give desk providers one canteen job each. <b>Manager</b> (1 or 2): menu, prices, timings, payments, reports, everything. <b>Counter</b>: sells to walk-in customers, takes cash / UPI, prints bills, confirms online payments, hands orders over. <b>Kitchen</b>: sees only the KOT screen (start cooking, ready). Campus admins can do everything a manager can.</div>
      <div class="cn-staff">${s.providers.map(p => { const job = s.managers.includes(p.id) ? 'manager' : s.kitchen.includes(p.id) ? 'kitchen' : s.counter.includes(p.id) ? 'counter' : ''; return `<label class="cn-srow"><span><b>${esc(p.name)}</b><span class="muted small">${esc(p.email)}</span></span><select name="job" data-u="${p.id}" aria-label="Canteen job for ${esc(p.name)}">${[['', 'No canteen job'], ['manager', 'Manager'], ['counter', 'Counter'], ['kitchen', 'Kitchen']].map(([v, l]) => `<option value="${v}" ${job === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>`; }).join('') || '<p class="muted small">No active service providers on this campus yet. Add them under People.</p>'}</div>
      <div class="err" id="cnserr"></div><p><button class="btn primary">Save</button></p>
      ${s.on ? `<p class="muted small">Student link: <code>${esc(location.origin + '/' + s.slug + '/cafeteria')}</code> · the QR code is on the Menu tab.</p>` : ''}</form>`;
    wire();
    const f = document.getElementById('cnset'), jobs = [...f.querySelectorAll('[name=job]')], pick = j => jobs.filter(x => x.value === j).map(x => x.dataset.u);
    jobs.forEach(b => b.onchange = () => { if (pick('manager').length > s.max) { b.value = ''; toast(`At most ${s.max} canteen managers`); } });
    f.onsubmit = async e => { e.preventDefault(); try { await api('/canteen/setup', { method: 'PUT', body: { name: f.name.value, on: f.on.checked, managers: pick('manager'), kitchen: pick('kitchen'), counter: pick('counter') } }); toast('Canteen settings saved'); location.reload(); }
      catch (er) { document.getElementById('cnserr').textContent = er.message; } };
  }
}
