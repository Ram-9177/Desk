import { allowedTargets, STATUS_WORDS, PRIORITIES, REQUESTOR_TYPES, FIELD_TYPES, FORM_TYPES, DEFAULT_LISTS, builtinFields, fieldsOf, hasLocation, hasStudent, isGeneral } from './shared.js';

const $ = s => document.querySelector(s), app = $('#app');
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = iso => iso ? new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) : '—';
const toast = m => { const t = $('#toast'); t.textContent = m; t.style.display = 'block'; clearTimeout(t._h); t._h = setTimeout(() => t.style.display = 'none', 3500); };
const pill = s => `<span class="pill s-${s}">${s}</span>`;
const ppill = p => `<span class="pill p-${p}">${p}</span>`;
const I = (n, s = 20) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${{
  home: '<path d="M3 11l9-8 9 8v9a2 2 0 0 1-2 2h-4v-7H9v7H5a2 2 0 0 1-2-2z"/>', tasks: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M8 12l3 3 5-6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>', chart: '<path d="M4 20V10M10 20V4M16 20v-6M22 20H2"/>', grid: '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
  users: '<circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0 1 14 0M17 4a4 4 0 0 1 0 8M22 21a7 7 0 0 0-5-6.7"/>', user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0v5l2 3H4l2-3zM10 20a2 2 0 0 0 4 0"/>', list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  building: '<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M9 6h2M13 6h2M9 10h2M13 10h2M9 14h2M13 14h2M10 22v-4h4v4"/>', chev: '<path d="M9 6l6 6-6 6"/>', back: '<path d="M15 6l-6 6 6 6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>', camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3"/>', image: '<rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-8 8"/>',
  check: '<path d="M5 12l5 5L20 7"/>', play: '<path d="M7 4.5v15l12-7.5z"/>', xmark: '<path d="M6 6l12 12M18 6L6 18"/>', clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', alert: '<circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/>', pause: '<path d="M8 5v14M16 5v14"/>',
  wifi: '<path d="M2 9a15 15 0 0 1 20 0M6 13a9 9 0 0 1 12 0M10 17a3 3 0 0 1 4 0M12 20h.01"/>', bolt: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>', bed: '<path d="M3 18V8M3 12h18v6M7 12V9h5v3M21 18v-2"/>', bus: '<rect x="4" y="3" width="16" height="15" rx="3"/><path d="M4 10h16M8 18v2M16 18v2M8 14h.01M16 14h.01"/>',
  logout: '<path d="M10 17l-5-5 5-5M5 12h11M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/>', settings: '<circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1l2-1.5-2-3.5-2.3 1a7 7 0 0 0-1.7-1L14.5 3h-5l-.4 2.5a7 7 0 0 0-1.7 1l-2.3-1-2 3.5 2 1.5a7 7 0 0 0 0 2l-2 1.5 2 3.5 2.3-1a7 7 0 0 0 1.7 1l.4 2.5h5l.4-2.5a7 7 0 0 0 1.7-1l2.3 1 2-3.5-2-1.5c.1-.3.1-.7.1-1z"/>',
  tool: '<path d="M14.7 6.3a4 4 0 0 0 5 5L21 13l-8 8-3-3 8-8zM3 21l6-6"/><path d="M7 3l4 4-2 2-4-4z"/>', drop: '<path d="M12 3s6 7 6 11a6 6 0 0 1-12 0c0-4 6-11 6-11z"/>',
  book: '<path d="M4 4h6a3 3 0 0 1 3 3v13a2 2 0 0 0-2-2H4zM20 4h-5a2 2 0 0 0-2 2"/><path d="M20 4v14h-7"/>', cash: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 10v4M18 10v4"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M3 8l9 6 9-6"/>', shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>', copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>', send: '<path d="M22 2L11 13M22 2l-7 20-4-9-9-4z"/>',
}[n]}</svg>`;
const ICONS = ['wifi', 'bolt', 'bed', 'bus', 'tool', 'drop', 'book', 'cash', 'grid'];
const BLOCK_FIELDS = ['progress', 'ticket_details', 'timeline'];
const ACT_ICON = { hold: 'pause', open: 'play', closed: 'check', rejected: 'xmark' };
const fmtLeft = m => { m = Math.abs(Math.round(m)); return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60 ? (m % 60) + 'm' : ''}`.trim() : `${m}m`; };
const leaderboard = rows => `<b>Provider leaderboard</b><div class="muted small">Points for closing within SLA, this campus</div>${rows.length ? rows.map((u, i) => `<div class="brow">
  <span class="rank">${['🥇', '🥈', '🥉'][i] || i + 1}</span><div><b>${esc(u.name)}</b><div class="muted small">${u.closed} closed · ${u.on_time ?? 0}% on time</div></div>
  <b class="mono" style="color:${u.points < 0 ? 'var(--warn)' : 'var(--brand)'}">${u.points} pts</b></div>`).join('') : '<p class="muted">No providers yet.</p>'}`;
const svcIcon = s => s.form_schema?.icon || ({ IT: 'wifi', ELEC: 'bolt', HOSTEL: 'bed', TRANS: 'bus' })[s.code] || 'grid';
const ring = (pct, size = 96, color = 'var(--brand)') => { const r = (size - 12) / 2, c = 2 * Math.PI * r;
  return `<div class="ring" style="width:${size}px;height:${size}px"><svg width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${r}" stroke="rgba(91,91,240,.13)" stroke-width="10" fill="none"/>
  <circle cx="${size / 2}" cy="${size / 2}" r="${r}" stroke="${color}" stroke-width="10" fill="none" stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - pct / 100)}" transform="rotate(-90 ${size / 2} ${size / 2})"/></svg><b>${pct}%</b></div>`; };
const S = { token: localStorage.getItem('tok'), tenant: localStorage.getItem('tid'), me: null };

async function api(path, { method = 'GET', body, raw } = {}) {
  const h = { 'content-type': 'application/json' };
  if (S.token) h.authorization = 'Bearer ' + S.token;
  if (S.tenant && S.me?.user.role === 'super_admin') h['x-tenant-id'] = S.tenant;
  const r = await fetch('/api' + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  if (raw) return r;
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && S.token && !path.startsWith('/auth')) { logout(); throw new Error('Session expired'); }
  if (!r.ok) { const e = new Error(j.error?.message || 'Error'); e.details = j.error?.details; e.status = r.status; throw e; }
  return j.data;
}
const readFiles = async (inputs) => {
  const out = [];
  for (const inp of inputs) for (const f of inp.files) {
    if (f.size > 5 * 1024 * 1024) throw new Error(`${f.name} is over 5 MB`);
    out.push({ name: f.name, type: f.type, source: inp.dataset.source, data: await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(f); }) });
  }
  if (out.length > 5) throw new Error('At most 5 files');
  return out;
};
const fileButtons = (id) => `<div class="files">
  <label class="btn">${I('camera', 22)}Camera<input hidden type="file" accept="image/*" capture="environment" multiple data-source="camera" class="f-${id}"></label>
  <label class="btn">${I('image', 22)}Gallery<input hidden type="file" accept="image/*,application/pdf" multiple data-source="gallery" class="f-${id}"></label></div>
  <div class="muted f-${id}-n" style="font-size:13px"></div>`;
const wireFiles = id => document.querySelectorAll('.f-' + id).forEach(i => i.onchange = () => {
  const n = [...document.querySelectorAll('.f-' + id)].reduce((a, x) => a + x.files.length, 0); $(`.f-${id}-n`).textContent = n ? `${n} file(s) attached` : ''; });
const thumbs = files => files?.length ? `<div class="thumbs">${files.map(f => f.mime_type?.startsWith('image/')
  ? `<a href="/api/files/${f.storage_key}" target="_blank"><img src="/api/files/${f.storage_key}" alt="${esc(f.file_name)}"></a>${f.stamped_at ? `<div class="muted" style="font-size:11px">📷 ${fmt(f.stamped_at)}</div>` : ''}`
  : `<a href="/api/files/${f.storage_key}" target="_blank">📄 ${esc(f.file_name)}</a>`).join('')}</div>` : '';
const formVals = form => Object.fromEntries(new FormData(form));

function fieldInput(f, v = '') {
  const req = f.required ? 'required' : '', name = `fd_${f.key}`;
  if (f.type === 'long_text') return `<textarea name="${name}" ${req} placeholder="${esc(f.placeholder)}">${esc(v)}</textarea>`;
  if (f.type === 'select') return `<select name="${name}" ${req}><option value="">Choose…</option>${f.options.map(o => `<option>${esc(o)}</option>`).join('')}</select>`;
  if (f.type === 'multi_select') return `<select name="${name}" multiple ${req}>${f.options.map(o => `<option>${esc(o)}</option>`).join('')}</select>`;
  if (f.type === 'yes_no') return `<select name="${name}" ${req}><option value="">Choose…</option><option>Yes</option><option>No</option></select>`;
  const t = { number: 'number', date: 'date', phone: 'tel', email: 'email' }[f.type] || 'text';
  return `<input type="${t}" name="${name}" ${req} placeholder="${esc(f.placeholder)}">`;
}
// The form type's built-in questions (student details and/or location), in titled sections.
const typeFields = svc => { const b = builtinFields(svc.form_schema || {});
  const sec = (title, pre) => { const f = b.filter(x => x.key.startsWith(pre)); return f.length ? `<div class="fsec"><b>${title}</b>${f.map(x => `<label>${esc(x.label)}</label>${fieldInput(x)}`).join('')}</div>` : ''; };
  return sec('Your student details', 'stu_') + sec('Where is the problem?', 'loc_'); };
const customFields = svc => (svc.form_schema?.fields || []).map(f => `<label>${esc(f.label)}${f.required ? '' : ' <small>(optional)</small>'}</label>${fieldInput(f)}`).join('');
const collectForm = (form, svc) => {
  const fd = {};
  for (const f of fieldsOf(svc.form_schema || {})) {
    const el = form.elements[`fd_${f.key}`]; if (!el) continue;
    fd[f.key] = f.type === 'multi_select' ? [...el.selectedOptions].map(o => o.value) : el.value;
  }
  return fd;
};

