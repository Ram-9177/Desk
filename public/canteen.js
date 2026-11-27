// Canteen screens. Student side (#/d/<campus>/canteen…): browse the menu without logging in, verify email once per device,
// order, get a token, watch the status refresh by itself, collect at the counter. Desk side (#/c/canteen): canteen managers
// open the canteen for the day, run the order board, build the menu and see reports; the super admin sets it up.
// app.js hands in its helpers so this file looks and behaves like the rest of ONE Desk.
let H; // { api, esc, toast, I, dlg, app }
export const initCanteen = h => { H = h; };
const rupees = p => '₹' + (p / 100).toFixed(p % 100 ? 2 : 0);
const ls = { get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } } };
const STEPS = [['placed', 'Placed'], ['accepted', 'Preparing'], ['ready', 'Ready'], ['collected', 'Collected']];
let timer = null, S_find = '';
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
  let cart = ls.get(cartKey, {}); for (const k of Object.keys(cart)) if (!items.has(k) || items.get(k).sold_out) delete cart[k];
  const save = () => ls.set(cartKey, cart), count = () => Object.values(cart).reduce((s, n) => s + n, 0), total = () => Object.entries(cart).reduce((s, [k, n]) => s + items.get(k).price_paise * n, 0);
  const mine = ls.get('canteen-mine:' + slug, []).length, pop = new Set(c.popular || []);
  const stepper = it => it.sold_out ? '<span class="cn-so">Sold out</span>' : !c.open ? '' : cart[it.id]
    ? `<span class="cn-step"><button type="button" data-dec="${it.id}" aria-label="One less ${esc(it.name)}">−</button><b>${cart[it.id]}</b><button type="button" data-inc="${it.id}" aria-label="One more ${esc(it.name)}">+</button></span>`
    : `<button type="button" class="btn soft cn-add" data-inc="${it.id}">Add</button>`;
  const row = it => `<div class="cn-item ${it.sold_out ? 'off' : ''}" data-name="${esc((it.name + ' ' + (it.description || '')).toLowerCase())}" data-veg="${it.is_veg ? 1 : 0}" data-price="${it.price_paise}" data-i="${it.sort_order ?? 0}"><div class="cn-in">${vegDot(it.is_veg)}<div><b>${esc(it.name)}</b>${pop.has(it.id) ? ' <span class="cn-pop">★ Popular</span>' : ''}${it.description ? `<div class="muted small">${esc(it.description)}</div>` : ''}<div class="cn-price">${rupees(it.price_paise)}</div></div></div><div id="st-${it.id}">${stepper(it)}</div></div>`;
  const groups = [...c.categories, ...(c.uncategorised.length ? [{ id: 'x', name: c.categories.length ? 'More' : 'Menu', items: c.uncategorised }] : [])];
  const bar = () => { const n = count(), b = document.getElementById('cnbar'); if (!b) return;
    b.hidden = !n || !c.open; b.innerHTML = `<a class="btn primary big" href="#/d/${slug}/canteen/cart">${I('utensils', 18)} ${n} item${n === 1 ? '' : 's'} · ${rupees(total())} <span style="margin-left:auto">View cart ${I('chev', 16)}</span></a>`; };
  if (view === 'cart') return cartPage();
  app.innerHTML = `<div class="wrap cn-wrap">${back(`#/d/${slug}`, esc(c.name))}
    <div class="cn-banner ${c.open ? 'on' : ''}">${I(c.open ? 'ccheck' : 'clock', 18)}<span>${stateLine(c.state)}${c.state.hours ? `<span class="cn-hrs">${I('clock', 13)} ${hoursText(c.state.hours)}</span>` : ''}${c.open && c.busy ? `<span class="cn-hrs">${c.busy} order${c.busy === 1 ? '' : 's'} in the kitchen${c.wait_min ? ` · usually ready in about ${c.wait_min} min` : ''}</span>` : ''}</span></div>
    <div id="cnlive"></div>
    ${c.popular?.length && c.open ? `<div class="cn-picks"><b>Popular this week</b><div>${c.popular.map(k => items.get(k)).filter(Boolean).map(it => `<button type="button" class="cn-pick" ${it.sold_out ? 'disabled' : `data-inc="${it.id}"`}><b>${esc(it.name)}</b><span>${it.sold_out ? 'Sold out' : rupees(it.price_paise) + ' · Add'}</span></button>`).join('')}</div></div>` : ''}
    <div class="cn-search">${I('search', 18)}<input id="cnq" type="search" placeholder="Search the menu" aria-label="Search the menu" autocomplete="off"></div>
    <div class="cn-filters" role="group" aria-label="Filters"><button type="button" class="tab" data-f="veg">🟢 Veg only</button><button type="button" class="tab" data-f="cheap">Under ₹50</button><button type="button" class="tab" data-f="avail">Available now</button><button type="button" class="tab" data-f="sort">Price: low to high</button></div>
    ${mine ? `<a class="svc" href="#/d/${slug}/canteen/mine"><span class="chip c2">${I('ticket', 22)}</span><span class="t"><b>My orders</b><span class="muted small">Tokens and live status</span></span><span class="chev">${I('chev')}</span></a>` : ''}
    ${groups.length > 1 ? `<div class="tabs cn-cats">${groups.map(g => `<a class="tab" href="#" data-go="${g.id}">${esc(g.name)}</a>`).join('')}</div>` : ''}
    <p class="muted" id="cnnone" hidden>Nothing on the menu matches. Try clearing a filter.</p>
    ${groups.map(g => `<section class="cn-cat" id="cat-${g.id}"><h2>${esc(g.name)} <span class="muted small">${g.items.length} item${g.items.length === 1 ? '' : 's'}</span></h2><div class="card cn-list">${g.items.map(row).join('')}</div></section>`).join('') || '<div class="card empty"><span class="et">The menu is being prepared</span><span>Please check back soon.</span></div>'}
    </div><div class="cn-bar" id="cnbar" hidden></div>`;
  app.querySelectorAll('[data-go]').forEach(a => a.onclick = e => { e.preventDefault(); document.getElementById('cat-' + a.dataset.go)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
  app.onclick = e => { const inc = e.target.closest('[data-inc]'), dec = e.target.closest('[data-dec]'); if (!inc && !dec) return;
    const k = (inc || dec).dataset.inc || (inc || dec).dataset.dec; cart[k] = Math.max(0, Math.min(20, (cart[k] || 0) + (inc ? 1 : -1))); if (!cart[k]) delete cart[k]; save();
    const st_ = document.getElementById('st-' + k); if (st_) st_.innerHTML = stepper(items.get(k)); bar(); if (inc && cart[k] === 1) H.toast(`${items.get(k).name} added`, 1500); };
  bar();
  // search (name and description) + filters (veg, under ₹50, available) + sort by price, all together; the choices are remembered
  const F = new Set(ls.get('canteen-filters', [])), qi = document.getElementById('cnq');
  const apply = () => { const v = qi.value.trim().toLowerCase();
    app.querySelectorAll('[data-f]').forEach(b => b.classList.toggle('on', F.has(b.dataset.f)));
    app.querySelectorAll('.cn-cat').forEach(sec => { let any = false; const list = sec.querySelector('.cn-list');
      [...list.children].sort((a, b) => F.has('sort') ? a.dataset.price - b.dataset.price : a.dataset.i - b.dataset.i || a.dataset.name.localeCompare(b.dataset.name)).forEach(r => list.append(r));
      list.querySelectorAll('.cn-item').forEach(r => { const hit = (!v || r.dataset.name.includes(v)) && (!F.has('veg') || r.dataset.veg === '1') && (!F.has('cheap') || +r.dataset.price < 5000) && (!F.has('avail') || !r.classList.contains('off')); r.hidden = !hit; any ||= hit; });
      sec.hidden = !any; });
    const nm = document.getElementById('cnnone'); if (nm) nm.hidden = !!app.querySelector('.cn-cat:not([hidden])'); };
  qi.oninput = apply; app.querySelectorAll('[data-f]').forEach(b => b.onclick = () => { F.has(b.dataset.f) ? F.delete(b.dataset.f) : F.add(b.dataset.f); ls.set('canteen-filters', [...F]); apply(); }); apply();
  // a live order on this phone sits on top; the last collected one can be ordered again in one tap
  const dev0 = localStorage.getItem(devKey);
  if (dev0) H.api(`/public/${slug}/canteen/mine`, { method: 'POST', body: { device: dev0 } }).then(rows => { const el = document.getElementById('cnlive'); if (!el) return;
    const live = rows.filter(o => ['placed', 'accepted', 'ready'].includes(o.status)), last = rows.find(o => o.status === 'collected');
    el.innerHTML = live.map(o => `<a class="cn-livecard s-${o.status}" href="#/d/${slug}/canteen/o/${o.id}?k=${o.key}"><span class="cn-tk s-${o.status}">${o.token}</span><span><b>${esc(o.status_text)}</b><span class="muted small">${o.status === 'ready' ? 'Show the token at the counter' : 'Tap to follow it live'}</span></span>${I('chev', 18)}</a>`).join('')
      + (last && c.open ? `<button type="button" class="cn-again" id="cnagain">${I('history', 18)}<span><b>Order again</b><span class="muted small">${last.items.map(i => `${i.qty}× ${esc(i.name)}`).join(', ')}</span></span></button>` : '');
    const ag = document.getElementById('cnagain'); if (ag) ag.onclick = () => { let n = 0; for (const i of last.items) { const it = items.get(i.id); if (it && !it.sold_out) { cart[i.id] = Math.min(20, (cart[i.id] || 0) + i.qty); n++; } }
      save(); if (!n) return H.toast('Those items are not available right now'); location.hash = `#/d/${slug}/canteen/cart`; };
  }).catch(() => {});

  function cartPage() {
    app.onclick = null;
    if (!count() || !c.open) { if (!c.open) H.toast(`${c.name} is closed right now`); location.replace(`#/d/${slug}/canteen`); return; }
    const who = ls.get('canteen-who', {}), dev = localStorage.getItem(devKey);
    app.innerHTML = `<div class="wrap">${back(`#/d/${slug}/canteen`, 'Your order')}
      <div class="card cn-list">${Object.entries(cart).map(([k, n]) => { const it = items.get(k); return `<div class="cn-item"><div class="cn-in">${vegDot(it.is_veg)}<div><b>${esc(it.name)}</b><div class="muted small">${n} × ${rupees(it.price_paise)}</div></div></div><b>${rupees(n * it.price_paise)}</b></div>`; }).join('')}
        <div class="cn-item cn-tot"><b>Total · pay at the counter</b><b>${rupees(total())}</b></div></div>
      <form id="cnf" class="card"><label>Your name</label><input name="name" required maxlength="80" value="${esc(who.name || '')}" autocomplete="name">
        <label>Phone <span class="muted small">(optional)</span></label><input name="phone" type="tel" maxlength="20" value="${esc(who.phone || '')}" autocomplete="tel">
        <label>Note for the canteen <span class="muted small">(optional)</span></label><input name="note" maxlength="200" placeholder="e.g. less spicy">
        <div id="vbox"></div><div class="err" id="cnerr"></div>
        <button class="btn primary big" id="cnplace">${I('check', 18)} Place order</button></form></div>`;
    const f = document.getElementById('cnf'), err = document.getElementById('cnerr'), vbox = document.getElementById('vbox');
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
        ls.set('canteen-who', { ...ls.get('canteen-who', {}), name: f.name.value.trim(), phone: f.phone.value.trim() });
        const o = await H.api(`/public/${slug}/canteen/orders`, { method: 'POST', body: { device: localStorage.getItem(devKey), name: f.name.value, phone: f.phone.value, note: f.note.value, items: Object.entries(cart).map(([id, qty]) => ({ id, qty })) } });
        cart = {}; save(); ls.set('canteen-mine:' + slug, [{ id: o.id, key: o.key }, ...ls.get('canteen-mine:' + slug, [])].slice(0, 20));
        location.hash = `#/d/${slug}/canteen/o/${o.id}?k=${o.key}&new=1`;
      } catch (e2) { err.textContent = e2.message; if (e2.code === 'VERIFY') { localStorage.removeItem(devKey); verified = false; verifyUI(); } btn.disabled = false; } };
  }
}

