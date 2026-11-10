import { allowedTargets, STATUS_WORDS, PRIORITIES, REQUESTOR_TYPES, WHO_FIELDS, otherOf, MAX_FILES, FIELD_TYPES, FORM_TYPES, DEFAULT_LISTS, builtinFields, fieldsOf, hasLocation, hasStudent, isGeneral, STATUSES, STATUS_INFO, ACTIVE, isFood, MEALS, MEAL_NAMES, MEAL_COLORS, FOOD_CHIPS, FOOD_CATEGORIES, CATEGORY_CHIPS, mealAt } from './shared.js';
import { installBtnHtml, iosHintHtml, mountGuide, stickyInstall, canInstall } from './install.js';

const $ = s => document.querySelector(s), app = $('#app');
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = iso => iso ? new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) : '—';
const toast = m => { const t = $('#toast'); t.textContent = m; t.style.display = 'block'; clearTimeout(t._h); t._h = setTimeout(() => t.style.display = 'none', 3500); };
// ---------- shared components (design system) ----------
// StatusPill: white pill with a 7px dot in the status colour (statuses without their own colour use the neutral grey)
const ST_VAR = { open: 'open', in_progress: 'progress', hold: 'hold', closed: 'closed', overdue: 'overdue' };
const ST_LABEL = { overdue: 'Overdue', escalated: 'Escalated', queued: 'In queue' };
const pill = s => `<span class="pill st s-${s}"><i class="sdot" style="background:var(--st-${ST_VAR[s] || 'neutral'})"></i>${STATUS_INFO[s]?.[0] || ST_LABEL[s] || esc(s)}</span>`;
// StatusIcon: a circle icon stroked in the darker status colour
const ST_ICON = { open: 'cdot', in_progress: 'cplay', hold: 'cpause', closed: 'ccheck', overdue: 'calert', rejected: 'cx' };
const statusIcon = (s, size = 18) => `<span class="sicon" style="color:${ST_VAR[s] ? `var(--st-${ST_VAR[s]}-icon)` : 'var(--st-neutral)'}" aria-hidden="true">${I(ST_ICON[s] || 'cdot', size)}</span>`;
// PriorityTag: flag + label in the priority colour; the pill variant adds the soft background
const priorityTag = (p, asPill = false) => `<span class="ptag pr-${p} ${asPill ? 'pv' : ''}">${I('flag', 12)}${cap(p)}</span>`;
// Requester-type badge: Student is plain white; faculty, staff, parent and visitor each have their own colour, for a quick visual identity
const rtBadge = t => t ? `<span class="rtb rt-${esc(t)}">${esc(cap(t))}</span>` : '';
// CardHeading: 28px icon tile + title
const TONE = { clock: 'amber', bell: 'amber', alarm: 'amber', cpause: 'amber', star: 'amber', utensils: 'amber', user: 'blue', history: 'blue', file: 'blue', mail: 'blue', home: 'blue', chart: 'blue', ticket: 'blue',
  users: 'violet', grid: 'violet', building: 'violet', settings: 'slate', download: 'green', pencil: 'green', ccheck: 'green', shield: 'green', check: 'green', flag: 'rose', calert: 'rose', alert: 'rose', swap: 'teal', eye: 'teal', copy: 'slate', plus: 'blue' };
const tile = (icon, size = 16) => `<span class="tile t-${TONE[icon] || 'slate'}">${I(icon, size)}</span>`;
const cardHeading = (icon, title) => `<div class="chead">${tile(icon)}<span>${title}</span></div>`;
// Avatar: initials in a circle; sizes 24/28/32/36/40/44; variants neutral, dark, accent
const initialsOf = n => String(n || '?').trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
const avatar = (name, size = 36, variant = 'neutral') => `<span class="av av-${size} ${variant === 'neutral' ? '' : 'av-' + variant}" aria-hidden="true">${esc(initialsOf(name))}</span>`;
// EmptyState: a 600 title and one grey line
const emptyState = (title, line = '') => `<div class="empty"><span class="et">${title}</span>${line ? `<span>${line}</span>` : ''}</div>`;
const cap = s => String(s).charAt(0).toUpperCase() + String(s).slice(1);
const ppill = p => priorityTag(p, true);
const I = (n, s = 20) => `<svg aria-hidden="true" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${{
  home: '<path d="M3 11l9-8 9 8v9a2 2 0 0 1-2 2h-4v-7H9v7H5a2 2 0 0 1-2-2z"/>', tasks: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M8 12l3 3 5-6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>', chart: '<path d="M4 20V10M10 20V4M16 20v-6M22 20H2"/>', grid: '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
  users: '<circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0 1 14 0M17 4a4 4 0 0 1 0 8M22 21a7 7 0 0 0-5-6.7"/>', user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0v5l2 3H4l2-3zM10 20a2 2 0 0 0 4 0"/>', alarm: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2M5 3 2 6M22 6l-3-3"/>', list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  building: '<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M9 6h2M13 6h2M9 10h2M13 10h2M9 14h2M13 14h2M10 22v-4h4v4"/>', chev: '<path d="M9 6l6 6-6 6"/>', back: '<path d="M15 6l-6 6 6 6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>', camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3"/>', image: '<rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-8 8"/>',
  check: '<path d="M5 12l5 5L20 7"/>', play: '<path d="M7 4.5v15l12-7.5z"/>', xmark: '<path d="M6 6l12 12M18 6L6 18"/>', clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', alert: '<circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/>', pause: '<path d="M8 5v14M16 5v14"/>',
  wifi: '<path d="M2 9a15 15 0 0 1 20 0M6 13a9 9 0 0 1 12 0M10 17a3 3 0 0 1 4 0M12 20h.01"/>', bolt: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>', bed: '<path d="M3 18V8M3 12h18v6M7 12V9h5v3M21 18v-2"/>', bus: '<rect x="4" y="3" width="16" height="15" rx="3"/><path d="M4 10h16M8 18v2M16 18v2M8 14h.01M16 14h.01"/>',
  logout: '<path d="M10 17l-5-5 5-5M5 12h11M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/>', settings: '<circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1l2-1.5-2-3.5-2.3 1a7 7 0 0 0-1.7-1L14.5 3h-5l-.4 2.5a7 7 0 0 0-1.7 1l-2.3-1-2 3.5 2 1.5a7 7 0 0 0 0 2l-2 1.5 2 3.5 2.3-1a7 7 0 0 0 1.7 1l.4 2.5h5l.4-2.5a7 7 0 0 0 1.7-1l2.3 1 2-3.5-2-1.5c.1-.3.1-.7.1-1z"/>',
  tool: '<path d="M14.7 6.3a4 4 0 0 0 5 5L21 13l-8 8-3-3 8-8zM3 21l6-6"/><path d="M7 3l4 4-2 2-4-4z"/>', drop: '<path d="M12 3s6 7 6 11a6 6 0 0 1-12 0c0-4 6-11 6-11z"/>',
  book: '<path d="M4 4h6a3 3 0 0 1 3 3v13a2 2 0 0 0-2-2H4zM20 4h-5a2 2 0 0 0-2 2"/><path d="M20 4v14h-7"/>', cash: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 10v4M18 10v4"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>', eyeoff: '<path d="M9.9 4.2A10 10 0 0 1 12 4c6.500 0 10 8 10 8a13 13 0 0 1-1.700 2.700M6.600 6.600A13 13 0 0 0 2 12s3.500 8 10 8a10 10 0 0 0 5.400-1.600M2 2l20 20M9.900 9.900a3 3 0 1 0 4.200 4.200"/>',
  swap: '<path d="M8 3 4 7l4 4M4 7h16M16 21l4-4-4-4M20 17H4"/>', file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v5h6M16 13H8M16 17H8M10 9H8"/>',
  history: '<path d="M3 12a9 9 0 1 0 9-9 9.700 9.700 0 0 0-6.700 2.700L3 8"/><path d="M3 3v5h5M12 7v5l4 2"/>', pencil: '<path d="M17 3a2.800 2.800 0 1 1 4 4L7.500 20.500 2 22l1.500-5.500Z"/><path d="m15 5 4 4"/>',
  pin: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>', phone: '<path d="M22 16.900v3a2 2 0 0 1-2.200 2 19.800 19.800 0 0 1-8.600-3.100 19.500 19.500 0 0 1-6-6A19.800 19.800 0 0 1 2.100 4.200 2 2 0 0 1 4.100 2h3a2 2 0 0 1 2 1.700c.1 1 .4 1.900.7 2.800a2 2 0 0 1-.500 2.100L8.100 9.900a16 16 0 0 0 6 6l1.300-1.300a2 2 0 0 1 2.100-.400c.9.300 1.800.6 2.800.7a2 2 0 0 1 1.700 2Z"/>',
  idea: '<path d="M9 18h6M10 22h4M15.1 14c.2-1 .7-1.700 1.400-2.500A6 6 0 1 0 7.500 11.500c.7.700 1.200 1.500 1.400 2.500"/>',
  star: '<path d="m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.8-6.2-3.2L5.8 21 7 14.2 2 9.3l6.9-1z"/>', filter: '<path d="M22 3H2l8 9.5V19l4 2v-8.500z"/>',
  ticket: '<path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"/><path d="M13 5v2M13 17v2M13 11v2"/>', flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1zM4 22v-7"/>',
  cdot: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/>', cplay: '<circle cx="12" cy="12" r="10"/><path d="m10 8 6 4-6 4z"/>', cpause: '<circle cx="12" cy="12" r="10"/><path d="M10 15V9M14 15V9"/>',
  ccheck: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>', calert: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>', cx: '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6M9 9l6 6"/>',
  more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>', x: '<path d="M18 6 6 18M6 6l12 12"/>', download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  utensils: '<path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2M7 2v20M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M3 8l9 6 9-6"/>', shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>', copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>', send: '<path d="M22 2L11 13M22 2l-7 20-4-9-9-4z"/>',
}[n]}</svg>`;
const ICONS = ['wifi', 'bolt', 'bed', 'bus', 'tool', 'drop', 'book', 'cash', 'grid'];
const BLOCK_FIELDS = ['progress', 'ticket_details', 'timeline', 'guide'];
const ACT_ICON = { hold: 'pause', open: 'play', in_progress: 'play', closed: 'check', rejected: 'xmark' };
const fmtLeft = m => { m = Math.abs(Math.round(m)); return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60 ? (m % 60) + 'm' : ''}`.trim() : `${m}m`; };
const leaderboard = rows => `<b>Provider leaderboard</b><div class="muted small">Points for closing within SLA, this campus</div>${rows.length ? rows.map((u, i) => `<div class="brow">
  <span class="rank r${i + 1}">${['🥇', '🥈', '🥉'][i] || i + 1}</span><div><b>${esc(u.name)}</b><div class="muted small">${u.closed} closed · ${u.on_time ?? 0}% on time</div></div>
  <b class="mono" style="color:${u.points < 0 ? 'var(--warn)' : 'var(--brand)'}">${u.points} pts</b></div>`).join('') : '<p class="muted">No providers yet.</p>'}`;
const svcIcon = s => s.form_schema?.icon || ({ IT: 'wifi', ELEC: 'bolt', HOSTEL: 'bed', TRANS: 'bus' })[s.code] || 'grid';
const ring = (pct, size = 96, color = 'var(--brand)', track = '#EEF0F3') => { const r = (size - 12) / 2, c = 2 * Math.PI * r;
  return `<div class="ring" style="width:${size}px;height:${size}px"><svg width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${r}" stroke="${track}" stroke-width="10" fill="none"/>
  <circle cx="${size / 2}" cy="${size / 2}" r="${r}" stroke="${color}" stroke-width="10" fill="none" stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - pct / 100)}" transform="rotate(-90 ${size / 2} ${size / 2})"/></svg><b>${pct}%</b></div>`; };
const S = { token: localStorage.getItem('tok'), tenant: localStorage.getItem('tid'), me: null };

async function api(path, { method = 'GET', body, raw } = {}) {
  const h = { 'content-type': 'application/json' };
  if (S.token) h.authorization = 'Bearer ' + S.token;
  if (S.tenant && S.me?.user.role === 'super_admin') h['x-tenant-id'] = S.tenant;
  const r = await fetch('/api' + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  if (raw) return r;
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && S.token && !path.startsWith('/auth')) { logout(true); throw new Error('Session expired'); }
  if (!r.ok) { const e = new Error(j.error?.message || 'Error'); e.details = j.error?.details; e.status = r.status; e.code = j.error?.code; throw e; }
  return j.data;
}
// Photos go up as JPEG, at most 1920 px on the long side: a phone's 5–12 MB picture becomes a few hundred KB, and every
// browser and email app can show it. What this browser can't open (HEIC in Chrome, say) goes up as it is; the server turns it into JPEG.
const shrinkPhoto = async f => {
  if (/^image\/(jpeg|png|gif)$/.test(f.type) && f.size <= 1.5e6) return f; // small and already in a format everyone shows
  const url = URL.createObjectURL(f), img = new Image(); img.src = url;
  try { await img.decode(); } catch { URL.revokeObjectURL(url); return f; }
  const k = Math.min(1, 1920 / Math.max(img.naturalWidth, img.naturalHeight)), c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(img.naturalWidth * k)); c.height = Math.max(1, Math.round(img.naturalHeight * k));
  const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85));
  return blob ? new File([blob], f.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' }) : f;
};
const readFiles = async (inputs) => {
  const out = []; let total = 0;
  for (const inp of inputs) for (const f0 of inp.files) {
    const pic = /^image\//.test(f0.type) || /\.(heic|heif|avif|webp|bmp|tiff?)$/i.test(f0.name), f = pic ? await shrinkPhoto(f0) : f0;
    const heic = f === f0 && (/\.(heic|heif)$/i.test(f0.name) || /^image\/hei[cf]/.test(f0.type)), max = heic ? 12 : 5; // the server shrinks HEIC
    if (f.size > max * 1024 * 1024) throw new Error(`${f0.name} is too large (over ${max} MB)`);
    if ((total += f.size) > 28 * 1024 * 1024) throw new Error('These photos are too large together. Please attach fewer.');
    out.push({ name: f.name, type: f.type || 'application/octet-stream', source: inp.dataset.source, data: await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(f); }) });
  }
  if (out.length > MAX_FILES) throw new Error(`You can attach at most ${MAX_FILES} photos. Please remove ${out.length - MAX_FILES}.`);
  return out;
};
const fileButtons = (id) => `<div class="files">
  <label class="btn">${I('camera', 22)}Camera<input hidden type="file" accept="image/*" capture="environment" multiple data-source="camera" class="f-${id}"></label>
  <label class="btn">${I('image', 22)}Gallery<input hidden type="file" accept="image/*,application/pdf" multiple data-source="gallery" class="f-${id}"></label></div>
  <div class="muted f-${id}-n" style="font-size:13px"></div>`;
const wireFiles = id => document.querySelectorAll('.f-' + id).forEach(i => i.onchange = () => {
  const n = [...document.querySelectorAll('.f-' + id)].reduce((a, x) => a + x.files.length, 0), el = $(`.f-${id}-n`);
  el.textContent = !n ? '' : n > MAX_FILES ? `${n} photos chosen, only ${MAX_FILES} allowed. Please choose again.` : `${n} of ${MAX_FILES} photos attached`;
  el.classList.toggle('err', n > MAX_FILES); });
// Photos show as pictures. Other files (PDF, or a picture type browsers can't show) are a named link; so is a picture
// that fails to load, never a broken image.
const thumbs = files => files?.length ? `<div class="thumbs">${files.map(f => /^image\/(jpeg|png|gif|webp)$/.test(f.mime_type || '')
  ? `<a href="/api/files/${f.storage_key}" target="_blank"><img src="/api/files/${f.storage_key}" alt="${esc(f.file_name)}" loading="lazy"></a>${f.stamped_at ? `<div class="tstamp">${I('camera', 12)}${fmt(f.stamped_at)}</div>` : ''}`
  : `<a class="fchip" href="/api/files/${f.storage_key}" target="_blank">${I('file', 14)} ${esc(f.file_name)}</a>`).join('')}</div>` : '';
document.addEventListener('error', e => { const img = e.target; if (img.tagName !== 'IMG' || !img.closest?.('.thumbs')) return;
  const a = img.closest('a'); a.className = 'fchip'; a.textContent = img.alt; }, true);
const formVals = form => Object.fromEntries(new FormData(form));
// Get the app (install.js): Android / Chrome install in one tap, iPhone gets the Add to Home Screen steps
const installBtn = () => ''; // the sticky Install button (install.js) is on every screen, so no second one in the page
// The requestor's step-by-step guide lives beside the app, at guide/requestor.html. A first visit gets a card offering it;
// Start guide or Not now hides that card for good on this device.
const guideSeen = k => { try { return localStorage.getItem(k) === '1'; } catch { return true; } };
const guideCard = (href, kicker, title, sub) => `<div class="guidecard"><span class="chip c1">${I('play', 22)}</span><div class="t"><span class="new">${kicker}</span><b>${title}</b><span class="muted small">${sub}</span></div>
  <div class="gact"><a class="btn primary" href="${href}" data-gstart>${I('play', 18)} Start guide</a><button type="button" class="btn" data-gskip>Not now</button></div></div>`;
const wireGuide = (k, redraw) => { const seen = () => { try { localStorage.setItem(k, '1'); } catch { /* storage off */ } };
  document.querySelectorAll('[data-gstart]').forEach(a => a.addEventListener('click', seen));
  document.querySelectorAll('[data-gskip]').forEach(b => { b.onclick = () => { seen(); redraw(); }; }); };
// Picking "Other" in a dropdown shows a box to type the answer (required when the question is).
document.addEventListener('change', e => { const sel = e.target.closest?.('select[data-other]'); if (!sel) return;
  const box = sel.nextElementSibling, on = sel.value === sel.dataset.other; if (!box?.classList.contains('other-input')) return;
  box.hidden = !on; box.required = on && sel.required; if (on) box.focus(); else box.value = ''; });