// ================= PUBLIC =================
async function portal(slug, q, view, code) {
  document.body.className = '';
  const { tenant, services } = await api(`/public/${slug}`);
  document.title = `${tenant.name} · ONE Desk`;
  const want = (code || q.get('service') || '').toUpperCase(), pick = want && services.find(s => s.code === want);
  if (pick) return raiseForm(slug, tenant, pick);
  if (view !== 'raise') {
    const opt = (href, ic, cls, title, sub) => `<a class="svc" href="${href}"><span class="chip ${cls}">${I(ic, 22)}</span><span class="t"><b>${title}</b><span class="muted small">${sub}</span></span><span class="chev">${I('chev')}</span></a>`;
    app.innerHTML = `<div class="wrap hero"><div class="logo">${I('grid', 26)}</div>
      <h1>Need help?<br><span>We're</span> on it.</h1><p class="muted">${esc(tenant.name)} service desk. No login needed to raise or track a ticket.</p>
      ${opt(`#/d/${slug}/raise`, 'plus', 'c0', 'Raise a ticket', 'Report a problem and get a ticket number instantly')}
      ${opt(`#/d/${slug}/track`, 'search', 'c2', 'Track ticket', 'Check status with your ticket number')}
      ${opt('#/login', 'user', 'c1', 'Staff login', 'Providers and admins sign in here')}</div>`;
    return;
  }
  app.innerHTML = `<div class="wrap"><div class="head"><a class="iconbtn" href="#/d/${slug}">${I('back')}</a><h1>Raise a ticket</h1></div>
    <p class="muted">Pick the service you need.</p>
    ${services.map((s, i) => `<a class="svc" href="#/d/${slug}/raise/${encodeURIComponent(s.code)}"><span class="chip c${i % 5}">${I(svcIcon(s), 22)}</span>
      <span class="t"><b>${esc(s.name)}</b><span class="muted small">${esc(s.description || '')}</span><br>
      ${s.providers.map(p => `<span class="plate">${esc(p)}</span>`).join('')}</span><span class="chev">${I('chev')}</span></a>`).join('')}
</div>`;
}

function raiseForm(slug, tenant, svc, related) {
  const idem = crypto.randomUUID();
  app.innerHTML = `<div class="wrap"><div class="head"><a class="iconbtn" href="#/d/${slug}/raise">${I('back')}</a>
    <h1>${esc(svc.name)}</h1><span class="chip c0">${I(svcIcon(svc), 22)}</span></div>
  <form id="f" class="card">
    <input class="hp" name="website" tabindex="-1" autocomplete="off">
    <div class="row"><div><label>Your name</label><input name="name" required></div>
      <div><label>I am a</label><select name="requestor_type">${REQUESTOR_TYPES.map(t => `<option ${hasStudent(svc.form_schema) && t === 'student' ? 'selected' : ''}>${t}</option>`).join('')}</select></div></div>
    <div class="row"><div><label>Email <small>(we send updates here)</small></label><input name="email" type="email" required autocomplete="email"></div>
      <div><label>Phone <small>(optional)</small></label><input name="phone" type="tel" autocomplete="tel"></div></div>
    ${hasStudent(svc.form_schema) ? '' : `<div class="row"><div><label>Roll / employee ID <small>(optional)</small></label><input name="identifier"></div>
      <div><label>Department <small>(optional)</small></label><input name="department"></div></div>`}
    ${typeFields(svc)}
    ${isGeneral(svc.form_schema) ? '<label>Location <small>(room, building)</small></label><input name="location" required>' : ''}
    <label>Subject</label><input name="subject" required maxlength="200">
    <label>Describe the problem</label><textarea name="description"></textarea>
    ${customFields(svc)}
    <label>Photos <small>(up to 5)</small></label>${fileButtons('raise')}
    <div class="err" id="err"></div>
    <p><button class="btn primary big">${I('send')} Raise ticket</button></p>
  </form></div>`;
  wireFiles('raise');
  $('#f').onsubmit = async e => {
    e.preventDefault(); const btn = e.target.querySelector('button.primary'); btn.disabled = true; $('#err').textContent = '';
    try {
      const v = formVals(e.target);
      if (!/^\S+@\S+\.\S+$/.test(v.email || '')) throw new Error('Enter a valid email address so we can send you updates');
      const body = { ...v, service_id: svc.id, form_data: collectForm(e.target, svc), idempotency_key: idem, related_ticket_no: related,
        files: await readFiles(document.querySelectorAll('.f-raise')) };
      const r = await api(`/public/${slug}/tickets`, { method: 'POST', body });
      const link = `${location.origin}${location.pathname}#/d/${slug}/t/${r.ticket_no}?k=${r.tracking_token}`;
      app.innerHTML = `<div class="wrap"><div class="head"><a class="iconbtn" href="#/d/${slug}">${I('back')}</a><h1>Ticket raised</h1></div><div class="stub"><span class="chip c2" style="margin:0 auto 10px;width:56px;height:56px;border-radius:50%">${I('check', 28)}</span>
        <div class="muted">Ticket raised! Your number is</div><div class="no">${r.ticket_no}</div>
        <p>${esc(svc.name)} · target by <b>${fmt(r.due_at)}</b></p>
        ${r.providers.map(p => `<span class="plate">${esc(p.name)} ${p.phone ? '· ' + esc(p.phone) : ''}</span>`).join('')}
        <p class="muted small" style="margin:14px 0 30px">${v.email ? 'We also emailed these details to you.' : 'Save this link — it is your key to the ticket.'}</p>
        <div class="row"><button class="btn primary" id="cp">${I('copy', 18)} Copy link</button><a class="btn" href="${link}">Open ticket</a></div></div></div>`;
      $('#cp').onclick = () => navigator.clipboard.writeText(link).then(() => toast('Link copied'));
    } catch (er) { $('#err').textContent = er.message + (er.details ? ': ' + Object.values(er.details).join(', ') : ''); btn.disabled = false; }
  };
}

async function track(slug) {
  document.body.className = '';
  app.innerHTML = `<div class="wrap"><div class="head"><a class="iconbtn" href="#/d/${slug}">${I('back')}</a><h1>Track a ticket</h1></div><form id="f" class="card">
    <label>Ticket number</label><input name="no" required placeholder="0001" inputmode="numeric" class="mono">
    <div class="err" id="err"></div><p><button class="btn primary big">${I('search')} Find my ticket</button></p></form></div>`;
  $('#f').onsubmit = async e => { e.preventDefault(); const v = formVals(e.target);
    try { await api(`/public/${slug}/tickets/${encodeURIComponent(v.no.trim())}`);
      location.hash = `#/d/${slug}/t/${/^\d+$/.test(v.no.trim()) ? v.no.trim().padStart(4, '0') : v.no.trim().toUpperCase()}`;
    } catch { $('#err').textContent = 'No ticket with that number.'; } };
}

async function ticketPage(slug, no, q) {
  document.body.className = '';
  const key = q.get('k') ? { k: q.get('k') } : {};
  const qs = new URLSearchParams(key).toString();
  let t;
  try { t = await api(`/public/${slug}/tickets/${no}?${qs}`); } catch { return track(slug); }
  const label = e => ({ created: `Received at ${esc(e.to_value)}`, transferred: `Moved from ${esc(e.from_value)} to ${esc(e.to_value)}`,
    status_changed: { hold: 'Put on hold', open: 'Work resumed', closed: 'Closed', rejected: 'Rejected' }[e.to_value],
    note: `Note from ${esc(e.actor_name)}`, reopened: `Reopened by ${esc(e.actor_name)}` })[e.event_type] || e.event_type;
  const next = { open: 'Closed', hold: 'Work resumes' }[t.status];
  const canReopen = t.status === 'closed' && new Date(t.reopen_until) > new Date();
  const step = { open: 50, hold: 50, closed: 100, rejected: 100 }[t.status];
  app.innerHTML = `<div class="wrap"><div class="head"><a class="iconbtn" href="#/d/${slug}">${I('back')}</a><h1>My Ticket</h1>${pill(t.status)}</div>
    <div class="stub left"><div class="mono muted small">${t.ticket_no}</div><h2 style="margin:4px 0 2px;font-size:20px">${esc(t.subject)}</h2>
    <div class="muted small">${esc(t.service)} · ${esc(t.location || '')}</div>
    <div class="progress card" style="margin-top:14px;box-shadow:none">${ring(step, 80, t.status === 'rejected' ? 'var(--warn)' : t.status === 'closed' ? 'var(--ok)' : 'var(--brand)')}
      <div><b>${STATUS_WORDS[t.status]}</b><div class="muted small">${t.status === 'open' ? `Target by ${fmt(t.due_at)}` : t.status === 'hold' && t.hold_due_at ? `${esc(t.hold_label || '')} · expected to resume by ${fmt(t.hold_due_at)}` : t.closed_at ? fmt(t.closed_at) : ''}</div></div></div>
    ${t.providers.map(p => `<span class="plate">${esc(p.name)}${p.phone ? ' · ' + esc(p.phone) : ''}</span>`).join('')}</div>
    <h2>What happened</h2><div class="card"><ul class="stamps">${t.events.map(e => `<li><b>${label(e)}</b><div class="when">${fmt(e.created_at)}${e.actor_type === 'user' ? ' · ' + esc(e.actor_name) : ''}</div>
      ${e.body ? `<div>${esc(e.body)}</div>` : ''}${thumbs(e.files)}</li>`).join('')}${next ? `<li class="faint"><b>${next}</b></li>` : ''}</ul></div>
    ${t.status === 'rejected' ? `<div class="card">This ticket was rejected. <a href="#/d/${slug}" id="newt">Raise a new ticket</a></div>` : `
    <form id="nf" class="card"><b>Add a note</b><textarea name="body" required placeholder="Anything the team should know" style="margin-top:10px"></textarea>${fileButtons('note')}
      <p><button class="btn primary big">${I('send')} Send note</button></p></form>`}
    ${canReopen ? `<form id="rf" class="card"><b>Not fixed?</b> <span class="muted small">Reopen until ${fmt(t.reopen_until)}.</span><textarea name="reason" required placeholder="What is still wrong?" style="margin-top:10px"></textarea>
      <p><button class="btn danger big">Reopen ticket</button></p></form>` : ''}</div>`;
  if ($('#nf')) { wireFiles('note'); $('#nf').onsubmit = async e => { e.preventDefault();
    try { await api(`/public/${slug}/tickets/${no}/notes`, { method: 'POST', body: { ...key, body: e.target.body.value, files: await readFiles(document.querySelectorAll('.f-note')) } });
      toast('Note sent'); ticketPage(slug, no, q); } catch (er) { toast(er.message); } }; }
  if ($('#rf')) $('#rf').onsubmit = async e => { e.preventDefault();
    try { await api(`/public/${slug}/tickets/${no}/reopen`, { method: 'POST', body: { ...key, reason: e.target.reason.value } }); toast('Reopened'); ticketPage(slug, no, q); } catch (er) { toast(er.message); } };
}