async function orderPage(slug, id, key) {
  const { app, I, esc } = H, hash = location.hash.split('?')[0]; let prev = null;
  const draw = async () => {
    let o; try { o = await H.api(`/public/${slug}/canteen/orders/${id}?k=${encodeURIComponent(key || '')}`); } catch (e) { app.innerHTML = `<div class="wrap"><h1>Order not found</h1><p class="muted">${esc(e.message)}</p><a href="#/d/${slug}/canteen">Back to the menu</a></div>`; return clearInterval(timer); }
    const at = STEPS.findIndex(s => s[0] === o.status), end = ['rejected', 'cancelled'].includes(o.status);
    app.innerHTML = `<div class="wrap"><div class="head"><a class="iconbtn" href="#/d/${slug}/canteen" aria-label="Back">${I('back')}</a><h1>Your order</h1></div><p class="muted small">${esc(o.canteen)}</p>
      <div class="card cn-token s-${o.status}"><span class="muted small">Token</span><b>${o.token}</b><span class="cn-stat">${esc(o.status_text)}</span>
        ${o.status === 'ready' ? '<p>Show this token at the counter and pay there.</p>' : o.status === 'placed' ? '<p>Waiting for the canteen to accept your order.</p>' : o.status === 'accepted' ? '<p>Your food is being prepared. This page refreshes by itself.</p>' : ''}
        ${['placed', 'accepted'].includes(o.status) ? `<p class="cn-eta">${o.ahead ? `${o.ahead} order${o.ahead === 1 ? '' : 's'} ahead of you` : 'You are next'}${o.wait_min ? ` · usually about ${o.wait_min} min` : ''}</p>` : ''}
        ${o.status === 'rejected' ? `<p class="err">Reason: ${esc(o.reject_reason)}</p>` : ''}</div>
      ${end ? '' : `<ol class="cn-steps">${STEPS.map(([k, l], i) => `<li class="${i < at ? 'done' : i === at ? 'now' : ''}"><i></i>${l}</li>`).join('')}</ol>`}
      <div class="card cn-list">${o.items.map(it => `<div class="cn-item"><span>${it.qty} × ${esc(it.name)}</span><b>${rupees(it.qty * it.price_paise)}</b></div>`).join('')}
        <div class="cn-item cn-tot"><b>Total · pay at the counter</b><b>${o.total}</b></div>${o.note ? `<div class="muted small" style="padding-top:8px">Note: ${esc(o.note)}</div>` : ''}</div>
      ${o.status === 'placed' ? '<p><button class="btn danger" id="cncancel">Cancel order</button></p>' : ''}
      <p><a class="btn" href="#/d/${slug}/canteen">${I('utensils', 18)} Back to the menu</a></p></div>`;
    const cb = document.getElementById('cncancel');
    if (cb) cb.onclick = async () => { if (!confirm('Cancel this order?')) return; try { await H.api(`/public/${slug}/canteen/orders/${id}/cancel`, { method: 'POST', body: { k: key } }); H.toast('Order cancelled'); draw(); } catch (e) { H.toast(e.message); draw(); } };
    if (o.status === 'ready' && prev && prev !== 'ready') { chime(); H.toast(`Your order ${o.token} is ready!`, 6000); }
    document.title = o.status === 'ready' ? `✅ ${o.token} ready · ${o.canteen}` : `${o.token} · ${o.canteen}`; prev = o.status;
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
export async function canteenPage(main, { sa }) {
  const { I, esc, api, toast, dlg } = H, acc = await api('/canteen/access');
  const st = ls.get('canteen-tab', 'orders'), hash = '#/c/canteen';
  const tabs = [acc.manage && ['orders', 'Orders'], acc.manage && ['menu', 'Menu'], acc.manage && ['report', 'Reports'], acc.setup && ['setup', 'Set up']].filter(Boolean);
  let tab = tabs.some(t => t[0] === st) ? st : tabs[0]?.[0];
  if (!tab) { main.innerHTML = '<div class="card empty"><span class="et">Canteen is not set up for you</span><span>The super admin switches the canteen on and picks the canteen managers.</span></div>'; return; }
  const head = () => `<div class="tabs">${tabs.map(([k, l]) => `<button class="tab ${tab === k ? 'on' : ''}" data-t="${k}">${l}</button>`).join('')}</div>`;
  const wire = () => main.querySelectorAll('[data-t]').forEach(b => b.onclick = () => { tab = b.dataset.t; ls.set('canteen-tab', tab); clearInterval(timer); draw(); });
  const draw = async () => { try { await ({ orders, menu, report, setup })[tab](); } catch (e) { main.innerHTML = head() + `<p class="err">${esc(e.message)}</p>`; wire(); } };
  await draw();

  async function orders() {
    const d = await api('/canteen/orders'), by = s => d.orders.filter(o => s.includes(o.status));
    const card = o => `<div class="card cn-oc s-${o.status}" data-tk="${o.token_no}"><div class="cn-oh"><span class="cn-tk s-${o.status}">${o.token}</span><div><b>${esc(o.name)}</b>${o.earlier ? ` <span class="cn-so">from ${esc(o.day)}</span>` : ''}<div class="muted small">${new Date(o.created_at).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' })}${o.phone ? ' · ' + esc(o.phone) : ''}</div></div><b class="cn-amt">${o.total}</b></div>
      <ul class="cn-lines">${o.items.map(i => `<li><b>${i.qty}×</b> ${esc(i.name)}</li>`).join('')}</ul>${o.note ? `<div class="cn-note">${I('pencil', 13)} ${esc(o.note)}</div>` : ''}
      ${o.status === 'rejected' ? `<div class="muted small">Rejected: ${esc(o.reject_reason)}</div>` : ''}
      <div class="fact">${o.status === 'placed' ? `<button class="btn primary" data-a="accepted" data-id="${o.id}">${I('check', 16)} Accept</button><button class="btn danger" data-a="rejected" data-id="${o.id}">Reject</button>`
        : o.status === 'accepted' ? `<button class="btn primary" data-a="ready" data-id="${o.id}">${I('bell', 16)} Mark ready</button><button class="btn danger" data-a="rejected" data-id="${o.id}">Reject</button>`
        : o.status === 'ready' ? `<button class="btn primary" data-a="collected" data-id="${o.id}">${I('ccheck', 16)} Collected &amp; paid</button><button class="btn danger" data-a="rejected" data-id="${o.id}">Not collected</button>` : ''}</div></div>`;
    const col = (t, list, empty) => `<section class="cn-col"><h3>${t} <span class="cnt">${list.length}</span></h3>${list.map(card).join('') || `<p class="muted small">${empty}</p>`}</section>`;
    const done = by(['collected', 'rejected', 'cancelled']), pend = by(['placed', 'accepted', 'ready']).length;
    main.innerHTML = `${head()}<div class="card cn-openbar ${d.open ? 'on' : ''}"><div>${I(d.open ? 'ccheck' : 'clock', 18)} <b>${esc(d.name)}: ${d.open ? 'open for orders today' : 'closed'}</b><div class="muted small">${d.open && d.state && !d.state.accepting ? 'Opened, but outside the canteen timings: students can order once the timings allow. ' : ''}${d.state?.hours ? hoursText(d.state.hours) + ' · ' : ''}${d.open ? 'Students can order now. Use the Menu tab to mark items sold out.' : 'Open the canteen to start taking orders. Sold-out marks reset each new day.'}</div></div>
      <input id="cnfind" class="cn-find" inputmode="numeric" placeholder="Find token, e.g. 47" aria-label="Find token"><button class="btn ${d.open ? '' : 'primary'}" id="cnopen">${d.open ? 'Close for today' : 'Open canteen for the day'}</button></div>
      <div class="cn-board">${col('New', by(['placed']).reverse(), 'No new orders')}${col('Preparing', by(['accepted']).reverse(), 'Nothing being prepared')}${col('Ready', by(['ready']).reverse(), 'Nothing waiting at the counter')}</div>
      <details class="card"><summary><b>Done today</b> · ${done.length} (${by(['collected']).length} collected)</summary>${done.map(o => `<div class="cn-item"><span><span class="cn-tk sm s-${o.status}">${o.token}</span> ${esc(o.name)} · ${o.items.map(i => `${i.qty}× ${esc(i.name)}`).join(', ')}</span><span class="muted small">${o.status === 'rejected' ? 'Rejected' : o.status === 'cancelled' ? 'Cancelled by student' : o.total}</span></div>`).join('') || '<p class="muted small">Nothing yet.</p>'}</details>`;
    wire();
    document.getElementById('cnopen').onclick = async () => { if (d.open && !confirm(`Close the canteen? Students can no longer place orders.${pend ? ` ${pend} order${pend === 1 ? ' is' : 's are'} still in progress: you can still finish ${pend === 1 ? 'it' : 'them'}.` : ''}`)) return; await api(d.open ? '/canteen/close' : '/canteen/open', { method: 'POST' }); toast(d.open ? 'Canteen closed' : 'Canteen open for today'); draw(); };
    const fi = document.getElementById('cnfind'); fi.value = S_find; fi.oninput = () => { S_find = fi.value.replace(/\D/g, ''); filt(); }; const filt = () => main.querySelectorAll('.cn-oc').forEach(c => { c.hidden = !!S_find && +c.dataset.tk !== +S_find; }); filt();
    main.querySelectorAll('[data-a]').forEach(b => b.onclick = async () => {
      const go = async body => { await api(`/canteen/orders/${b.dataset.id}/${b.dataset.a}`, { method: 'POST', body }); draw(); };
      if (b.dataset.a !== 'rejected') { b.disabled = true; try { await go({}); } catch (e) { toast(e.message); draw(); } return; }
      const reasons = ['Item sold out', 'Canteen closing', 'Too many orders right now', 'Kitchen problem'];
      const dd = dlg(`<h3>Reject order</h3><p class="muted small">The student sees this reason and gets an email.</p><div class="cn-chips">${reasons.map(r => `<button type="button" class="tab" data-r="${esc(r)}">${esc(r)}</button>`).join('')}</div>
        <label>Reason</label><textarea name="reason" required minlength="3" maxlength="200"></textarea>`, async f => { await go({ reason: f.reason.value }); toast('Order rejected'); });
      dd.querySelectorAll('[data-r]').forEach(x => x.onclick = () => { dd.querySelector('[name=reason]').value = x.dataset.r; });
    });
    every(10000, () => !document.querySelector('dialog') && document.activeElement?.id !== 'cnfind' && draw(), hash);
  }

  async function menu() {
    const m = await api('/canteen/menu'), cats = m.categories;
    const itemRow = it => `<div class="cn-item ${it.active ? '' : 'gone'}"><div class="cn-in">${vegDot(it.is_veg)}<div><b>${esc(it.name)}</b> ${it.active ? `<label class="cn-qp">₹<input inputmode="decimal" data-price="${it.id}" value="${it.price_paise / 100}" aria-label="Price of ${esc(it.name)} in rupees"></label>` : `<span class="cn-price">${rupees(it.price_paise)}</span>`}${it.description ? `<div class="muted small">${esc(it.description)}</div>` : ''}</div></div>
      <div class="cn-acts">${it.active ? `<label class="chk cn-sw"><input type="checkbox" data-so="${it.id}" ${it.sold_out ? 'checked' : ''}> Sold out</label>
        <button class="iconbtn" data-edit="${it.id}" aria-label="Edit ${esc(it.name)}">${I('pencil', 16)}</button><button class="iconbtn" data-del="${it.id}" aria-label="Remove ${esc(it.name)}">${I('x', 16)}</button>`
        : `<button class="btn soft" data-back="${it.id}">Put back</button>`}</div></div>`;
    const all_ = [...cats.flatMap(c => c.items), ...m.uncategorised], groups = [...cats, ...(m.uncategorised.length ? [{ id: '', name: 'No category', items: m.uncategorised }] : [])];
    main.innerHTML = `${head()}<div class="card cn-openbar ${m.open ? 'on' : ''}"><div><b>Student link</b><div class="muted small">Share or print as a QR code. No login needed to see the menu.</div><code class="cn-link">${esc(location.origin + location.pathname + '#/d/' + m.slug + '/canteen')}</code></div>
      <button class="btn soft" id="cncopy">${I('copy', 16)} Copy</button></div>
      ${acc.rename ? `<details class="cn-set" ${m.hours ? '' : 'open'}><summary>${I('settings', 16)} Canteen name &amp; timings <span class="muted small">${esc(m.name)}${m.hours ? ' · ' + hoursText(m.hours) : ' · no timings yet'}</span></summary>` : ''}${acc.rename ? `<form class="card cn-openbar" id="cnname"><div><b>Canteen name</b><div class="muted small">Students see it on the menu, the order page and emails.</div><input name="name" maxlength="60" value="${esc(m.name)}" required></div><button class="btn soft">Save name</button></form>` : ''}
      ${acc.rename ? `<form class="card" id="cnhrs"><b>Canteen timings</b><div class="muted small">Students see these and can only order inside them. You still open the canteen each day.${m.hours ? '' : ' No timings yet: orders are taken whenever the canteen is open.'}</div>
        <div class="cn-hgrid"><label>Opens<input type="time" name="open" value="${m.hours?.open || '08:00'}" required></label><label>Closes<input type="time" name="close" value="${m.hours?.close || '20:00'}" required></label>
        <label>Last orders (min before closing)<input type="number" name="last" min="0" max="120" value="${m.hours?.last_order_min ?? 15}"></label></div>
        <div class="cn-days">${DAYS.map((d, i) => `<label class="chk"><input type="checkbox" name="d" value="${i}" ${(m.hours?.days || [1, 2, 3, 4, 5, 6]).includes(i) ? 'checked' : ''}> ${d}</label>`).join('')}</div>
        <p class="row"><button class="btn soft">Save timings</button>${m.hours ? '<button type="button" class="btn" id="cnhclr">No time limit</button>' : ''}</p></form></details>` : ''}
      <p class="row"><button class="btn primary" id="additem">${I('plus', 16)} Add item</button><button class="btn soft" id="addcat">${I('plus', 16)} Add category</button></p>
      ${groups.map(g => `<section class="cn-cat"><div class="cn-ch"><h2>${esc(g.name)}</h2>${g.id ? `<span><button class="iconbtn" data-up="${g.id}" aria-label="Move ${esc(g.name)} up" ${cats[0]?.id === g.id ? 'disabled' : ''}>▲</button><button class="iconbtn" data-ren="${g.id}" aria-label="Rename">${I('pencil', 15)}</button><button class="iconbtn" data-cdel="${g.id}" aria-label="Remove category">${I('x', 15)}</button></span>` : ''}</div>
        <div class="card cn-list">${g.items.map(itemRow).join('') || '<p class="muted small">No items yet.</p>'}</div></section>`).join('') || '<div class="card empty"><span class="et">Start your menu</span><span>Add a category (Snacks, Meals, Drinks…) and then its items with prices.</span></div>'}`;
    wire();
    const hf = document.getElementById('cnhrs'); if (hf) { hf.onsubmit = async e => { e.preventDefault(); try { await api('/canteen/hours', { method: 'PUT', body: { open: hf.open.value, close: hf.close.value, last_order_min: +hf.last.value, days: [...hf.querySelectorAll('[name=d]:checked')].map(x => +x.value) } }); toast('Timings saved'); draw(); } catch (er) { toast(er.message); } };
      const hc = document.getElementById('cnhclr'); if (hc) hc.onclick = async () => { await api('/canteen/hours', { method: 'PUT', body: { clear: true } }); toast('Time limit removed'); draw(); }; }
    const nf = document.getElementById('cnname'); if (nf) nf.onsubmit = async e => { e.preventDefault(); try { await api('/canteen/name', { method: 'PUT', body: { name: nf.name.value } }); toast('Name saved'); } catch (er) { toast(er.message); } };
    document.getElementById('cncopy').onclick = () => { navigator.clipboard?.writeText(main.querySelector('.cn-link').textContent).then(() => toast('Link copied'), () => toast('Copy the link from the box')); };
    const catForm = (n = '') => `<h3>${n ? 'Rename category' : 'New category'}</h3><label>Name</label><input name="name" required maxlength="60" value="${esc(n)}" placeholder="e.g. Snacks">`;
    document.getElementById('addcat').onclick = () => dlg(catForm(), async f => { await api('/canteen/categories', { method: 'POST', body: { name: f.name.value } }); draw(); });
    const itemForm = (it = {}) => `<h3>${it.id ? 'Edit item' : 'New item'}</h3><label>Name</label><input name="name" required maxlength="80" value="${esc(it.name || '')}" placeholder="e.g. Masala dosa">
      <label>Price (₹)</label><input name="price" required inputmode="decimal" value="${it.price_paise != null ? it.price_paise / 100 : ''}" placeholder="e.g. 40">
      <label>Category</label><select name="category_id"><option value="">No category</option>${cats.map(c => `<option value="${c.id}" ${c.id === it.category_id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
      <label>Description <span class="muted small">(optional)</span></label><input name="description" maxlength="200" value="${esc(it.description || '')}">
      <label class="chk"><input type="checkbox" name="is_veg" ${it.is_veg === 0 ? '' : 'checked'}> Vegetarian</label>`;
    const body = f => ({ name: f.name.value, price: f.price.value, category_id: f.category_id.value, description: f.description.value, is_veg: f.is_veg.checked });
    document.getElementById('additem').onclick = () => dlg(itemForm({ category_id: cats[0]?.id }), async f => { await api('/canteen/items', { method: 'POST', body: body(f) }); toast('Item added'); draw(); });
    main.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => { const it = all_.find(x => x.id === b.dataset.edit); dlg(itemForm(it), async f => { await api('/canteen/items/' + it.id, { method: 'PATCH', body: body(f) }); draw(); }); });
    main.querySelectorAll('[data-so]').forEach(b => b.onchange = async () => { try { await api('/canteen/items/' + b.dataset.so, { method: 'PATCH', body: { sold_out: b.checked } }); toast(b.checked ? 'Marked sold out' : 'Back in stock'); } catch (e) { toast(e.message); b.checked = !b.checked; } });
    main.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => { if (!confirm('Remove this item from the menu?')) return; await api('/canteen/items/' + b.dataset.del, { method: 'DELETE' }); draw(); });
    main.querySelectorAll('[data-back]').forEach(b => b.onclick = async () => { await api('/canteen/items/' + b.dataset.back, { method: 'PATCH', body: { active: true } }); draw(); });
    main.querySelectorAll('[data-price]').forEach(inp => { const was = inp.value; inp.onchange = async () => { try { await api('/canteen/items/' + inp.dataset.price, { method: 'PATCH', body: { price: inp.value } }); toast('Price saved'); } catch (e) { toast(e.message); inp.value = was; } }; inp.onkeydown = e => { if (e.key === 'Enter') inp.blur(); }; });
    main.querySelectorAll('[data-up]').forEach(b => b.onclick = async () => { const i = cats.findIndex(c => c.id === b.dataset.up); if (i < 1) return; const order = cats.map(c => c.id); [order[i - 1], order[i]] = [order[i], order[i - 1]];
      for (const [k, id] of order.entries()) await api('/canteen/categories/' + id, { method: 'PATCH', body: { sort_order: k } }); draw(); });
    main.querySelectorAll('[data-ren]').forEach(b => b.onclick = () => dlg(catForm(cats.find(c => c.id === b.dataset.ren).name), async f => { await api('/canteen/categories/' + b.dataset.ren, { method: 'PATCH', body: { name: f.name.value } }); draw(); }));
    main.querySelectorAll('[data-cdel]').forEach(b => b.onclick = async () => { if (!confirm('Remove this category?')) return; try { await api('/canteen/categories/' + b.dataset.cdel, { method: 'DELETE' }); draw(); } catch (e) { toast(e.message); } });
  }

  async function report() {
    const rr = ls.get('canteen-range', 'week'), today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
    const back = n => { const d = new Date(today + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
    const from = rr === 'day' ? today : rr === 'month' ? back(29) : back(6), r = await api(`/canteen/report?from=${from}&to=${today}`);
    const max = Math.max(1, ...r.days.map(x => x.paise));
    main.innerHTML = `${head()}<div class="tabs">${[['day', 'Today'], ['week', '7 days'], ['month', '30 days']].map(([k, l]) => `<button class="tab ${rr === k ? 'on' : ''}" data-rr="${k}">${l}</button>`).join('')}</div>
      <div class="cn-kpis">${[['Collected orders', r.collected], ['Sales', rupees(r.revenue_paise)], ['Avg. prep time', r.avg_prep_min == null ? '—' : r.avg_prep_min + ' min'], ['Rejected', r.rejected], ['Cancelled', r.cancelled]].map(([l, v]) => `<div class="card"><span class="muted small">${l}</span><b>${v}</b></div>`).join('')}</div>
      <div class="card"><b>Sales by day</b><div class="cn-bars">${r.days.map(x => `<div title="${x.day}: ${x.orders} orders, ${rupees(x.paise)}"><i style="height:${Math.round(x.paise / max * 100)}%"></i><span>${x.day.slice(8)}</span></div>`).join('')}</div></div>
      <div class="cn-two"><div class="card"><b>Top items</b>${r.top.map(t => `<div class="cn-item"><span>${esc(t.name)}</span><span><b>${t.qty}</b> <span class="muted small">· ${rupees(t.paise)}</span></span></div>`).join('') || '<p class="muted small">No collected orders yet.</p>'}</div>
        <div class="card"><b>Why orders were rejected</b>${r.reasons.map(t => `<div class="cn-item"><span>${esc(t.reason)}</span><b>${t.count}</b></div>`).join('') || '<p class="muted small">None.</p>'}</div></div>`;
    wire(); main.querySelectorAll('[data-rr]').forEach(b => b.onclick = () => { ls.set('canteen-range', b.dataset.rr); draw(); });
  }

  async function setup() {
    const s = await api('/canteen/setup');
    main.innerHTML = `${head()}<form id="cnset" class="card" style="max-width:640px"><b>Canteen for this campus</b>
      <label>Canteen name</label><input name="name" maxlength="60" value="${esc(s.name)}" placeholder="${esc(s.default_name)}">
      <label class="chk" style="margin:12px 0"><input type="checkbox" name="on" ${s.on ? 'checked' : ''}> Canteen ordering is on</label>
      <b>Canteen managers</b><div class="muted small">Pick 1 or 2 desk providers. They build the menu, open the canteen and handle orders; campus admins can help too.</div>
      <div class="cn-mgrs">${s.providers.map(p => `<label class="chk"><input type="checkbox" name="m" value="${p.id}" ${s.managers.includes(p.id) ? 'checked' : ''}> ${esc(p.name)} <span class="muted small">${esc(p.email)}</span></label>`).join('') || '<p class="muted small">No active service providers on this campus yet. Add them under People.</p>'}</div>
      <div class="err" id="cnserr"></div><p><button class="btn primary">Save</button></p>
      ${s.on ? `<p class="muted small">Student link: <code>${esc(location.origin + location.pathname + '#/d/' + s.slug + '/canteen')}</code></p>` : ''}</form>`;
    wire();
    const f = document.getElementById('cnset'), boxes = [...f.querySelectorAll('[name=m]')];
    boxes.forEach(b => b.onchange = () => { if (boxes.filter(x => x.checked).length > s.max) { b.checked = false; toast(`At most ${s.max} canteen managers`); } });
    f.onsubmit = async e => { e.preventDefault(); try { await api('/canteen/setup', { method: 'PUT', body: { name: f.name.value, on: f.on.checked, managers: boxes.filter(x => x.checked).map(x => x.value) } }); toast('Canteen settings saved'); location.reload(); }
      catch (er) { document.getElementById('cnserr').textContent = er.message; } };
  }
}
