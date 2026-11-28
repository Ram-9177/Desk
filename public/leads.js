// Leads screens (#/c/leads). Tele-callers work their "To call" list: call or WhatsApp the person, log what happened and
// set the next call; look up their leads; see their own numbers. Campus admins also see every tele-caller's leads, move
// leads, import old ones, connect the WhatsApp bot (Set up) and see the campus reports.
// app.js hands in its helpers so this file looks and behaves like the rest of ONE Desk.
let H; // { api, esc, toast, I, dlg, app }
export const initLeads = h => { H = h; };
const TZ = 'Asia/Kolkata';
const ls = { get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } } };
const fmt = iso => iso ? new Date(iso).toLocaleString('en-IN', { timeZone: TZ, dateStyle: 'medium', timeStyle: 'short' }) : '—';
const dayKey = d => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);
const clock = d => d.toLocaleTimeString('en-IN', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
// "today 4:30 pm", "tomorrow 10:00 am", "Mon, 2 Dec, 10:00 am"
const when = iso => { if (!iso) return ''; const d = new Date(iso), k = dayKey(d), t = dayKey(new Date()), tm = dayKey(new Date(Date.now() + 864e5)), y = dayKey(new Date(Date.now() - 864e5));
  return k === t ? `today ${clock(d)}` : k === tm ? `tomorrow ${clock(d)}` : k === y ? `yesterday ${clock(d)}` : d.toLocaleString('en-IN', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }); };
const ago = iso => { const m = Math.round((Date.now() - Date.parse(iso)) / 6e4); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.floor(m / 60)} h ago` : `${Math.floor(m / 1440)} d ago`; };
const mins = m => m == null ? '—' : m < 60 ? `${m} min` : m < 1440 ? `${Math.floor(m / 60)} h ${m % 60 ? (m % 60) + ' min' : ''}`.trim() : `${Math.round(m / 144) / 10} days`;
const WA = (s = 16) => `<svg aria-hidden="true" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21l1.7-5A8.5 8.5 0 1 1 8 19.3z"/><path d="M9 9.5c0 3 2.5 5.5 5.5 5.5l1.2-1.4-2-1-1 .8a4 4 0 0 1-2.1-2.1l.8-1-1-2z"/></svg>`;
const tel = l => `tel:+${l.phone}`, wa = l => `https://wa.me/${l.phone}`;
let timer = null, seenIds = null, pendingCall = null, stateFor = null, filt = { q: '', status: 'open', source: '', caller: '' }, period = 30;
const every = (ms, fn, hash) => { clearInterval(timer); timer = setInterval(() => { if (location.hash.split('?')[0] !== hash) return clearInterval(timer); if (!document.hidden) fn(); }, ms); };
const chime = () => { try { navigator.vibrate?.([150, 80, 150]); const a = new (window.AudioContext || window.webkitAudioContext)(), o = a.createOscillator(), g = a.createGain();
  o.connect(g); g.connect(a.destination); o.frequency.value = 740; g.gain.setValueAtTime(.18, a.currentTime); g.gain.exponentialRampToValueAtTime(.001, a.currentTime + .7); o.start(); o.stop(a.currentTime + .7); } catch { /* no sound */ } };
// back from the phone app after tapping Call: ask how it went
document.addEventListener('visibilitychange', () => { if (!pendingCall) return; if (document.hidden) { pendingCall.away = true; return; }
  if (pendingCall.away && Date.now() - pendingCall.at < 3 * 36e5 && location.hash.startsWith('#/c/leads') && !document.querySelector('dialog[open]')) { const { id, redraw } = pendingCall; pendingCall = null; setTimeout(() => openLead(id, redraw), 300); } });

const stPill = l => `<span class="ld-st s-${l.status}">${H.esc(l.status_text)}</span>`;
const whenLine = l => l.status === 'new' ? (l.late ? `<b>Late:</b> first call was due ${when(l.due_at)}` : `First call by ${when(l.due_at)}`)
  : l.open ? `${l.late ? '<b>Late:</b> ' : ''}${l.status === 'interested' ? 'Follow up' : l.status === 'trying' ? 'Try again' : 'Call back'} ${when(l.next_call_at)}${l.attempts ? ` · ${l.attempts} call${l.attempts === 1 ? '' : 's'} so far` : ''}`
  : `${H.esc(l.status_text)} ${when(l.closed_at)}${l.close_reason ? ` · ${H.esc(l.close_reason)}` : ''}`;
const card = (l, admin) => { const { esc, I } = H;
  return `<article class="card ld-card ${l.late ? 'late' : ''}" data-id="${l.id}">
    <div class="ld-top"><div class="ld-who"><b>${esc(l.name || 'No name yet')}</b> <span class="ld-ref">${l.ref}</span>${l.unread ? '<span class="ld-new">New message</span>' : ''}</div>${stPill(l)}</div>
    <div class="ld-sub">${esc(l.phone_text)}${l.course ? ` · ${esc(l.course)}` : ''}${l.city ? ` · ${esc(l.city)}` : ''} · ${esc(l.source_text)} ${ago(l.created_at)}${admin && l.caller ? ` · ${I('user', 12)} ${esc(l.caller)}` : ''}</div>
    ${l.message ? `<p class="ld-msg">“${esc(l.message.length > 180 ? l.message.slice(0, 180) + '…' : l.message)}”</p>` : ''}
    <div class="ld-when ${l.late ? 'late' : ''}">${I(l.late ? 'alert' : 'clock', 14)} ${whenLine(l)}</div>
    <div class="ld-act"><a class="btn primary" href="${tel(l)}" data-call="${l.id}">${I('phone', 16)} Call</a><a class="btn" href="${wa(l)}" target="_blank" rel="noopener">${WA()} WhatsApp</a><button type="button" class="btn" data-log="${l.id}">${I('pencil', 15)} Log call</button></div></article>`; };