// ================= STAFF =================
function logout() { localStorage.removeItem('tok'); localStorage.removeItem('tid'); S.token = S.me = null; location.hash = '#/login'; }
function login() {
  document.body.className = 'console';
  app.innerHTML = `<div class="wrap hero" style="max-width:440px"><a class="iconbtn" href="#/" id="bk" style="margin-bottom:20px">${I('back')}</a><div class="logo">${I('grid', 26)}</div>
    <h1>Your Desk,<br><span>Organized</span> in One Place</h1><p class="muted">Sign in to see your service queue, act on tickets and track your progress.</p>
    <form id="f" class="card"><label style="margin-top:0">Email</label><input name="email" type="email" required autofocus><label>Password</label><input name="password" type="password" required>
    <div class="err" id="err"></div><p style="margin-bottom:0"><button class="btn dark big">Get started ${I('chev', 18)}</button></p></form></div>`;
  $('#bk').onclick = e => { if (history.length > 1) { e.preventDefault(); history.back(); } };
  $('#f').onsubmit = async e => { e.preventDefault();
    try { const r = await api('/auth/login', { method: 'POST', body: formVals(e.target) }); S.token = r.token; localStorage.setItem('tok', r.token); location.hash = '#/c'; }
    catch (er) { $('#err').textContent = er.message; } };
}
async function shell(active, render, title) {
  document.body.className = 'console';
  if (!S.token) return login();
  if (!S.me) S.me = await api('/me');
  if (S.me.user.must_change_pw) return setOwnPassword();
  const u = S.me.user, sa = u.role === 'super_admin', admin = u.role !== 'provider';
  if (!sa) S.tenant = u.tenant_id;
  else if (!S.tenant || !S.me.tenants.find(t => t.id === S.tenant)) S.tenant = S.me.tenants[0]?.id;
  if (S.tenant) localStorage.setItem('tid', S.tenant);
  const nav = [['c', 'Home', 'home'], ['c/new', 'New ticket', 'plus'], admin && ['c/attention', 'Attention', 'bell'], ['c/reports', 'Reports', 'chart'], admin && ['c/services', 'Services', 'grid'],
    admin && ['c/sla', 'SLA & points', 'clock'], admin && ['c/email', 'Email', 'mail'], admin && ['c/users', 'People', 'users'], admin && ['c/audit', 'Audit', 'shield'], sa && ['c/tenants', 'Tenants', 'building']].filter(Boolean);
  const initials = u.name.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();
  const bn = (h, l, ic) => `<a href="#/${h}" class="${active === h ? 'on' : ''}">${I(ic, 22)}${l}</a>`;
  app.innerHTML = `<div class="top"><span class="logo"><i>${I('grid', 18)}</i>ONE Desk</span>
    <nav>${nav.map(([h, l, ic]) => `<a href="#/${h}" class="${active === h ? 'on' : ''}">${I(ic, 17)}${l}</a>`).join('')}</nav>
    <span class="sp"></span>${sa ? `<select id="tsw">${S.me.tenants.map(t => `<option value="${t.id}" ${t.id === S.tenant ? 'selected' : ''}>${esc(t.code)}</option>`).join('')}</select>` : ''}
    <a href="#/c/me" title="${esc(u.name)}" style="display:flex;gap:10px;align-items:center;color:var(--ink)"><span class="who" style="text-align:right;line-height:1.2"><b style="font-size:13.5px">${esc(u.name)}</b><br><span class="muted small">${u.role.replace('_', ' ')}</span></span><span class="avatar">${initials}</span></a></div>
    <div class="cwrap">${active !== 'c' || title ? `<div class="head"><a class="iconbtn" href="#/c" id="bk">${I('back')}</a><h1>${esc(title || (nav.find(n => n[0] === active) || [])[1] || '')}</h1></div>` : ''}<div id="main">Loading…</div></div>
    <div class="bnav">${bn('c', 'Home', 'home')}${bn('c/reports', 'Reports', 'chart')}<a href="#/c/new" class="fab">${I('plus', 26)}</a>
      ${admin ? bn('c/attention', 'Attention', 'bell') : ''}${bn('c/me', 'Profile', 'user')}</div>`;
  if ($('#tsw')) $('#tsw').onchange = e => { S.tenant = e.target.value; localStorage.setItem('tid', S.tenant); route(); };
  const main = $('#main');
  S.nav = nav;
  if ($('#bk') && title === 'Ticket') $('#bk').onclick = e => { e.preventDefault(); history.length > 1 ? history.back() : location.hash = '#/c'; };
  if (!S.tenant && !['c/tenants', 'c/me'].includes(active)) { main.innerHTML = '<p>No tenant yet. <a href="#/c/tenants">Create one</a>.</p>'; return; }
  try { await render(main, { sa, admin, u }); } catch (e) { main.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
}
const tenantObj = () => S.me.tenants.find(t => t.id === S.tenant);

// One ticket as a card: state strip, number + labels, subject, service, requestor, location, due / resume time.
function ticketCard(r, services) {
  const now = new Date().toISOString(), holdOver = r.status === 'hold' && r.hold_due_at && r.hold_due_at < now;
  const state = r.overdue || holdOver ? 'over' : r.status, svc = services.find(s => s.code === r.service_code) || { code: r.service_code };
  const foot = r.status === 'open' ? [r.overdue ? 'Overdue since' : 'Due', r.due_at, 'clock']
    : r.status === 'hold' ? [holdOver ? 'Hold overdue since' : 'Resume by', r.hold_due_at, 'pause'] : [r.status === 'closed' ? 'Closed' : 'Rejected', r.closed_at, r.status === 'closed' ? 'check' : 'xmark'];
  return `<div class="tcard st-${state} ${r.status === 'rejected' ? 'dim' : ''}" data-id="${r.id}" tabindex="0">
    <div class="tc-top"><span class="mono tc-no">#${r.ticket_no}</span><span class="sp"></span>${r.is_internal ? '<span class="pill p-int">internal</span>' : ''}${pill(r.status)}${ppill(r.priority)}</div>
    <b class="tc-title">${esc(r.subject)}</b>
    <div class="tc-svc"><span class="chip c0">${I(svcIcon(svc), 16)}</span>${esc(r.service)}</div>
    <div class="tc-row">${I('user', 15)}<span>${esc(r.requestor)}</span></div>
    ${r.location ? `<div class="tc-row">${I('building', 15)}<span>${esc(r.location)}</span></div>` : ''}
    <div class="tc-foot">${I(foot[2], 15)}<span>${foot[0]} <b>${fmt(foot[1])}</b></span></div></div>`;
}

let pollT;
async function queue(main) {
  const services = await api('/services');
  const st = JSON.parse(sessionStorage.getItem('qf') || '{"status":"open"}');
  const draw = async () => {
    const qs = new URLSearchParams(Object.entries(st).filter(([, v]) => v)).toString();
    const [rows, rep, pts] = await Promise.all([api('/tickets?' + qs), api('/reports?days=7'), api('/points')]);
    const c = rep.counts || {};
    const done = c.closed_period || 0, total = done + (c.open || 0) + (c.hold || 0), pct = total ? Math.round(100 * done / total) : 0;
    const h = new Date().getHours(), greet = h < 12 ? 'Good Morning' : h < 17 ? 'Good Afternoon' : 'Good Evening';
    const tile = (k, label, n, ic, cls) => `<div class="stat" data-s="${k}"><span class="chip ${cls}">${I(ic, 18)}</span><div><span>${label}</span><b>${n || 0}</b></div></div>`;
    main.innerHTML = `<div class="hello"><div><div class="muted">${greet},</div><h1>${esc(S.me.user.name.split(' ')[0])} 👋</h1><div class="muted small">Here's what's happening at ${esc(tenantObj()?.code || '')} today.</div></div>
      <div style="display:flex;gap:8px;align-items:center"><a href="#/c/me" class="pill p-int" style="font-size:13px;padding:9px 12px;border-radius:12px">⭐ ${pts.me} pts</a>
      ${S.me.user.role !== 'provider' ? `<a class="iconbtn" href="#/c/attention">${I('bell')}</a>` : ''}</div></div>
      <div class="dash"><div class="card progress">${ring(pct)}<div><b>Weekly progress</b><div class="small">${done} of ${total} tickets closed</div>
        <div class="muted small">${pct >= 70 ? "You're doing great!" : 'Keep going!'}</div></div></div>
      <div class="stats">${tile('open', 'Open', c.open, 'list', 'c4')}${tile('hold', 'On hold', c.hold, 'pause', 'c1')}${tile('closed', 'Closed (7d)', c.closed_period, 'check', 'c2')}${tile('overdue', 'Overdue', c.overdue, 'alert', 'c5')}</div></div>
      <div class="sechead"><h2>My Tickets</h2><a href="/api/tickets.csv?${qs}" id="csv">Export CSV</a></div>
      <div class="filters"><label class="search" style="margin:0">${I('search', 18)}<input id="fq" placeholder="Search tickets…" value="${esc(st.q || '')}"></label>
      <select id="fsv"><option value="">All my services</option>${services.map(s => `<option value="${s.id}" ${st.service === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></div>
      <div class="tabs">${[['all', 'All'], ['open', 'Open'], ['hold', 'On hold'], ['overdue', 'Overdue'], ['closed', 'Closed'], ['rejected', 'Rejected']].map(([k, l]) => `<button class="tab ${st.status === k ? 'on' : ''}" data-s="${k}">${l}</button>`).join('')}</div>
      <div class="tgrid">${rows.map(r => ticketCard(r, services)).join('') || `<div class="empty card" style="grid-column:1/-1">${I('tasks', 40)}<p>Nothing here — all clear.</p></div>`}</div>`;
    main.querySelectorAll('.tcard').forEach(tr => { tr.onclick = () => location.hash = '#/c/t/' + tr.dataset.id; tr.onkeydown = e => e.key === 'Enter' && tr.click(); });
    const set = (k, v) => { st[k] = v; sessionStorage.setItem('qf', JSON.stringify(st)); draw(); };
    main.querySelectorAll('[data-s]').forEach(b => b.onclick = () => set('status', b.dataset.s)); $('#fsv').onchange = e => set('service', e.target.value);
    $('#fq').onchange = e => set('q', e.target.value);
    $('#csv').onclick = async e => { e.preventDefault(); const r = await api('/tickets.csv?' + qs, { raw: true }); const a = document.createElement('a');
      a.href = URL.createObjectURL(await r.blob()); a.download = 'tickets.csv'; a.click(); };
  };
  await draw();
  clearInterval(pollT); pollT = setInterval(() => location.hash === '#/c' && !document.hidden && draw(), 30000);
}

function dlg(html, onSubmit) {
  const d = document.createElement('dialog'); d.innerHTML = `<form method="dialog" id="df">${html}<div class="err" id="derr"></div>
    <p class="row"><button class="btn" value="cancel" formnovalidate>Cancel</button><button class="btn primary" value="ok">Save</button></p></form>`;
  document.body.append(d); d.showModal(); d.onclose = () => d.remove();
  d.querySelector('form').onsubmit = async e => { if (e.submitter?.value !== 'ok') return; e.preventDefault();
    try { await onSubmit(e.target); d.close(); } catch (er) { d.querySelector('#derr').textContent = er.message; } };
  return d;
}

async function workspace(main, id, { admin }) {
  const [t, services] = await Promise.all([api('/tickets/' + id), api('/services')]);
  const evLabel = e => ({ created: `Created in ${esc(e.to_value)}`, transferred: `Transferred ${esc(e.from_value)} → ${esc(e.to_value)}`,
    status_changed: (m => `${e.from_value} → ${e.to_value}${m.hold_reason ? ' · ' + esc(m.hold_reason) : ''}${m.points != null ? ` · ${m.points > 0 ? '+' : ''}${m.points} pts` : ''}`)(JSON.parse(e.meta || '{}')), priority_changed: `Priority ${e.from_value} → ${e.to_value}`, note: 'Note',
    reopened: 'Reopened', due_extended: `Due extended to ${fmt(e.to_value)}` })[e.event_type] || e.event_type;
  const targets = allowedTargets(t.status);
  const btnName = { hold: 'Hold (h)', open: t.status === 'closed' ? 'Reopen' : 'Resume', closed: 'Close (c)', rejected: 'Reject (r)' };
  const fd = Object.entries(t.form_data || {}).filter(([, v]) => v !== '' && v != null);
  main.innerHTML = `<div class="ws">
   <div><div class="card"><div class="mono muted small">${t.ticket_no}</div>${pill(t.status)} ${ppill(t.priority)} ${t.is_internal ? '<span class="pill s-hold">internal</span>' : ''}
     <h2 style="margin:10px 0">${esc(t.subject)}</h2><div class="muted">${esc(t.service.name)} · ${t.channel}</div>
     <p>${esc(t.description || '')}</p><p><b>Location:</b> ${esc(t.location || '—')}</p>
     ${fd.map(([k, v]) => `<div><b>${esc((t.service.form_schema ? fieldsOf(JSON.parse(t.service.form_schema)).find(f => f.key === k)?.label : k) || k)}:</b> ${esc(Array.isArray(v) ? v.join(', ') : v)}</div>`).join('')}
     <p class="muted small">Created ${fmt(t.created_at)}</p>
     ${t.status === 'open' ? `<div class="slabox ${t.sla_left_min < 0 ? 'late' : ''}">${I('clock', 20)}<div><b>${t.sla_left_min >= 0 ? fmtLeft(t.sla_left_min) + ' working time left' : fmtLeft(t.sla_left_min) + ' past SLA'}</b><div class="small">Due ${fmt(t.due_at)}</div></div></div>` : ''}
     ${t.status === 'hold' ? `<div class="slabox hold ${t.hold_over ? 'late' : ''}">${I('pause', 20)}<div><b>On hold · ${esc(t.hold_label || '')}</b><div class="small">${t.hold_over ? 'Hold SLA passed at' : 'Resume by'} ${fmt(t.hold_due_at)} · main SLA paused</div></div></div>` : ''}
     ${t.held_minutes ? `<div class="muted small" style="margin-top:6px">Total time on hold: ${fmtLeft(t.held_minutes)} (working)</div>` : ''}
     <p><a href="${t.tracking_url}" target="_blank" style="font-size:13px">Requestor's view ↗</a></p></div></div>
   <div><div class="card"><b>Timeline</b><div style="margin-top:10px">${t.events.map(e => `<div class="ev ${e.is_internal ? 'int' : ''}"><b>${evLabel(e)}</b>${e.is_internal ? ' <span class="muted">(internal)</span>' : ''}
      <div class="meta">${fmt(e.created_at)} · ${esc(e.actor_name || e.actor_type)}</div>${e.body ? `<div>${esc(e.body)}</div>` : ''}${thumbs(t.attachments.filter(a => a.event_id === e.id))}</div>`).join('')}</div></div>
     <form id="act" class="card"><b>Act on this ticket</b><textarea name="note" placeholder="Note (required for any status change)"></textarea>
       ${fileButtons('act')}<label style="font-weight:400"><input type="checkbox" name="is_internal" style="width:auto;min-height:0"> Internal — hide from requestor</label>
       <div class="actbar">${targets.map(s => `<button class="btn act act-${s === 'open' && t.status === 'closed' ? 'reopen' : s}" data-to="${s}">${I(ACT_ICON[s], 18)}${btnName[s]}</button>`).join('')}
       ${t.status !== 'rejected' ? `<button class="btn act act-note" data-to="note">${I('plus', 18)}Add note</button>` : ''}</div></form></div>
   <div><div class="card"><b>Requestor</b><div>${esc(t.requestor.name)} <span class="muted">${esc(t.requestor.requestor_type || '')}</span></div>
     <div class="muted" style="font-size:13px">${esc(t.requestor.email || '')}<br>${esc(t.requestor.phone || '')}<br>${esc(t.requestor.identifier || '')} ${esc(t.requestor.department || '')}</div>
     ${t.requestor_history.length ? `<p style="font-size:13px"><b>Last tickets</b><br>${t.requestor_history.map(h => `<a href="#/c/t/${h.id}">${h.ticket_no}</a> ${pill(h.status)}`).join('<br>')}</p>` : ''}</div>
    <div class="card"><b>Providers</b>${t.providers.map(p => `<div>${esc(p.name)} <span class="muted">${esc(p.phone || '')}</span></div>`).join('') || '<div class="err">No provider mapped</div>'}</div>
    ${['open', 'hold'].includes(t.status) ? `<div class="card"><b>Priority</b><select id="pri">${PRIORITIES.map(p => `<option ${p === t.priority ? 'selected' : ''}>${p}</option>`).join('')}</select>
      <p><button class="btn" id="tr" style="width:100%">Transfer (t)</button></p>${admin ? '<p><button class="btn" id="ext" style="width:100%">Extend due time</button></p>' : ''}</div>` : ''}</div></div>`;
  wireFiles('act');
  const reload = () => workspace(main, id, { admin });
  $('#act').onsubmit = async e => {
    e.preventDefault(); const to = e.submitter?.dataset.to, f = e.target, note = f.note.value.trim();
    if (!note) return toast('Write a note first');
    try { const body = { note, body: note, is_internal: f.is_internal.checked, files: await readFiles(document.querySelectorAll('.f-act')) };
      if (to === 'hold') return dlg(`<h2>Put on hold</h2><label>Why is it on hold?</label><select name="hold_reason">${t.hold_reasons.map(r => `<option value="${r.key}">${esc(r.label)} — ${r.hours}h</option>`).join('')}</select>
        <p class="muted small">The main SLA clock pauses while on hold. The hold has its own limit (working hours); going past it costs points.</p>`,
        async d => { await api(`/tickets/${id}/status`, { method: 'POST', body: { ...body, to, hold_reason: d.elements.hold_reason.value } }); toast('Put on hold'); reload(); });
      const res = await api(`/tickets/${id}/${to === 'note' ? 'notes' : 'status'}`, { method: 'POST', body: to === 'note' ? body : { ...body, to } });
      toast(res.points != null ? `Closed · ${res.points > 0 ? '+' : ''}${res.points} points` : 'Saved'); reload();
    } catch (er) { toast(er.message); if (er.status === 409) reload(); }
  };
  if ($('#pri')) $('#pri').onchange = async e => { try { await api(`/tickets/${id}/priority`, { method: 'POST', body: { priority: e.target.value } }); reload(); } catch (er) { toast(er.message); } };
  const transfer = () => dlg(`<h2>Transfer ticket</h2><label>To service</label><select name="service_id">${services.filter(s => s.id !== t.service_id && s.is_active).map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select>
    <label>Note</label><textarea name="note" required></textarea>`, async f => { await api(`/tickets/${id}/transfer`, { method: 'POST', body: formVals(f) }); toast('Transferred'); location.hash = '#/c'; });
  if ($('#tr')) $('#tr').onclick = transfer;
  if ($('#ext')) $('#ext').onclick = () => dlg(`<h2>Extend due time</h2><label>Hours</label><input name="hours" type="number" min="1" required><label>Reason</label><textarea name="reason" required></textarea>`,
    async f => { await api(`/tickets/${id}/extend`, { method: 'POST', body: formVals(f) }); reload(); });
  document.onkeydown = e => { if (!location.hash.startsWith('#/c/t/') || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName) || $('dialog')) return;
    const m = { h: 'hold', c: 'closed', r: 'rejected' }[e.key];
    if (m && targets.includes(m)) { $('#act').note.focus(); toast(`Write a note, then press ${btnName[m]}`); }
    if (e.key === 't' && $('#tr')) transfer(); };
}

async function newTicket(main) {
  const services = (await api('/services')).filter(s => s.is_active);
  main.innerHTML = `<form id="f" class="card" style="max-width:720px"><h2 style="margin-top:0">New ticket</h2>
    <label>Kind</label><select name="channel"><option value="walk_in">Walk-in (on behalf of a requestor)</option><option value="phone">Phone call</option><option value="internal">Internal request (from me to another service)</option></select>
    <label>Service</label><select name="service_id" id="svc">${services.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select>
    <div id="who"><div class="row"><div><label>Requestor name</label><input name="name"></div><div><label>Type</label><select name="requestor_type">${REQUESTOR_TYPES.map(t => `<option>${t}</option>`).join('')}</select></div></div>
    <div class="row"><div><label>Email <small>(updates go here)</small></label><input name="email" type="email" required></div><div><label>Phone <small>(optional)</small></label><input name="phone"></div></div>
    <div class="row" id="idrow"><div><label>Roll / emp ID</label><input name="identifier"></div><div><label>Department</label><input name="department"></div></div></div><div id="tfs"></div>
    <label>Priority</label><select name="priority">${PRIORITIES.map(p => `<option ${p === 'medium' ? 'selected' : ''}>${p}</option>`).join('')}</select>
    <div id="locrow"><label>Location</label><input name="location" required></div><label>Subject</label><input name="subject" required><label>Description</label><textarea name="description"></textarea>
    <div id="cf"></div><label>Photos</label>${fileButtons('nt')}<p><button class="btn primary">Create ticket</button></p></form>`;
  wireFiles('nt');
  const svcOf = () => services.find(s => s.id === $('#svc').value);
  const drawCf = () => { const s = svcOf(), sch = s.form_schema || {};
    $('#cf').innerHTML = customFields(s); $('#tfs').innerHTML = typeFields(s);
    $('#locrow').style.display = isGeneral(sch) ? '' : 'none'; $('#f').location.required = isGeneral(sch);
    $('#idrow').style.display = hasStudent(sch) ? 'none' : ''; };
  drawCf(); $('#svc').onchange = drawCf;
  $('#f').channel.onchange = e => { const internal = e.target.value === 'internal'; $('#who').style.display = internal ? 'none' : ''; $('#f').email.required = !internal; };
  $('#f').onsubmit = async e => { e.preventDefault();
    try { const t = await api('/tickets', { method: 'POST', body: { ...formVals(e.target), form_data: collectForm(e.target, svcOf()), files: await readFiles(document.querySelectorAll('.f-nt')) } });
      toast('Created ' + t.ticket_no); location.hash = '#/c/t/' + t.id; } catch (er) { toast(er.message + (er.details ? ': ' + Object.values(er.details).join(', ') : '')); } };
}

async function attention(main) {
  const a = await api('/attention');
  const list = (rows) => rows.length ? `<table>${rows.map(r => `<tr class="click" data-id="${r.id}"><td class="mono">${r.ticket_no}</td><td>${esc(r.service)}</td><td>${esc(r.subject)}</td><td>${fmt(r.due_at)}</td></tr>`).join('')}</table>` : '<p class="muted">Clear.</p>';
  main.innerHTML = `<h2>Services with no provider</h2>${a.no_provider.length ? a.no_provider.map(s => `<div class="card">${esc(s.name)} — ${s.open_count} active ticket(s). <a href="#/c/services">Map a provider</a></div>`).join('') : '<p class="muted">Clear.</p>'}
    <h2>Overdue</h2>${list(a.overdue)}<h2>Hold past its hold SLA</h2>${list(a.stuck_hold)}
    <h2>Failed mail</h2>${a.failed_mail.length ? `<table>${a.failed_mail.map(n => `<tr><td>${esc(n.recipient)}</td><td>${esc(n.subject)}</td><td class="err">${esc(n.last_error)}</td><td><button class="btn" data-n="${n.id}">Resend</button></td></tr>`).join('')}</table>` : '<p class="muted">Clear.</p>'}`;
  main.querySelectorAll('tr.click').forEach(tr => tr.onclick = () => location.hash = '#/c/t/' + tr.dataset.id);
  main.querySelectorAll('[data-n]').forEach(b => b.onclick = async () => { await api(`/notifications/${b.dataset.n}/resend`, { method: 'POST' }); toast('Queued'); attention(main); });
}

async function services(main) {
  const [svcs, users] = await Promise.all([api('/services'), api('/users')]);
  const eligible = users.filter(u => u.is_active);
  const provSel = (name, val) => `<select name="${name}"><option value="">— None —</option>${eligible.map(u => `<option value="${u.id}" ${u.id === val ? 'selected' : ''}>${esc(u.name)}${u.role === 'tenant_admin' ? ' (admin)' : ''}</option>`).join('')}</select>`;
  const iconPick = cur => `<div class="iconpick">${ICONS.map((ic, i) => `<label><input type="radio" name="icon" value="${ic}" ${ic === cur ? 'checked' : ''}><span class="chip c${i % 5}">${I(ic, 20)}</span></label>`).join('')}</div>`;
  const fields = (s = {}) => `<label>Service name</label><input name="name" required value="${esc(s.name || '')}" placeholder="e.g. Plumbing">
    ${s.id ? '' : '<label>Code <small>(short, used in QR links)</small></label><input name="code" required placeholder="PLUMB" style="text-transform:uppercase">'}
    <label>Description</label><input name="description" value="${esc(s.description || '')}" placeholder="What this service covers">
    <label>Icon</label>${iconPick(s.id ? svcIcon(s) : 'grid')}
    ${typePick(s.form_schema || { form_type: 'general' })}
    <div class="row"><div><label>Service provider 1</label>${provSel('p1', s.members?.[0]?.id)}</div><div><label>Service provider 2 <small>(optional)</small></label>${provSel('p2', s.members?.[1]?.id)}</div></div>`;
  const members = f => [...new Set([f.elements.p1.value, f.elements.p2.value].filter(Boolean))];
  main.innerHTML = `<div class="sechead" style="margin-top:0"><span class="muted small">What requestors see on the portal. Each service needs one or two providers.</span>
      <button class="btn primary" id="add">${I('plus', 18)} New service</button></div>
    ${svcs.map((s, i) => `<div class="svc ${s.is_active ? '' : 'dim'}" style="cursor:default"><span class="chip c${i % 5}">${I(svcIcon(s), 22)}</span>
      <span class="t"><b>${esc(s.name)} <span class="muted small mono">${esc(s.code)}</span> <span class="pill c4">${FORM_TYPES[s.form_schema.form_type] || 'General'}</span>${s.is_active ? '' : ' <span class="pill s-closed">inactive</span>'}</b><span class="muted small">${esc(s.description || '')}</span><br>
      ${s.members.map(m => `<span class="plate">${esc(m.name)}</span>`).join('') || '<span class="pill s-rejected" style="margin-top:6px">No provider assigned</span>'}</span>
      <button class="btn soft" data-e="${s.id}">Edit</button></div>`).join('')}
    <p class="muted small">Working hours, default targets and hold reasons are under <a href="#/c/sla">SLA &amp; points</a>.</p>
    <p class="muted small">QR link for one service: ${location.origin}${location.pathname}#/d/${tenantObj().slug}?service=CODE</p>`;
  const qHead = `<b style="display:block;margin-top:20px">Questions on the form</b><div class="muted small">Extra questions for this service. Requestors always answer name, contact, location, subject and description first.</div><div id="fb"></div>`;
  $('#add').onclick = () => { let fb; const d = dlg(`<h2>New service</h2>${fields()}${qHead}`, async f => {
    const s = await api('/services', { method: 'POST', body: { code: f.elements.code.value, name: f.elements.name.value, description: f.elements.description.value, form_schema: { fields: fb.get(), icon: f.elements.icon.value, ...typeOf(f) } } });
    if (members(f).length) await api(`/services/${s.id}/members`, { method: 'PUT', body: { user_ids: members(f) } });
    toast('Service created'); services(main); });
    d.style.maxWidth = '680px'; wireType(d); fb = formBuilder(d.querySelector('#fb'), []); };
  main.querySelectorAll('[data-e]').forEach(b => b.onclick = () => {
    const s = svcs.find(x => x.id === b.dataset.e), { icon, ...schema } = s.form_schema;
    let fb; const d = dlg(`<h2>Edit ${esc(s.name)}</h2>${fields(s)}${qHead}
      <div class="row">${PRIORITIES.map(p => `<div><label style="text-transform:capitalize">${p} target <small>working h, override</small></label><input type="number" name="sla_${p}" value="${s.sla[p] || ''}"></div>`).join('')}</div>
      <label style="font-weight:400"><input type="checkbox" name="is_active" ${s.is_active ? 'checked' : ''}> Active (shown on the portal)</label>`,
      async f => {
        await api(`/services/${s.id}`, { method: 'PATCH', body: { name: f.elements.name.value, description: f.elements.description.value, form_schema: { fields: fb.get(), icon: f.elements.icon.value, ...typeOf(f) },
          is_active: f.elements.is_active.checked ? 1 : 0, sla: Object.fromEntries(PRIORITIES.map(p => [p, f.elements['sla_' + p].value])) } });
        await api(`/services/${s.id}/members`, { method: 'PUT', body: { user_ids: members(f) } }); toast('Saved'); services(main); });
    d.style.maxWidth = '680px'; wireType(d); fb = formBuilder(d.querySelector('#fb'), schema.fields);
  });
}

// Form type for a service: which built-in question sets the raise form asks.
const FT_HINT = { general: 'Just a location box', location: 'Block · Floor · Location / room', student: 'Branch · Student ID · Department', both: 'Student details + Block · Floor · Room' };
function typePick(sch) {
  const ft = FORM_TYPES[sch.form_type] ? sch.form_type : 'general', l = { ...DEFAULT_LISTS, ...(sch.lists || {}) };
  const ta = (n, label, hint, v) => `<div class="tl" data-l="${n}"><label>${label} <small>${hint}</small></label><textarea name="l_${n}" rows="4" placeholder="One per line">${esc(v.join('\n'))}</textarea></div>`;
  return `<label>Form type <small>(the questions requestors answer for this service)</small></label>
    <div class="ftypes">${Object.entries(FORM_TYPES).map(([k, lab]) => `<label class="ftype"><input type="radio" name="form_type" value="${k}" ${k === ft ? 'checked' : ''}><span><b>${lab}</b><small>${FT_HINT[k]}</small></span></label>`).join('')}</div>
    <div class="row tls">${ta('block', 'Blocks', '(empty = people type it)', l.block)}${ta('floor', 'Floors', '', l.floor)}</div>`;
}
function wireType(d) {
  const f = d.querySelector('form'), sync = () => { const t = f.elements.form_type.value;
    d.querySelectorAll('.tl').forEach(x => { x.style.display = ['location', 'both'].includes(t) ? '' : 'none'; });
    d.querySelectorAll('.ftype').forEach(x => x.classList.toggle('on', x.querySelector('input').checked)); };
  f.querySelectorAll('[name=form_type]').forEach(r => r.onchange = sync); sync();
}
const typeOf = f => { const lines = n => f.elements['l_' + n].value.split('\n').map(x => x.trim()).filter(Boolean);
  return { form_type: f.elements.form_type.value, lists: { block: lines('block'), floor: lines('floor') } }; };

// Visual builder for a service's extra questions, with a live preview of the requestor's form.
const TYPE_NAMES = { short_text: 'Short answer', long_text: 'Paragraph', number: 'Number', date: 'Date', select: 'Dropdown (pick one)',
  multi_select: 'Multiple choice (pick many)', phone: 'Phone number', email: 'Email address', yes_no: 'Yes / No' };
function formBuilder(box, initial = []) {
  const fields = initial.map(f => ({ ...f, options: f.options || [] })), hasOpts = t => t === 'select' || t === 'multi_select';
  const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  const get = () => { const used = new Set(fields.filter(f => f.key).map(f => f.key));
    return fields.filter(f => String(f.label || '').trim()).map(f => {
      let key = f.key; if (!key) { const base = slug(f.label) || 'question'; key = base; for (let n = 2; used.has(key); n++) key = `${base}_${n}`; used.add(key); }
      const o = { key, label: f.label.trim(), type: f.type, required: !!f.required };
      if (hasOpts(f.type)) o.options = f.options.map(x => x.trim()).filter(Boolean); else if (f.placeholder) o.placeholder = f.placeholder;
      return o; }); };
  const preview = () => { const q = get();
    box.querySelector('.preview').innerHTML = `<div class="muted small" style="margin-bottom:-6px">${I('search', 14)} Preview of the extra questions</div>${q.length
      ? customFields({ form_schema: { fields: q.map(f => hasOpts(f.type) && f.options.length < 1 ? { ...f, options: ['…'] } : f) } }) : '<p class="muted small">No extra questions yet.</p>'}`;
    box.querySelectorAll('.preview input,.preview select,.preview textarea').forEach(el => { el.disabled = true; el.removeAttribute('name'); }); };
  const draw = () => {
    box.innerHTML = `<div class="flist">${fields.map((f, i) => `<div class="fld" data-i="${i}">
      <div class="fhead"><span class="fnum">${i + 1}</span><input data-k="label" value="${esc(f.label || '')}" placeholder="Question, e.g. Asset tag">
        <select data-k="type">${FIELD_TYPES.map(t => `<option value="${t}" ${t === f.type ? 'selected' : ''}>${TYPE_NAMES[t]}</option>`).join('')}</select></div>
      ${hasOpts(f.type) ? `<textarea data-k="options" placeholder="One choice per line, e.g.&#10;Wi-Fi&#10;Laptop&#10;Printer">${esc(f.options.join('\n'))}</textarea>`
        : ['yes_no', 'date'].includes(f.type) ? '' : `<input data-k="placeholder" value="${esc(f.placeholder || '')}" placeholder="Hint inside the box (optional), e.g. LAP-0231">`}
      <div class="fact"><label class="switch"><input type="checkbox" data-k="required" ${f.required ? 'checked' : ''}> Required</label><span class="sp"></span>
        <button type="button" class="btn" data-m="-1" ${i ? '' : 'disabled'} title="Move up">↑</button>
        <button type="button" class="btn" data-m="1" ${i < fields.length - 1 ? '' : 'disabled'} title="Move down">↓</button>
        <button type="button" class="btn danger" data-x title="Remove question">✕</button></div></div>`).join('')}</div>
      <button type="button" class="btn soft" data-add style="width:100%">${I('plus', 16)} Add a question</button><div class="preview"></div>`;
    preview();
  };
  box.addEventListener('input', e => { const el = e.target.closest('[data-k]'); if (!el) return;
    const f = fields[+el.closest('.fld').dataset.i], k = el.dataset.k;
    if (k === 'required') f.required = el.checked; else if (k === 'options') f.options = el.value.split('\n'); else f[k] = el.value;
    k === 'type' ? draw() : preview(); });
  box.addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; const i = +b.closest('.fld')?.dataset.i;
    if (b.dataset.add !== undefined) { fields.push({ label: '', type: 'short_text', required: false, options: [] }); draw(); box.querySelector('.fld:last-child [data-k=label]').focus(); }
    else if (b.dataset.m) { const j = i + +b.dataset.m; [fields[i], fields[j]] = [fields[j], fields[i]]; draw(); }
    else if (b.dataset.x !== undefined) { fields.splice(i, 1); draw(); } });
  draw();
  return { get: () => { const bad = fields.find(f => f.label?.trim() && hasOpts(f.type) && f.options.filter(x => x.trim()).length < 2);
    if (bad) throw new Error(`"${bad.label}" needs at least two choices`); return get(); } };
}

// one-off pop-up showing a temporary password with a copy button
function showTemp(title, u, pw) {
  const d = document.createElement('dialog');
  d.innerHTML = `<form method="dialog"><h2>${title}</h2><p class="muted small">Share these with ${esc(u.name)}. They were also emailed to ${esc(u.email)}. At first sign-in they must set their own password.</p>
    <div class="card" style="box-shadow:none"><div class="muted small">Email</div><b>${esc(u.email)}</b><div class="muted small" style="margin-top:8px">Temporary password</div><b class="mono" style="font-size:20px">${esc(pw)}</b></div>
    <p class="row"><button class="btn" type="button" id="cpw">${I('copy', 18)} Copy</button><button class="btn primary" value="ok">Done</button></p></form>`;
  document.body.append(d); d.showModal(); d.onclose = () => d.remove();
  d.querySelector('#cpw').onclick = () => navigator.clipboard.writeText(`ONE Desk sign-in\nEmail: ${u.email}\nTemporary password: ${pw}\n${location.origin}${location.pathname}#/login`).then(() => toast('Copied'));
}

async function users(main, { sa }) {
  const rows = await api('/users'), me = S.me.user;
  const st = JSON.parse(sessionStorage.getItem('uf') || '{"tab":"all","q":""}');
  const canManage = u => sa || u.role === 'provider' || u.id === me.id;
  const roleName = r => ({ tenant_admin: 'Admin', provider: 'Provider' })[r] || r;
  const draw = () => {
    const q = st.q.toLowerCase(), list = rows.filter(u => (st.tab === 'all' ? u.is_active : st.tab === 'inactive' ? !u.is_active : u.is_active && u.role === st.tab)
      && (!q || `${u.name} ${u.email} ${u.phone || ''}`.toLowerCase().includes(q)));
    const n = k => rows.filter(u => k === 'all' ? u.is_active : k === 'inactive' ? !u.is_active : u.is_active && u.role === k).length;
    main.innerHTML = `<div class="filters"><label class="search" style="margin:0">${I('search', 18)}<input id="uq" placeholder="Search name, email, phone…" value="${esc(st.q)}"></label>
      <button class="btn primary" id="add">${I('plus', 18)} Add person</button></div>
      <div class="tabs">${[['all', 'All active'], ['tenant_admin', 'Admins'], ['provider', 'Providers'], ['inactive', 'Inactive']].map(([k, l]) => `<button class="tab ${st.tab === k ? 'on' : ''}" data-t="${k}">${l} · ${n(k)}</button>`).join('')}</div>
      <div class="tlist">${list.map(u => `<div class="trow ${u.is_active ? '' : 'dim'}" style="cursor:default;align-items:flex-start">
        <span class="avatar">${esc(u.name.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase())}</span>
        <div class="tm"><b>${esc(u.name)}${u.id === me.id ? ' <span class="muted small">(you)</span>' : ''}</b>
          <div class="sub"><span>${esc(u.email)}</span>${u.phone ? `·<span>${esc(u.phone)}</span>` : ''}</div>
          <div class="sub" style="margin-top:4px"><span class="pill ${u.role === 'tenant_admin' ? 'p-int' : 'c4'}">${roleName(u.role)}</span>
            ${u.must_change_pw ? '<span class="pill p-medium">Must set password</span>' : ''}${!u.is_active ? '<span class="pill s-closed">Inactive</span>' : ''}
            <span>${u.services ? I('grid', 13) + ' ' + esc(u.services) : u.is_active ? '<span style="color:var(--hold)">No services</span>' : ''}</span>
            <span>· last sign-in ${u.last_login_at ? fmt(u.last_login_at) : 'never'}</span></div></div>
        ${canManage(u) ? `<div class="uact"><button class="btn soft" data-e="${u.id}">Edit</button>
          ${u.id !== me.id && u.is_active ? `<button class="btn" data-r="${u.id}">Reset password</button>` : ''}
          ${u.id !== me.id ? `<button class="btn ${u.is_active ? 'danger' : ''}" data-a="${u.id}">${u.is_active ? 'Deactivate' : 'Activate'}</button>` : ''}</div>` : ''}
      </div>`).join('') || `<div class="empty card">${I('users', 40)}<p>No one here.</p></div>`}</div>`;
    main.querySelectorAll('[data-t]').forEach(b => b.onclick = () => { st.tab = b.dataset.t; save(); draw(); });
    $('#uq').oninput = e => { st.q = e.target.value; save(); const pos = e.target.selectionStart; draw(); $('#uq').focus(); $('#uq').setSelectionRange(pos, pos); };
    $('#add').onclick = () => dlg(`<h2>Add person</h2><label>Full name</label><input name="name" required><label>Email</label><input name="email" type="email" required>
      <label>Phone <small>(optional)</small></label><input name="phone" type="tel"><label>Role</label><select name="role"><option value="provider">Service provider</option>${sa ? '<option value="tenant_admin">Campus admin</option>' : ''}</select>
      <p class="muted small">A temporary password is created and emailed. Assign their services under Services.</p>`,
      async f => { const r = await api('/users', { method: 'POST', body: formVals(f) }); showTemp('Account created', formVals(f), r.temp_password); reload(); });
    main.querySelectorAll('[data-e]').forEach(b => b.onclick = () => { const u = rows.find(x => x.id === b.dataset.e);
      dlg(`<h2>Edit ${esc(u.name)}</h2><label>Full name</label><input name="name" required value="${esc(u.name)}"><label>Email <small>(used to sign in)</small></label><input name="email" type="email" required value="${esc(u.email)}">
        <label>Phone</label><input name="phone" type="tel" value="${esc(u.phone || '')}">
        ${sa && u.id !== me.id ? `<label>Role</label><select name="role"><option value="provider" ${u.role === 'provider' ? 'selected' : ''}>Service provider</option><option value="tenant_admin" ${u.role === 'tenant_admin' ? 'selected' : ''}>Campus admin</option></select>` : ''}`,
        async f => { await api('/users/' + u.id, { method: 'PATCH', body: formVals(f) }); toast('Saved'); reload(); }); });
    main.querySelectorAll('[data-r]').forEach(b => b.onclick = () => { const u = rows.find(x => x.id === b.dataset.r);
      dlg(`<h2>Reset password?</h2><p>${esc(u.name)} gets a new temporary password by email and must set their own at next sign-in. Their old password stops working.</p>`,
        async () => { const r = await api(`/users/${u.id}/reset-password`, { method: 'POST' }); showTemp('Password reset', u, r.temp_password); reload(); }); });
    main.querySelectorAll('[data-a]').forEach(b => b.onclick = () => { const u = rows.find(x => x.id === b.dataset.a), on = !u.is_active;
      dlg(`<h2>${on ? 'Activate' : 'Deactivate'} ${esc(u.name)}?</h2><p class="muted">${on ? 'They can sign in again. Add them back to services under Services.' : 'They can no longer sign in and are removed from their services. Their ticket history stays.'}</p>`,
        async () => { await api('/users/' + u.id, { method: 'PATCH', body: { is_active: on ? 1 : 0 } }); toast(on ? 'Activated' : 'Deactivated'); reload(); }); });
  };
  const save = () => sessionStorage.setItem('uf', JSON.stringify(st)), reload = () => users(main, { sa });
  draw();
}

function setOwnPassword() {
  document.body.className = 'console';
  app.innerHTML = `<div class="wrap hero" style="max-width:440px;padding-top:48px"><div class="logo">${I('shield', 26)}</div>
    <h1>Set your <span>new password</span></h1><p class="muted">Hi ${esc(S.me.user.name.split(' ')[0])}, you signed in with a temporary password. Choose your own to continue.</p>
    <form id="f" class="card"><label style="margin-top:0">New password <small>(8+ characters, letters and numbers)</small></label><input name="password" type="password" required autofocus autocomplete="new-password">
    <label>Confirm new password</label><input name="confirm" type="password" required autocomplete="new-password">
    <div class="err" id="err"></div><p style="margin-bottom:0"><button class="btn dark big">Save and continue ${I('chev', 18)}</button></p></form>
    <p style="text-align:center"><a href="#" id="lo">Sign out</a></p></div>`;
  $('#lo').onclick = e => { e.preventDefault(); logout(); };
  $('#f').onsubmit = async e => { e.preventDefault(); const v = formVals(e.target);
    try { if (v.password !== v.confirm) throw new Error('The two passwords do not match');
      await api('/me/password', { method: 'POST', body: { password: v.password } }); S.me = null; toast('Password set'); route();
    } catch (er) { $('#err').textContent = er.message; } };
}

async function reports(main, { sa }) {
  const days = Number(sessionStorage.getItem('rd') || 30);
  const [r, g] = await Promise.all([api('/reports?days=' + days), sa ? api('/group/report') : null]);
  const c = r.counts || {}, max = Math.max(1, ...r.daily.map(d => d.c));
  const bars = (rows) => rows.map(x => `<div class="brow"><span style="flex:0 0 70px;text-transform:capitalize">${esc(x.k)}</span><div style="flex:1"><div class="bartrack"><div class="bar" style="width:${100 * x.c / Math.max(1, ...rows.map(y => y.c))}%"></div></div></div><span style="flex:0 0 40px" class="mono">${x.c}</span></div>`).join('') || '<p class="muted">No data</p>';
  main.innerHTML = `<div class="filters"><select id="rd">${[7, 30, 90, 365].map(d => `<option value="${d}" ${d === days ? 'selected' : ''}>Last ${d} days</option>`).join('')}</select></div>
    <div class="kpis"><div class="kpi"><span class="muted">Raised</span><b>${c.created_period || 0}</b></div><div class="kpi"><span class="muted">Closed</span><b>${c.closed_period || 0}</b></div>
    <div class="kpi"><span class="muted">Avg hours to close</span><b>${c.avg_hours ?? '—'}</b></div>
    <div class="kpi warn"><span class="muted">Overdue now</span><b>${c.overdue || 0}</b></div></div>
    <div class="two"><div class="card progress" style="margin:0">${ring(c.on_time_pct ?? 0, 110)}<div><b>On-time score</b><div class="muted small">Tickets closed before their due time</div></div></div>
    <div class="card" style="margin:0"><b>Raised per day</b><svg viewBox="0 0 ${Math.max(1, r.daily.length) * 20} 100" style="width:100%;height:110px" preserveAspectRatio="none">
      <polygon fill="var(--brand-2)" points="10,100 ${r.daily.map((d, i) => `${i * 20 + 10},${95 - 90 * d.c / max}`).join(' ')} ${(r.daily.length - 1) * 20 + 10},100"/>
      <polyline fill="none" stroke="var(--brand)" stroke-width="2.5" vector-effect="non-scaling-stroke" points="${r.daily.map((d, i) => `${i * 20 + 10},${95 - 90 * d.c / max}`).join(' ')}"/>${r.daily.map((d, i) => `<circle cx="${i * 20 + 10}" cy="${95 - 90 * d.c / max}" r="3" fill="var(--brand)"/>`).join("")}</svg></div></div>
    <div class="two" style="margin-top:14px"><div class="card"><b>By priority</b>${bars(r.by_priority)}</div><div class="card"><b>Aging of active tickets</b>${bars(r.aging)}</div></div>
    <div class="card" id="lb"></div>
    <div class="card"><b>By service</b><table><tr><th>Service</th><th>Open</th><th>Hold</th><th>Closed</th><th>Rejected</th><th>Overdue</th></tr>
      ${r.by_service.map(s => `<tr><td>${esc(s.name)}</td><td>${s.open}</td><td>${s.hold}</td><td>${s.closed}</td><td>${s.rejected}</td><td>${s.overdue}</td></tr>`).join('')}</table></div>
    ${g ? `<div class="card"><b>Group-wide</b><table><tr><th>Tenant</th><th>Open</th><th>Hold</th><th>Closed</th><th>Overdue</th></tr>${g.map(t => `<tr><td>${esc(t.name)}</td><td>${t.open || 0}</td><td>${t.hold || 0}</td><td>${t.closed || 0}</td><td>${t.overdue || 0}</td></tr>`).join('')}</table></div>` : ''}`;
  api('/points').then(p => $('#lb').innerHTML = leaderboard(p.leaderboard));
  $('#rd').onchange = e => { sessionStorage.setItem('rd', e.target.value); reports(main, { sa }); };
}

async function auditPage(main) {
  const rows = await api('/audit');
  main.innerHTML = `<div class="tblwrap"><table><tr><th>When</th><th>Who</th><th>Action</th><th>Details</th></tr>${rows.map(a => `<tr><td>${fmt(a.created_at)}</td><td>${esc(a.actor)}</td><td class="mono">${esc(a.action)}</td><td style="font-size:12px" class="muted">${esc(a.meta)}</td></tr>`).join('')}</table></div>`;
}

async function tenants(main) {
  const list = (await api('/me')).tenants; S.me.tenants = list;
  main.innerHTML = `<p><button class="btn primary" id="add">+ New tenant</button></p><table><tr><th>Code</th><th>Name</th><th>Portal</th><th>Reopen days</th><th></th></tr>
    ${list.map(t => `<tr class="${t.is_active ? '' : 'dim'}"><td class="mono">${esc(t.code)}</td><td>${esc(t.name)}</td><td><a href="#/d/${t.slug}" target="_blank">/d/${esc(t.slug)}</a></td><td>${t.reopen_window_days}</td>
    <td><button class="btn" data-t="${t.id}" data-a="${t.is_active ? 0 : 1}">${t.is_active ? 'Deactivate' : 'Activate'}</button></td></tr>`).join('')}</table>
    <p class="muted">To add a tenant admin, switch to the tenant (top right), then People → Add person → Tenant admin.</p>`;
  $('#add').onclick = () => dlg(`<h2>New tenant</h2><label>Code</label><input name="code" required placeholder="SMRU"><label>Name</label><input name="name" required>
    <label>Slug (URL)</label><input name="slug" required placeholder="smru"><label>Reopen window days</label><input name="reopen_window_days" type="number" value="7">`,
    async f => { const t = await api('/tenants', { method: 'POST', body: formVals(f) }); S.tenant = t.id; S.me = null; route(); });
  main.querySelectorAll('[data-t]').forEach(b => b.onclick = async () => { await api('/tenants/' + b.dataset.t, { method: 'PATCH', body: { is_active: Number(b.dataset.a) } }); tenants(main); });
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
async function slaPage(main) {
  const [c, pts] = await Promise.all([api('/sla'), api('/points')]);
  const rRow = (r = { label: '', hours: 8 }) => `<div class="row hr" style="margin-top:8px;align-items:center"><input type="hidden" name="hk" value="${esc(r.key || '')}"><input name="hl" value="${esc(r.label)}" placeholder="e.g. Waiting for parts" style="flex:3">
    <input name="hh" type="number" min="1" value="${r.hours}" style="flex:1;min-width:80px" title="Hold limit in working hours"><button type="button" class="btn danger" data-rm style="flex:0 0 auto;min-width:0">✕</button></div>`;
  const badge = (n, cls) => `<span class="pill ${cls}" style="flex:0 0 52px;text-align:center">${n > 0 ? '+' : ''}${n}</span>`;
  main.innerHTML = `<div class="two"><form id="sf" class="card" style="margin:0" novalidate>
    <b>Working hours</b><div class="muted small">The SLA clock only runs inside this window. Evenings, nights and days off don't count.</div>
    <div class="row"><div><label>Starts</label><input type="time" name="work_start" value="${c.work_start}"></div><div><label>Ends</label><input type="time" name="work_end" value="${c.work_end}"></div></div>
    <label>Working days</label><div class="tabs">${DAYS.map((d, i) => `<label class="tab ${c.work_days.includes(i) ? 'on' : ''}" style="margin:0"><input type="checkbox" name="wd" value="${i}" ${c.work_days.includes(i) ? 'checked' : ''} hidden>${d}</label>`).join('')}</div>
    <b style="display:block;margin-top:18px">Time to close, by priority</b><div class="muted small">In working hours. Requestor tickets start as Medium; providers can change the priority.</div>
    <div class="row">${['critical', 'high', 'medium', 'low'].map(p => `<div><label style="text-transform:capitalize">${p}</label><input type="number" min="1" name="t_${p}" value="${c.targets[p] || ''}"><div class="muted small" data-d="${p}"></div></div>`).join('')}</div>
    <b style="display:block;margin-top:18px">Hold reasons — each with its own hold SLA</b><div class="muted small">On hold, the provider picks a reason. The main clock pauses and the hold must end within that many working hours.</div>
    <div class="row muted small" style="margin-top:8px"><span style="flex:3">Reason</span><span style="flex:1;min-width:80px">Hold limit (h)</span><span style="flex:0 0 44px"></span></div>
    <div id="hrs">${c.hold_reasons.map(rRow).join('')}</div><button type="button" class="btn soft" id="addr" style="margin-top:10px">${I('plus', 16)} Add reason</button>
    <div class="err" id="err"></div><p style="margin-bottom:0"><button class="btn primary big">Save SLA settings</button></p></form>
    <div><div class="card" style="margin-top:0"><b>How providers earn points</b><div class="muted small">Given to whoever closes the ticket, by how much of the SLA window they used.</div>
      ${c.point_rules.map(r => `<div class="brow">${badge(r.points, r.points > 0 ? 'p-low' : 'p-high')}<div>${esc(r.reason)}</div></div>`).join('')}
      <div class="brow">${badge(c.points.reopened, 'p-high')}<div>Requestor reopens a ticket you closed</div></div>
      <div class="brow">${badge(c.points.holdBreach, 'p-high')}<div>A hold you started runs past its hold SLA</div></div></div>
    <div class="card">${leaderboard(pts.leaderboard)}</div></div></div>`;
  const f = $('#sf'), len = () => { const [a, b] = [f.work_start.value, f.work_end.value].map(v => +v.slice(0, 2) * 60 + +v.slice(3)); return Math.max(1, (b - a) / 60); };
  const hints = () => ['critical', 'high', 'medium', 'low'].forEach(p => { const h = +f['t_' + p].value, d = h / len();
    main.querySelector(`[data-d=${p}]`).textContent = h ? (d >= 1 ? `≈ ${+d.toFixed(1)} working day${d === 1 ? '' : 's'}` : `${h}h`) : ''; });
  hints(); f.oninput = hints;
  f.querySelectorAll('[name=wd]').forEach(i => i.onchange = () => i.parentElement.classList.toggle('on', i.checked));
  $('#addr').onclick = () => $('#hrs').insertAdjacentHTML('beforeend', rRow());
  $('#hrs').onclick = e => { if (e.target.closest('[data-rm]')) e.target.closest('.hr').remove(); };
  f.onsubmit = async e => { e.preventDefault(); $('#err').textContent = '';
    try { await api('/sla', { method: 'PUT', body: { work_start: f.work_start.value, work_end: f.work_end.value,
        work_days: [...f.querySelectorAll('[name=wd]:checked')].map(i => +i.value),
        targets: Object.fromEntries(['critical', 'high', 'medium', 'low'].map(p => [p, f['t_' + p].value])),
        hold_reasons: [...f.querySelectorAll('.hr')].map(r => ({ key: r.querySelector('[name=hk]').value || undefined, label: r.querySelector('[name=hl]').value, hours: r.querySelector('[name=hh]').value })) } });
      toast('SLA settings saved'); slaPage(main);
    } catch (er) { $('#err').textContent = er.message; } };
}

// ================= EMAIL (Power Automate) =================
const MAIL_STATUS = { sent: 's-open', failed: 's-rejected', queued: 's-hold', skipped: 's-closed', logged: 's-closed' };
const copyBox = (text, label = 'Copy') => `<div class="codebox"><pre>${esc(text)}</pre><button type="button" class="btn soft" data-copy="${esc(text)}">${I('copy', 15)} ${label}</button></div>`;
const wireCopy = root => root.querySelectorAll('[data-copy]').forEach(b => b.onclick = () => navigator.clipboard.writeText(b.dataset.copy).then(() => toast('Copied')));

async function emailPage(main, { sa }) {
  const tabs = sa ? [['connect', 'Connection'], ['events', 'Emails sent'], ['log', 'Delivery log'], ['guide', 'Setup guide']] : [['log', 'Delivery log']];
  let tab = sessionStorage.getItem('et'); if (!tabs.some(t => t[0] === tab)) tab = tabs[0][0];
  main.innerHTML = `<div class="tabs">${tabs.map(([k, l]) => `<button class="tab ${k === tab ? 'on' : ''}" data-tab="${k}">${l}</button>`).join('')}</div><div id="etab">Loading…</div>`;
  main.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { sessionStorage.setItem('et', b.dataset.tab); emailPage(main, { sa }); });
  const box = $('#etab');
  try { await { connect: mailConnect, events: mailEvents, log: mailLog, guide: mailGuide }[tab](box, () => emailPage(main, { sa }), sa); }
  catch (e) { box.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
}

async function mailConnect(box, reload) {
  const c = await api('/mail/config'), st = c.stats || {};
  const [label, cls, sub] = !c.url ? ['Not connected', 's-closed', 'Emails are only printed in the server log until a flow is connected.']
    : !c.sending ? ['Paused', 's-hold', 'Connected, but sending is paused: emails are logged, not sent.']
    : ['Connected', 's-open', c.last_ok_at ? `Last email delivered ${fmt(c.last_ok_at)}` : 'No email delivered yet. Send a test below.'];
  box.innerHTML = `<div class="card progress" style="justify-content:space-between;flex-wrap:wrap"><div style="display:flex;gap:14px;align-items:center"><span class="chip c0">${I('mail', 22)}</span>
      <div><b>Power Automate</b> <span class="pill ${cls}">${label}</span><div class="muted small">${sub}</div></div></div>
      <div class="row" style="flex:0 1 auto;gap:18px">${['sent', 'failed', 'queued', 'skipped'].map(k => `<div style="min-width:0"><b style="font-size:20px">${st[k] || 0}</b><div class="muted small" style="text-transform:capitalize">${k} (7d)</div></div>`).join('')}</div></div>
    <div class="two"><form id="cf" class="card" style="margin:0">
      <b>Connection</b><div class="muted small">Paste the values from your flow. See the Setup guide tab for building it.</div>
      <label>Flow URL <small>(the trigger's HTTP URL)</small></label><textarea name="url" rows="3" class="mono" style="font-size:12px;min-height:76px" placeholder="https://…">${esc(c.url)}</textarea>
      <label>Secret key <small>(must match the flow's Condition step)</small></label>
      <div class="row" style="gap:8px"><input name="key" class="mono" style="flex:3" autocomplete="off" placeholder="${c.has_key ? `Saved (${esc(c.key_masked)}). Leave empty to keep it` : 'Generate or paste a key'}">
        <button type="button" class="btn soft" id="gen" style="flex:0 0 auto">Generate</button>${c.has_key ? '<button type="button" class="btn soft" id="cpk" style="flex:0 0 auto">' + I('copy', 15) + ' Copy saved key</button>' : ''}</div>
      <div id="keynote" class="muted small"></div>
      <label>Public address of ONE Desk <small>(links inside emails)</small></label><input name="base" value="${esc(c.base)}" placeholder="https://desk.supercxo.ai">
      <label class="switch" style="margin-top:14px"><input type="checkbox" name="sending" ${c.sending ? 'checked' : ''}> Send emails <span class="muted small">(untick to pause; emails are then only logged)</span></label>
      <div class="err" id="cerr"></div><p style="margin-bottom:0"><button class="btn primary big">Save connection</button></p></form>
    <div class="card" style="margin:0"><b>Send a test email</b><div class="muted small">Uses the values in the form, even before you save. Try a Gmail, a Yahoo and an Outlook address.</div>
      <label>Send to</label><div class="row" style="gap:8px"><input id="tto" type="email" placeholder="yourname@gmail.com" value="${esc(S.me.user.email)}" style="flex:3">
      <button type="button" class="btn primary" id="tsend" style="flex:0 0 auto">${I('send', 16)} Send test</button></div><div id="tres"></div>
      <div class="muted small" style="margin-top:16px">Sender: whichever mailbox the flow's "Send an email from a shared mailbox" step uses (Digital Services).</div></div></div>`;
  const f = $('#cf');
  $('#gen').onclick = () => { const k = [...crypto.getRandomValues(new Uint8Array(24))].map(b => b.toString(16).padStart(2, '0')).join('');
    f.key.value = k; $('#keynote').innerHTML = `New key. Copy it into the flow's Condition step, then save here.${copyBox(k)}`; wireCopy($('#keynote')); };
  if ($('#cpk')) $('#cpk').onclick = async () => { const { key } = await api('/mail/key'); await navigator.clipboard.writeText(key); toast('Saved key copied. Paste it in the flow\'s Condition'); };
  f.onsubmit = async e => { e.preventDefault(); $('#cerr').textContent = '';
    try { await api('/mail/config', { method: 'PUT', body: { url: f.url.value, key: f.key.value || undefined, base: f.base.value, sending: f.sending.checked } }); toast('Connection saved'); reload(); }
    catch (er) { $('#cerr').textContent = er.message; } };
  $('#tsend').onclick = async () => { const b = $('#tsend'); b.disabled = true; $('#tres').innerHTML = '<p class="muted small">Sending…</p>';
    try { const r = await api('/mail/test', { method: 'POST', body: { to: $('#tto').value, url: f.url.value, key: f.key.value } });
      $('#tres').innerHTML = `<div class="slabox ${r.ok ? '' : 'late'}" style="${r.ok ? 'background:var(--ok-2);color:var(--ok)' : ''}">${I(r.ok ? 'check' : 'alert', 20)}
        <div><b>${r.ok ? 'Sent to Power Automate' : 'Not sent'}${r.status ? ` · HTTP ${r.status}` : ''}${r.ms ? ` · ${r.ms} ms` : ''}</b><div class="small">${esc(r.hint)}${r.ok ? ' Check the inbox, and the spam folder.' : ''}</div></div></div>`;
    } catch (er) { $('#tres').innerHTML = `<p class="err">${esc(er.message)}</p>`; }
    b.disabled = false; };
}

async function mailEvents(box) {
  const c = await api('/mail/config');
  box.innerHTML = `<p class="muted small">Every step that sends an email. Each one has its own template: click <b>Edit template</b> to change the subject and message.
    Switch one off and it is recorded as "skipped" in the delivery log instead of being sent.</p>
    <div class="tlist">${c.events.map(e => `<div class="trow" style="cursor:default"><label class="switch" title="Send this email"><input type="checkbox" data-ev="${e.key}" ${e.on ? 'checked' : ''}></label>
      <div class="tm"><b>${esc(e.label)} ${e.custom ? '<span class="pill p-int">Customised</span>' : ''}</b>
        <div class="sub"><span class="pill c4">${esc(e.who)}</span><span>${esc(e.when)}</span></div><div class="sub mono" style="margin-top:2px">${esc(e.subject)}</div></div>
      <div class="uact"><button class="btn soft" data-ed="${e.key}">Edit template</button><button class="btn" data-pv="${e.key}">Preview</button></div></div>`).join('')}</div>`;
  box.querySelectorAll('[data-ev]').forEach(i => i.onchange = async () => {
    try { await api('/mail/config', { method: 'PUT', body: { events: { [i.dataset.ev]: i.checked } } }); toast(i.checked ? 'Email switched on' : 'Email switched off'); }
    catch (er) { i.checked = !i.checked; toast(er.message); } });
  box.querySelectorAll('[data-pv]').forEach(b => b.onclick = async () => {
    const r = await api('/mail/preview', { method: 'POST', body: { key: b.dataset.pv } });
    const d = document.createElement('dialog'); d.style.maxWidth = '640px';
    d.innerHTML = `<form method="dialog"><h2>${esc(c.events.find(e => e.key === b.dataset.pv).label)}</h2><div class="muted small">Subject</div><b>${esc(r.subject)}</b>
      <iframe style="width:100%;height:440px;border:1px solid var(--line);border-radius:12px;margin-top:10px"></iframe><p class="row"><button class="btn primary" value="ok">Close</button></p></form>`;
    document.body.append(d); d.querySelector('iframe').srcdoc = r.html; d.showModal(); d.onclose = () => d.remove(); });
  box.querySelectorAll('[data-ed]').forEach(b => b.onclick = () => templateEditor(c, c.events.find(e => e.key === b.dataset.ed), () => mailEvents(box)));
}

// Edit one step's email: fields to insert, live preview with sample values, reset to default.
function templateEditor(c, e, done) {
  const links = e.vars.filter(v => v.endsWith('_link'));
  const d = document.createElement('dialog'); d.style.maxWidth = '1080px';
  d.innerHTML = `<form method="dialog" id="tf"><h2>${esc(e.label)} <span class="muted small" style="font-weight:400">→ ${esc(e.who)}</span></h2>
    <div class="two" style="align-items:start"><div>
      <label style="margin-top:0">Subject</label><input name="subject" value="${esc(e.subject)}" class="mono" style="font-size:13.5px">
      <label>Message</label><textarea name="body" class="mono" style="min-height:260px;font-size:13px;line-height:1.6">${esc(e.body)}</textarea>
      <div class="muted small" style="margin:10px 0 6px">Click to insert at the cursor:</div>
      <div class="chips">${e.vars.filter(v => !BLOCK_FIELDS.includes(v)).map(v => `<button type="button" class="chip-btn" data-ins="{{${v}}}" title="${esc(c.vars[v] || '')}">${v}</button>`).join('')}</div>
      ${e.vars.some(v => BLOCK_FIELDS.includes(v)) ? `<div class="muted small" style="margin:10px 0 6px">Designed sections (put each on its own line):</div><div class="chips">${BLOCK_FIELDS.filter(v => e.vars.includes(v)).map(v =>
        `<button type="button" class="chip-btn blk" data-ins="\n{{${v}}}\n" title="${esc(c.vars[v] || '')}">▦ ${{ progress: 'Progress tracker', ticket_details: 'Ticket details', timeline: 'Latest updates' }[v]}</button>`).join('')}</div>` : ''}
      <div class="chips" style="margin-top:8px">${links.length ? `<button type="button" class="chip-btn alt" data-ins="[[Button text|{{${links[0]}}}]]">+ Button</button>` : ''}<button type="button" class="chip-btn alt" data-ins="**bold text**">+ Bold</button></div>
      <div class="muted small" style="margin-top:10px;line-height:1.6"><b>Tips:</b> <code>{{field}}</code> is replaced with the real value · a line whose fields are all empty is left out ·
        <code>[[Text|{{${links[0] || 'login_link'}}}]]</code> on its own line becomes a button · <code>**text**</code> is bold · start the subject with <code>[{{ticket_no}}]</code> so replies thread by ticket.</div>
      <div class="err" id="terr"></div></div>
    <div><div class="muted small">Preview with sample values</div><div id="tsub" style="font-weight:600;margin:4px 0 8px"></div>
      <iframe id="tpv" style="width:100%;height:470px;border:1px solid var(--line);border-radius:12px;background:#f3f4fb"></iframe></div></div>
    <p class="row" style="justify-content:space-between"><span>${e.custom ? '<button type="button" class="btn danger" id="trs">Reset to default</button>' : ''}</span>
      <span class="row" style="flex:0 0 auto"><button class="btn" value="cancel" formnovalidate>Cancel</button><button type="button" class="btn primary" id="tsv">Save template</button></span></p></form>`;
  document.body.append(d); d.showModal(); d.onclose = () => d.remove();
  const f = d.querySelector('#tf'); let last = f.body, timer;
  const preview = async () => { try { const r = await api('/mail/preview', { method: 'POST', body: { key: e.key, subject: f.subject.value, body: f.body.value } });
      d.querySelector('#tsub').textContent = r.subject; d.querySelector('#tpv').srcdoc = r.html;
      d.querySelector('#terr').textContent = r.unknown.length ? `Not available in this email: ${r.unknown.map(n => `{{${n}}}`).join(', ')}` : '';
    } catch (er) { d.querySelector('#terr').textContent = er.message; } };
  [f.subject, f.body].forEach(el => { el.onfocus = () => last = el; el.oninput = () => { clearTimeout(timer); timer = setTimeout(preview, 300); }; });
  d.querySelectorAll('[data-ins]').forEach(b => b.onclick = () => { const el = last, t = b.dataset.ins, a = el.selectionStart ?? el.value.length, z = el.selectionEnd ?? a;
    el.value = el.value.slice(0, a) + t + el.value.slice(z); el.focus(); el.setSelectionRange(a + t.length, a + t.length); preview(); });
  const save = async (subject, body, msg) => { try { await api(`/mail/template/${e.key}`, { method: 'PUT', body: { subject, body } }); toast(msg); d.close(); done(); }
    catch (er) { d.querySelector('#terr').textContent = er.message; } };
  d.querySelector('#tsv').onclick = () => save(f.subject.value, f.body.value, 'Template saved');
  if (d.querySelector('#trs')) d.querySelector('#trs').onclick = () => { if (confirm('Go back to the default wording for this email?')) save('', '', 'Back to the default template'); };
  preview();
}

async function mailLog(box, reload, sa) {
  const st = JSON.parse(sessionStorage.getItem('ml') || '{"status":"all","q":""}');
  const rows = await api(`/mail/log?status=${st.status}&q=${encodeURIComponent(st.q)}`);
  const failed = rows.filter(r => r.status === 'failed').map(r => r.id);
  box.innerHTML = `<div class="filters"><label class="search" style="margin:0">${I('search', 18)}<input id="mq" placeholder="Search email address or subject…" value="${esc(st.q)}"></label>
      ${failed.length ? `<button class="btn primary" id="rall">Resend ${failed.length} failed</button>` : ''}</div>
    <div class="tabs">${['all', 'sent', 'failed', 'queued', 'skipped', 'logged'].map(k => `<button class="tab ${st.status === k ? 'on' : ''}" data-s="${k}" style="text-transform:capitalize">${k}</button>`).join('')}</div>
    <div class="tblwrap"><table><tr><th>When</th><th>To</th><th>Subject</th>${sa ? '<th>Campus</th>' : ''}<th>Status</th><th></th></tr>
    ${rows.map(r => `<tr><td class="small">${fmt(r.created_at)}</td><td>${esc(r.recipient)}</td><td>${esc(r.subject)}${r.last_error ? `<div class="small" style="color:var(--warn)">${esc(r.last_error)}</div>` : ''}</td>
      ${sa ? `<td>${esc(r.campus || '—')}</td>` : ''}<td><span class="pill ${MAIL_STATUS[r.status] || ''}">${r.status}</span>${r.attempts > 1 ? `<div class="muted small">${r.attempts} tries</div>` : ''}</td>
      <td>${['failed', 'logged', 'skipped'].includes(r.status) && r.template_key !== 'test' ? `<button class="btn soft" data-rs="${r.id}" style="min-height:34px">Resend</button>` : ''}</td></tr>`).join('')
      || `<tr><td colspan="6" class="muted">No emails here.</td></tr>`}</table></div>
    <p class="muted small">Sent = handed to Power Automate. Logged = no flow connected or sending paused. Skipped = that email is switched off. Failed = gave up after 4 tries.</p>`;
  const save = () => sessionStorage.setItem('ml', JSON.stringify(st));
  box.querySelectorAll('[data-s]').forEach(b => b.onclick = () => { st.status = b.dataset.s; save(); mailLog(box, reload, sa); });
  $('#mq').onchange = e => { st.q = e.target.value; save(); mailLog(box, reload, sa); };
  const resend = async ids => { const r = await api('/mail/resend', { method: 'POST', body: { ids } }); toast(`${r.queued} email(s) queued`); setTimeout(() => mailLog(box, reload, sa), 1500); };
  box.querySelectorAll('[data-rs]').forEach(b => b.onclick = () => resend([b.dataset.rs]));
  if ($('#rall')) $('#rall').onclick = () => resend(failed);
}

function mailGuide(box) {
  const schema = JSON.stringify({ type: 'object', properties: { to: { type: 'string' }, subject: { type: 'string' }, html: { type: 'string' }, text: { type: 'string' } }, required: ['to', 'subject', 'html'] }, null, 2);
  const step = (n, title, html) => `<div class="card"><div style="display:flex;gap:12px"><span class="fnum" style="width:30px;height:30px;flex-basis:30px">${n}</span><div style="flex:1;min-width:0"><b>${title}</b>${html}</div></div></div>`;
  box.innerHTML = `<p class="muted small">Build this once in Power Automate, signed in as an account with "Send As" rights on the Digital Services mailbox. The HTTP trigger is a Premium connector.</p>
    ${step(1, 'Create the flow', `<p>Go to <a href="https://make.powerautomate.com" target="_blank">make.powerautomate.com</a> → <b>+ Create</b> → <b>Instant cloud flow</b> → <b>Skip</b>. Name it <b>ONE Desk – Send Email</b>.</p>`)}
    ${step(2, 'Add the trigger "When a HTTP request is received"', `<p>Set <b>Who can trigger the flow?</b> to <b>Anyone</b>. Paste this into <b>Request Body JSON Schema</b>:</p>${copyBox(schema)}`)}
    ${step(3, 'Check the secret key', `<p>Add <b>Condition</b>. Left box → <b>fx</b> → paste:</p>${copyBox("triggerOutputs()?['headers']?['x-desk-key']")}<p>Middle: <b>is equal to</b>. Right box: the secret key from the <b>Connection</b> tab (use <b>Generate</b> there to make one).</p>`)}
    ${step(4, 'If yes: send the email', `<p>Inside <b>True</b> add <b>Send an email from a shared mailbox (V2)</b>:</p>
      <div class="tblwrap"><table><tr><td>Original Mailbox Address</td><td>${copyBox('digitalservices@stmarysgroup.com')}</td></tr><tr><td>To</td><td>Dynamic content → <b>to</b></td></tr>
      <tr><td>Subject</td><td>Dynamic content → <b>subject</b></td></tr><tr><td>Body</td><td>Dynamic content → <b>html</b></td></tr></table></div>
      <p>Then, still inside <b>True</b>, add <b>Response</b> with Status Code <b>200</b> and Body:</p>${copyBox('{ "ok": true }')}`)}
    ${step(5, 'If no: reject the call', `<p>Inside <b>False</b> add <b>Response</b> with Status Code <b>401</b> and Body:</p>${copyBox('{ "error": "bad key" }')}`)}
    ${step(6, 'Save, copy the URL, connect', `<p>Click <b>Save</b>, open the trigger again and copy its <b>HTTP URL</b>. Paste it on the <b>Connection</b> tab with the same secret key, set the public address (e.g. <code>https://desk.supercxo.ai</code>), <b>Save</b>, then <b>Send test</b>.</p>`)}
    ${step(7, 'Reach Gmail, Yahoo and every inbox (not spam)', `<p>Your domain admin adds these once for <b>stmarysgroup.com</b>:</p>
      <p><b>SPF</b>: if a <code>v=spf1</code> TXT record exists, add <code>include:spf.protection.outlook.com</code> to it (never create a second one). Otherwise add TXT:</p>${copyBox('v=spf1 include:spf.protection.outlook.com -all')}
      <p><b>DKIM</b>: security.microsoft.com → Email &amp; collaboration → Policies &amp; rules → Threat policies → Email authentication settings → DKIM → stmarysgroup.com. Add the two CNAME records it shows, then <b>Enable</b>.</p>
      <p><b>DMARC</b>: add a TXT record named <code>_dmarc</code>:</p>${copyBox('v=DMARC1; p=none; rua=mailto:digitalservices@stmarysgroup.com')}
      <p>Check: open a test email in Gmail → <b>⋮</b> → <b>Show original</b>. SPF, DKIM and DMARC should all say <b>PASS</b>.</p>`)}`;
  wireCopy(box);
}

async function profile(main) {
  const u = S.me.user, [r, svcs, pts] = S.tenant ? await Promise.all([api('/reports?days=7'), api('/services'), api('/points')]) : [{ counts: {} }, [], { me: 0, history: [] }];
  const mine = u.role === 'provider' ? svcs.filter(s => s.members.some(m => m.id === u.id)) : svcs;
  main.innerHTML = `<div style="max-width:560px;margin:0 auto"><div class="profile"><div class="avatar">${u.name.split(' ').map(w => w[0]).slice(0, 2).join('')}</div>
    <h2 style="margin:0">${esc(u.name)}</h2><div class="muted">${esc(u.email)}</div><div class="muted small" style="text-transform:capitalize">${u.role.replace('_', ' ')}${tenantObj() ? ' · ' + esc(tenantObj().name) : ''}</div>
    <div class="pstats" style="grid-template-columns:repeat(4,1fr)"><div><b>⭐ ${pts.me}</b><span>Points</span></div><div><b>${r.counts.open || 0}</b><span>Open</span></div><div><b>${r.counts.closed_period || 0}</b><span>Closed (7d)</span></div><div><b>${mine.length}</b><span>Services</span></div></div></div>
    ${pts.history.length ? `<div class="card"><b>Recent points</b>${pts.history.map(h => `<div class="brow"><span class="pill ${h.points > 0 ? 'p-low' : 'p-high'}" style="flex:0 0 48px;text-align:center">${h.points > 0 ? '+' : ''}${h.points}</span>
      <div>${esc(h.reason)}<div class="muted small">${h.ticket_id ? `<a href="#/c/t/${h.ticket_id}">#${h.ticket_no}</a> · ` : ''}${fmt(h.created_at)}</div></div></div>`).join('')}</div>` : ''}
    <div class="menu">${S.nav.filter(([h]) => h !== 'c').map(([h, l, ic]) => `<a href="#/${h}">${I(ic)}${l}<span class="chev">${I('chev', 18)}</span></a>`).join('')}
      <a href="#" id="pw">${I('settings')}Change password<span class="chev">${I('chev', 18)}</span></a></div>
    <button class="btn big" id="lo" style="color:var(--warn)">${I('logout')} Log out</button></div>`;
  $('#lo').onclick = logout;
  $('#pw').onclick = e => { e.preventDefault(); dlg(`<h2>Change password</h2><label>Current password</label><input name="current" type="password" required autocomplete="current-password">
    <label>New password <small>(8+ characters, letters and numbers)</small></label><input name="password" type="password" minlength="8" required autocomplete="new-password">
    <label>Confirm new password</label><input name="confirm" type="password" required autocomplete="new-password">`,
    async f => { if (f.elements.password.value !== f.elements.confirm.value) throw new Error('The two new passwords do not match');
      await api('/me/password', { method: 'POST', body: formVals(f) }); toast('Password changed'); }); };
}

// ================= ROUTER =================
async function route() {
  document.onkeydown = null; clearInterval(pollT);
  const [p, qs] = location.hash.slice(1).split('?'), q = new URLSearchParams(qs), seg = p.split('/').filter(Boolean);
  try {
    if (seg[0] === 'd' && seg[2] === 't') return await ticketPage(seg[1], seg[3], q);
    if (seg[0] === 'd' && seg[2] === 'track') return await track(seg[1]);
    if (seg[0] === 'd') return await portal(seg[1], q, seg[2], seg[3] && decodeURIComponent(seg[3]));
    if (seg[0] === 'login') return login();
    if (seg[0] === 'c') {
      const page = seg.slice(0, 2).join('/');
      const map = { c: queue, 'c/new': newTicket, 'c/attention': attention, 'c/services': services, 'c/users': users, 'c/reports': reports, 'c/sla': slaPage, 'c/email': emailPage, 'c/audit': auditPage, 'c/tenants': tenants, 'c/me': profile };
      if (seg[1] === 't') return await shell('c', (m, ctx) => workspace(m, seg[2], ctx), 'Ticket');
      return await shell(page, map[page] || queue, page === 'c/me' ? 'Profile' : undefined);
    }
    document.body.className = '';
    const camps = await api('/public');
    if (camps.length === 1) return location.replace(`#/d/${camps[0].slug}`);
    if (!camps.length) { app.innerHTML = `<div class="wrap hero"><div class="logo">${I('grid', 26)}</div><h1>ONE <span>Desk</span></h1>
      <p class="muted">The service desk is being set up. Please check back soon.</p><p class="muted" style="margin-top:20px">Staff? <a href="#/login">Sign in</a></p></div>`; return; }
    app.innerHTML = `<div class="wrap hero"><div class="logo">${I('grid', 26)}</div><h1>ONE <span>Desk</span></h1><p class="muted">St. Mary's Group service desk. Choose your campus.</p>
      ${camps.map((c, i) => `<a class="svc" href="#/d/${c.slug}"><span class="chip c${i % 5}">${I('building', 22)}</span><span class="t"><b>${esc(c.name)}</b><span class="muted small">${esc(c.code)}</span></span><span class="chev">${I('chev')}</span></a>`).join('')}
      <p class="muted" style="text-align:center;margin-top:20px">Staff? <a href="#/login">Sign in</a></p></div>`;
  } catch (e) { app.innerHTML = `<div class="wrap"><h1>Not found</h1><p class="muted">${esc(e.message)}</p><a href="#/">Home</a></div>`; }
}
addEventListener('hashchange', route);
route();