// A red * after the label of every required field, on every form the app draws (pages and dialogs).
const markRequired = root => root.querySelectorAll('input[required],select[required],textarea[required]').forEach(el => {
  const l = el.previousElementSibling; if (l?.tagName !== 'LABEL' || l.querySelector('.req')) return;
  const s = document.createElement('span'), small = l.querySelector('small'); s.className = 'req'; s.setAttribute('aria-hidden', 'true');
  s.textContent = small ? '* ' : ' *'; small ? l.insertBefore(s, small) : l.append(s);
});
const tabsA11y = root => root.querySelectorAll?.('.tabs').forEach(t => { t.setAttribute('role', 'tablist');
  t.querySelectorAll('.tab').forEach(b => { b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', b.classList.contains('on') ? 'true' : 'false'); }); });
new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(n => { if (n.nodeType !== 1) return; markRequired(n.parentNode || n); tabsA11y(n.parentNode || n); }))).observe(document.body, { childList: true, subtree: true });

function fieldInput(f, v = '') {
  const req = f.required ? 'required' : '', name = `fd_${f.key}`;
  if (f.type === 'long_text') return `<textarea name="${name}" ${req} placeholder="${esc(f.placeholder)}">${esc(v)}</textarea>`;
  if (f.type === 'select') { const oth = otherOf(f.options); // "Other" opens a box to type the answer
    return `<select name="${name}" ${req} ${oth ? `data-other="${esc(oth)}"` : ''}><option value="">Choose…</option>${f.options.map(o => `<option>${esc(o)}</option>`).join('')}</select>`
      + (oth ? `<input type="text" name="${name}__other" class="other-input" maxlength="200" placeholder="Please type it here" hidden>` : ''); }
  if (f.type === 'multi_select') return `<select name="${name}" multiple ${req}>${f.options.map(o => `<option>${esc(o)}</option>`).join('')}</select>`;
  if (f.type === 'yes_no') return `<select name="${name}" ${req}><option value="">Choose…</option><option>Yes</option><option>No</option></select>`;
  const t = { number: 'number', date: 'date', phone: 'tel', email: 'email' }[f.type] || 'text';
  return `<input type="${t}" name="${name}" ${req} placeholder="${esc(f.placeholder)}">`;
}
// The form type's built-in questions (student details and/or location), in titled sections.
const typeFields = svc => { const b = builtinFields(svc.form_schema || {});
  const sec = (title, pre) => { const f = b.filter(x => x.key.startsWith(pre)); return f.length ? `<div class="fsec" data-sec="${pre.slice(0, -1)}"><b>${title}</b>${f.map(x => `<label>${esc(x.label)}</label>${fieldInput(x)}`).join('')}</div>` : ''; };
  return sec('Your student details', 'stu_') + sec('Where is the problem?', 'loc_'); };
// the service's own questions; each one is required only if its Required box is ticked
const customFields = svc => (svc.form_schema?.fields || []).map(f => `<label>${esc(f.label)}</label>${fieldInput(f)}`).join('');
const collectForm = (form, svc) => {
  const fd = {};
  for (const f of fieldsOf(svc.form_schema || {})) {
    const el = form.elements[`fd_${f.key}`]; if (!el) continue;
    fd[f.key] = f.type === 'multi_select' ? [...el.selectedOptions].map(o => o.value) : el.value;
    const typed = form.elements[`fd_${f.key}__other`]?.value.trim(); if (typed && el.dataset.other && el.value === el.dataset.other) fd[f.key] = `${el.value}: ${typed}`;
  }
  return fd;
};

// ================= PUBLIC =================
async function portal(slug, q, view, code) {
  document.body.className = '';
  const { tenant, services } = await api(`/public/${slug}`);
  document.title = `${tenant.name} · ONE Desk`;
  const want = (code || q.get('service') || '').toUpperCase(), pick = want && services.find(s => s.code === want);
  // a team with sub-teams (Maintenance → Electrical, Plumbing …): pick the sub-team first
  const subs = pick ? services.filter(x => x.parent_id === pick.id) : [];
  if (pick && subs.length) {
    app.innerHTML = `<div class="wrap"><div class="head"><a class="iconbtn" href="#/d/${slug}/raise" aria-label="Back">${I('back')}</a><h1>${esc(pick.name)}</h1></div>
      <p class="muted">Which team can help? Pick the closest one.</p>
      ${[...subs, { ...pick, name: `Other ${pick.name} problem`, description: 'Not in the list above', other: true }].map((s, i) => `<a class="svc" href="#/d/${slug}/raise/${encodeURIComponent(s.code)}${s.other ? '?direct=1' : ''}"><span class="chip c${i % 5}">${I(svcIcon(s), 22)}</span>
        <span class="t"><b>${esc(s.name)}</b><span class="muted small">${esc(s.description || '')}</span></span><span class="chev">${I('chev')}</span></a>`).join('')}</div>`;
    if (!q.get('direct')) return;
  }
  if (pick && isFood(pick.form_schema)) return foodScreens(slug, tenant, pick, q.get('flow'));
  if (pick) return raiseForm(slug, tenant, pick);
  if (view !== 'raise') {
    const opt = (href, ic, cls, title, sub) => `<a class="svc" href="${href}"><span class="chip ${cls}">${I(ic, 22)}</span><span class="t"><b>${title}</b><span class="muted small">${sub}</span></span><span class="chev">${I('chev')}</span></a>`;
    const seen = guideSeen('guide-seen');
    app.innerHTML = `<div class="wrap hero"><img class="logo" src="logo.png" alt="St. Mary's Rehabilitation University">
      <h1>Need help?<br><span>We're</span> on it.</h1><p class="muted">${esc(tenant.name)} service desk. No login needed to raise or track a ticket.</p>
      ${seen ? '' : guideCard('guide/requestor.html', 'New here?', 'Watch the full guide', '2 minutes, step by step, with voice in English or తెలుగు.')}
      ${opt(`#/d/${slug}/raise`, 'plus', 'c0', 'Raise a ticket', 'Report a problem and get a ticket number instantly')}
      ${opt(`#/d/${slug}/track`, 'search', 'c2', 'Track ticket', 'Check status with your ticket number')}
      ${seen ? opt('guide/requestor.html', 'book', 'c4', 'Full guide', 'How to raise and track a ticket, step by step with voice') : ''}${iosHintHtml()}</div>${installBtn()}`;
    wireGuide('guide-seen', route);
    return;
  }
  app.innerHTML = `<div class="wrap"><div class="head"><a class="iconbtn" href="#/d/${slug}" aria-label="Back">${I('back')}</a><h1>Raise a ticket</h1></div>
    <p class="muted">${services.length ? 'Pick the service you need.' : 'No services are open on this campus yet. Please check back soon.'}</p>
    ${services.filter(s => !s.parent_id || !services.some(x => x.id === s.parent_id)).map((s, i) => `<a class="svc" href="#/d/${slug}/raise/${encodeURIComponent(s.code)}"><span class="chip c${i % 5}">${I(svcIcon(s), 22)}</span>
      <span class="t"><b>${esc(s.name)}</b><span class="muted small">${isFood(s.form_schema) ? 'Rate meals or report a problem' : esc(s.description || '')}</span>
      ${services.some(x => x.parent_id === s.id) ? `<br><span class="plate">${services.filter(x => x.parent_id === s.id).length} teams inside</span>` : ''}</span><span class="chev">${I('chev')}</span></a>`).join('')}
</div>`;
}

// ================= FOOD: rate a meal (feedback, no ticket) or report a serious problem (a ticket) =================
const foodDevice = () => { try { let k = localStorage.getItem('food-device'); if (!k) { k = crypto.randomUUID().replace(/-/g, ''); localStorage.setItem('food-device', k); } return k; } catch { return null; } };
const foodCarry = (v) => { try { if (v === undefined) { const x = JSON.parse(sessionStorage.getItem('food-carry') || 'null'); sessionStorage.removeItem('food-carry'); return x || {}; } sessionStorage.setItem('food-carry', JSON.stringify(v)); } catch { return {}; } };
const nowHM = () => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
async function foodScreens(slug, tenant, svc, flow) {
  const f = await api(`/public/${slug}/food`), base = `#/d/${slug}/raise/${encodeURIComponent(svc.code)}`;
  const head = (title, back) => `<div class="head"><a class="iconbtn" href="${back}" aria-label="Back">${I('back')}</a><h1>${title}</h1></div>`;
  const where = (sel = {}) => `<div class="row">${f.locations.length ? `<div><label>Mess / canteen</label><select name="location_id" required><option value="">Choose…</option>${f.locations.map(l => `<option value="${l.id}" ${l.id === sel.location_id ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></div>` : ''}
    <div><label>Meal</label><select name="meal" required>${MEALS.map(m => `<option value="${m}" ${m === (sel.meal || mealAt(f.windows, nowHM())) ? 'selected' : ''}>${MEAL_NAMES[m]}</option>`).join('')}</select></div></div>`;
  document.title = `${svc.name} · ONE Desk`;
  if (flow === 'rate') { // ---------- Flow A: Rate your meal ----------
    const c = foodCarry();
    app.innerHTML = `<div class="wrap">${head('Rate your meal', base)}<form id="f" class="card food-form">
      <input class="hp" name="website" tabindex="-1" autocomplete="off">
      ${where(c)}
      <label>How was it?</label><div class="stars" role="radiogroup" aria-label="Rating">${[1, 2, 3, 4, 5].map(n => `<label><input type="radio" name="rating" value="${n}" required><span aria-label="${n} star${n > 1 ? 's' : ''}">★</span></label>`).join('')}</div>
      <label>What stood out? <small>(tap all that apply)</small></label><div class="fchips">${FOOD_CHIPS.map(ch => `<label><input type="checkbox" name="chips" value="${esc(ch)}" ${(c.chips || []).includes(ch) ? 'checked' : ''}><span>${esc(ch)}</span></label>`).join('')}</div>
      <label>Comment</label><textarea name="comment" maxlength="300" placeholder="Anything the chef should know (you can skip this)">${esc(c.comment || '')}</textarea><div class="muted small" id="cc"></div>
      <label>Your name or roll no. <small>(leave empty to stay anonymous)</small></label><input name="name" maxlength="80" autocomplete="name">
      <div class="err" id="err"></div><p><button class="btn primary big">${I('send')} Send rating</button></p></form></div>`;
    const ta = $('#f').comment, cc = () => { $('#cc').textContent = `${ta.value.length} / 300`; }; ta.oninput = cc; cc();
    $('#f').onsubmit = async e => { e.preventDefault(); const fm = e.target, btn = fm.querySelector('button.primary'); btn.disabled = true; $('#err').textContent = '';
      const v = { location_id: fm.location_id?.value || null, meal: fm.meal.value, rating: Number(fm.rating.value), chips: [...fm.querySelectorAll('[name=chips]:checked')].map(x => x.value),
        comment: fm.comment.value.trim(), name: fm.name.value.trim(), website: fm.website.value, device_key: foodDevice() };
      try { const r = await api(`/public/${slug}/food/feedback`, { method: 'POST', body: v });
        app.innerHTML = `<div class="wrap">${head('Thank you', `#/d/${slug}`)}<div class="stub"><span class="chip c2" style="margin:0 auto 10px;width:56px;height:56px;border-radius:50%">${I('check', 28)}</span>
          <h2 style="margin:6px 0">${esc(r.message)}</h2><p class="muted">${'★'.repeat(v.rating)}${'☆'.repeat(5 - v.rating)} · ${MEAL_NAMES[v.meal]}</p>
          ${v.rating <= 2 ? `<p><a href="${base}?flow=report" id="serious" class="soft-link">Is this serious? Report a problem →</a></p>` : ''}
          <p><a class="btn" href="#/d/${slug}">Done</a></p></div></div>`;
        if ($('#serious')) $('#serious').onclick = () => foodCarry({ location_id: v.location_id, meal: v.meal, description: v.comment });
      } catch (er) { $('#err').textContent = er.message; btn.disabled = false; } };
    return;
  }
  if (flow === 'report') { // ---------- Flow B: Report a serious problem ----------
    const c = foodCarry(), idem = crypto.randomUUID();
    app.innerHTML = `<div class="wrap">${head('Report a serious problem', base)}<form id="f" class="card food-form">
      <input class="hp" name="website" tabindex="-1" autocomplete="off">
      ${where(c)}
      <label>What is the problem?</label><div class="fcats">${FOOD_CATEGORIES.map(([k, l]) => `<label><input type="radio" name="category" value="${k}" required><span>${esc(l)}</span></label>`).join('')}</div>
      <div class="limitbox" id="else" hidden>${I('alert', 22)}<div><b>Taste, quantity or cold food?</b><div>Rate the meal instead. The chef sees it tonight.</div>
        <button type="button" class="btn soft" id="toRate" style="margin-top:8px">${I('play', 16)} Switch to rating</button></div></div>
      <label>Describe what happened</label><textarea name="description" required maxlength="2000" placeholder="What, where and when">${esc(c.description || '')}</textarea>
      <label>Photo <span class="req" aria-hidden="true">*</span> <small>(camera or gallery)</small></label>${fileButtons('food')}
      <div class="row"><div><label>Your name</label><input name="name" required autocomplete="name"></div></div><label>I'm</label><div class="whochips" role="radiogroup" aria-label="I'm">${REQUESTOR_TYPES.map(t => `<label><input type="radio" name="requestor_type" value="${t}" ${t === 'student' ? 'checked' : ''}><span class="rtb rt-${t}">${cap(t)}</span></label>`).join('')}</div>
      <div class="row"><div><label>Email <small>(we send updates here)</small></label><input name="email" type="email" required autocomplete="email" inputmode="email"></div>
        <div><label>Phone</label><input name="phone" type="tel" required autocomplete="tel" inputmode="tel" pattern="\+?[0-9 \-]{7,15}" title="7–15 digits, e.g. 9876543210"></div></div>
      <div class="err" id="err"></div><p><button class="btn primary big">${I('send')} Continue</button></p></form></div>`;
    wireFiles('food');
    const fm = $('#f'), sync = () => { $('#else').hidden = fm.category.value !== 'other'; };
    fm.querySelectorAll('[name=category]').forEach(r => r.onchange = sync);
    $('#toRate').onclick = () => { foodCarry({ location_id: fm.location_id?.value, meal: fm.meal.value, comment: fm.description.value.trim().slice(0, 300) }); location.hash = `${base}?flow=rate`; };
    fm.onsubmit = async e => { e.preventDefault(); const btn = fm.querySelector('button.primary'); $('#err').textContent = '';
      const n = [...document.querySelectorAll('.f-food')].reduce((a, x) => a + x.files.length, 0);
      if (!n) { $('#err').textContent = 'Please add a photo of the problem (camera or gallery).'; return; }
      const v = { location_id: fm.location_id?.value || null, meal: fm.meal.value, category: fm.category.value, description: fm.description.value.trim(), name: fm.name.value.trim(),
        requestor_type: fm.requestor_type.value, email: fm.email.value.trim(), phone: fm.phone.value.trim(), website: fm.website.value, idempotency_key: idem };
      const choice = await foodConfirm(); if (!choice) return;
      btn.disabled = true;
      try {
        if (choice === 'feedback') { // converted: no ticket, the comment and a matching chip go to the kitchen's report
          const r = await api(`/public/${slug}/food/feedback`, { method: 'POST', body: { location_id: v.location_id, meal: v.meal, converted_from_complaint: true,
            chips: CATEGORY_CHIPS[v.category] || [], comment: v.description.slice(0, 300), name: v.name, device_key: null } });
          app.innerHTML = `<div class="wrap">${head('Sent as feedback', `#/d/${slug}`)}<div class="stub"><span class="chip c2" style="margin:0 auto 10px;width:56px;height:56px;border-radius:50%">${I('check', 28)}</span>
            <h2 style="margin:6px 0">${esc(r.message)}</h2><p class="muted">No ticket was raised.</p><p><a class="btn" href="#/d/${slug}">Done</a></p></div></div>`;
          return;
        }
        const body = { ...v, files: await readFiles(document.querySelectorAll('.f-food')) };
        let r; try { r = await api(`/public/${slug}/food/complaint`, { method: 'POST', body }); }
        catch (er) { if (er.code !== 'POSSIBLE_DUPLICATE') throw er; r = await api(`/public/${slug}/food/complaint`, { method: 'POST', body: { ...body, merge: await sameIssue(er.details) } }); }
        const link = `${location.origin}${location.pathname}#/d/${slug}/t/${r.ticket_no}?k=${r.tracking_token}`;
        app.innerHTML = `<div class="wrap">${head('Ticket raised', `#/d/${slug}`)}<div class="stub"><span class="chip c2" style="margin:0 auto 10px;width:56px;height:56px;border-radius:50%">${I('check', 28)}</span>
          <div class="muted">${r.merged ? 'Added to the ticket for this problem. Your number is' : 'Ticket raised! Your number is'}</div><div class="no">${r.ticket_no}</div>
          ${r.merged ? knownIssue(r.affected_count) : ''}<p>${esc(svc.name)} · target by <b>${fmt(r.due_at)}</b></p>
          <p class="muted small" style="margin:14px 0 30px">We also emailed these details to you.</p>
          <div class="row"><button class="btn primary" id="cp">${I('copy', 18)} Copy link</button><a class="btn" href="${link}">Track status</a></div></div></div>`;
        $('#cp').onclick = () => navigator.clipboard.writeText(link).then(() => toast('Link copied'));
      } catch (er) { $('#err').textContent = er.message; btn.disabled = false; } };
    return;
  }
  // ---------- Screen 2: choose ----------
  app.innerHTML = `<div class="wrap">${head('How can we help with food?', `#/d/${slug}/raise`)}
    <a class="foodpick primary" href="${base}?flow=rate"><span class="fp-ic">★</span><span class="t"><b>Rate your meal</b><span>Taste, quantity, cold food, menu, variety</span>
      <small>Goes to the kitchen team's report tonight</small></span><span class="chev">${I('chev')}</span></a>
    <a class="foodpick secondary" href="${base}?flow=report"><span class="fp-ic">${I('alert', 20)}</span><span class="t"><b>Report a serious problem</b><span>Insect or foreign object, spoiled food, hygiene, billing error, staff behaviour</span>
      <small>Creates a ticket · photo required</small></span><span class="chev">${I('chev')}</span></a></div>`;
}
// "Does this need action right now?" → 'ticket' | 'feedback' | null (closed)
const foodConfirm = () => new Promise(res => {
  const d = document.createElement('dialog'); d.className = 'sheet';
  d.innerHTML = `<h2>Does this need action right now?</h2><p class="muted">A ticket goes to the Executive Chef to fix now. Feedback goes into tonight's kitchen report.</p>
    <p><button type="button" class="btn primary big" data-c="ticket">Yes, raise ticket</button></p><p><button type="button" class="btn big" data-c="feedback">No, send as feedback</button></p>
    <p style="text-align:center;margin:0"><button type="button" class="btn ghost" data-c="">Go back</button></p>`;
  document.body.append(d); d.showModal(); let v = null;
  d.onclick = e => { const b = e.target.closest('[data-c]'); if (b) { v = b.dataset.c || null; d.close(); } };
  d.onclose = () => { d.remove(); res(v); };
});

function raiseForm(slug, tenant, svc, related) {
  const idem = crypto.randomUUID();
  app.innerHTML = `<div class="wrap"><div class="head"><a class="iconbtn" href="#/d/${slug}/raise" aria-label="Back">${I('back')}</a>
    <h1>${esc(svc.name)}</h1><span class="chip c0">${I(svcIcon(svc), 22)}</span></div>
  <form id="f" class="card">
    <input class="hp" name="website" tabindex="-1" autocomplete="off">
    <div class="kindsw" role="radiogroup" aria-label="What would you like to do?">
      <label><input type="radio" name="kind" value="issue" checked><span>${I('alert', 16)}Report a problem</span></label>
      <label><input type="radio" name="kind" value="suggestion"><span>${I('idea', 16)}Share a suggestion</span></label></div>
    <div class="kindhint" id="kindhint" hidden>${I('idea', 16)}<span>A suggestion goes to the ${esc(svc.name)} team as an idea, not a complaint. It has no deadline; they reply when they can.</span></div>
    <label>Your name</label><input name="name" required autocomplete="name">
    <label>I'm</label><div class="whochips" role="radiogroup" aria-label="I'm">${REQUESTOR_TYPES.map(t => `<label><input type="radio" name="requestor_type" value="${t}" ${t === 'student' ? 'checked' : ''} required><span class="rtb rt-${t}">${cap(t)}</span></label>`).join('')}</div>
    <div class="row"><div><label>Email <small>(we send updates here)</small></label><input name="email" type="email" required autocomplete="email" inputmode="email"></div>
      <div><label>Phone</label><input name="phone" type="tel" required autocomplete="tel" inputmode="tel" pattern="\+?[0-9 \-]{7,15}" title="7–15 digits, e.g. 9876543210"></div></div>
    <div class="row" id="idrow"><div><label><span id="idl"></span></label><input name="identifier" required></div>
      <div><label><span id="dpl"></span></label><input name="department" required></div></div>
    ${typeFields(svc).replace(/<div class="fsec" data-sec="loc"/, '<div class="fsec prob-only" data-sec="loc"')}
    ${isGeneral(svc.form_schema) ? '<div class="prob-only"><label>Location <small>(room, building)</small></label><input name="location" required></div>' : ''}
    <label id="subjL">Subject</label><input name="subject" required maxlength="200">
    <label id="descL">Describe the problem</label><textarea name="description"></textarea>
    <div class="prob-only">${customFields(svc)}</div>
    <label>Photos <small>(up to ${MAX_FILES})</small></label>${fileButtons('raise')}
    <div class="err" id="err"></div>
    <p><button class="btn primary big" id="raiseBtn">${I('send')} <span>Raise ticket</span></button></p>
  </form></div>`;
  wireFiles('raise');
  // Suggestion box: the same form; the problem's place and questions step aside, the wording changes
  const kindSync = () => { const sug = $('#f').kind.value === 'suggestion';
    $('#f').querySelectorAll('.prob-only').forEach(x => { x.hidden = sug; x.querySelectorAll('input, select, textarea').forEach(i => { if (sug) { i.dataset.req ??= i.required ? '1' : ''; i.required = false; } else if (i.dataset.req !== undefined) { i.required = i.dataset.req === '1'; } }); });
    $('#kindhint').hidden = !sug; $('#subjL').firstChild.textContent = sug ? 'Your suggestion in a few words' : 'Subject';
    $('#descL').firstChild.textContent = sug ? 'Your suggestion' : 'Describe the problem'; $('#f').description.required = sug;
    $('#f').description.placeholder = sug ? 'What would make it better, and why?' : '';
    $('#raiseBtn span').textContent = sug ? 'Send suggestion' : 'Raise ticket'; markRequired($('#f')); };
  $('#f').querySelectorAll('[name=kind]').forEach(r => r.onchange = kindSync);
  // the "about you" questions follow "I'm": student ID for students, faculty ID for faculty, staff ID for staff, the ward's ID for parents…
  // On student services a student fills the student details section instead; everyone else gets the two ID questions.
  const who = $('#f').requestor_type, idrow = $('#idrow'), stu = $('#f [data-sec="stu"]'), syncId = () => { // who: the I'm chips (radio group)
    const [[il, ip], [dl, dp]] = WHO_FIELDS[who.value] || WHO_FIELDS.student, asStudent = !!stu && who.value === 'student';
    $('#idl').textContent = il; $('#dpl').textContent = dl; $('#f').identifier.placeholder = ip; $('#f').department.placeholder = dp;
    idrow.hidden = asStudent; idrow.querySelectorAll('input').forEach(i => i.required = !asStudent);
    if (stu) { stu.hidden = !asStudent; stu.querySelectorAll('input, select').forEach(i => i.required = asStudent); }
    markRequired($('#f')); }; // fields that just became required get their red *
  $('#f').querySelectorAll('[name=requestor_type]').forEach(r => r.addEventListener('change', syncId)); syncId(); kindSync();
  $('#f').onsubmit = async e => {
    e.preventDefault(); const btn = e.target.querySelector('button.primary'); btn.disabled = true; $('#err').textContent = '';
    try {
      const v = formVals(e.target);
      if (!/^\S+@\S+\.\S+$/.test(v.email || '')) throw new Error('Enter a valid email address so we can send you updates');
      const body = { ...v, service_id: svc.id, form_data: collectForm(e.target, svc), idempotency_key: idem, related_ticket_no: related,
        files: await readFiles(document.querySelectorAll('.f-raise')) };
      let r; try { r = await api(`/public/${slug}/tickets`, { method: 'POST', body }); }
      catch (er) { if (er.code !== 'POSSIBLE_DUPLICATE') throw er; // confirm mode: the person says whether it is the same issue
        r = await api(`/public/${slug}/tickets`, { method: 'POST', body: { ...body, merge: await sameIssue(er.details) } }); }
      const link = `${location.origin}${location.pathname}#/d/${slug}/t/${r.ticket_no}?k=${r.tracking_token}`;
      app.innerHTML = `<div class="wrap"><div class="head"><a class="iconbtn" href="#/d/${slug}" aria-label="Back">${I('back')}</a><h1>${r.kind === 'suggestion' ? 'Suggestion sent' : 'Ticket raised'}</h1></div><div class="stub"><span class="chip c2" style="margin:0 auto 10px;width:56px;height:56px;border-radius:50%">${I(r.kind === 'suggestion' ? 'idea' : 'check', 28)}</span>
        <div class="muted">${r.kind === 'suggestion' ? 'Thank you! Your suggestion number is' : r.merged ? 'Added to the ticket for this problem. Your number is' : 'Ticket raised! Your number is'}</div><div class="no">${r.ticket_no}</div>
        <button type="button" class="btn soft" id="cpn" style="margin:6px auto 4px">${I('copy', 16)} Copy number</button>
        ${r.merged ? knownIssue(r.affected_count) : ''}${queueBox(r.queue)}
        <p>${r.kind === 'suggestion' ? `It went to the ${esc(svc.name)} team. If they reply, we'll email you.` : `${esc(svc.name)} · target by <b>${fmt(r.due_at)}</b>`}</p>
        ${r.providers.map(p => `<span class="plate">${esc(p.name)}${p.phone && v.requestor_type !== 'student' ? ' · ' + esc(p.phone) : ''}</span>`).join('')}
        <p class="muted small" style="margin:14px 0 30px">${v.email ? 'We also emailed these details to you.' : 'Save this link — it is your key to the ticket.'}</p>
        <div class="row"><button class="btn primary" id="cp">${I('copy', 18)} Copy link</button><a class="btn" href="${link}">Open ticket</a></div></div></div>`;
      $('#cp').onclick = () => navigator.clipboard.writeText(link).then(() => toast('Link copied'));
      $('#cpn').onclick = () => navigator.clipboard.writeText(r.ticket_no).then(() => toast('Number copied'), () => toast(r.ticket_no));
    } catch (er) {
      if (er.code === 'DAILY_LIMIT') $('#err').innerHTML = `<div class="limitbox">${I('clock', 22)}<div><b>Daily ticket limit reached</b><div>${esc(cap(er.message.replace(/^Daily limit reached: /, '')))}</div></div></div>`;
      else $('#err').textContent = er.message;
      btn.disabled = false; }
  };
}

async function track(slug) {
  document.body.className = '';
  app.innerHTML = `<div class="wrap"><div class="head"><a class="iconbtn" href="#/d/${slug}" aria-label="Back">${I('back')}</a><h1>Track a ticket</h1></div><form id="f" class="card">
    <label>Ticket number</label><input name="no" required placeholder="0001" inputmode="numeric" class="mono">
    <div class="err" id="err"></div><p><button class="btn primary big">${I('search')} Find my ticket</button></p></form></div>`;
  $('#f').onsubmit = async e => { e.preventDefault(); const v = formVals(e.target);
    try { await api(`/public/${slug}/tickets/${encodeURIComponent(v.no.trim())}`);
      location.hash = `#/d/${slug}/t/${/^\d+$/.test(v.no.trim()) ? v.no.trim().padStart(4, '0') : v.no.trim().toUpperCase()}`;
    } catch { $('#err').textContent = 'No ticket with that number.'; } };
}

// A team that takes N tickets a day: past that, the ticket waits in the team's queue with a number and the day it reaches them
const queueBox = q => q ? `<div class="queuebox">${I('clock', 22)}<div><b>Queue number ${q.queue_no}</b>
  <div>Today's tickets for ${esc(q.service)} are full (the team takes ${q.daily_cap} a day). ${q.ahead ? `${q.ahead} ticket${q.ahead === 1 ? ' is' : 's are'} ahead of you` : 'You are next'}${q.waiting > 1 ? ` · ${q.waiting} waiting in all` : ''}.</div>
  <div>Your ticket reaches the team on <strong>${esc(q.lands_on)}</strong>. We'll email you then; you don't need to raise it again.</div></div></div>` : '';
// Many people reporting the same problem the same day share one ticket (see merge.js on the server)
const knownIssue = n => n > 1 ? `<div class="knownissue">${I('users', 18)}<span><b>Known issue:</b> ${n - 1} other${n === 2 ? '' : 's'} reported this too. You will get updates by email.</span></div>` : '';
const sameIssue = d => new Promise(res => {
  $('#err').innerHTML = `<div class="limitbox">${I('alert', 22)}<div><b>Ticket #${esc(d.ticket_no)} already exists for this problem.</b><div>${esc(d.subject)} · reported by ${d.affected_count} so far. Same issue?</div>
    <div class="row" style="margin-top:10px"><button type="button" class="btn primary" id="sy">Yes, add me</button><button type="button" class="btn" id="sn">No, raise new</button></div></div></div>`;
  $('#sy').onclick = () => { $('#err').textContent = ''; res('yes'); }; $('#sn').onclick = () => { $('#err').textContent = ''; res('no'); };
});
async function ticketPage(slug, no, q) {
  document.body.className = '';
  const key = q.get('k') ? { k: q.get('k') } : {};
  const qs = new URLSearchParams(key).toString();
  let t;
  try { t = await api(`/public/${slug}/tickets/${no}?${qs}`); } catch { return track(slug); }
  const label = e => ({ escalated: `Escalated to ${esc(e.to_value)} for faster help`, created: `Received at ${esc(e.to_value)}`, transferred: `Moved from ${esc(e.from_value)} to ${esc(e.to_value)}`,
    landed: `Reached the ${esc(e.to_value)} team`,
    status_changed: e.to_value === 'in_progress' ? (e.from_value === 'hold' ? 'Work resumed' : 'Work started') : { hold: 'Put on hold', open: 'Work resumed', closed: 'Closed', rejected: 'Rejected' }[e.to_value],
    note: `Note from ${esc(e.actor_name)}`, reopened: `Reopened by ${esc(e.actor_name)}`, reopen_requested: 'You asked to reopen', reopen_declined: `Reopen declined by ${esc(e.actor_name)}` })[e.event_type] || e.event_type;
  const next = { open: 'Work starts', in_progress: 'Closed', hold: 'Work resumes' }[t.status];
  const canReopen = t.status === 'closed' && !t.reopen_request && new Date(t.reopen_until) > new Date(), sug = t.kind === 'suggestion';
  const step = t.queue ? 10 : { open: 25, in_progress: 50, hold: 50, closed: 100, rejected: 100 }[t.status];
  app.innerHTML = `<div class="wrap"><div class="head"><a class="iconbtn" href="#/d/${slug}" aria-label="Back">${I('back')}</a><h1>My Ticket</h1>${pill(t.status)}</div>
    <div class="stub left"><div class="mono muted small">${t.ticket_no}</div><h2 style="margin:4px 0 2px;font-size:20px">${esc(t.subject)}</h2>
    <div class="muted small">${esc(t.service)} · ${esc(t.location || '')}</div>${knownIssue(t.affected_count)}${queueBox(t.queue)}
    <div class="progress card" style="margin-top:14px;box-shadow:none">${ring(step, 80, t.status === 'rejected' ? 'var(--warn)' : t.status === 'closed' ? 'var(--ok)' : 'var(--brand)')}
      <div><b>${sug ? (t.status === 'closed' ? 'Suggestion closed' : 'Suggestion received') : t.queue ? `In the queue · number ${t.queue.queue_no}` : STATUS_WORDS[t.status]}</b><div class="muted small">${sug && t.status !== 'closed' ? `The ${esc(t.service)} team will read it. If they reply, we'll email you.` : ACTIVE.includes(t.status) ? `Target by ${fmt(t.due_at)}` : t.status === 'hold' && t.hold_due_at ? `${esc(t.hold_label || '')} · expected to resume by ${fmt(t.hold_due_at)}` : t.closed_at ? fmt(t.closed_at) : ''}</div></div></div>
    ${t.providers.map(p => `<span class="plate">${esc(p.name)}${p.phone ? ' · ' + esc(p.phone) : ''}</span>`).join('')}</div>
    <h2>What happened</h2><div class="card"><ul class="stamps">${t.events.map(e => `<li><b>${label(e)}</b><div class="when">${fmt(e.created_at)}${e.actor_type === 'user' ? ' · ' + esc(e.actor_name) : ''}</div>
      ${e.body ? `<div>${esc(e.body)}</div>` : ''}${thumbs(e.files)}</li>`).join('')}${next ? `<li class="faint"><b>${next}</b></li>` : ''}</ul></div>
    ${t.status === 'rejected' ? `<div class="card">This ticket was rejected. <a href="#/d/${slug}" id="newt">Raise a new ticket</a></div>` : `
    <form id="nf" class="card"><b>Add a note</b><textarea name="body" required placeholder="Anything the team should know" style="margin-top:10px"></textarea>${fileButtons('note')}
      <p><button class="btn primary big">${I('send')} Send note</button></p></form>`}
    ${t.reopen_request ? `<div class="card reoreq"><div class="reo-h">${tile('history')}<div><b>Reopen requested</b><div class="psub">Waiting for ${esc(t.reopen_request.with || 'the team')} to accept. You'll get an email either way; add a note above if there is more to tell.</div></div></div></div>` : ''}
    ${canReopen ? `<form id="rf" class="card"><b>${sug ? 'Want to add to it?' : 'Not fixed?'}</b> <span class="muted small">Ask to reopen until ${fmt(t.reopen_until)}. ${sug ? '' : 'The person who closed it will accept or reply.'}</span><textarea name="reason" required placeholder="${sug ? 'What would you like the team to look at again?' : 'What is still wrong?'}" style="margin-top:10px"></textarea>
      <p><button class="btn danger big">Ask to reopen</button></p></form>` : ''}</div>`;
  if ($('#nf')) { wireFiles('note'); $('#nf').onsubmit = async e => { e.preventDefault();
    try { await api(`/public/${slug}/tickets/${no}/notes`, { method: 'POST', body: { ...key, body: e.target.body.value, files: await readFiles(document.querySelectorAll('.f-note')) } });
      toast('Note sent'); ticketPage(slug, no, q); } catch (er) { toast(er.message); } }; }
  if ($('#rf')) $('#rf').onsubmit = async e => { e.preventDefault();
    try { await api(`/public/${slug}/tickets/${no}/reopen`, { method: 'POST', body: { ...key, reason: e.target.reason.value } }); toast('Request sent. The team will answer soon.'); ticketPage(slug, no, q); } catch (er) { toast(er.message); } };
}

// ================= STAFF =================
// After signing in again, staff return to the screen they were opening (a ticket from an email button), not always Home.
function logout(expired) { if (expired && location.hash.startsWith('#/c')) sessionStorage.setItem('after-login', location.hash);
  localStorage.removeItem('tok'); localStorage.removeItem('tid'); S.token = S.me = null; location.hash = '#/login'; }
function login() {
  if (S.token && location.hash.startsWith('#/login')) return location.replace('#/c'); // already signed in (e.g. the Sign in button in an email)
  document.body.className = 'console';
  app.innerHTML = `<div class="wrap hero" style="max-width:440px"><a class="iconbtn" href="#/" id="bk" style="margin-bottom:20px">${I('back')}</a><img class="logo" src="logo.png" alt="St. Mary's Rehabilitation University">
    <h1>Your Desk,<br><span>Organized</span> in One Place</h1><p class="muted">Sign in to see your service queue, act on tickets and track your progress.</p>
    <form id="f" class="card"><label style="margin-top:0">Email</label><input name="email" type="email" required autofocus><label>Password</label><input name="password" type="password" required>
    <div class="err" id="err"></div><p style="margin-bottom:0"><button class="btn dark big">Get started ${I('chev', 18)}</button></p></form>${installBtn()}</div>`;
  $('#bk').onclick = e => { if (history.length > 1) { e.preventDefault(); history.back(); } };
  $('#f').onsubmit = async e => { e.preventDefault();
    try { const r = await api('/auth/login', { method: 'POST', body: formVals(e.target) }); S.token = r.token; localStorage.setItem('tok', r.token);
      const want = location.hash.startsWith('#/c') ? location.hash : sessionStorage.getItem('after-login') || '#/c'; sessionStorage.removeItem('after-login');
      if (location.hash === want) route(); else location.hash = want; }
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
  if (S.foodFor !== S.tenant) { S.foodFor = S.tenant; S.foodOk = S.tenant ? (await api('/food/access').catch(() => ({ ok: false }))).ok : false; } // food team or admin, and a food service here
  // every screen a person may open; the header shows `nav`, the phone's More sheet the ones not on the tab bar
  const all = [['c', 'Home', 'home'], ['c/new', 'New ticket', 'plus'], S.foodOk && ['c/food', 'Food scores', 'utensils'], admin && ['c/attention', 'Attention', 'bell'], ['c/reports', 'Reports', 'chart'], admin && ['c/services', 'Services', 'grid'],
    admin && ['c/sla', 'SLA & points', 'clock'], admin && ['c/email', 'Email', 'mail'], admin && ['c/users', 'People', 'users'], admin && ['c/audit', 'Audit', 'shield'], sa && ['c/tenants', 'Tenants', 'building']].filter(Boolean);
  const nav = all.filter(n => n[0] !== 'c/new'); // New ticket is the Home header's primary button and the phone's centre tab
  const cur = h => active === h ? 'class="on" aria-current="page"' : '';
  // the bell: admins open Attention; providers their overdue tickets (they have no Attention page)
  const bellHref = admin ? '#/c/attention' : '#/c', bellAttr = admin ? '' : 'data-overdue';
  const bn = (h, l, ic, extra = '') => `<a href="#/${h}" ${cur(h)} ${extra}>${I(ic, 22)}<span>${l}</span></a>`;
  app.innerHTML = `<header class="top"><div class="top-in">
    <a class="brandlink" href="#/c" aria-label="ONE Desk home"><span class="logo-tile">${I('ticket', 18)}</span>ONE Desk</a>
    <nav aria-label="Main">${nav.map(([h, l, ic]) => `<a href="#/${h}" ${cur(h)}>${I(ic, 17)}${l}</a>`).join('')}</nav>
    <div class="top-r">${sa ? `<select id="tsw" aria-label="Campus">${S.me.tenants.map(t => `<option value="${t.id}" ${t.id === S.tenant ? 'selected' : ''}>${esc(t.code)}</option>`).join('')}</select>` : ''}
      <a class="ibtn bell" href="${bellHref}" ${bellAttr} aria-label="Notifications">${I('bell', 20)}<i class="ndot" hidden></i></a>
      <a class="ibtn gear" href="#/settings" aria-label="Settings">${I('settings', 20)}</a><span class="vdiv"></span>
      <a class="melink" href="#/c/me" aria-label="Profile: ${esc(u.name)}">${avatar(u.name, 36, 'dark')}<span class="who"><b>${esc(u.name)}</b><span>${esc(cap(u.role.replace('_', ' ')))}</span></span></a></div></div></header>
    <div class="cwrap">${active !== 'c' || title ? `<div class="head"><a class="iconbtn" href="#/c" id="bk" aria-label="Back">${I('back')}</a><h1>${esc(title || (all.find(n => n[0] === active) || [])[1] || '')}</h1></div>` : ''}<div id="main">Loading…</div></div>
    <nav class="bnav" aria-label="Primary">${bn('c', 'Home', 'home')}
      <a href="${bellHref}" ${bellAttr} ${active === 'c/attention' ? 'class="on" aria-current="page"' : ''}>${I('bell', 22)}<span>Attention</span><i class="ndot" hidden></i></a>
      <a href="#/c/new" class="newt" aria-label="New ticket">${I('plus', 24)}</a>
      ${bn('c/reports', 'Reports', 'chart')}<button type="button" id="moreb" aria-haspopup="dialog" ${['c/services', 'c/sla', 'c/email', 'c/users', 'c/audit', 'c/tenants', 'c/food'].includes(active) ? 'class="on"' : ''}>${I('more', 22)}<span>More</span></button></nav>`;
  app.querySelectorAll('[data-overdue]').forEach(a => a.onclick = () => { sessionStorage.setItem('qf', JSON.stringify({ status: 'overdue' })); if (location.hash === '#/c') route(); });
  $('#moreb').onclick = () => moreSheet(all.filter(n => !['c', 'c/new', 'c/attention', 'c/reports'].includes(n[0])));
  bellDot(admin);
  if ($('#tsw')) $('#tsw').onchange = e => { S.tenant = e.target.value; localStorage.setItem('tid', S.tenant); route(); };
  const main = $('#main');
  S.nav = all;
  if ($('#bk') && title === 'Ticket') $('#bk').onclick = e => { e.preventDefault(); history.length > 1 ? history.back() : location.hash = '#/c'; };
  if (!S.tenant && !['c/tenants', 'c/me'].includes(active)) { main.innerHTML = '<p>No tenant yet. <a href="#/c/tenants">Create one</a>.</p>'; return; }
  try { await render(main, { sa, admin, u }); } catch (e) { main.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
}
// The red dot on the bell: something needs attention (admins: the Attention lists; providers: overdue tickets). Checked at most once a minute.
async function bellDot(admin) {
  const show = () => document.querySelectorAll('.ndot').forEach(d => d.hidden = !S.bell?.on);
  show(); if (!S.tenant || (S.bell && S.bell.for === S.tenant && Date.now() - S.bell.at < 60e3)) return;
  try { const rem = (await api('/reminders').catch(() => ({ due: [] }))).due.length > 0;
    const on = rem || (admin ? Object.values(await api('/attention')).some(l => l.length) : (cc => (cc.overdue || 0) + (cc.reopen_requests || 0) > 0)((await api('/reports?days=7')).counts || {}));
    S.bell = { on, at: Date.now(), for: S.tenant }; show(); } catch { /* the dot is a hint only */ }
}
// Phone: the More sheet (the screens that are not on the tab bar, Settings, and Install app when it can be installed)
function moreSheet(items) {
  document.querySelector('.msheet-back')?.remove(); document.querySelector('.msheet')?.remove();
  const row = (tag, attrs, ic, label) => `<${tag} class="mrow ${attrs.cls || ''}" ${attrs.a}>${tile(ic, 18)}<span class="l">${label}</span><span class="chv">${I('chev', 18)}</span></${tag}>`;
  document.body.insertAdjacentHTML('beforeend', `<div class="msheet-back"></div><div class="msheet" role="dialog" aria-modal="true" aria-labelledby="mshT"><div class="grab"></div>
    <div class="msheet-h"><h2 id="mshT">More</h2><button type="button" class="msheet-x" aria-label="Close">${I('x', 20)}</button></div>
    ${items.map(([h, l, ic]) => row('a', { a: `href="#/${h}"` }, ic, l)).join('')}${row('a', { a: 'href="#/settings"' }, 'settings', 'Settings')}
    ${canInstall() ? row('button', { a: 'type="button"', cls: 'install' }, 'download', 'Install app') : ''}</div>`);
  const sheet = document.querySelector('.msheet'), close = () => { document.querySelector('.msheet-back')?.remove(); sheet.remove(); document.removeEventListener('keydown', esc_); $('#moreb')?.focus(); };
  const esc_ = e => { if (e.key === 'Escape') close(); };
  document.querySelector('.msheet-back').onclick = close; sheet.querySelector('.msheet-x').onclick = close; document.addEventListener('keydown', esc_);
  sheet.querySelectorAll('.mrow').forEach(r => r.addEventListener('click', () => setTimeout(close, 0)));
  sheet.querySelector('.msheet-x').focus();
}
const tenantObj = () => S.me.tenants.find(t => t.id === S.tenant);

// One ticket as a card: state strip, number + labels, subject, service, requestor, location, due / resume time.
// ---------- tickets as a table (desktop) and as cards (phones) ----------
const shortDate = iso => iso ? new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '—';
// what the last column / card foot says: [label, date, icon, isClosedLike]
function ticketWhen(r) {
  const now = new Date().toISOString(), holdOver = r.status === 'hold' && r.hold_due_at && r.hold_due_at < now;
  if (r.kind === 'suggestion' && [...ACTIVE, 'hold'].includes(r.status)) return ['Suggested', r.created_at, 'idea', false];
  if (r.reopen_requested_at && r.status === 'closed') return ['Reopen asked', r.reopen_requested_at, 'history', false];
  return r.queued ? ['Reaches the team', r.lands_at, 'clock', false] : ACTIVE.includes(r.status) ? [isOverdue(r) ? 'Overdue since' : 'Due', r.due_at, 'clock', false]
    : r.status === 'hold' ? [holdOver ? 'Hold overdue since' : 'Resume by', r.hold_due_at, 'pause', false] : [r.status === 'closed' ? 'Closed' : 'Rejected', r.closed_at, r.status === 'closed' ? 'check' : 'xmark', true];
}
const isOverdue = r => r.kind === 'suggestion' ? false : r.overdue ?? (ACTIVE.includes(r.status) && !!r.due_at && r.due_at < new Date().toISOString()); // lists that come without the flag
const ticketStatus = r => isOverdue(r) ? 'overdue' : r.status; // an open ticket past its due time shows as Overdue
const ticketFlags = r => `${r.kind === 'suggestion' ? `<span class="pill sugg">${I('idea', 12)}Suggestion</span>` : ''}${r.reopen_requested_at && r.status === 'closed' ? '<span class="pill reoq">Reopen requested</span>' : ''}${r.escalated_at && [...ACTIVE, 'hold'].includes(r.status) ? `<span class="pill" title="Escalated to ${esc(r.escalated_name || '')}">Escalated</span>` : ''}${r.queued ? '<span class="pill">In queue</span>' : ''}${r.is_internal ? '<span class="pill">Internal</span>' : ''}`;
const ticketPeople = r => `${esc(r.requestor)}${r.affected_count > 1 ? ` + ${r.affected_count - 1} more` : ''}${r.requestor_type && r.requestor_type !== 'student' ? ' ' + rtBadge(r.requestor_type) : ''}`;
// One ticket as a card: one link to the ticket (phones, and the short lists on other screens)
function ticketCard(r) {
  const w = ticketWhen(r);
  return `<a class="tcard ${r.status === 'rejected' ? 'dim' : ''}" href="#/c/t/${r.id}" data-id="${r.id}">
    <span class="tc-r1"><span class="mono tc-no">#${r.ticket_no}</span>${priorityTag(r.priority)}<span class="sp"></span>${ticketFlags(r)}${pill(ticketStatus(r))}</span>
    <span class="tc-r2"><b class="tc-title">${esc(r.subject)}</b><span class="tc-loc">${esc([r.service, r.location, r.problem_label].filter(Boolean).join(' · '))}</span></span>
    <span class="tc-r3">${avatar(r.requestor, 24)}<span class="tc-who">${ticketPeople(r)}</span><span class="tc-when ${w[3] ? 'done' : ''}">${I(w[2] === 'xmark' ? 'x' : w[2], 14)}${w[0]} ${shortDate(w[1])}</span></span></a>`;
}
function ticketTable(rows) {
  return `<div class="tblbox"><table class="ttable"><thead><tr><th>Ticket</th><th>Requester</th><th>Location</th><th>Priority</th><th>Status</th><th>Due / closed</th></tr></thead><tbody>
    ${rows.map(r => { const w = ticketWhen(r); return `<tr data-id="${r.id}" class="${r.status === 'rejected' ? 'dim' : ''}">
      <td><a href="#/c/t/${r.id}" class="tt-main"><span class="mono tt-no">#${r.ticket_no}</span><b>${esc(r.subject)}</b><span class="tt-svc">${esc(r.service)}</span></a></td>
      <td><span class="tt-req">${avatar(r.requestor, 28)}<span>${ticketPeople(r)}</span></span></td>
      <td class="tt-loc">${esc([r.location, r.problem_label].filter(Boolean).join(' · ')) || '—'}</td>
      <td>${priorityTag(r.priority)}</td><td><span class="tt-st">${pill(ticketStatus(r))}${ticketFlags(r)}</span></td>
      <td><span class="tt-when ${w[3] ? 'done' : ''}"><small>${w[0]}</small>${shortDate(w[1])}</span></td></tr>`; }).join('')}</tbody></table></div>`;
}
// progress ring: starts at 12 o'clock, round caps
const ringSvg = (pct, size, stroke) => { const r = (size - stroke) / 2, c = 2 * Math.PI * r;
  return `<span class="pring" style="width:${size}px;height:${size}px" role="img" aria-label="${pct}% of this week's tickets closed"><svg width="${size}" height="${size}" aria-hidden="true"><circle cx="${size / 2}" cy="${size / 2}" r="${r}" stroke="#EEF0F3" stroke-width="${stroke}" fill="none"/>
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" stroke="var(--accent)" stroke-width="${stroke}" fill="none" stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - pct / 100)}" transform="rotate(-90 ${size / 2} ${size / 2})"/></svg><b>${pct}%</b></span>`; };

let pollT;
async function queue(main) {
  const services = await api('/services');
  const st = JSON.parse(sessionStorage.getItem('qf') || '{"status":"open"}');
  const draw = async () => {
    const keep = document.activeElement?.id === 'fq' ? [$('#fq').selectionStart, true] : null, more = $('.mt-more')?.classList.contains('open');
    const qs = new URLSearchParams(Object.entries(st).filter(([, v]) => v)).toString();
    const [rows, rep, pts, rem] = await Promise.all([api('/tickets?' + qs), api('/reports?days=7'), api('/points'), api('/reminders').catch(() => ({ due: [], upcoming: [] }))]);
    const c = rep.counts || {};
    const done = c.closed_period || 0, total = done + (c.open || 0) + (c.in_progress || 0) + (c.hold || 0), pct = total ? Math.round(100 * done / total) : 0;
    const now = new Date(), h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', hourCycle: 'h23' }).format(now)), greet = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
    const day = o => now.toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata', ...o }), tn = tenantObj();
    const cell = (k, label, n, cap_) => `<button type="button" class="stcell ${st.status === k ? 'on' : ''}" data-s="${k}" aria-pressed="${st.status === k}"><span class="stl">${statusIcon(k)}${label}</span>
      <b class="${k === 'overdue' && n > 0 ? 'hot' : ''}">${n || 0}</b><span class="stc">${cap_}</span></button>`;
    const counts = { open: c.open, in_progress: c.in_progress, hold: c.hold, overdue: c.overdue, queued: c.queued, reopen: c.reopen_requests, suggestions: c.suggestions };
    const tabs = [['all', 'All'], ['open', 'Open'], ['in_progress', 'In progress'], ['hold', 'On hold'], ['overdue', 'Overdue'], ['reopen', 'Reopen requests'], ['escalated', 'Escalated'], ['suggestions', 'Suggestions'], ['closed', 'Closed'], ['rejected', 'Rejected'], ['queued', 'In queue']]
      .filter(([k]) => !['reopen'].includes(k) || counts[k] || st.status === k);
    main.innerHTML = `<div class="home">
      <div class="greet"><div><div class="eyebrow"><span class="d-only">${day({ weekday: 'long', day: 'numeric', month: 'long' })} · ${esc(tn?.name || '')}</span><span class="m-only">${day({ weekday: 'short', day: 'numeric', month: 'short' })} · ${esc(tn?.code || '')}</span></div>
        <h1>${greet}, ${esc(S.me.user.name.split(' ')[0])} <span class="wave" aria-hidden="true">👋</span></h1></div>
        <div class="greet-r"><a href="#/c/me" class="ptschip" aria-label="${pts.me} points. Open my points">${I('star', 16)}<span>${pts.me} pts</span></a>
          <a href="#/c/new" class="btn primary d-only">${I('plus', 16)}New ticket</a></div></div>
      <div class="ovr"><div class="card wk"><span class="d-only">${ringSvg(pct, 88, 8)}</span><span class="m-only">${ringSvg(pct, 64, 7)}</span><div><div class="eyebrow up">This week</div><div class="wk-l">${done} of ${total} tickets closed</div><div class="wk-s d-only">${total - done} still open this week</div></div></div>
        <div class="card stcard">${cell('open', 'Open', c.open, 'Awaiting action')}${cell('in_progress', 'In progress', c.in_progress, 'Being worked on')}${cell('hold', 'On hold', c.hold, 'Paused, clock stopped')}${cell('closed', 'Closed', c.closed_period, 'Last 7 days')}${cell('overdue', 'Overdue', c.overdue, 'Past SLA due time')}
          <a class="stcell viewrep m-only" href="#/c/reports">View reports ${I('chev', 16)}</a></div></div>
      ${rem.due.length ? `<section class="card rembox" aria-labelledby="remT"><div class="chead" id="remT">${tile('alarm')}<span>Reminders due</span><span class="cnt">${rem.due.length}</span><span class="sp"></span>${rem.upcoming.length ? `<span class="muted small">${rem.upcoming.length} later</span>` : ''}</div>
        ${rem.due.map(m => `<div class="remrow due"><a href="#/c/t/${m.ticket_id}"><span class="mono">#${m.ticket_no}</span> <b>${esc(m.note)}</b><span class="psub">${esc(m.subject)} · ${shortDate(m.remind_at)}</span></a>
          <button type="button" class="btn" data-remdone="${m.id}">${I('check', 16)}Done</button></div>`).join('')}</section>` : ''}
      ${c.reopen_requests ? `<button type="button" class="queuebar reobar" data-s="reopen">${I('history', 20)}<span><b>${c.reopen_requests} reopen request${c.reopen_requests === 1 ? '' : 's'} waiting for you</b><span class="small">A requester says it is not fixed. Open the ticket to accept or decline; you can reply with a note first.</span></span>${I('chev', 18)}</button>` : ''}
      ${c.queued ? `<button type="button" class="queuebar" data-s="queued">${I('clock', 20)}<span><b>${c.queued} ticket${c.queued === 1 ? '' : 's'} waiting in the queue</b><span class="small">Your team's tickets for today are full. These reach you on the next working days, a day's worth at a time.</span></span>${I('chev', 18)}</button>` : ''}
      <div class="card mt"><div class="mt-h"><div class="mt-t"><h2>My tickets</h2><span class="mt-n">${rows.length} ticket${rows.length === 1 ? '' : 's'}</span>
          <button type="button" class="iconbtn m-only" id="fsvb" aria-label="Filter by service" aria-expanded="${!!more}">${I('filter', 20)}</button></div>
        <div class="mt-tools"><label class="search">${I('search', 18)}<input id="fq" type="search" aria-label="Search tickets" placeholder="Search by ID, subject or person" value="${esc(st.q || '')}"></label>
          <div class="mt-more ${more ? 'open' : ''}"><select id="fsv" aria-label="Service"><option value="">All my services</option>${services.map(s => `<option value="${s.id}" ${st.service === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>
          <a href="/api/tickets.csv?${qs}" id="csv" class="btn">${I('download', 16)}Export CSV</a></div></div></div>
        <div class="tabs mt-tabs">${tabs.map(([k, l]) => `<button class="tab ${st.status === k ? 'on' : ''}" data-s="${k}"><span>${l}</span>${counts[k] ? `<span class="cnt">${counts[k]}</span>` : ''}</button>`).join('')}</div>
        ${rows.length ? `${ticketTable(rows)}<div class="tcards">${rows.map(ticketCard).join('')}</div>` : `<div class="mt-empty">${emptyState('No tickets here', 'Nothing matches this filter. Try another status or clear the search.')}</div>`}</div></div>`;
    main.querySelectorAll('.ttable tbody tr').forEach(tr => { tr.onclick = e => { if (!e.target.closest('a')) location.hash = '#/c/t/' + tr.dataset.id; }; });
    const set = (k, v) => { st[k] = v; sessionStorage.setItem('qf', JSON.stringify(st)); draw(); };
    main.querySelectorAll('[data-s]').forEach(b => b.onclick = () => set('status', b.dataset.s)); $('#fsv').onchange = e => set('service', e.target.value);
    main.querySelectorAll('[data-remdone]').forEach(b => b.onclick = async () => { try { await api(`/reminders/${b.dataset.remdone}/done`, { method: 'POST' }); S.bell = null; toast('Reminder done'); draw(); bellDot(S.me.user.role !== 'provider'); } catch (er) { toast(er.message); } });
    $('#fq').onchange = e => set('q', e.target.value);
    $('#fsvb').onclick = () => { const on = $('.mt-more').classList.toggle('open'); $('#fsvb').setAttribute('aria-expanded', on); if (on) $('#fsv').focus(); };
    $('#csv').onclick = async e => { e.preventDefault(); const r = await api('/tickets.csv?' + qs, { raw: true }); const a = document.createElement('a');
      a.href = URL.createObjectURL(await r.blob()); a.download = 'tickets.csv'; a.click(); };
    if (keep) { $('#fq').focus(); $('#fq').setSelectionRange(keep[0], keep[0]); }
  };
  await draw();
  clearInterval(pollT); pollT = setInterval(() => location.hash === '#/c' && !document.hidden && draw(), 30000);
}

// Remind me: when (a day, a week, a month, or a date) and what about. Only the ticket's reminder is saved; its status stays.
const REMIND_OPTS = [['day', 'Tomorrow'], ['3days', 'In 3 days'], ['week', 'In a week'], ['month', 'In a month'], ['at', 'Pick a date']];
function remindDlg(id, done) {
  const d = dlg(`<h2>Remind me later</h2><p class="muted small">The ticket stays as it is. At that time you get an email and it shows on your Home.</p>
    <label>When</label><div class="whochips remwhen" role="radiogroup" aria-label="When">${REMIND_OPTS.map(([k, l], i) => `<label><input type="radio" name="in" value="${k}" ${i === 2 ? 'checked' : ''}><span class="rtb">${l}</span></label>`).join('')}</div>
    <div id="remat" hidden><label for="remdt">Date and time</label><input type="datetime-local" id="remdt" name="at"></div>
    <label for="remnote">What should we remind you about?</label><textarea id="remnote" name="note" required maxlength="500" rows="3" placeholder="e.g. Check the new bulb is still working"></textarea>`,
    async f => { const k = f.querySelector('[name=in]:checked')?.value;
      if (k === 'at' && !f.at.value) throw new Error('Pick the date and time');
      const r = await api(`/tickets/${id}/reminders`, { method: 'POST', body: { in: k === 'at' ? null : k, at: k === 'at' ? new Date(f.at.value).toISOString() : null, note: f.note.value } });
      toast('Reminder set for ' + shortDate(r.remind_at)); done(); });
  const pad = n => String(n).padStart(2, '0'), min = new Date(Date.now() + 5 * 60e3), dt = d.querySelector('#remdt');
  dt.min = `${min.getFullYear()}-${pad(min.getMonth() + 1)}-${pad(min.getDate())}T${pad(min.getHours())}:${pad(min.getMinutes())}`;
  d.querySelectorAll('[name=in]').forEach(r => r.onchange = () => { const on = r.value === 'at' && r.checked; if (r.checked) { d.querySelector('#remat').hidden = !on; dt.required = on; } });
  d.querySelector('button[value=ok]').textContent = 'Set reminder';
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
  document.body.classList.add('on-ticket'); // phones: this page has its own app bar and bottom action bar
  const meta = e => { try { return JSON.parse(e.meta || '{}'); } catch { return {}; } };
  const stName = v => (STATUS_INFO[v] || [v])[0];
  const evLabel = e => ({ escalated: `Escalated to ${esc(e.to_value)}`, created: `Created in ${esc(e.to_value)}`, transferred: `Transferred ${esc(e.from_value)} → ${esc(e.to_value)}`,
    status_changed: (m => `${stName(e.from_value)} → ${stName(e.to_value)}${m.hold_reason ? ' · ' + esc(m.hold_reason) : ''}${m.points != null ? ` · ${m.points > 0 ? '+' : ''}${m.points} pts` : ''}`)(meta(e)), note: 'Note',
    reopened: 'Reopened', reopen_requested: 'Reopen requested', reopen_declined: 'Reopen declined', landed: 'Reached the team from the daily queue', due_extended: `Due extended to ${fmt(e.to_value)}`, merged: 'Also reported (same problem, same day)',
    priority_changed: `Priority ${esc(cap(e.from_value))} → ${esc(cap(e.to_value))}${meta(e).reason ? ' · ' + esc(meta(e).reason) : ''}` })[e.event_type] || esc(e.event_type);
  // timeline dot: a status change takes the new status's colour; reopened = Open; priority = red; created = accent; the rest grey
  const evDot = e => e.event_type === 'status_changed' ? `var(--st-${ST_VAR[e.to_value] || 'neutral'})` : e.event_type === 'reopened' ? 'var(--st-open)'
    : e.event_type === 'priority_changed' ? 'var(--st-overdue)' : e.event_type === 'created' ? 'var(--accent)' : e.event_type === 'reopen_requested' ? 'var(--st-hold)' : 'var(--st-neutral)';
  const targets = allowedTargets(t.status);
  const HINT = { same: 'Keeps the status and adds a note.',
    open: 'Reopens the ticket with a fresh target; the service providers are emailed.',
    in_progress: t.status === 'hold' ? 'Resumes work. The target moves forward by the time spent on hold.' : 'Tells the requester that work has started.',
    hold: 'Pauses the target clock. Pick a reason below; each has its own time limit, and going past it costs points.',
    closed: `The requester can reopen within ${tenantObj()?.reopen_window_days ?? 7} days. Add a proof photo if you can.`,
    rejected: 'Write the reason. The requester is told and can raise a new ticket.' };
  const schema = t.service.form_schema ? fieldsOf(JSON.parse(t.service.form_schema)) : [];
  const fdRaw = t.form_data || {};
  const fd = Object.entries(fdRaw).filter(([k, v]) => v !== '' && v != null && !/_label$/.test(k) && k !== 'food_location').map(([k, v]) => [schema.find(f => f.key === k)?.label || cap(k.replace(/^(loc|stu|food)_/, '').replace(/_/g, ' ')),
    k === 'food_category' ? fdRaw.food_category_label || v : k === 'meal' ? MEAL_NAMES[v] || v : Array.isArray(v) ? v.join(', ') : v]);
  const live = [...ACTIVE, 'hold'].includes(t.status), r = t.requestor, shown = ticketStatus(t);
  const dl = rows => rows.map(([k, v]) => `<div class="dli"><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');
  // SLA: the tag, the big value, and how much of the window is used (by the clock, from when the ticket reached the team)
  const start = new Date(t.lands_at || t.created_at).getTime(), due = new Date(t.due_at).getTime(), used = Math.max(0, Math.min(100, Math.round(100 * (Date.now() - start) / Math.max(1, due - start))));
  const dayOf = d => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d), dd = Math.round((new Date(dayOf(new Date(due))) - new Date(dayOf(new Date()))) / 864e5);
  const slaTag = !ACTIVE.includes(t.status) ? '' : t.sla_left_min < 0 ? '<span class="tag danger">Overdue</span>' : t.sla_left_min <= 24 * 60 ? `<span class="tag warn">${dd <= 0 ? 'Due today' : dd === 1 ? 'Due tomorrow' : 'Due soon'}</span>` : '';
  const sug = t.kind === 'suggestion';
  const slaBig = sug ? 'Suggestion' : t.queue ? `Queue no. ${t.queue.queue_no}` : ACTIVE.includes(t.status) ? fmtLeft(t.sla_left_min) + (t.sla_left_min < 0 ? ' late' : '') : t.status === 'hold' ? 'On hold' : stName(t.status);
  const slaSub = sug ? 'An idea from the requester: no target time, never overdue.' : t.queue ? `of ${t.queue.waiting} waiting · reaches the team on ${esc(t.queue.lands_on)}` : ACTIVE.includes(t.status) ? `${t.sla_left_min < 0 ? 'Past the SLA' : 'Working time left'} · due ${shortDate(t.due_at)}`
    : t.status === 'hold' ? `${esc(t.hold_label || '')} · ${t.hold_over ? 'hold limit passed' : 'resume by'} ${shortDate(t.hold_due_at)} · SLA clock paused` : t.closed_at ? shortDate(t.closed_at) : '';
  const slaCard = `<div class="card side sla">${`<div class="chead">${tile('clock')}<span>SLA</span><span class="sp"></span>${slaTag}</div>`}
    <div class="sla-row"><span class="sla-tile m-only">${I('clock', 20)}</span><div><div class="sla-big">${slaBig}</div><div class="sla-sub">${slaSub}</div></div></div>
    ${ACTIVE.includes(t.status) && !sug ? `<div class="pbar" role="progressbar" aria-label="Share of the SLA window used" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${used}"><i style="width:${used}%;${t.sla_left_min < 0 ? 'background:var(--danger)' : ''}"></i></div>` : ''}
    ${t.escalated_name && live ? `<div class="sla-note danger">${I('calert', 15)}<span>Escalated to ${esc(t.escalated_name)} · ${shortDate(t.escalated_at)}</span></div>` : ''}
    ${sug ? '' : `<div class="sla-foot"><span>Time on hold: ${t.held_minutes ? fmtLeft(t.held_minutes) : '0m'}</span>${admin && live ? '<button type="button" class="linkbtn" id="ext">Extend due time</button>' : ''}</div>`}</div>`;
  // my reminders on this ticket: only I see them; the ticket's status does not change
  const rems = t.reminders || [];
  const remCard = `<div class="card side rem">${cardHeading('alarm', 'My reminders')}
    ${rems.map(m => `<div class="remrow ${m.fired_at ? 'due' : ''}"><div><b>${esc(m.note)}</b><div class="psub">${m.fired_at ? 'Due since' : 'On'} ${shortDate(m.remind_at)}</div></div>
      <button type="button" class="linkbtn" data-remdone="${m.id}">${m.fired_at ? 'Done' : 'Remove'}</button></div>`).join('') || '<div class="psub">Need to check on this later? Set a reminder. The ticket stays as it is.</div>'}
    <button type="button" class="btn remadd" data-remadd>${I('alarm', 16)}Remind me</button></div>`;
  const prev = t.requestor_history || [];
  const people = `<div class="card side">${cardHeading('user', 'Requester')}
      <div class="person">${avatar(r.name, 40, 'accent')}<div><b>${esc(r.name)}</b> ${rtBadge(r.requestor_type || 'student')}<div class="psub">${esc([r.department, r.identifier].filter(Boolean).join(' · '))}</div></div></div>
      ${r.email ? `<a class="crow" href="mailto:${esc(r.email)}">${I('mail', 15)}<span>${esc(r.email)}</span></a>` : ''}${r.phone ? `<a class="crow" href="tel:${esc(r.phone)}">${I('phone', 15)}<span>${esc(r.phone)}</span></a>` : ''}
      ${prev.length ? `<div class="sdiv"></div><div class="slabel">Previous tickets</div>${prev.map(h => `<a class="prow" href="#/c/t/${h.id}"><span class="mono">#${h.ticket_no}</span>${pill(h.status)}</a>`).join('')}` : ''}</div>
    ${t.requestors?.length > 1 ? `<div class="card side">${cardHeading('users', `Requesters (${t.requestors.length})`)}${t.requestors.map(q => `<div class="rqrow"><b>${esc(q.name)}</b>${q.is_first ? ' <span class="tag">First</span>' : ''}
      <div class="psub">${esc(q.contact)} · ${shortDate(q.raised_at)}</div>${thumbs(t.attachments.filter(a => a.event_id === (q.is_first ? t.events.find(e => e.event_type === 'created')?.id : q.event_id)))}</div>`).join('')}</div>` : ''}
    <div class="card side">${cardHeading('users', 'Assigned to')}${t.providers.map(p => `<div class="person">${avatar(p.name, 40, 'dark')}<div><b>${esc(p.name)}</b><div class="psub">Provider${p.phone ? ' · ' + esc(p.phone) : ''}</div></div></div>`).join('') || '<div class="psub">No provider is mapped to this service.</div>'}</div>
    ${live ? `<div class="card side">${cardHeading('flag', 'Priority')}<select id="pri" aria-label="Priority">${PRIORITIES.map(p => `<option value="${p}" ${p === t.priority ? 'selected' : ''}>${cap(p)}</option>`).join('')}</select>
      <div class="helper">${I('eyeoff', 14)}<span>Set by your team. The requester never sees it.</span></div></div>` : ''}`;
  const evs = t.events, last = evs.length - 1;
  const timeline = `<ol class="tl">${evs.map((e, i) => `<li class="${i === last ? 'latest' : ''}"><span class="rail"><i style="background:${evDot(e)}"></i></span>
    <div class="tlc"><div class="tlt"><b>${evLabel(e)}</b>${e.is_internal ? '<span class="tag">Internal</span>' : ''}</div><div class="tlm">${shortDate(e.created_at)} · ${esc(e.actor_name || e.actor_type || '')}</div>
      ${e.body ? `<div class="bubble">${esc(e.body)}</div>` : ''}${thumbs(t.attachments.filter(a => a.event_id === e.id))}</div></li>`).join('')}</ol>`;
  const details = `<div class="issue"><div class="eyebrow up ic">${tile('file', 14)}Issue</div><p>${esc(t.description || t.subject)}</p></div>
    ${t.location ? `<div class="locrow m-only">${I('pin', 16)}<div><dt>Location</dt><dd>${esc(t.location)}</dd></div></div>` : ''}
    <dl class="dlist">${t.location ? `<div class="dli dli-loc"><dt>Location</dt><dd>${esc(t.location)}</dd></div>` : ''}${dl([...fd, ['Created', fmt(t.created_at)], ['Channel', cap(String(t.channel).replace('_', ' '))], ...(t.is_internal ? [['Kind', 'Internal request']] : [])])}</dl>`;
  const updateForm = `<form id="act" class="upd" aria-labelledby="updT">
      <div class="upd-h"><div class="chead" id="updT">${tile('pencil')}<span>Update this ticket</span></div><button type="button" class="msheet-x m-only" id="updX" aria-label="Close">${I('x', 20)}</button></div>
      <label for="to">Status<span class="m-only"> · now ${stName(t.status)}</span></label><select name="to" id="to">${STATUSES.map(s2 => `<option value="${s2}" ${s2 === t.status ? 'selected' : ''} ${s2 !== t.status && !targets.includes(s2) ? 'disabled' : ''}>${STATUS_INFO[s2][0]}${s2 === t.status ? ' (current)' : ''}</option>`).join('')}</select>
      <div class="helper" id="tohint"></div>
      <div id="holdrow" hidden><label>Why is it on hold?</label><select name="hold_reason">${t.hold_reasons.map(x => `<option value="${x.key}">${esc(x.label)} — ${x.hours}h limit</option>`).join('')}</select></div>
      <label for="unote">Note</label><textarea name="note" id="unote" required rows="4" placeholder="What did you do, or why this change?"></textarea>
      ${t.location_key && t.problem_key ? `<label id="earlyrow" class="chk" hidden><input type="checkbox" name="close_earlier"> Also close earlier open tickets for the same problem and location</label>` : ''}
      <div class="upd-row"><label class="iconbtn" aria-label="Attach a photo from camera">${I('camera', 18)}<input hidden type="file" accept="image/*" capture="environment" multiple data-source="camera" class="f-act"></label>
        <label class="iconbtn" aria-label="Attach from gallery">${I('image', 18)}<input hidden type="file" accept="image/*,application/pdf" multiple data-source="gallery" class="f-act"></label>
        <label class="chk"><input type="checkbox" name="is_internal"> Internal — hide from requester</label><span class="sp"></span>
        <button class="btn primary" id="go">${I('check', 16)}<span class="d-only">Update ticket</span><span class="m-only">Save update</span></button></div>
      <div class="muted f-act-n" style="font-size:12px"></div><div class="helper" id="mailhint"></div></form>`;
  const flags = `${sug ? `<span class="pill sugg">${I('idea', 12)}Suggestion</span>` : ''}${t.is_internal ? '<span class="pill">Internal</span>' : ''}${t.escalated_name && live ? '<span class="pill">Escalated</span>' : ''}${t.queue ? '<span class="pill">In queue</span>' : ''}`;
  const seg = sessionStorage.getItem('tkseg') || 'activity';
  main.innerHTML = `<div class="tkp" data-seg="${seg}">
    <div class="tk-appbar m-only"><button type="button" class="ibtn" data-back aria-label="Back to my tickets">${I('back', 22)}</button><div class="tk-abt"><b>Ticket</b><span class="mono">#${t.ticket_no}</span></div>
      <a class="ibtn" href="${t.tracking_url}" target="_blank" rel="noopener" aria-label="Requester's view">${I('eye', 20)}</a><button type="button" class="ibtn" id="tkmore" aria-label="More actions" aria-haspopup="dialog">${I('more', 20)}</button></div>
    <a href="#/c" class="backlink d-only" data-back>${I('back', 16)}Back to my tickets</a>
    <div class="tk-title"><div><div class="tk-ids"><span class="mono d-only">#${t.ticket_no}</span>${pill(shown)}${priorityTag(t.priority, true)}${flags}</div>
        <h1>${esc(t.subject)}</h1><div class="tk-sub"><span>${esc(t.service.name)}</span><span class="d-only"> · Raised via ${esc(String(t.channel).replace('_', ' '))} by</span><span class="m-only"> ·</span> <span>${esc(r.name)}</span></div></div>
      <div class="tk-acts d-only"><a class="btn" href="${t.tracking_url}" target="_blank" rel="noopener">${I('eye', 16)}Requester's view</a>${live ? `<button type="button" class="btn" id="tr">${I('swap', 16)}Transfer</button>` : ''}</div></div>
    <div class="tk-cols">
      <div class="segs m-only" role="tablist" aria-label="Ticket sections">${[['activity', `Activity <span class="cnt">${evs.length}</span>`], ['details', 'Details'], ['people', 'People']].map(([k, l]) => `<button type="button" role="tab" aria-selected="${seg === k}" data-seg="${k}">${l}</button>`).join('')}</div>
      ${t.reopen_request ? `<section class="card reoreq"><div class="reo-h">${tile('history')}<div><b>Reopen requested</b><div class="psub">${esc(r.name)} · ${shortDate(t.reopen_request.at)}</div></div></div>
        ${t.reopen_request.note ? `<div class="bubble">${esc(t.reopen_request.note)}</div>` : ''}
        ${t.reopen_request.can_decide ? `<div class="psub">Reply with a note below if you need more detail first. Accepting reopens the ticket with a fresh target; the requester is emailed either way.</div>
          <div class="reo-acts"><button type="button" class="btn primary" data-reo="accept">${I('history', 16)}Accept and reopen</button><button type="button" class="btn" data-reo="decline">Decline</button></div>`
        : `<div class="psub">Waiting for ${esc(t.reopen_request.deciders.join(' or ') || 'the provider who closed it')} to accept or decline.</div>`}</section>` : ''}
      <div class="tk-main"><section class="card sec-details">${details}</section>
        <section class="card sec-activity"><div class="act-h">${cardHeading('history', 'Activity')}<span class="act-n">${evs.length} event${evs.length === 1 ? '' : 's'}<span class="m-only"> · Newest first</span></span></div>${timeline}${updateForm}</section></div>
      <aside class="tk-side">${slaCard}${remCard}<div class="sec-people">${people}</div></aside></div>
    <div class="tk-bar m-only">${live ? `<button type="button" class="btn" id="trm">${I('swap', 16)}Transfer</button>` : ''}<button type="button" class="btn primary" id="updOpen">${I('pencil', 16)}Update ticket</button></div>
    <div class="msheet-back upd-back" hidden></div></div>`;
  wireFiles('act');
  const reload = () => workspace(main, id, { admin });
  const back = e => { e.preventDefault(); history.length > 1 ? history.back() : location.hash = '#/c'; };
  main.querySelectorAll('[data-back]').forEach(b => b.onclick = back);
  // phones: the three sections, and the update form as a bottom sheet
  const tkp = main.querySelector('.tkp');
  main.querySelectorAll('.segs [data-seg]').forEach(b => b.onclick = () => { tkp.dataset.seg = b.dataset.seg; sessionStorage.setItem('tkseg', b.dataset.seg);
    main.querySelectorAll('.segs [data-seg]').forEach(x => x.setAttribute('aria-selected', x === b)); });
  const sheet = on => { $('#act').classList.toggle('open', on); main.querySelector('.upd-back').hidden = !on; if (on) $('#to').focus(); else $('#updOpen')?.focus(); };
  $('#updOpen').onclick = () => { tkp.dataset.seg = 'activity'; sessionStorage.setItem('tkseg', 'activity'); sheet(true); };
  $('#updX').onclick = () => sheet(false); main.querySelector('.upd-back').onclick = () => sheet(false);
  const sel = $('#to'), sync = () => { const to = sel.value, same = to === t.status;
    $('#holdrow').hidden = to !== 'hold'; $('#tohint').textContent = HINT[same ? 'same' : to]; if ($('#earlyrow')) $('#earlyrow').hidden = to !== 'closed';
    $('#mailhint').textContent = $('#act').is_internal.checked ? 'Saved as an internal note. The requester will not be emailed.' : 'The requester will get this note by email.'; };
  sel.onchange = sync; $('#act').is_internal.onchange = sync; sync();
  $('#act').onsubmit = async e => {
    e.preventDefault(); const f = e.target, to = f.to.value, note = f.note.value.trim();
    if (!note) return toast('Write a note first');
    if (to === 'hold' && !f.hold_reason.value) return toast('Pick a hold reason');
    try { const body = { note, body: note, is_internal: f.is_internal.checked, files: await readFiles(document.querySelectorAll('.f-act')) };
      if (to === t.status) { await api(`/tickets/${id}/notes`, { method: 'POST', body }); toast('Note added'); }
      else { const res = await api(`/tickets/${id}/status`, { method: 'POST', body: { ...body, to, hold_reason: f.hold_reason.value, close_earlier: !!f.close_earlier?.checked } });
        toast((res.points != null ? `Closed · ${res.points > 0 ? '+' : ''}${res.points} points` : `Status: ${STATUS_INFO[to][0]}`) + (res.closed_earlier ? ` · ${res.closed_earlier} earlier closed too` : '')); }
      sessionStorage.setItem('tkseg', 'activity'); reload();
    } catch (er) { toast(er.message); if (er.status === 409) reload(); }
  };
  main.querySelectorAll('#pri').forEach(p => p.onchange = async e => { try { await api(`/tickets/${id}/priority`, { method: 'POST', body: { priority: e.target.value } }); reload(); } catch (er) { toast(er.message); } });
  const transfer = () => dlg(`<h2>Transfer ticket</h2><label>To service</label><select name="service_id">${services.filter(s2 => s2.id !== t.service_id && s2.is_active).map(s2 => `<option value="${s2.id}">${esc(s2.name)}</option>`).join('')}</select>
    <label>Note</label><textarea name="note" required></textarea>`, async f => { await api(`/tickets/${id}/transfer`, { method: 'POST', body: formVals(f) }); toast('Transferred'); location.hash = '#/c'; });
  const extend = () => dlg(`<h2>Extend due time</h2><label>Hours</label><input name="hours" type="number" min="1" required><label>Reason</label><textarea name="reason" required></textarea>`,
    async f => { await api(`/tickets/${id}/extend`, { method: 'POST', body: formVals(f) }); reload(); });
  main.querySelectorAll('#tr, #trm').forEach(b => b.onclick = transfer);
  const remind = () => remindDlg(id, reload);
  main.querySelectorAll('[data-remadd]').forEach(b => b.onclick = remind);
  main.querySelectorAll('[data-remdone]').forEach(b => b.onclick = async () => { try { await api(`/reminders/${b.dataset.remdone}/done`, { method: 'POST' }); S.bell = null; toast(b.textContent === 'Done' ? 'Reminder done' : 'Reminder removed'); reload(); } catch (er) { toast(er.message); } });
  main.querySelectorAll('[data-reo]').forEach(b => b.onclick = () => { const acc = b.dataset.reo === 'accept';
    dlg(`<h2>${acc ? 'Accept and reopen' : 'Decline the reopen request'}</h2><p class="muted">${acc ? 'The ticket opens again with a fresh target. The requester is emailed.' : 'The ticket stays closed. The requester is emailed your note.'}</p>
      <label>Note to the requester</label><textarea name="note" required placeholder="${acc ? 'What happens next' : 'Why it stays closed'}"></textarea>`,
      async f => { await api(`/tickets/${id}/reopen-request`, { method: 'POST', body: { decision: b.dataset.reo, note: f.elements.note.value } }); toast(acc ? 'Reopened' : 'Kept closed'); reload(); }); }); main.querySelectorAll('#ext').forEach(b => b.onclick = extend);
  // phones: the three-dots menu holds the secondary actions
  $('#tkmore').onclick = () => actionSheet('More actions', [['alarm', 'Remind me later', remind], live && ['swap', 'Transfer to another service', transfer], admin && live && ['clock', 'Extend due time', extend],
    ['eye', "Open the requester's view", () => window.open(t.tracking_url, '_blank', 'noopener')], ['copy', 'Copy the ticket number', () => navigator.clipboard?.writeText(t.ticket_no).then(() => toast('Number copied'))]].filter(Boolean));
  document.onkeydown = e => { if (!location.hash.startsWith('#/c/t/') || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName) || $('dialog')) return;
    const m = { h: 'hold', c: 'closed', r: 'rejected' }[e.key];
    if (m && targets.includes(m)) { sel.value = m; sync(); $('#act').note.focus(); }
    if (e.key === 't' && live) transfer(); };
}
// A small bottom sheet of actions (phones): rows of [icon, label, action]
function actionSheet(title, rows) {
  document.querySelector('.asheet-back')?.remove(); document.querySelector('.asheet')?.remove();
  document.body.insertAdjacentHTML('beforeend', `<div class="msheet-back asheet-back"></div><div class="msheet asheet" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="grab"></div>
    <div class="msheet-h"><h2>${esc(title)}</h2><button type="button" class="msheet-x" aria-label="Close">${I('x', 20)}</button></div>
    ${rows.map(([ic, l], i) => `<button type="button" class="mrow" data-i="${i}">${tile(ic, 18)}<span class="l">${esc(l)}</span><span class="chv">${I('chev', 18)}</span></button>`).join('')}</div>`);
  const sh = document.querySelector('.asheet'), close = () => { document.querySelector('.asheet-back')?.remove(); sh.remove(); };
  document.querySelector('.asheet-back').onclick = close; sh.querySelector('.msheet-x').onclick = close;
  sh.querySelectorAll('.mrow').forEach(b => b.onclick = () => { close(); rows[b.dataset.i][2](); });
  sh.querySelector('.msheet-x').focus();
}

async function newTicket(main) {
  const services = (await api('/services')).filter(s => s.is_active);
  if (!services.length) { main.innerHTML = `<div class="empty card">${I('grid', 40)}<p><b>No services on this campus yet.</b></p>
    <p class="muted">A ticket always belongs to a service. ${S.me.user.role === 'provider' ? 'Ask your admin to add one.' : '<a href="#/c/services">Add a service</a> first, then come back here.'}</p></div>`; return; }
  main.innerHTML = `<form id="f" class="card" style="max-width:720px">
    <label style="margin-top:0">Kind</label><select name="channel"><option value="walk_in">Walk-in (on behalf of a requestor)</option><option value="phone">Phone call</option><option value="internal">Internal request (from me to another service)</option></select>
    <label>Service</label><select name="service_id" id="svc">${services.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select>
    <div id="who"><div class="row"><div><label>Requestor name</label><input name="name"></div><div><label>Type</label><select name="requestor_type">${REQUESTOR_TYPES.map(t => `<option value="${t}">${cap(t)}</option>`).join('')}</select></div></div>
    <div class="row"><div><label>Email <small>(updates go here)</small></label><input name="email" type="email" required></div><div><label>Phone</label><input name="phone"></div></div>
    <div class="row" id="idrow"><div><label>Roll / emp ID</label><input name="identifier"></div><div><label>Department</label><input name="department"></div></div></div><div id="tfs"></div>
    <label>Priority</label><select name="priority">${PRIORITIES.map(p => `<option value="${p}" ${p === 'medium' ? 'selected' : ''}>${cap(p)}</option>`).join('')}</select>
    <div id="locrow"><label>Location</label><input name="location" required></div><label>Subject</label><input name="subject" required><label>Description</label><textarea name="description"></textarea>
    <div id="cf"></div><label>Photos <small>(up to ${MAX_FILES})</small></label>${fileButtons('nt')}<p><button class="btn primary big">${I('send')} Create ticket</button></p></form>`;
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
      toast('Created ' + t.ticket_no); location.hash = '#/c/t/' + t.id; } catch (er) { toast(er.message); } };
}

async function attention(main) {
  const a = await api('/attention');
  const sec = (icon, title, n, body, hint) => `<section class="card att"><div class="att-h">${cardHeading(icon, title)}<span class="tab-cnt ${n ? 'hot' : ''}">${n}</span></div>${n ? body : emptyState('All clear', hint)}</section>`;
  const tix = rows => `${ticketTable(rows)}<div class="tcards">${rows.map(ticketCard).join('')}</div>`;
  main.innerHTML = `<div class="attp">
    ${a.reopen_requests?.length ? sec('history', 'Reopen requests', a.reopen_requests.length, tix(a.reopen_requests), '') : ''}
    ${sec('calert', 'Overdue', a.overdue.length, tix(a.overdue), 'No ticket is past its due time.')}
    ${sec('bell', 'Escalated', a.escalated.length, tix(a.escalated), 'No open ticket is escalated.')}
    ${sec('cpause', 'On hold past the hold limit', a.stuck_hold.length, tix(a.stuck_hold), 'No hold has run past its limit.')}
    ${sec('users', 'Services with no provider', a.no_provider.length, `<div class="att-list">${a.no_provider.map(s => `<a class="att-row" href="#/c/services"><span><b>${esc(s.name)}</b><span class="psub">${s.open_count} active ticket${s.open_count === 1 ? '' : 's'}</span></span><span class="linkbtn">Map a provider</span></a>`).join('')}</div>`, 'Every service has a provider.')}
    ${sec('mail', 'Emails that failed to send', a.failed_mail.length, `<div class="att-list">${a.failed_mail.map(n => `<div class="att-row"><span><b>${esc(n.subject)}</b><span class="psub">${esc(n.recipient)} · ${esc(n.last_error || '')}</span></span><button class="btn" data-n="${n.id}">Resend</button></div>`).join('')}</div>`, 'Every email went out.')}</div>`;
  main.querySelectorAll('.ttable tbody tr').forEach(tr => { tr.onclick = e => { if (!e.target.closest('a')) location.hash = '#/c/t/' + tr.dataset.id; }; });
  main.querySelectorAll('[data-n]').forEach(b => b.onclick = async () => { await api(`/notifications/${b.dataset.n}/resend`, { method: 'POST' }); toast('Queued'); attention(main); });
}

async function services(main) {
  const [svcs, users, slaCfg] = await Promise.all([api('/services'), api('/users'), api('/sla')]);
  const campusSla = slaCfg.targets || {};
  // SLA for this team (department): its own target hours per priority; empty = the main team's, else the campus default
  const slaBox = (s = {}) => { const par = s.parent_id ? svcs.find(x => x.id === s.parent_id) : null;
    return `<b style="display:block;margin-top:20px">SLA for this team</b><div class="muted small">Working hours to close, by priority. Leave a box empty to use ${par ? `${esc(par.name)}'s (then the campus default)` : 'the campus default'}. Set on <a href="#/c/sla">SLA &amp; points</a>.</div>
      <div class="row slarow">${PRIORITIES.slice().reverse().map(p => `<div><label style="text-transform:capitalize">${p}</label><input type="number" min="1" step="1" inputmode="numeric" name="sla_${p}" value="${s.sla?.[p] || ''}" placeholder="${(par?.sla?.[p]) || campusSla[p] || ''} h"></div>`).join('')}</div>`; };
  const eligible = users.filter(u => u.is_active);
  const provSel = (name, val) => `<select name="${name}"><option value="">— None —</option>${eligible.map(u => `<option value="${u.id}" ${u.id === val ? 'selected' : ''}>${esc(u.name)}${u.role === 'tenant_admin' ? ' (admin)' : ''}</option>`).join('')}</select>`;
  const iconPick = cur => `<div class="iconpick">${ICONS.map((ic, i) => `<label><input type="radio" name="icon" value="${ic}" ${ic === cur ? 'checked' : ''}><span class="chip c${i % 5}">${I(ic, 20)}</span></label>`).join('')}</div>`;
  const fields = (s = {}) => `<label>Service name</label><input name="name" required value="${esc(s.name || '')}" placeholder="e.g. Plumbing">
    ${s.id ? '' : '<label>Code <small>(2–12 letters or digits, no spaces; used in QR links)</small></label><input name="code" required maxlength="12" pattern="[A-Za-z0-9\\-]{2,12}" title="2–12 letters or digits, no spaces" placeholder="e.g. ADM" style="text-transform:uppercase">'}
    <label>Description</label><input name="description" value="${esc(s.description || '')}" placeholder="What this service covers">
    <label>Icon</label>${iconPick(s.id ? svcIcon(s) : 'grid')}
    ${typePick(s.form_schema || { form_type: 'general' })}
    <label>Part of <small>(make this a sub-team, e.g. Electrical under Maintenance)</small></label><select name="parent_id"><option value="">— Main team (not a sub-team) —</option>${svcs.filter(x => !x.parent_id && x.id !== s.id).map(x => `<option value="${x.id}" ${x.id === s.parent_id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
    <label>Service providers / nodal officers <small>(any number; they get this team's tickets${s.id && svcs.some(x => x.parent_id === s.id) ? ' and see its sub-teams' : ''})</small></label>${pickMany('prov', (s.members || []).map(m => m.id))}
    <label>Escalation officers <small>(any number; only they get the ticket when it misses its target; none = the main team's, else the admin)</small></label>${pickMany('escs', (s.escalation_users || []).map(m => m.id))}
    <label>Escalate after <small>(working hours past the target; 0 = the moment it is missed; empty = the campus setting${s.parent_id ? ' or the main team’s' : ''})</small></label><input name="escalate_after_hours" type="number" min="0" step="0.5" inputmode="decimal" placeholder="Campus setting" value="${s.escalate_after_hours ?? ''}">
    <label>Tickets a day <small>(how many new tickets the team takes each day; empty = no limit)</small></label><input name="daily_cap" type="number" min="0" step="1" inputmode="numeric" placeholder="No limit" value="${s.daily_cap || ''}">
    <div class="muted small">Example: 100. If 500 students raise a ticket today, the first 100 reach the team today. The others get a queue number, are told how many are ahead of them, and reach the team 100 a day on the next working days.</div>`;
  const pickMany = (name, sel) => `<div class="svcpick">${eligible.map(u => `<label><input type="checkbox" name="${name}" value="${u.id}" ${sel.includes(u.id) ? 'checked' : ''}> ${esc(u.name)}${u.role === 'tenant_admin' ? ' <small>(admin)</small>' : ''}</label>`).join('') || '<span class="muted small">Add people first.</span>'}</div>`;
  const checked = (f, n) => [...f.querySelectorAll(`[name=${n}]:checked`)].map(x => x.value);
  const members = f => checked(f, 'prov');
  main.innerHTML = `<div class="sechead" style="margin-top:0"><span class="muted small">What requestors see on the portal. Each team needs at least one provider; a team can have sub-teams with their own providers, limit and queue.</span>
      <button class="btn primary" id="add">${I('plus', 18)} New service</button></div>
    ${svcs.filter(s => !s.parent_id).flatMap(s => [s, ...svcs.filter(x => x.parent_id === s.id)]).concat(svcs.filter(s => s.parent_id && !svcs.some(x => x.id === s.parent_id))).map((s, i) => `<div class="svc ${s.is_active ? '' : 'dim'}" style="cursor:default${s.parent_id ? ';margin-left:28px;width:calc(100% - 28px);box-sizing:border-box;border-left:3px solid var(--amber)' : ''}"><span class="chip c${i % 5}">${I(svcIcon(s), 22)}</span>
      <span class="t"><b>${esc(s.name)} <span class="muted small mono">${esc(s.code)}</span> <span class="pill c4">${FORM_TYPES[s.form_schema.form_type] || 'General'}</span>${s.is_active ? '' : ' <span class="pill s-closed">inactive</span>'}</b><span class="muted small">${esc(s.description || '')}</span><br>
      ${s.members.map(m => `<span class="plate">${esc(m.name)}</span>`).join('') || '<span class="pill s-rejected" style="margin-top:6px">No provider assigned</span>'}
      <span class="muted small" style="display:block;margin-top:6px">${I('alert', 13)} Escalates to ${esc((s.escalation_users || []).map(x => x.name).join(', ') || (s.parent_id ? 'the main team’s officers' : 'admin'))}${s.escalate_after_hours != null ? ` · ${s.escalate_after_hours ? `${s.escalate_after_hours} working h after the target` : 'as soon as the target is missed'}` : ''}</span>
      ${Object.keys(s.sla || {}).length ? `<span class="muted small" style="display:block;margin-top:4px">${I('clock', 13)} Own SLA: ${PRIORITIES.slice().reverse().filter(p => s.sla[p]).map(p => `${cap(p)} ${s.sla[p]}h`).join(' · ')}</span>` : ''}
      ${s.parent_id ? `<span class="muted small" style="display:block;margin-top:4px">${I('grid', 13)} Sub-team of ${esc(svcs.find(x => x.id === s.parent_id)?.name || '')}</span>` : ''}
      ${s.daily_cap ? `<span class="muted small" style="display:block;margin-top:4px">${I('clock', 13)} Takes ${s.daily_cap} tickets a day${s.queue?.waiting ? ` · <strong>${s.queue.waiting} waiting in the queue</strong>` : ''}</span>` : ''}</span>
      <button class="btn soft" data-e="${s.id}">Edit</button></div>`).join('')}
    <p class="muted small">Working hours, default targets and hold reasons are under <a href="#/c/sla">SLA &amp; points</a>.</p>
    <p class="muted small">QR link for one service: ${location.origin}${location.pathname}#/d/${tenantObj().slug}?service=CODE</p>`;
  const qHead = `<b style="display:block;margin-top:20px">Questions on the form</b><div class="muted small">Extra questions for this service. Requestors always give their own details, the location and a subject first. Tick Required for questions people must answer. A dropdown option called Other lets people type their own answer.</div><div id="fb"></div>`;
  $('#add').onclick = () => { let fb; const d = dlg(`<h2>New service</h2>${fields()}${slaBox()}${qHead}`, async f => {
    const s = await api('/services', { method: 'POST', body: { sla: Object.fromEntries(PRIORITIES.map(p => [p, f.elements['sla_' + p].value])), code: f.elements.code.value, name: f.elements.name.value, description: f.elements.description.value, escalation_user_ids: checked(f, 'escs'), parent_id: f.elements.parent_id.value || null, daily_cap: f.elements.daily_cap.value, escalate_after_hours: f.elements.escalate_after_hours.value, form_schema: { fields: fb.get(), icon: f.elements.icon.value, ...typeOf(f) } } });
    if (members(f).length) await api(`/services/${s.id}/members`, { method: 'PUT', body: { user_ids: members(f) } });
    toast('Service created'); services(main); });
    d.style.maxWidth = '680px'; wireType(d); fb = formBuilder(d.querySelector('#fb'), []);
    // suggest a short code from the name (initials of the main words) until the admin types their own
    const nm = d.querySelector('[name=name]'), cd = d.querySelector('[name=code]'); let typed = false;
    cd.oninput = () => { typed = true; cd.value = cd.value.replace(/[^A-Za-z0-9-]/g, '').toUpperCase(); };
    nm.addEventListener('input', () => { if (typed) return; const w = nm.value.split(/[^A-Za-z0-9]+/).filter(x => x && !/^(and|of|the|for|other)$/i.test(x));
      cd.value = (w.length > 1 ? w.map(x => x[0]).join('') : (w[0] || '').slice(0, 6)).toUpperCase().slice(0, 12); }); };
  main.querySelectorAll('[data-e]').forEach(b => b.onclick = () => {
    const s = svcs.find(x => x.id === b.dataset.e), { icon, ...schema } = s.form_schema;
    let fb; const d = dlg(`<h2>Edit ${esc(s.name)}</h2>${fields(s)}${qHead}
      ${slaBox(s)}
      <label style="font-weight:400"><input type="checkbox" name="is_active" ${s.is_active ? 'checked' : ''}> Active (shown on the portal)</label>`,
      async f => {
        await api(`/services/${s.id}`, { method: 'PATCH', body: { name: f.elements.name.value, description: f.elements.description.value, escalation_user_ids: checked(f, 'escs'), parent_id: f.elements.parent_id.value || null, daily_cap: f.elements.daily_cap.value, escalate_after_hours: f.elements.escalate_after_hours.value, form_schema: { fields: fb.get(), icon: f.elements.icon.value, ...typeOf(f) },
          is_active: f.elements.is_active.checked ? 1 : 0, sla: Object.fromEntries(PRIORITIES.map(p => [p, f.elements['sla_' + p].value])) } });
        await api(`/services/${s.id}/members`, { method: 'PUT', body: { user_ids: members(f) } }); toast('Saved'); services(main); });
    d.style.maxWidth = '680px'; wireType(d); fb = formBuilder(d.querySelector('#fb'), schema.fields);
  });
}

// Form type for a service: which built-in question sets the raise form asks.
const FT_HINT = { general: 'Just a location box', location: 'Block · Floor · Location / room', student: 'Branch · Student ID · Department', both: 'Student details + Block · Floor · Room', food: 'Rate a meal (no ticket) or report a serious problem (ticket)' };
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
        : ['yes_no', 'date'].includes(f.type) ? '' : `<input data-k="placeholder" value="${esc(f.placeholder || '')}" placeholder="Hint inside the box, e.g. LAP-0231">`}
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
    $('#add').onclick = async () => { const sv = (await api('/services')).filter(s => s.is_active); dlg(`<h2>Add person</h2><label>Full name</label><input name="name" required><label>Email</label><input name="email" type="email" required>
      <label>Phone</label><input name="phone" type="tel"><label>Role</label><select name="role"><option value="provider">Service provider</option>${sa ? '<option value="tenant_admin">Campus admin</option>' : ''}</select>
      <label>Services <small>(the tickets they handle)</small></label>
      <div class="svcpick">${sv.map(s => `<label><input type="checkbox" name="svc" value="${s.id}"> ${esc(s.name)}</label>`).join('') || '<span class="muted small">No services yet. Add them under Services.</span>'}</div>
      <p class="muted small">They are emailed a welcome with their role, services, sign-in link and a temporary password.</p>`,
      async f => { const r = await api('/users', { method: 'POST', body: { ...formVals(f), svc: undefined, service_ids: [...f.querySelectorAll('[name=svc]:checked')].map(x => x.value) } });
        showTemp('Account created', formVals(f), r.temp_password); reload(); }); };
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
  app.innerHTML = `<div class="wrap hero" style="max-width:440px;padding-top:48px"><img class="logo" src="logo.png" alt="St. Mary's Rehabilitation University">
    <h1>Set your <span>new password</span></h1><p class="muted">Hi ${esc(S.me.user.name.split(' ')[0])}, you signed in with a temporary password. Choose your own to continue.</p>
    <form id="f" class="card"><label style="margin-top:0">Temporary password <small>(from your welcome email)</small></label><input name="current" type="password" required autofocus autocomplete="current-password">
    <label>New password <small>(8+ characters, letters and numbers)</small></label><input name="password" type="password" required autocomplete="new-password">
    <label>Confirm new password</label><input name="confirm" type="password" required autocomplete="new-password">
    <div class="err" id="err"></div><p style="margin-bottom:0"><button class="btn dark big">Save and continue ${I('chev', 18)}</button></p></form>
    <p style="text-align:center"><a href="#" id="lo">Sign out</a></p></div>`;
  $('#lo').onclick = e => { e.preventDefault(); logout(); };
  $('#f').onsubmit = async e => { e.preventDefault(); const v = formVals(e.target);
    try { if (v.password !== v.confirm) throw new Error('The two new passwords do not match');
      await api('/me/password', { method: 'POST', body: { current: v.current, password: v.password } }); S.me = null; toast('Password set. Your sign-in details were emailed to you.'); route();
    } catch (er) { $('#err').textContent = er.message; } };
}

async function reports(main, { sa }) {
  const rd = sessionStorage.getItem('rd') || '30', custom = rd === 'custom', today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  const rf = sessionStorage.getItem('rfrom') || today, rt = sessionStorage.getItem('rto') || today;
  const [r, g] = await Promise.all([api('/reports?' + (custom ? `from=${rf}&to=${rt}` : 'days=' + rd)), sa ? api('/group/report') : null]);
  const c = r.counts || {}, x = r.extra || {}, dlabel = d => new Date(d + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  // every day in the range (weeks when the range is long), with tickets raised and closed
  const days = []; for (let d = new Date(r.days.from + 'T00:00:00Z'), e = new Date(r.days.to + 'T00:00:00Z'); d <= e && days.length < 400; d.setUTCDate(d.getUTCDate() + 1)) days.push(d.toISOString().slice(0, 10));
  const rm = Object.fromEntries(r.daily.map(v => [v.d, v.c])), cm = Object.fromEntries((r.daily_closed || []).map(v => [v.d, v.c])), step = days.length > 45 ? 7 : 1;
  const pts = []; for (let i = 0; i < days.length; i += step) { const sl = days.slice(i, i + step); pts.push({ label: dlabel(sl[0]), raised: sl.reduce((a, d) => a + (rm[d] || 0), 0), closed: sl.reduce((a, d) => a + (cm[d] || 0), 0) }); }
  const chart = () => { const W = 720, H = 220, pl = 30, pb = 26, pt = 10, max = Math.max(1, ...pts.flatMap(p => [p.raised, p.closed])), gw = (W - pl - 8) / Math.max(1, pts.length), bw = Math.max(2, Math.min(18, gw * 0.36)), Y = v => pt + (H - pt - pb) * (1 - v / max);
    const every = Math.ceil(pts.length / 10), ticks = [...new Set([0, Math.ceil(max / 2), max])];
    return `<svg viewBox="0 0 ${W} ${H}" class="rchart" role="img" aria-label="Tickets raised and closed per ${step === 7 ? 'week' : 'day'}">${ticks.map(v => `<line x1="${pl}" x2="${W - 8}" y1="${Y(v)}" y2="${Y(v)}" class="g"/><text x="${pl - 6}" y="${Y(v) + 4}" text-anchor="end">${v}</text>`).join('')}
      ${pts.map((p, i) => { const cx = pl + gw * i + gw / 2; return `${p.raised ? `<rect x="${cx - bw - 1}" y="${Y(p.raised)}" width="${bw}" height="${H - pb - Y(p.raised)}" rx="2" fill="var(--accent)"><title>${p.label}: ${p.raised} raised</title></rect>` : ''}${p.closed ? `<rect x="${cx + 1}" y="${Y(p.closed)}" width="${bw}" height="${H - pb - Y(p.closed)}" rx="2" fill="var(--st-closed)"><title>${p.label}: ${p.closed} closed</title></rect>` : ''}${i % every === 0 ? `<text x="${cx}" y="${H - 8}" text-anchor="middle">${p.label}</text>` : ''}`; }).join('')}</svg>
      <div class="flegend"><span><i style="background:var(--accent)"></i>Raised</span><span><i style="background:var(--st-closed)"></i>Closed</span>${step === 7 ? '<span class="muted">per week</span>' : ''}</div>`; };
  const hb = (rows, color) => { const max = Math.max(1, ...rows.map(v => v[1])); return rows.some(v => v[1]) ? rows.map(([l, v, col]) => `<div class="hbar"><span>${l}</span><div><i style="width:${(100 * v) / max}%;background:${col || color}"></i></div><b>${v}</b></div>`).join('') : '<p class="muted small">No tickets in this period.</p>'; };
  const pr = Object.fromEntries(r.by_priority.map(v => [v.k, v.c])), ag = Object.fromEntries(r.aging.map(v => [v.k, v.c]));
  const kpi = (label, val, sub = '', hot = false, ic = 'ticket') => `<div class="kpi2"><span class="kl">${tile(ic, 14)}${label}</span><b class="${hot ? 'hot' : ''}">${val}</b>${sub ? `<small>${sub}</small>` : ''}</div>`;
  const pct = v => v == null ? '—' : v + '%';
  main.innerHTML = `<div class="repp">
    <div class="rep-h"><div class="filters rfil" style="margin:0"><select id="rd" aria-label="Period">${[7, 30, 90, 365].map(d => `<option value="${d}" ${String(d) === rd ? 'selected' : ''}>Last ${d} days</option>`).join('')}<option value="custom" ${custom ? 'selected' : ''}>Custom dates…</option></select>
      ${custom ? `<label class="dfield">From<input type="date" id="rfrom" value="${rf}" max="${today}"></label><label class="dfield">To<input type="date" id="rto" value="${rt}" max="${today}"></label><button class="btn primary" id="rgo">Show</button>` : ''}</div>
      <button class="btn" id="rcsv">${I('download', 16)}Export CSV</button></div>
    <div class="muted small">Tickets raised from <b>${dlabel(r.days.from)}</b> to <b>${dlabel(r.days.to)}</b>. Open, on hold and overdue are as of now.</div>
    <div class="card kpis2">${kpi('Raised', c.created_period || 0, `${r.affected ?? 0} people affected`, false, 'ticket')}${kpi('Closed', c.closed_period || 0, c.created_period ? `${Math.round(100 * (c.closed_period || 0) / c.created_period)}% of raised` : '', false, 'ccheck')}
      ${kpi('Closed on time', pct(c.closed_period ? c.on_time_pct : null), 'before the due time', false, 'shield')}${kpi('Avg time to close', c.avg_hours == null ? '—' : c.avg_hours + ' h', 'hold time not counted', false, 'clock')}
      ${kpi('Overdue now', c.overdue || 0, 'past the SLA due time', c.overdue > 0, 'calert')}${kpi('Reopened', x.reopened || 0, 'by the requester or staff', false, 'history')}${kpi('Escalated', x.escalated || 0, 'missed their target', false, 'bell')}${kpi('In queue', c.queued || 0, 'waiting for their day', false, 'users')}</div>
    <div class="card"><b>Raised and closed</b>${pts.some(p => p.raised || p.closed) ? chart() : '<p class="muted small">No tickets in this period.</p>'}</div>
    <div class="two"><div class="card"><b>By priority</b>${hb(['critical', 'high', 'medium', 'low'].map(k => [cap(k), pr[k] || 0, `var(--pr-${k})`]))}</div>
      <div class="card"><b>Age of open tickets</b><div class="muted small">Open, in progress and on hold, by how long ago they were raised</div>${hb([['Under 1 day', ag['<1d'] || 0], ['1 to 3 days', ag['1-3d'] || 0], ['3 to 7 days', ag['3-7d'] || 0, 'var(--st-hold)'], ['Over 7 days', ag['7d+'] || 0, 'var(--st-overdue)']], 'var(--accent)')}</div></div>
    <div class="card"><b>By service</b><div class="muted small">Tickets raised in this period, and where they stand now</div><div class="tblbox"><table class="rtable"><thead><tr><th>Service</th><th>Raised</th><th>Open</th><th>In progress</th><th>On hold</th><th>Closed</th><th>Rejected</th><th>Overdue</th><th>On time</th><th>Avg hours</th></tr></thead><tbody>
      ${r.by_service.map(s2 => `<tr><td><b>${esc(s2.name)}</b></td><td>${s2.raised ?? ''}</td><td>${s2.open}</td><td>${s2.in_progress || 0}</td><td>${s2.hold}</td><td>${s2.closed}</td><td>${s2.rejected}</td><td class="${s2.overdue > 0 ? 'hot' : ''}">${s2.overdue}</td><td>${pct(s2.on_time_pct)}</td><td>${s2.avg_hours ?? '—'}</td></tr>`).join('') || '<tr><td colspan="10" class="muted">No tickets in this period.</td></tr>'}</tbody></table></div></div>
    <div class="card" id="lb"></div>
    ${r.by_location?.length ? `<div class="card"><b>People affected by place</b><div class="muted small">Everyone who reported a ticket raised in this period, per service and location</div><div class="tblbox"><table class="rtable"><thead><tr><th>Service</th><th>Location</th><th>Tickets</th><th>People affected</th></tr></thead><tbody>
      ${r.by_location.map(v => `<tr><td>${esc(v.service)}</td><td>${esc(v.location)}</td><td>${v.tickets}</td><td><b>${v.affected}</b></td></tr>`).join('')}</tbody></table></div></div>` : ''}
    ${g ? `<div class="card"><b>All campuses</b><div class="muted small">As of now</div><div class="tblbox"><table class="rtable"><thead><tr><th>Campus</th><th>Open</th><th>On hold</th><th>Closed</th><th>Overdue</th></tr></thead><tbody>${g.map(t => `<tr><td><b>${esc(t.name)}</b></td><td>${t.open || 0}</td><td>${t.hold || 0}</td><td>${t.closed || 0}</td><td class="${t.overdue > 0 ? 'hot' : ''}">${t.overdue || 0}</td></tr>`).join('')}</tbody></table></div></div>` : ''}</div>`;
  api('/points').then(p => { if ($('#lb')) $('#lb').innerHTML = leaderboard(p.leaderboard); });
  $('#rd').onchange = e => { sessionStorage.setItem('rd', e.target.value); reports(main, { sa }); };
  $('#rcsv').onclick = () => { const cell = v => `"${String(v ?? '').replace(/"/g, '""')}"`, cols = ['name', 'raised', 'open', 'in_progress', 'hold', 'closed', 'rejected', 'overdue', 'on_time_pct', 'avg_hours'];
    const csv = [`"Report","${r.days.from} to ${r.days.to}"`, '', ['Service', 'Raised', 'Open', 'In progress', 'On hold', 'Closed', 'Rejected', 'Overdue', 'On time %', 'Avg hours to close'].map(cell).join(','), ...r.by_service.map(s2 => cols.map(k => cell(s2[k])).join(',')),
      '', ['Day', 'Raised', 'Closed'].map(cell).join(','), ...days.map(d => [d, rm[d] || 0, cm[d] || 0].map(cell).join(','))].join('\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = `report-${r.days.from}-to-${r.days.to}.csv`; a.click(); };
  if (custom) $('#rgo').onclick = () => { const f = $('#rfrom').value, t = $('#rto').value;
    if (!f || !t) return toast('Pick both dates'); if (f > t) return toast('From must be on or before To');
    sessionStorage.setItem('rfrom', f); sessionStorage.setItem('rto', t); reports(main, { sa }); };
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
    <p class="muted">To add a tenant admin, switch to the tenant (top right), then People → Add person → Tenant admin.</p>
    <div class="card"><b>Same-day duplicate reports</b><div class="muted small">When people report the same problem at the same place on the same day, later reports join the first ticket.</div>
      <label>When a report matches today's ticket</label><select id="mm"><option value="silent">Add it to that ticket automatically</option><option value="confirm">Ask the person "Same issue?" first</option></select></div>`;
  api('/merge-mode').then(m => { $('#mm').value = m.mode; });
  $('#mm').onchange = async e => { try { await api('/merge-mode', { method: 'PUT', body: { mode: e.target.value } }); toast('Saved'); } catch (er) { toast(er.message); } };
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
    <label>Working days</label><div class="daypick">${DAYS.map((d, i) => `<label class="daychip ${c.work_days.includes(i) ? 'on' : ''}" style="margin:0"><input type="checkbox" name="wd" value="${i}" ${c.work_days.includes(i) ? 'checked' : ''} hidden>${d}</label>`).join('')}</div>
    <b style="display:block;margin-top:18px">Time to close, by priority</b><div class="muted small">In working hours. Requestor tickets start as Medium; providers can change the priority.</div>
    <div class="prow">${['critical', 'high', 'medium', 'low'].map(p => `<div><label style="text-transform:capitalize">${p}</label><input type="number" min="1" name="t_${p}" value="${c.targets[p] || ''}"><div class="muted small" data-d="${p}"></div></div>`).join('')}</div>
    <b style="display:block;margin-top:18px">Escalation</b><div class="muted small">A ticket goes to the service's providers first. If it misses its target by this many working days, it moves to the service's escalation person and the requestor is told.</div>
    <div class="row" style="align-items:end"><div><label>Escalate after <small>(working days past the target; 0 = as soon as it's missed)</small></label><input type="number" name="esc_days" min="0" max="60" step="0.5" value="${c.escalate_after_days}"></div></div>
    <label class="switch" style="margin-top:10px"><input type="checkbox" name="esc_holds" ${c.escalate_holds ? 'checked' : ''}> Also escalate holds that run past their limit</label>
    <b style="display:block;margin-top:18px">Daily ticket limit, per email</b><div class="muted small">How many tickets one email address can raise in a day on the public form. Past it, the requestor is told when they can raise the next one. Tickets entered by staff don't count.</div>
    <div class="prow">${Object.entries(c.daily_limits).map(([k, v]) => `<div><label style="text-transform:capitalize">${k}</label><input type="number" min="1" max="100" name="dl_${k}" value="${v}"></div>`).join('')}</div>
    <b style="display:block;margin-top:18px">Hold reasons — each with its own hold SLA</b><div class="muted small">On hold, the provider picks a reason. The main clock pauses and the hold must end within that many working hours.</div>
    <div class="row muted small hrhead" style="margin-top:8px"><span style="flex:3">Reason</span><span style="flex:1;min-width:80px">Hold limit (h)</span><span style="flex:0 0 44px"></span></div>
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
        escalate_after_days: f.esc_days.value, escalate_holds: f.esc_holds.checked,
        daily_limits: Object.fromEntries(Object.keys(c.daily_limits).map(k => [k, f['dl_' + k].value])),
        hold_reasons: [...f.querySelectorAll('.hr')].map(r => ({ key: r.querySelector('[name=hk]').value || undefined, label: r.querySelector('[name=hl]').value, hours: r.querySelector('[name=hh]').value })) } });
      toast('SLA settings saved'); slaPage(main);
    } catch (er) { $('#err').textContent = er.message; } };
}

// ================= EMAIL (Power Automate) =================
const MAIL_STATUS = { sent: 's-open', failed: 's-rejected', queued: 's-hold', skipped: 's-closed', logged: 's-closed' };
const copyBox = (text, label = 'Copy') => `<div class="codebox"><pre>${esc(text)}</pre><button type="button" class="btn soft" data-copy="${esc(text)}">${I('copy', 15)} ${label}</button></div>`;
const wireCopy = root => root.querySelectorAll('[data-copy]').forEach(b => b.onclick = () => navigator.clipboard.writeText(b.dataset.copy).then(() => toast('Copied')));

// Every email button opens the public address. Warn when that can't work from people's inboxes, with a one-click fix.
const baseWarn = base => {
  const local = u => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(u || ''), here = location.origin + location.pathname.replace(/\/(index\.html)?$/, '');
  let origin = ''; try { origin = new URL(base).origin; } catch { /* not a full address */ }
  const msg = local(base) ? `"View your ticket", "Open the ticket" and "Sign in" buttons open ${esc(base)}, which only works on this computer. Set the public address to your live site, e.g. https://stmarys-desk.supercxo.ai.`
    : !local(here) && origin !== location.origin ? `Email buttons open ${esc(base || '(not set)')}, but ONE Desk is open here at ${esc(here)}. If this is the live site, use this address so the buttons work from Gmail and Outlook.` : '';
  return msg ? `<div class="limitbox">${I('alert', 22)}<div><b>${local(base) ? 'Email buttons point to this computer' : 'Email buttons may open the wrong address'}</b><div>${msg}</div>`
    + `${local(here) ? '' : `<button type="button" class="btn soft" id="usehere" data-here="${esc(here)}" style="margin-top:8px">Use ${esc(here)}</button>`}</div></div>` : '';
};
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
      ${baseWarn(c.base)}
      <label>Public address of ONE Desk <small>(links inside emails)</small></label><input name="base" value="${esc(c.base)}" placeholder="https://stmarys-desk.supercxo.ai">
      <label class="switch" style="margin-top:14px"><input type="checkbox" name="sending" ${c.sending ? 'checked' : ''}> Send emails <span class="muted small">(untick to pause; emails are then only logged)</span></label>
      <div class="err" id="cerr"></div><p style="margin-bottom:0"><button class="btn primary big">Save connection</button></p></form>
    <div class="card" style="margin:0"><b>Send a test email</b><div class="muted small">Uses the values in the form, even before you save. Try a Gmail, a Yahoo and an Outlook address, and tap both buttons in it: each should open ONE Desk.</div>
      <label>Send to</label><div class="row" style="gap:8px"><input id="tto" type="email" placeholder="yourname@gmail.com" value="${esc(S.me.user.email)}" style="flex:3">
      <button type="button" class="btn primary" id="tsend" style="flex:0 0 auto">${I('send', 16)} Send test</button></div><div id="tres"></div>
      <div class="muted small" style="margin-top:16px">Sender: whichever mailbox the flow's "Send an email from a shared mailbox" step uses (Digital Services).</div></div></div>`;
  const f = $('#cf');
  if ($('#usehere')) $('#usehere').onclick = e => { f.base.value = e.currentTarget.dataset.here; toast('Address filled in. Save the connection to keep it.'); };
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
  const failed = rows.filter(r => r.status === 'failed' || (r.status === 'logged' && r.template_key !== 'test')).map(r => r.id);
  box.innerHTML = `<div class="filters"><label class="search" style="margin:0">${I('search', 18)}<input id="mq" placeholder="Search email address or subject…" value="${esc(st.q)}"></label>
      ${failed.length ? `<button class="btn primary" id="rall">Send ${failed.length} held or failed</button>` : ''}</div>
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
    ${step(6, 'Save, copy the URL, connect', `<p>Click <b>Save</b>, open the trigger again and copy its <b>HTTP URL</b>. Paste it on the <b>Connection</b> tab with the same secret key, set the public address (e.g. <code>https://stmarys-desk.supercxo.ai</code>), <b>Save</b>, then <b>Send test</b>.</p>`)}
    ${step(7, 'Reach Gmail, Yahoo and every inbox (not spam)', `<p>Your domain admin adds these once for <b>stmarysgroup.com</b>:</p>
      <p><b>SPF</b>: if a <code>v=spf1</code> TXT record exists, add <code>include:spf.protection.outlook.com</code> to it (never create a second one). Otherwise add TXT:</p>${copyBox('v=spf1 include:spf.protection.outlook.com -all')}
      <p><b>DKIM</b>: security.microsoft.com → Email &amp; collaboration → Policies &amp; rules → Threat policies → Email authentication settings → DKIM → stmarysgroup.com. Add the two CNAME records it shows, then <b>Enable</b>.</p>
      <p><b>DMARC</b>: add a TXT record named <code>_dmarc</code>:</p>${copyBox('v=DMARC1; p=none; rua=mailto:digitalservices@stmarysgroup.com')}
      <p>Check: open a test email in Gmail → <b>⋮</b> → <b>Show original</b>. SPF, DKIM and DMARC should all say <b>PASS</b>.</p>`)}`;
  wireCopy(box);
}

// ================= Kitchen dashboard: Complaints (the ticket queue) and Feedback & Scores =================
const svgLine = (days, series, h = 200) => { const w = 640, p = 28, n = days.length, X = i => p + (n < 2 ? (w - 2 * p) / 2 : ((w - 2 * p) * i) / (n - 1)), Y = v => h - p - (v / 5) * (h - 2 * p);
  return `<svg viewBox="0 0 ${w} ${h}" class="fchart" role="img" aria-label="Average score per meal over time">${[1, 2, 3, 4, 5].map(v => `<line x1="${p}" x2="${w - p}" y1="${Y(v)}" y2="${Y(v)}" class="g"/><text x="4" y="${Y(v) + 4}">${v}★</text>`).join('')}
    ${MEALS.map(m => { const pts = series[m].map((v, i) => v == null ? null : [X(i), Y(v)]); return `<polyline fill="none" stroke="${MEAL_COLORS[m]}" stroke-width="2.5" points="${pts.filter(Boolean).map(q => q.join(',')).join(' ')}"/>${pts.filter(Boolean).map(q => `<circle cx="${q[0]}" cy="${q[1]}" r="3.5" fill="${MEAL_COLORS[m]}"/>`).join('')}`; }).join('')}
    ${days.length <= 14 ? days.map((d, i) => `<text x="${X(i)}" y="${h - 6}" text-anchor="middle">${d.slice(8)}/${d.slice(5, 7)}</text>`).join('') : `<text x="${p}" y="${h - 6}">${days[0]}</text><text x="${w - p}" y="${h - 6}" text-anchor="end">${days.at(-1)}</text>`}</svg>`; };
const hbars = (rows, colorOf) => { const max = Math.max(1, ...rows.map(r => r[1])); return rows.length ? rows.map(([l, v]) => `<div class="hbar"><span>${esc(l)}</span><div><i style="width:${(100 * v) / max}%;background:${colorOf(l)}"></i></div><b>${v}</b></div>`).join('') : '<p class="muted small">Nothing yet.</p>'; };
const legendHtml = () => `<div class="flegend">${MEALS.map(m => `<span><i style="background:${MEAL_COLORS[m]}"></i>${MEAL_NAMES[m]}</span>`).join('')}</div>`;
async function foodPage(main, { admin }) {
  const st = JSON.parse(sessionStorage.getItem('foodf') || '{"tab":"scores","range":"week"}'), q = new URLSearchParams(location.hash.split('?')[1] || '');
  if (q.get('from')) Object.assign(st, { range: 'custom', from: q.get('from'), to: q.get('to') || q.get('from'), tab: 'scores' });
  const save = () => sessionStorage.setItem('foodf', JSON.stringify(st));
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date()), back = n => { const d = new Date(today + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
  const span = () => st.range === 'day' ? [today, today] : st.range === 'week' ? [back(6), today] : st.range === 'month' ? [back(29), today] : [st.from || back(6), st.to || today];
  const draw = async () => {
    const [from, to] = span(), qs = new URLSearchParams({ from, to, ...(st.location ? { location: st.location } : {}) }).toString();
    const d = await api('/food/dashboard?' + qs), t = d.today, pr = d.period;
    const tabs = `<div class="tabs">${[['scores', 'Feedback & Scores'], ['complaints', `Complaints${d.complaints ? ` (${d.complaints})` : ''}`], ...(admin ? [['settings', 'Locations & meal times']] : [])].map(([k, l]) => `<button class="tab ${st.tab === k ? 'on' : ''}" data-t="${k}">${l}</button>`).join('')}</div>`;
    if (st.tab === 'complaints') {
      const [rows, services] = await Promise.all([api(`/tickets?service=${d.service.id}&status=all`), api('/services')]);
      main.innerHTML = `${tabs}<p class="muted small">Serious problems students reported. Each is a normal ticket: open it to act on it.</p><div class="tgrid">${rows.map(r => ticketCard(r, services)).join('') || '<div class="empty card" style="grid-column:1/-1"><p><b>No complaints.</b></p></div>'}</div>`;
      main.querySelectorAll('.tcard').forEach(c => c.onclick = () => location.hash = '#/c/t/' + c.dataset.id);
    } else if (st.tab === 'settings') {
      const fs = await api('/food/settings');
      main.innerHTML = `${tabs}<form id="fset" class="card" style="max-width:640px"><b>Messes and canteens</b><div class="muted small">Students pick one when they rate or report. Untick to hide one without losing its history.</div>
        <div id="locs">${fs.locations.map(l => `<div class="row locrow" data-id="${l.id}"><div><input name="lname" value="${esc(l.name)}" required></div><div style="flex:0 0 auto;align-self:center"><label style="margin:0;font-weight:400"><input type="checkbox" name="lact" ${l.active ? 'checked' : ''}> Shown</label></div></div>`).join('')}</div>
        <p><button type="button" class="btn soft" id="addloc">${I('plus', 16)} Add mess / canteen</button></p>
        <b style="display:block;margin-top:18px">Meal times</b><div class="muted small">Campus time. The form picks the meal being served (or the one just finished).</div>
        ${MEALS.map(m => `<div class="row"><div><label>${MEAL_NAMES[m]} from</label><input type="time" name="s_${m}" value="${fs.windows[m][0]}" required></div><div><label>to</label><input type="time" name="e_${m}" value="${fs.windows[m][1]}" required></div></div>`).join('')}
        <div class="err" id="ferr"></div><p><button class="btn primary">Save</button></p></form>`;
      $('#addloc').onclick = () => $('#locs').insertAdjacentHTML('beforeend', `<div class="row locrow"><div><input name="lname" placeholder="e.g. Boys mess" required></div><div style="flex:0 0 auto;align-self:center"><label style="margin:0;font-weight:400"><input type="checkbox" name="lact" checked> Shown</label></div></div>`);
      $('#fset').onsubmit = async e => { e.preventDefault(); const f = e.target;
        try { await api('/food/settings', { method: 'PUT', body: { locations: [...f.querySelectorAll('.locrow')].map(r => ({ id: r.dataset.id || undefined, name: r.querySelector('[name=lname]').value, active: r.querySelector('[name=lact]').checked })),
          windows: Object.fromEntries(MEALS.map(m => [m, [f['s_' + m].value, f['e_' + m].value]])) } }); toast('Saved'); draw(); } catch (er) { $('#ferr').textContent = er.message; } };
    } else {
      const card = m => { const x = t.per_meal[m]; return `<div class="card fscore"><span class="muted small"><i class="sdot" style="display:inline-block;margin-right:6px;background:${MEAL_COLORS[m]}"></i>${MEAL_NAMES[m]} · today</span>
        <b>${x.avg == null ? '—' : x.avg.toFixed(1) + ' ★'}</b><span class="muted small">${x.count} rating${x.count === 1 ? '' : 's'}</span>
        <div>${x.chips.map(c => `<span class="plate">${esc(c.chip)} ${c.count}</span>`).join('') || '<span class="muted small">No issues tagged</span>'}</div></div>`; };
      main.innerHTML = `${tabs}<div class="fscores">${MEALS.map(card).join('')}</div>
        <div class="filters" style="margin-top:14px"><select id="frange">${[['day', 'Today'], ['week', 'Last 7 days'], ['month', 'Last 30 days'], ['custom', 'Custom dates']].map(([k, l]) => `<option value="${k}" ${st.range === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
          ${st.range === 'custom' ? `<input type="date" id="ffrom" value="${from}"><input type="date" id="fto" value="${to}">` : ''}
          <select id="floc"><option value="">All messes / canteens</option>${d.locations.map(l => `<option value="${l.id}" ${st.location === l.id ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select>
          <button class="btn" id="fcsv">${I('copy', 16)} Export CSV</button></div>
        <div class="card"><b>Average score per meal</b> <span class="muted small">${pr.days[0]} → ${pr.days.at(-1)} · ${pr.rated} ratings · overall ${pr.avg == null ? '—' : pr.avg.toFixed(1) + ' ★'}</span>${svgLine(pr.days, pr.series)}${legendHtml()}</div>
        <div class="two"><div class="card"><b>Ratings per meal</b>${hbars(MEALS.map(m => [MEAL_NAMES[m], pr.per_meal[m].count]), l => MEAL_COLORS[MEALS.find(m => MEAL_NAMES[m] === l)])}</div>
          <div class="card"><b>Top issues</b>${hbars(pr.chips.map(c => [c.chip, c.count]), l => l.startsWith('Good') ? 'var(--ok)' : 'var(--warn)')}</div></div>
        <div class="card"><b>Latest comments</b>${pr.comments.map(c => `<div class="brow"><div><div>“${esc(c.comment)}”</div><div class="muted small">${fmt(c.at)} · ${MEAL_NAMES[c.meal]}${c.rating ? ' · ' + c.rating + ' ★' : ''}${c.location ? ' · ' + esc(c.location) : ''}${c.name ? ' · ' + esc(c.name) : ''}${c.converted ? ' · <i>sent as feedback instead of a complaint</i>' : ''}</div></div></div>`).join('') || '<p class="muted small">No comments in this period.</p>'}</div>`;
      $('#frange').onchange = e => { st.range = e.target.value; save(); draw(); };
      if ($('#ffrom')) $('#ffrom').onchange = $('#fto').onchange = () => { st.from = $('#ffrom').value; st.to = $('#fto').value; save(); draw(); };
      $('#floc').onchange = e => { st.location = e.target.value; save(); draw(); };
      $('#fcsv').onclick = async () => { const r = await api('/food/feedback.csv?' + qs, { raw: true }), a = document.createElement('a'); a.href = URL.createObjectURL(await r.blob()); a.download = `food-feedback-${from}-to-${to}.csv`; a.click(); };
    }
    main.querySelectorAll('[data-t]').forEach(b => b.onclick = () => { st.tab = b.dataset.t; save(); draw(); });
  };
  try { await draw(); } catch (e) { main.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
}

async function profile(main) {
  const u = S.me.user, [r, svcs, pts] = S.tenant ? await Promise.all([api('/reports?days=7'), api('/services'), api('/points')]) : [{ counts: {} }, [], { me: 0, history: [] }];
  const mine = u.role === 'provider' ? svcs.filter(s => s.members.some(m => m.id === u.id)) : svcs;
  main.innerHTML = `<div style="max-width:560px;margin:0 auto"><div class="profile"><div class="avatar">${u.name.split(' ').map(w => w[0]).slice(0, 2).join('')}</div>
    <h2 style="margin:0">${esc(u.name)}</h2><div class="muted">${esc(u.email)}</div><div class="muted small" style="text-transform:capitalize">${u.role.replace('_', ' ')}${tenantObj() ? ' · ' + esc(tenantObj().name) : ''}</div>
    <div class="pstats" style="grid-template-columns:repeat(4,1fr)"><div><b><span class="gold">${I('star', 18)}</span> ${pts.me}</b><span>Points</span></div><div><b>${r.counts.open || 0}</b><span>Open</span></div><div><b>${r.counts.closed_period || 0}</b><span>Closed (7d)</span></div><div><b>${mine.length}</b><span>Services</span></div></div></div>
    ${pts.history.length ? `<div class="card"><b>Recent points</b>${pts.history.map(h => `<div class="brow"><span class="pill ${h.points > 0 ? 'p-low' : 'p-high'}" style="flex:0 0 48px;text-align:center">${h.points > 0 ? '+' : ''}${h.points}</span>
      <div>${esc(h.reason)}<div class="muted small">${h.ticket_id ? `<a href="#/c/t/${h.ticket_id}" class="mono">#${h.ticket_no}</a> · ` : ''}${fmt(h.created_at)}</div></div></div>`).join('')}</div>` : ''}
    <div class="menu">${S.nav.filter(([h]) => h !== 'c').map(([h, l, ic]) => `<a href="#/${h}">${tile(ic, 18)}${l}<span class="chev">${I('chev', 18)}</span></a>`).join('')}
      <a href="#" id="pw">${tile('shield', 18)}Change password<span class="chev">${I('chev', 18)}</span></a>
      <a href="#/settings">${tile('settings', 18)}Settings<span class="chev">${I('chev', 18)}</span></a>
      ${canInstall() ? `<a href="#" class="install" onclick="return false">${tile('download', 18)}Install app<span class="chev">${I('chev', 18)}</span></a>` : ''}</div>
    <button class="btn big" id="lo" style="color:var(--warn)">${I('logout')} Log out</button></div>`;
  $('#lo').onclick = logout;
  $('#pw').onclick = e => { e.preventDefault(); dlg(`<h2>Change password</h2><label>Current password</label><input name="current" type="password" required autocomplete="current-password">
    <label>New password <small>(8+ characters, letters and numbers)</small></label><input name="password" type="password" minlength="8" required autocomplete="new-password">
    <label>Confirm new password</label><input name="confirm" type="password" required autocomplete="new-password">`,
    async f => { if (f.elements.password.value !== f.elements.confirm.value) throw new Error('The two new passwords do not match');
      await api('/me/password', { method: 'POST', body: formVals(f) }); toast('Password changed. Your sign-in details were emailed to you.'); }); };
}

// ================= ONE DESK BOT =================
// A chat window answered by the server from the app's own data (no AI): requestors on the campus pages ask about their
// ticket and how things work; staff inside the desk ask about their queue (admins about the whole campus).
const BOT_ICON = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/><path d="M8.5 12h.01M12 12h.01M15.5 12h.01"/></svg>';
let botUrl = null;
function botFor(url) { // url: '/public/<slug>/bot', '/bot', or null to hide the bot
  if (url !== botUrl) { botUrl = url; const log = $('#botlog'); if (log) log.innerHTML = ''; }
  let b = $('#botbtn');
  if (!b && url) {
    document.body.insertAdjacentHTML('beforeend', `<button type="button" id="botbtn" class="botbtn" aria-label="Open help chat">${BOT_ICON}</button>
      <section id="botp" class="botp" hidden role="dialog" aria-label="ONE Desk Bot"><header><span class="botava">${BOT_ICON}</span><div><b>ONE Desk Bot</b><small>Answers from ONE Desk itself</small></div>
      <button type="button" class="iconbtn" id="botx" aria-label="Close">${I('xmark')}</button></header><div id="botlog" class="botlog" aria-live="polite"></div>
      <form id="botf" class="botf"><input name="q" autocomplete="off" maxlength="300" placeholder="Ask, or type a ticket number"><button class="btn primary" aria-label="Send">${I('send', 18)}</button></form></section>`);
    b = $('#botbtn');
    b.onclick = () => { const p = $('#botp'); p.hidden = !p.hidden; if (!p.hidden) { if (!$('#botlog').children.length) botAsk('help', true); $('#botf').q.focus(); } };
    $('#botx').onclick = () => { $('#botp').hidden = true; };
    $('#botf').onsubmit = e => { e.preventDefault(); const q = e.target.q.value.trim(); if (q) { e.target.q.value = ''; botAsk(q); } };
  }
  if (b) { b.hidden = !url; if (!url) $('#botp').hidden = true; }
}
async function botAsk(q, quiet) {
  const log = $('#botlog'), add = html => { log.insertAdjacentHTML('beforeend', html); log.scrollTop = log.scrollHeight; };
  if (!quiet) add(`<div class="bmsg me">${esc(q)}</div>`);
  add('<div class="bmsg bot typing">…</div>');
  let r; try { r = await api(botUrl, { method: 'POST', body: { q } }); } catch (er) { r = { text: er.message } }
  log.querySelector('.typing')?.remove();
  add(`<div class="bmsg bot">${esc(r.text).replace(/\n/g, '<br>')}${r.items?.length ? `<div class="bitems">${r.items.map(x => `<a href="${esc(x.href)}" class="bitem"><b>${esc(x.title)}</b>${x.sub ? `<small>${esc(x.sub)}</small>` : ''}</a>`).join('')}</div>` : ''}</div>`
    + (r.chips?.length ? `<div class="bchips">${r.chips.map(c => `<button type="button" class="chip-btn" data-q="${esc(c)}">${esc(c)}</button>`).join('')}</div>` : ''));
  log.querySelectorAll('.bchips:last-child [data-q]').forEach(c => { c.onclick = () => botAsk(c.dataset.q); });
  log.querySelectorAll('.bitem').forEach(a => { a.onclick = () => { if (matchMedia('(max-width:700px)').matches) $('#botp').hidden = true; }; });
}

// ================= ROUTER =================
async function route() {
  document.onkeydown = null; clearInterval(pollT); stickyInstall(); cornerMenu(location.hash); // Install button and the Sign in corner on every screen
  const [p, qs] = location.hash.slice(1).split('?'), q = new URLSearchParams(qs), seg = p.split('/').filter(Boolean);
  botFor(seg[0] === 'd' && seg[1] ? `/public/${seg[1]}/bot` : seg[0] === 'c' && S.token ? '/bot' : null); // the bot, for who is looking
  try {
    if (seg[0] === 'd' && seg[2] === 't') return await ticketPage(seg[1], seg[3], q);
    if (seg[0] === 'd' && seg[2] === 'track') return await track(seg[1]);
    if (seg[0] === 'd') return await portal(seg[1], q, seg[2], seg[3] && decodeURIComponent(seg[3]));
    if (seg[0] === 'login') return login();
    if (seg[0] === 'install' || seg[0] === 'settings') return installPage();
    if (seg[0] === 'c') {
      const page = seg.slice(0, 2).join('/');
      const map = { c: queue, 'c/new': newTicket, 'c/attention': attention, 'c/services': services, 'c/users': users, 'c/reports': reports, 'c/sla': slaPage, 'c/email': emailPage, 'c/audit': auditPage, 'c/tenants': tenants, 'c/me': profile, 'c/food': foodPage };
      if (seg[1] === 't') return await shell('c', (m, ctx) => workspace(m, seg[2], ctx), 'Ticket');
      return await shell(page, map[page] || queue, page === 'c/me' ? 'Profile' : undefined);
    }
    document.body.className = '';
    const camps = await api('/public');
    if (camps.length === 1) return location.replace(`#/d/${camps[0].slug}`);
    if (!camps.length) { app.innerHTML = `<div class="wrap hero"><img class="logo" src="logo.png" alt="St. Mary's Rehabilitation University"><h1>ONE <span>Desk</span></h1>
      <p class="muted">The service desk is being set up. Please check back soon.</p></div>`; return; }
    app.innerHTML = `<div class="wrap hero"><img class="logo" src="logo.png" alt="St. Mary's Rehabilitation University"><h1>ONE <span>Desk</span></h1><p class="muted">St. Mary's Group service desk. Choose your campus.</p>
      ${camps.map((c, i) => `<a class="svc" href="#/d/${c.slug}"><span class="chip c${i % 5}">${I('building', 22)}</span><span class="t"><b>${esc(c.name)}</b><span class="muted small">${esc(c.code)}</span></span><span class="chev">${I('chev')}</span></a>`).join('')}
      ${installBtn()}</div>`;
  } catch (e) { app.innerHTML = `<div class="wrap"><h1>Not found</h1><p class="muted">${esc(e.message)}</p><a href="#/">Home</a></div>`; }
}
// #/install: the full "get the app" page, for a link or a QR code on a notice board
function installPage() {
  document.body.className = '';
  app.innerHTML = `<div class="wrap"><div class="head"><a class="iconbtn" href="#/" onclick="if(history.length>1){history.back();return false}">${I('back')}</a><h1>App &amp; settings</h1></div>
    <div class="card"><div class="idlg-h" style="padding:0 0 10px"><img src="icon-192.png" alt="" width="48" height="48"><div><b>ONE Desk</b><div class="muted small">St. Mary's service desk · free</div></div></div><div id="ig"></div></div></div>`;
  mountGuide($('#ig'), () => toast('ONE Desk installed. Find it on your home screen.'));
}
window.__toast = toast;
// Top-right corner on every public screen (phone and desktop): Sign in, and under it App & settings.
function cornerMenu(hash) {
  let el = document.querySelector('.corner');
  if (/^#\/(c|login)\b/.test(hash)) { el?.remove(); return; } // the staff desk and the sign-in page have their own header
  if (!el) { el = document.createElement('div'); el.className = 'corner'; document.body.append(el); }
  const signed = !!S.token;
  el.innerHTML = `<button type="button" class="corner-btn" aria-haspopup="true" aria-label="Sign in and settings">${I('user', 18)}<span>${signed ? 'My desk' : 'Sign in'}</span>${I('chev', 14)}</button>
    <div class="corner-menu" role="menu">
      <a href="${signed ? '#/c' : '#/login'}" role="menuitem">${I('user', 18)}<span><b>${signed ? 'Open my desk' : 'Staff sign in'}</b><small>Service providers and admins</small></span></a>
      <a href="#/settings" role="menuitem">${I('settings', 18)}<span><b>App &amp; settings</b><small>Steps for iPhone, Android, Mac or PC</small></span></a>
      ${canInstall() ? `<a href="#" class="install" role="menuitem" onclick="return false">${I('download', 18)}<span><b>Install app</b><small>Add ONE Desk to this device</small></span></a>` : ''}
    </div>`;
}
document.addEventListener('click', e => { const c = document.querySelector('.corner'); if (!c) return;
  if (e.target.closest('.corner-btn')) c.classList.toggle('open'); else c.classList.remove('open'); });
addEventListener('hashchange', route);
route();
// Installable app (PWA): the service worker caches the screens for offline opening; install.js handles the Install button and the guide.
if ('serviceWorker' in navigator && isSecureContext) addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
addEventListener('appinstalled', () => { document.querySelectorAll('.install').forEach(b => b.closest('p')?.remove()); toast('ONE Desk installed. Find it on your home screen.'); });