const row = l => { const { esc } = H;
  return `<button type="button" class="ld-row ${l.late ? 'late' : ''}" data-open="${l.id}"><span class="ld-ref">${l.ref}</span><span class="ld-rn"><b>${esc(l.name || 'No name yet')}</b><small>${esc(l.phone_text)}${l.course ? ' · ' + esc(l.course) : ''}</small></span>
    <span class="ld-rc">${l.caller ? esc(l.caller) : '<i>Nobody yet</i>'}</span><span class="ld-rd">${fmt(l.created_at)}</span>${stPill(l)}</button>`; };
const wireCards = (root, redraw) => {
  root.querySelectorAll('.ld-card').forEach(c => c.onclick = e => { if (e.target.closest('a,button')) return; openLead(c.dataset.id, redraw); });
  root.querySelectorAll('[data-log]').forEach(b => b.onclick = () => openLead(b.dataset.log, redraw, true));
  root.querySelectorAll('[data-open]').forEach(b => b.onclick = () => openLead(b.dataset.open, redraw));
  root.querySelectorAll('[data-call]').forEach(a => a.addEventListener('click', () => { pendingCall = { id: a.dataset.call, redraw, at: Date.now() }; }));
};

// ---------- next-call quick picks (local time) ----------
const at = (days, h, m = 0) => { const d = new Date(); d.setDate(d.getDate() + days); d.setHours(h, m, 0, 0); return d; };
const nextMon = () => { const d = at(1, 10); while (d.getDay() !== 1) d.setDate(d.getDate() + 1); return d; };
const QUICK = [['In 1 hour', () => new Date(Date.now() + 36e5)], ['In 3 hours', () => new Date(Date.now() + 3 * 36e5)], ['This evening 5 pm', () => at(0, 17)], ['Tomorrow 10 am', () => at(1, 10)],
  ['Tomorrow 4 pm', () => at(1, 16)], ['In 2 days', () => at(2, 10)], ['Next Monday', nextMon]];
const localVal = d => { const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };

// ================= one lead: details, history, log a call =================
export async function openLead(id, redraw, focusLog) {
  const { api, esc, toast, I, dlg } = H;
  let d; try { d = await api('/leads/' + id); } catch (e) { return toast(e.message); }
  const l = d.lead, ex = Object.entries(l.extra || {});
  const EV = { created: e => `Came in${e.outcome ? ' · ' + ({ whatsapp: 'WhatsApp', import: 'imported', manual: 'added by hand' }[e.outcome] || esc(e.outcome)) : ''}`, message: e => ({ import: 'Imported again', manual: 'Added again' })[e.outcome] || 'Wrote again on WhatsApp',
    reopened: () => 'Opened again', assigned: () => 'Tele-caller', call: e => esc(d.outcomes[e.outcome] || 'Call'), note: () => 'Note', edited: () => 'Details changed' };
  const tl = d.events.slice().reverse().map(e => `<li class="ld-ev k-${e.kind} o-${e.outcome || ''}"><div><b>${(EV[e.kind] || (() => esc(e.kind)))(e)}</b><span class="muted small"> · ${fmt(e.created_at)}${e.actor_name ? ' · ' + esc(e.actor_name) : ''}</span></div>
    ${e.body ? `<div class="ld-evb">${esc(e.body)}</div>` : ''}${e.next_call_at ? `<div class="muted small">Next call ${when(e.next_call_at)}</div>` : ''}</li>`).join('');
  const callerCell = d.can.assign ? `<select id="ldmove" aria-label="Tele-caller"><option value="">Nobody yet (pool)</option>${d.callers.map(c => `<option value="${c.id}" ${c.id === l.assigned_to ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>`
    : d.can.take ? `<span>Nobody yet</span> <button type="button" class="btn soft" id="ldtake">Take this lead</button>` : esc(l.caller || 'Nobody yet');
  const dl = dlg(`<div class="ld-dh"><div><h3>${esc(l.name || 'No name yet')} <span class="ld-ref">${l.ref}</span></h3><div class="muted small">${esc(l.source_text)} · came in ${fmt(l.created_at)}</div></div>${stPill(l)}</div>
    <div class="ld-dact"><a class="btn primary" href="${tel(l)}" id="ldcall">${I('phone', 16)} Call ${esc(l.phone_text)}</a><a class="btn" href="${wa(l)}" target="_blank" rel="noopener">${WA()} WhatsApp</a></div>
    <div class="ld-when ${l.late ? 'late' : ''}">${I(l.late ? 'alert' : 'clock', 14)} ${whenLine(l)}</div>
    <dl class="ld-facts"><dt>Tele-caller</dt><dd>${callerCell}</dd><dt>Course</dt><dd>${esc(l.course || '—')}</dd><dt>City</dt><dd>${esc(l.city || '—')}</dd><dt>Email</dt><dd>${esc(l.email || '—')}</dd></dl>
    <details class="ld-edit"><summary>Change name, course, city or email</summary><div class="row"><div><label>Name</label><input id="lde_name" value="${esc(l.name)}" maxlength="80"></div><div><label>Course</label><input id="lde_course" value="${esc(l.course)}" maxlength="120"></div></div>
      <div class="row"><div><label>City</label><input id="lde_city" value="${esc(l.city)}" maxlength="120"></div><div><label>Email</label><input id="lde_email" type="email" value="${esc(l.email)}" maxlength="120"></div></div><p><button type="button" class="btn" id="ldesave">Save details</button></p></details>
    ${l.message ? `<div class="ld-first"><small>First message</small>“${esc(l.message)}”</div>` : ''}
    ${ex.length ? `<details class="ld-extra" open><summary>What they told the bot</summary><table>${ex.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</table></details>` : ''}
    ${d.can.log ? `<h4 class="ld-h4" id="ldlog">How did the call go?</h4><div class="ld-oc">${Object.entries(d.outcomes).map(([k, v]) => `<label class="ld-ocb o-${k}"><input type="radio" name="outcome" value="${k}"><span>${esc(v)}</span></label>`).join('')}</div>
      <div id="ldnext" hidden><label for="ldnv">Next call</label><div class="ld-quick">${QUICK.map(([t, f], i) => f() > Date.now() + 6e4 ? `<button type="button" class="chip-btn" data-qk="${i}">${t}</button>` : '').join('')}</div><input type="datetime-local" id="ldnv" name="next">
        <div class="muted small" id="ldnh"></div></div>
      <div id="ldwhy" hidden><label for="ldr">Why not?</label><select id="ldr" name="reason"><option value="">Choose…</option>${d.lost_reasons.map(r => `<option>${esc(r)}</option>`).join('')}</select></div>
      <label for="ldnote">What they said</label><textarea id="ldnote" name="note" rows="3" maxlength="1000" placeholder="e.g. Wants the fee details for BPT; father will decide by Friday"></textarea>
      <p class="ld-noterow"><button type="button" class="btn" id="ldnoteonly">${I('pencil', 15)} Save as a note only</button></p>` : ''}
    <h4 class="ld-h4">History</h4><ul class="ld-tl">${tl}</ul>`,
  async f => { if (!d.can.log) return; const oc = f.outcome?.value; if (!oc) throw new Error('Pick how the call went, or use "Save as a note only"');
    const nv = f.next?.value; await api(`/leads/${l.id}/call`, { method: 'POST', body: { outcome: oc, note: f.note.value, reason: f.reason?.value, next_call_at: nv ? new Date(nv).toISOString() : undefined } });
    toast(['won', 'lost', 'invalid'].includes(oc) ? `Lead ${l.ref} closed: ${d.outcomes[oc]}` : 'Call saved'); redraw && redraw(); });
  dl.classList.add('ld-dlg');
  const okB = dl.querySelector('button[value=ok]'), noB = dl.querySelector('button[value=cancel]'); if (okB) { okB.textContent = 'Save call'; if (!d.can.log) okB.remove(); } if (noB) noB.textContent = 'Close';
  dl.querySelector('#ldcall').addEventListener('click', () => { pendingCall = { id: l.id, redraw, at: Date.now() }; setTimeout(() => dl.close(), 50); });
  const nextBox = dl.querySelector('#ldnext'), why = dl.querySelector('#ldwhy'), nv = dl.querySelector('#ldnv'), nh = dl.querySelector('#ldnh');
  dl.querySelectorAll('[name=outcome]').forEach(r => r.onchange = () => { const v = r.value; nextBox.hidden = !['callback', 'interested', 'no_answer'].includes(v); why.hidden = v !== 'lost';
    if (nv) { nv.required = v === 'callback' || v === 'interested'; if (v === 'interested' && !nv.value) nv.value = localVal(at(1, 10)); }
    if (nh) nh.textContent = v === 'no_answer' ? `Leave it empty to try again in ${mins(d.retry_min)} of working time.` : ''; });
  dl.querySelectorAll('[data-qk]').forEach(b => b.onclick = () => { nv.value = localVal(QUICK[b.dataset.qk][1]()); });
  const after = async (fn, msg) => { try { await fn(); toast(msg); dl.close(); redraw && redraw(); openLead(l.id, redraw); } catch (e) { dl.querySelector('#derr').textContent = e.message; } };
  dl.querySelector('#ldnoteonly')?.addEventListener('click', () => { const n = dl.querySelector('#ldnote').value.trim(); if (!n) { dl.querySelector('#derr').textContent = 'Write the note first'; return; }
    after(() => api(`/leads/${l.id}/note`, { method: 'POST', body: { note: n } }), 'Note saved'); });
  dl.querySelector('#ldesave').onclick = () => after(() => api('/leads/' + l.id, { method: 'PATCH', body: Object.fromEntries(['name', 'course', 'city', 'email'].map(k => [k, dl.querySelector('#lde_' + k).value])) }), 'Details saved');
  dl.querySelector('#ldmove')?.addEventListener('change', e => after(() => api(`/leads/${l.id}/assign`, { method: 'POST', body: { user_id: e.target.value || null } }), e.target.value ? 'Lead moved' : 'Lead is back in the pool'));
  dl.querySelector('#ldtake')?.addEventListener('click', () => after(() => api(`/leads/${l.id}/assign`, { method: 'POST', body: { user_id: 'me' } }), 'The lead is yours'));
  if (focusLog) dl.querySelector('#ldlog')?.scrollIntoView({ block: 'start' });
}

// ================= add a lead by hand =================
function addLead(redraw) {
  const { api, toast, dlg } = H;
  const d = dlg(`<h3>Add a lead</h3><p class="muted small">Someone who phoned or walked in. If the number is already a lead, the note joins that lead.</p>
    <div class="row"><div><label>Phone</label><input name="phone" inputmode="tel" required maxlength="20" placeholder="98765 43210"></div><div><label>Name</label><input name="name" maxlength="80"></div></div>
    <div class="row"><div><label>Course</label><input name="course" maxlength="120"></div><div><label>City</label><input name="city" maxlength="120"></div></div>
    <label>What they asked</label><textarea name="message" rows="3" maxlength="2000"></textarea>`,
  async f => { const r = await api('/leads', { method: 'POST', body: { phone: f.phone.value, name: f.name.value, course: f.course.value, city: f.city.value, message: f.message.value } });
    toast(r.result === 'created' ? `Lead ${r.lead.ref} added` : `That number is already lead ${r.lead.ref}${r.lead.caller ? ` (with ${r.lead.caller})` : ''}: the note was added to it`); redraw && redraw(); });
  d.querySelector('button[value=ok]').textContent = 'Add lead';
}

// ---------- small charts (inline SVG, no library) ----------
const CH = ['#1D4ED8', '#16A34A', '#F59E0B', '#7C3AED', '#DC2626', '#0891B2', '#64748B'];
const hbars = (title, rows, empty) => { const m = Math.max(1, ...rows.map(r => r[1]));
  return `<div class="card ld-chart"><b>${title}</b>${rows.length ? `<div class="ld-hb">${rows.map((r, i) => `<div class="ld-hbr"><span class="l" title="${r[0]}">${r[0]}</span><span class="t"><i style="width:${Math.max(2, Math.round(r[1] / m * 100))}%;background:${CH[i % CH.length]}"></i></span><b>${r[2] ?? r[1]}</b></div>`).join('')}</div>` : `<p class="muted small">${empty}</p>`}</div>`; };
const dayBars = days => { const m = Math.max(1, ...days.map(d => d.received)), w = Math.max(4, Math.floor(600 / Math.max(1, days.length)) - 2);
  return `<div class="card ld-chart"><b>Leads in, by day</b> <span class="muted small"><i class="ld-sw" style="background:${CH[0]}"></i>Came in <i class="ld-sw" style="background:${CH[1]}"></i>Converted</span>
    <svg viewBox="0 0 ${days.length * (w + 2)} 120" preserveAspectRatio="none" class="ld-days" role="img" aria-label="Leads by day">${days.map((d, i) => `<g><title>${d.day}: ${d.received} in, ${d.won} converted</title>
    <rect x="${i * (w + 2)}" y="${110 - Math.round(d.received / m * 100)}" width="${w}" height="${Math.round(d.received / m * 100)}" fill="${CH[0]}" opacity=".85"/><rect x="${i * (w + 2)}" y="${110 - Math.round(d.won / m * 100)}" width="${w}" height="${Math.round(d.won / m * 100)}" fill="${CH[1]}"/></g>`).join('')}
    <line x1="0" y1="110.5" x2="${days.length * (w + 2)}" y2="110.5" stroke="#D0D5DD"/></svg><div class="ld-dx muted small"><span>${days[0]?.day || ''}</span><span>${days[days.length - 1]?.day || ''}</span></div></div>`; };

// ================= the page =================
export async function leadsPage(main, { admin }) {
  clearInterval(timer);
  const tid = localStorage.getItem('tid') || ''; if (stateFor !== tid) { stateFor = tid; seenIds = null; filt = { q: '', status: 'open', source: '', caller: '' }; }
  const { I, esc, api, toast } = H, acc = await api('/leads/access'), hash = '#/c/leads';
  const tabs = [acc.use && ['tocall', 'To call'], acc.use && ['all', 'All leads'], acc.use && ['report', acc.admin ? 'Reports' : 'My numbers'], acc.admin && ['setup', 'Set up']].filter(Boolean);
  let tab = tabs.some(t => t[0] === ls.get('leads-tab')) ? ls.get('leads-tab') : tabs[0]?.[0];
  if (!tab) { main.innerHTML = '<div class="card empty"><span class="et">Leads are not set up for you</span><span>A campus admin switches Leads on and picks the tele-callers.</span></div>'; return; }
  let callers = null; const callerList = async () => callers ??= acc.admin ? (s => s.providers.filter(p => s.callers.includes(p.id)))(await api('/leads/setup')) : [];
  const head = () => `<div class="tabs">${tabs.map(([k, l]) => `<button class="tab ${tab === k ? 'on' : ''}" data-t="${k}">${l}${k === 'tocall' && acc.due ? ` <span class="cnt">${acc.due}</span>` : ''}</button>`).join('')}</div>`;
  const wire = () => main.querySelectorAll('[data-t]').forEach(b => b.onclick = () => { tab = b.dataset.t; ls.set('leads-tab', tab); clearInterval(timer); draw(); });
  const draw = async () => { try { await ({ tocall, all: allLeads, report, setup })[tab](); } catch (e) { main.innerHTML = head() + `<p class="err">${esc(e.message)}</p>`; wire(); } };
  await draw();

  // ---------- To call: late first, then new, then call-backs due; the pool of leads nobody has ----------
  async function tocall(silent) {
    const cl = await callerList(), d = await api('/leads?view=tocall' + (acc.admin && filt.caller ? '&caller=' + encodeURIComponent(filt.caller) : ''));
    const ids = new Set([...d.rows, ...d.pool].map(l => l.id)); if (seenIds && [...ids].some(x => !seenIds.has(x))) { chime(); toast('A new lead came in'); } seenIds = ids;
    if (silent && document.querySelector('dialog[open]')) return; // don't redraw under an open lead
    const c = d.counts, k = (n, l, cls = '') => `<div class="ld-k ${cls}"><b>${n}</b><span>${l}</span></div>`;
    main.innerHTML = `${head()}<div class="ld-bar"><div class="ld-ks">${k(c.late, 'Late', c.late ? 'hot' : '')}${k(c.new, 'New')}${k(c.due, 'Due now')}${k(c.today, 'Later today')}${k(d.later, 'Coming days')}</div>
      <div class="ld-tools">${acc.admin ? `<select id="ldcf" aria-label="Tele-caller"><option value="">All tele-callers</option>${cl.map(p => `<option value="${p.id}" ${filt.caller === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>` : ''}<button type="button" class="btn" id="ldadd">${I('plus', 16)} Add lead</button></div></div>
      ${d.pool.length ? `<div class="card ld-pool"><div class="ld-poolh"><b>${d.pool.length} lead${d.pool.length === 1 ? '' : 's'} nobody has yet</b>${acc.admin ? `<button type="button" class="btn soft" id="ldspread">${I('users', 15)} Share among the tele-callers</button>` : '<span class="muted small">Take one to call it</span>'}</div>
        ${d.pool.slice(0, 20).map(l => `<div class="ld-prow"><button type="button" class="linkbtn" data-open="${l.id}"><b>${esc(l.name || 'No name yet')}</b> <span class="ld-ref">${l.ref}</span> <span class="muted small">${esc(l.phone_text)} · ${ago(l.created_at)}</span></button>${acc.caller ? `<button type="button" class="btn" data-take="${l.id}">Take</button>` : ''}</div>`).join('')}</div>` : ''}
      ${c.total > d.rows.length ? `<p class="muted small ld-cap">Showing the ${d.rows.length} most urgent of ${c.total} leads for today. Call these first; the rest come up as you go.</p>` : ''}
      <div class="ld-list">${d.rows.map(l => card(l, acc.admin)).join('') || `<div class="card empty"><span class="et">Nothing to call right now</span><span>${d.later ? `Next call ${when(d.later_next)}. ` : ''}New WhatsApp leads appear here by themselves.</span></div>`}</div>`;
    wire(); wireCards(main, () => tocall());
    main.querySelector('#ldadd').onclick = () => addLead(() => tocall());
    main.querySelector('#ldcf')?.addEventListener('change', e => { filt.caller = e.target.value; seenIds = null; tocall(); }); // another list, not new leads
    main.querySelector('#ldspread')?.addEventListener('click', async () => { try { const r = await api('/leads/spread', { method: 'POST' }); toast(`${r.given} lead${r.given === 1 ? '' : 's'} shared out`); } catch (e) { toast(e.message); } tocall(); });
    main.querySelectorAll('[data-take]').forEach(b => b.onclick = async () => { try { await api(`/leads/${b.dataset.take}/assign`, { method: 'POST', body: { user_id: 'me' } }); toast('The lead is yours'); } catch (e) { toast(e.message); } tocall(); });
    every(30e3, () => tocall(true), hash);
  }

  // ---------- All leads: search and filters ----------
  async function allLeads() {
    const cl = await callerList(); let rows = [], total = 0;
    main.innerHTML = `${head()}<div class="ld-filters"><label class="search">${I('search', 16)}<input id="ldq" placeholder="Name, phone, course or lead number" value="${esc(filt.q)}" aria-label="Search leads"></label>
      <select id="ldst" aria-label="Status"><option value="">Every lead</option><option value="open">Open</option><option value="late">Late</option>${Object.entries({ new: 'New', trying: 'Not reached yet', callback: 'Call back', interested: 'Interested', won: 'Converted', lost: 'Not interested', invalid: 'Wrong number' }).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}<option value="closed">Closed</option></select>
      <select id="ldso" aria-label="Source"><option value="">From anywhere</option><option value="whatsapp">WhatsApp</option><option value="import">Imported</option><option value="manual">Added by hand</option></select>
      ${acc.admin ? `<select id="ldca" aria-label="Tele-caller"><option value="">Every tele-caller</option><option value="none">Nobody yet</option>${cl.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select>` : ''}
      <button type="button" class="btn" id="ldadd">${I('plus', 16)} Add lead</button></div>
      <div class="muted small" id="ldtot"></div><div class="ld-rows" id="ldrows">Loading…</div><p><button type="button" class="btn" id="ldmore" hidden>Show more</button></p>`;
    wire();
    const st = main.querySelector('#ldst'), so = main.querySelector('#ldso'), ca = main.querySelector('#ldca'); st.value = filt.status; so.value = filt.source; if (ca) ca.value = filt.caller;
    const load = async more => { const qs = new URLSearchParams({ view: 'all', q: filt.q, status: filt.status, source: filt.source, ...(acc.admin && filt.caller ? { caller: filt.caller } : {}), offset: more ? rows.length : 0 });
      const d = await api('/leads?' + qs); rows = more ? rows.concat(d.rows) : d.rows; total = d.total;
      main.querySelector('#ldtot').textContent = `${total} lead${total === 1 ? '' : 's'}`;
      main.querySelector('#ldrows').innerHTML = rows.map(row).join('') || '<div class="card empty"><span class="et">No leads match</span><span>Try another word or filter.</span></div>';
      main.querySelector('#ldmore').hidden = rows.length >= total; wireCards(main.querySelector('#ldrows'), () => load()); };
    let t0; main.querySelector('#ldq').oninput = e => { clearTimeout(t0); t0 = setTimeout(() => { filt.q = e.target.value.trim(); load(); }, 300); };
    st.onchange = () => { filt.status = st.value; load(); }; so.onchange = () => { filt.source = so.value; load(); }; if (ca) ca.onchange = () => { filt.caller = ca.value; load(); };
    main.querySelector('#ldmore').onclick = () => load(true); main.querySelector('#ldadd').onclick = () => addLead(() => load());
    await load();
  }

  // ---------- Reports (admins: the campus; tele-callers: their own) ----------
  async function report() {
    const r = await api(`/leads-report?${new URLSearchParams(typeof period === 'number' ? { from: dayKey(new Date(Date.now() - (period - 1) * 864e5)), to: dayKey(new Date()) } : period)}`);
    const kp = (l, v, s = '', cls = '') => `<div class="kpi2"><span>${l}</span><b class="${cls}">${v}</b>${s ? `<small>${s}</small>` : ''}</div>`, fc = r.first_call, OUT = { no_answer: 'No answer', callback: 'Call back', interested: 'Interested', won: 'Converted', lost: 'Not interested', invalid: 'Wrong number' };
    const STN = { new: 'New', trying: 'Not reached yet', callback: 'Call back', interested: 'Interested', won: 'Converted', lost: 'Not interested', invalid: 'Wrong number' };
    main.innerHTML = `${head()}<div class="ld-per">${[7, 30, 90].map(n => `<button type="button" class="chip-btn ${period === n ? 'on' : ''}" data-p="${n}">Last ${n} days</button>`).join('')}
      <span class="ld-cust"><input type="date" id="ldf" value="${r.from}" aria-label="From"> to <input type="date" id="ldt" value="${r.to}" aria-label="To"></span>
      <button type="button" class="btn" id="ldcsv">${I('download', 16)} Download leads (CSV)</button></div>
      <div class="card kpis2">${kp('Leads in', r.received, Object.entries(r.by_source).map(([k, v]) => `${v} ${({ whatsapp: 'WhatsApp', import: 'imported', manual: 'by hand' })[k] || k}`).join(' · '))}${kp('Converted', r.won, r.conv_pct == null ? '' : `${r.conv_pct}% of the leads in`)}
        ${kp('First call on time', fc.on_time_pct == null ? '—' : fc.on_time_pct + '%', `target ${mins(fc.target_min)} of working time`)}${kp('Usual time to first call', mins(fc.median_min), `${fc.called} of ${fc.of} called`)}
        ${kp('Calls made', r.calls)}${kp('Open now', r.open_now, r.unassigned ? `${r.unassigned} with nobody` : '')}${kp('Late now', r.late_now, '', r.late_now ? 'hot' : '')}${kp('Waiting for a first call', fc.waiting)}</div>
      ${r.days.length > 1 ? dayBars(r.days) : ''}
      <div class="ld-two">${hbars('Where the leads are now', Object.entries(STN).filter(([k]) => r.status[k]).map(([k, v]) => [v, r.status[k]]), 'No leads in this period')}
        ${hbars('How the calls went', Object.entries(OUT).filter(([k]) => r.outcomes[k]).map(([k, v]) => [v, r.outcomes[k]]), 'No calls in this period')}</div>
      ${r.callers.length ? `<div class="card ld-tab"><b>${acc.admin ? 'Tele-callers' : 'My numbers'}</b><div class="tblwrap"><table class="rtable"><thead><tr><th>Name</th><th>Leads in</th><th>Calls</th><th>Reached</th><th>Converted</th><th>Rate</th><th>Open now</th><th>Late now</th></tr></thead>
        <tbody>${r.callers.map(c => `<tr><td>${esc(c.name)}${c.caller ? '' : ' <span class="muted small">(not a tele-caller now)</span>'}</td><td>${c.leads}</td><td>${c.calls}</td><td>${c.reached}</td><td>${c.won}</td><td>${c.conv_pct == null ? '—' : c.conv_pct + '%'}</td><td>${c.open}</td><td class="${c.late ? 'hot' : ''}">${c.late}</td></tr>`).join('')}</tbody></table></div></div>` : ''}
      <div class="ld-two">${hbars('Courses asked about', r.courses.map(c => [esc(c.course), c.leads, `${c.leads}${c.won ? ` · ${c.won} converted` : ''}`]), 'No leads in this period')}
        ${hbars('Why people said no', r.lost_reasons.map(x => [esc(x.reason), x.n]), 'Nobody said no in this period')}</div>`;
    wire();
    main.querySelectorAll('[data-p]').forEach(b => b.onclick = () => { period = +b.dataset.p; report(); });
    const cust = () => { const f = main.querySelector('#ldf').value, t = main.querySelector('#ldt').value; if (f && t) { period = { from: f, to: t }; report(); } };
    main.querySelector('#ldf').onchange = cust; main.querySelector('#ldt').onchange = cust;
    main.querySelector('#ldcsv').onclick = async () => { try { const res = await api(`/leads.csv?from=${r.from}&to=${r.to}`, { raw: true }); if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error?.message || 'Could not download');
      const a = document.createElement('a'); a.href = URL.createObjectURL(await res.blob()); a.download = `leads-${r.from}-to-${r.to}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); } catch (e) { toast(e.message); } };
  }

  // ---------- Set up (campus admins): on/off, tele-callers, timings, the WhatsApp bot, old leads ----------
  async function setup() {
    const s = await api('/leads/setup'), cfg = s.cfg, hdr = 'X-Leads-Key';
    const example = JSON.stringify({ phone: '919876543210', name: 'Ravi Kumar', message: 'Hi, I want to know the fees for BPT', course: 'BPT', city: 'Guntur', email: 'ravi@example.com', id: 'message-id-from-the-bot' }, null, 2);
    const curl = s.key ? `curl -X POST '${s.link}' \\\n  -H 'Content-Type: application/json' \\\n  -H '${hdr}: ${s.key}' \\\n  -d '{"phone":"9876543210","name":"Test lead","message":"Testing the link"}'` : '';
    // the key stays hidden on screen in every box; Copy still copies it in full
    const hideKey = t => s.key ? t.split(s.key).join('•••••• (the leads key)') : t;
    const copy = (id, text, label = 'Copy') => `<div class="codebox"><pre id="${id}" data-full="${esc(text)}">${esc(hideKey(text))}</pre><button type="button" class="btn" data-copy="${id}">${I('copy', 14)} ${label}</button></div>`;
    main.innerHTML = `${head()}${s.on ? '' : '<div class="card ld-off"><b>Leads are off on this campus.</b> Pick the tele-callers, tick "Leads on" and save. Then connect the WhatsApp bot below.</div>'}
      <form class="card" id="ldset"><div class="chead"><span class="tile t-blue">${I('phone', 16)}</span><span>Leads and tele-callers</span></div>
        <label class="chk ld-on"><input type="checkbox" name="on" ${s.on ? 'checked' : ''}><span><b>Leads on</b>: leads from the WhatsApp bot come in and go to the tele-callers</span></label>
        <label style="margin-top:14px">Tele-callers</label><div class="muted small">Desk service providers who call the leads. New leads go to whoever has the fewest open leads. Tele-callers in no ticket team open straight on Leads and are left out of the desk's points and Fair Score.</div>
        <div class="ld-callers">${s.providers.map(p => `<label class="chk"><input type="checkbox" name="caller" value="${p.id}" ${s.callers.includes(p.id) ? 'checked' : ''}> ${esc(p.name)} <span class="muted small">${esc(p.email)}${p.team ? ' · also in a ticket team' : ''}</span></label>`).join('') || '<p class="muted small">No service providers on this campus yet. Add them under People first.</p>'}</div>
        <div class="row"><div><label>First call within (minutes of working time)</label><input name="first" type="number" min="5" max="2880" value="${cfg.first_call_min}"></div><div><label>No answer: try again after (minutes of working time)</label><input name="retry" type="number" min="10" max="2880" value="${cfg.retry_min}"></div>
          <div><label>Country code for 10-digit numbers</label><input name="cc" inputmode="numeric" maxlength="4" value="${esc(cfg.country_code)}"></div></div>
        <div class="muted small">Working time follows the campus working hours (SLA &amp; points). A lead that comes in at night is due the next working morning.</div>
        <p><button class="btn primary">Save</button></p></form>
      ${s.key ? `<div class="card" id="ldbot"><div class="chead"><span class="tile t-green">${WA()}</span><span>Connect your WhatsApp bot</span></div>
        <p class="muted small" style="margin-top:0">In your WhatsApp bot's settings (WATI, Interakt, AiSensy, Gupshup, Twilio or any other), find <b>Webhook</b>, <b>API</b> or <b>Integrations</b> and add a webhook that <b>POSTs each new lead or message</b> to this link, with the key in the <code>${hdr}</code> header. If the bot cannot add a header, put <code>?key=</code> and the key at the end of the link.</p>
        <label>Leads link</label>${copy('ldlink', s.link)}
        <label>Leads key</label><div class="codebox"><pre id="ldkey" class="ld-mask">${esc(s.key)}</pre><button type="button" class="btn" id="ldshow">${I('eye', 14)} Show</button><button type="button" class="btn" data-copy="ldkey">${I('copy', 14)} Copy</button></div>
        <p><button type="button" class="btn danger" id="ldnewkey">Make a new key</button> <span class="muted small">The old key stops working at once: update the bot with the new one.</span></p>
        <details class="ld-how" open><summary>What the bot must send</summary><p class="muted small">JSON (or a form) with at least the person's <b>phone number</b>. Names like <code>phone</code>, <code>mobile</code>, <code>waId</code> or <code>from</code> all work, and so do <code>name</code>, <code>message</code>/<code>text</code>, <code>course</code>, <code>city</code>, <code>email</code>. Send the message's <code>id</code> too, so a message sent twice is saved once. Every other answer the bot collected is kept and shown on the lead. The same phone number is the same person: their next messages join their lead.</p>${copy('ldex', example)}
          <p class="muted small">Try the link from a computer:</p>${copy('ldcurl', curl)}</details>
        <details class="ld-how"><summary>Using Meta's WhatsApp Cloud API directly (no bot company)</summary><ol class="muted small"><li>In Meta for Developers, open your app → WhatsApp → Configuration → Webhook → Edit.</li>
          <li>Callback URL: the leads link with <code>?key=</code> and the key at the end (Copy below).</li><li>Verify token: the leads key. Press "Verify and save".</li><li>Under Webhook fields, subscribe to <b>messages</b>.</li>
          <li>Optional, safer: put the app's <b>App secret</b> (App settings → Basic) below, so ONE Desk checks Meta's signature on every delivery.</li></ol>${copy('ldmeta', s.link + '?key=' + s.key)}
          <form id="ldsec" class="row"><div><label>Meta app secret</label><input name="secret" type="password" autocomplete="off" placeholder="${cfg.has_app_secret ? 'Saved. Type a new one to change it' : 'Not set'}"></div><div style="flex:0"><button class="btn">Save</button></div>${cfg.has_app_secret ? '<div style="flex:0"><button type="button" class="btn danger" id="ldsecx">Remove</button></div>' : ''}</form></details>
        <details class="ld-how"><summary>Check a sample from your bot</summary><p class="muted small">Paste one delivery exactly as your bot sends it (its webhook log or documentation shows it). Nothing is saved.</p>
          <textarea id="ldsample" rows="6" placeholder='{"waId":"919876543210","senderName":"Ravi","text":"Fees for BPT?"}'></textarea><p><button type="button" class="btn" id="ldparse">Check</button></p><div id="ldparsed"></div></details></div>` : ''}
      ${s.on ? `<form class="card" id="ldimp"><div class="chead"><span class="tile t-violet">${I('download', 16)}</span><span>Bring in old leads</span></div>
        <p class="muted small" style="margin-top:0">In the bot's dashboard, export the contacts or chats as a spreadsheet and save it as <b>CSV</b> (Excel: File → Save as → CSV). The first row must be headings; a column named <b>Phone</b> (or Mobile, WhatsApp, Number) is needed, and Name, Course, City, Email, Message and Date are read when they are there. A number that is already a lead joins that lead. Nothing is saved if anything goes wrong.</p>
        <input type="file" id="ldfile" accept=".csv,text/csv,.txt"><div class="muted small" id="ldfinfo"></div>
        <label class="chk" style="margin-top:10px"><input type="radio" name="mode" value="spread" checked> Share them among the tele-callers now</label>
        <label class="chk"><input type="radio" name="mode" value="pool"> Keep them in the pool: tele-callers take them one by one</label>
        <p><button class="btn primary" id="ldimpb" disabled>Import</button></p><div id="ldimpr"></div></form>` : ''}
      ${s.counts.unassigned ? `<div class="card ld-pool"><div class="ld-poolh"><b>${s.counts.unassigned} open lead${s.counts.unassigned === 1 ? '' : 's'} with nobody</b><button type="button" class="btn soft" id="ldspread2">${I('users', 15)} Share among the tele-callers</button></div></div>` : ''}`;
    wire();
    main.querySelectorAll('[data-copy]').forEach(b => b.onclick = async () => { try { const el = main.querySelector('#' + b.dataset.copy); await navigator.clipboard.writeText(el.dataset.full || el.textContent); toast('Copied'); } catch { toast('Select the text and copy it'); } });
    main.querySelector('#ldset').onsubmit = async e => { e.preventDefault(); const f = e.target, b = f.querySelector('button.primary'); b.disabled = true;
      try { const r = await api('/leads/setup', { method: 'PUT', body: { on: f.on.checked, callers: [...f.querySelectorAll('[name=caller]:checked')].map(x => x.value), first_call_min: f.first.value, retry_min: f.retry.value, country_code: f.cc.value } });
        toast(r.moved ? `Saved. ${r.moved} open lead${r.moved === 1 ? '' : 's'} moved to the other tele-callers` : 'Saved'); callers = null; H.reroute ? H.reroute() : setup(); } catch (er) { toast(er.message); b.disabled = false; } };
    main.querySelector('#ldshow')?.addEventListener('click', e => { main.querySelector('#ldkey').classList.toggle('ld-mask'); e.currentTarget.lastChild.textContent = main.querySelector('#ldkey').classList.contains('ld-mask') ? ' Show' : ' Hide'; });
    main.querySelector('#ldnewkey')?.addEventListener('click', async () => { if (!confirm('Make a new leads key? The bot stops sending leads until you put the new key in its settings.')) return; try { await api('/leads/setup/key', { method: 'POST' }); toast('New key made'); } catch (e) { toast(e.message); } setup(); });
    main.querySelector('#ldsec')?.addEventListener('submit', async e => { e.preventDefault(); const v = e.target.secret.value.trim(); if (!v) return toast('Type the app secret first');
      try { await api('/leads/setup', { method: 'PUT', body: { app_secret: v } }); toast('App secret saved'); } catch (er) { toast(er.message); } setup(); });
    main.querySelector('#ldsecx')?.addEventListener('click', async () => { try { await api('/leads/setup', { method: 'PUT', body: { app_secret: '' } }); toast('App secret removed'); } catch (er) { toast(er.message); } setup(); });
    main.querySelector('#ldparse')?.addEventListener('click', async () => { const out = main.querySelector('#ldparsed');
      try { const r = await api('/leads/parse', { method: 'POST', body: { sample: main.querySelector('#ldsample').value } });
        out.innerHTML = r.leads.length ? `<div class="tblwrap"><table class="rtable"><thead><tr><th>Phone</th><th>Name</th><th>Message</th><th>Course</th><th>Other answers</th></tr></thead><tbody>${r.leads.map(x => `<tr><td class="${x.ok ? '' : 'hot'}">${x.ok ? esc(x.phone_text) : 'No phone number found'}</td><td>${esc(x.name || '—')}</td><td>${esc(x.message || '—')}</td><td>${esc(x.course || '—')}</td><td>${Object.entries(x.extra).map(([k, v]) => `${esc(k)}: ${esc(v)}`).join('<br>') || '—'}</td></tr>`).join('')}</tbody></table></div>`
          : '<p class="err">No lead in it. Leads need a phone number; a delivery with only message statuses (sent, read) has none, and that is fine.</p>'; } catch (e) { out.innerHTML = `<p class="err">${esc(e.message)}</p>`; } });
    const sp = async () => { try { const r = await api('/leads/spread', { method: 'POST' }); toast(`${r.given} lead${r.given === 1 ? '' : 's'} shared out`); } catch (e) { toast(e.message); } setup(); };
    main.querySelector('#ldspread2')?.addEventListener('click', sp);
    const imp = main.querySelector('#ldimp'); if (imp) { let csv = '';
      imp.querySelector('#ldfile').onchange = async e => { const f = e.target.files[0]; csv = ''; imp.querySelector('#ldimpb').disabled = true; if (!f) return;
        if (f.size > 8e6) { imp.querySelector('#ldfinfo').textContent = 'The file is too big (8 MB at most). Split it into parts.'; return; }
        if (/\.xlsx?$/i.test(f.name)) { imp.querySelector('#ldfinfo').textContent = 'That is an Excel file. In Excel, use File → Save as → CSV, then choose the CSV here.'; return; }
        csv = await f.text(); const n = csv.split(/\r?\n/).filter(x => x.trim()).length - 1; imp.querySelector('#ldfinfo').textContent = `${f.name}: about ${n} row${n === 1 ? '' : 's'}`; imp.querySelector('#ldimpb').disabled = n < 1; };
      imp.onsubmit = async e => { e.preventDefault(); const b = imp.querySelector('#ldimpb'); b.disabled = true; b.textContent = 'Importing…';
        try { const r = await api('/leads/import', { method: 'POST', body: { csv, mode: imp.querySelector('[name=mode]:checked').value } });
          imp.querySelector('#ldimpr').innerHTML = `<div class="ld-res"><b>${r.created} new lead${r.created === 1 ? '' : 's'}</b> from ${r.rows} row${r.rows === 1 ? '' : 's'}${r.merged ? ` · ${r.merged} joined a lead with the same number` : ''}${r.duplicate ? ` · ${r.duplicate} already imported` : ''}${r.skipped ? ` · ${r.skipped} skipped` : ''}
            ${r.skipped_rows.length ? `<ul class="muted small">${r.skipped_rows.map(x => `<li>Row ${x.row}: ${esc(x.why)}</li>`).join('')}</ul>` : ''}</div>`; toast('Import done'); }
        catch (er) { imp.querySelector('#ldimpr').innerHTML = `<p class="err">${esc(er.message)}</p>`; } finally { b.textContent = 'Import'; b.disabled = !csv; } }; }
  }
}
