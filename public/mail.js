// Mail desk screens (#/c/mail…): the shared mailboxes handled inside ONE Desk. Shown only when the server has the
// mail desk on (MAIL_ENABLED=true) and the person has a mail role; otherwise nothing here is ever drawn.
//   #/c/mail              mail list by lane (Important, Needs reply, Review, Auto, Noise) with SLA chips
//   #/c/mail/t/1001       one thread (MAIL-1001): the messages, reply box (sent from the mailbox), notes, status, Forward to service
//   #/c/mail/confirm      auto-replies waiting for a click
//   #/c/mail/settings     mailboxes, officers, response targets, templates, rules, AI providers
// Nodal officers also see their mail rows on the desk Home, in the same table as their tickets (mailRows / mailCards below).
// app.js hands in its helpers so this file looks and behaves like the rest of ONE Desk.
let H; // { api, esc, toast, I, dlg, pill, avatar, emptyState, shortDate, cardHeading, customFields, typeFields, collectForm, isGeneral }
export const initMail = h => { H = h; };
const LANES = [['important', 'Important'], ['needs_reply', 'Needs reply'], ['review', 'Review'], ['auto', 'Auto-handled'], ['noise', 'Noise']];
const LANE = Object.fromEntries(LANES);
const SLA = { on_track: ['On track', 'open'], warning: ['Reply soon', 'hold'], escalated: ['Escalated', 'overdue'], escalated_2: ['Escalated ×2', 'overdue'], met: ['Replied', 'closed'], breached_met: ['Replied late', 'rejected'] };
const STATUS = { open: 'Open', in_progress: 'In progress', hold: 'On hold', closed: 'Closed', rejected: 'Rejected', forwarded: 'Forwarded' };
const ROLE = { nodal_1: 'Nodal officer 1', nodal_2: 'Nodal officer 2', escalation: 'Escalation officer' };
const MODE = { off: 'Off', shadow: 'Shadow (read and sort only)', live: 'Live' };
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const e = v => H.esc(v);
const left = iso => { if (!iso) return ''; const m = Math.round((Date.parse(iso) - Date.now()) / 6e4), a = Math.abs(m), t = a >= 1440 ? `${Math.round(a / 1440)}d` : a >= 60 ? `${Math.floor(a / 60)}h ${a % 60 ? (a % 60) + 'm' : ''}`.trim() : `${a}m`; return m >= 0 ? `${t} left` : `${t} late`; };
export const slaChip = (w, due, responded) => { if (!w) return ''; const [l, s] = SLA[w] || [w, 'open']; return `<span class="mchip sla-${s}" title="${e(l)}">${e(l)}${due && !responded && !['met', 'breached_met'].includes(w) ? ` · ${e(left(due))}` : ''}</span>`; };
export const mailTag = '<span class="mchip mail">Mail</span>';
const statusPill = s => s === 'forwarded' ? '<span class="pill st"><i class="sdot" style="background:var(--accent)"></i>Forwarded</span>' : H.pill(s);
const laneChip = l => `<span class="mchip lane-${e(l)}">${e(LANE[l] || l)}</span>`;
const sel = (name, opts, cur, extra = '') => `<select name="${name}" ${extra}>${opts.map(([v, l]) => `<option value="${e(v)}" ${String(v) === String(cur ?? '') ? 'selected' : ''}>${e(l)}</option>`).join('')}</select>`;
let pollT = null;
const every = (ms, fn, hash) => { clearInterval(pollT); pollT = setInterval(() => { if (location.hash.split('?')[0] !== hash) return clearInterval(pollT); if (!document.hidden) fn(); }, ms); };

/* ================= the desk Home: mail rows in the same table ================= */
// items come from GET /mail/my-work (desk row shape). The status tab in view decides which show.
export const mailFilter = (items, st) => items.filter(w => {
  const s = st.status || 'open', overdue = !w.responded && (['escalated', 'escalated_2'].includes(w.sla) || (w.due_at && Date.parse(w.due_at) < Date.now()));
  if (st.service) return false; // a service filter is for desk tickets
  if (st.q && !`${w.ref} ${w.title} ${w.requester} ${w.requester_email}`.toLowerCase().includes(String(st.q).toLowerCase())) return false;
  return s === 'all' ? true : s === 'overdue' ? overdue : s === 'escalated' ? ['escalated', 'escalated_2'].includes(w.sla) : ['open', 'in_progress', 'hold'].includes(s) ? w.status === s : false;
});
export const mailCounts = items => ({ open: items.filter(w => w.status === 'open').length, in_progress: items.filter(w => w.status === 'in_progress').length, hold: items.filter(w => w.status === 'hold').length,
  overdue: items.filter(w => !w.responded && (['escalated', 'escalated_2'].includes(w.sla) || (w.due_at && Date.parse(w.due_at) < Date.now()))).length });
export const mailRows = items => items.map(w => `<tr data-href="${e(w.link)}" class="mrow">
  <td><a href="${e(w.link)}" class="tt-main"><span class="mono tt-no">${e(w.ref)}</span><b>${e(w.title)}</b><span class="tt-svc">${mailTag} ${e(w.where)}</span></a></td>
  <td><span class="tt-req">${H.avatar(w.requester, 28)}<span>${e(w.requester)}</span></span></td>
  <td class="tt-loc">${laneChip(w.lane)}</td><td>${slaChip(w.sla, w.due_at, w.responded)}</td><td><span class="tt-st">${statusPill(w.status)}</span></td>
  <td><span class="tt-when"><small>${w.responded ? 'Updated' : 'Reply by'}</small>${H.shortDate(w.responded ? w.updated_at : w.due_at)}</span></td></tr>`).join('');
export const mailCards = items => items.map(w => `<a class="tcard" href="${e(w.link)}"><span class="tc-r1"><span class="mono tc-no">${e(w.ref)}</span>${mailTag}<span class="sp"></span>${slaChip(w.sla, w.due_at, w.responded)}${statusPill(w.status)}</span>
  <span class="tc-r2"><b class="tc-title">${e(w.title)}</b><span class="tc-loc">${e(w.where)} · ${e(LANE[w.lane] || w.lane)}</span></span>
  <span class="tc-r3">${H.avatar(w.requester, 24)}<span class="tc-who">${e(w.requester)}</span><span class="tc-when">${w.responded ? 'Updated' : 'Reply by'} ${H.shortDate(w.responded ? w.updated_at : w.due_at)}</span></span></a>`).join('');

/* ================= routing ================= */
export async function mailPage(main, seg, q) {
  const me = await H.api('/maildesk/me');
  if (!me.role) { main.innerHTML = `<div class="card">${H.emptyState('No mailboxes for you', 'Ask your admin to add you as a nodal officer of a mailbox.')}</div>`; return; }
  if (seg[0] === 't') return thread(main, seg[1], me);
  if (seg[0] === 'confirm') return confirmPage(main, me);
  if (seg[0] === 'settings') return me.setup ? settings(main, me) : list(main, me, q);
  return list(main, me, q);
}
const subnav = (me, on) => `<div class="tabs mt-tabs" style="margin-bottom:12px"><a class="tab ${on === 'list' ? 'on' : ''}" href="#/c/mail">Mail</a>
  <a class="tab ${on === 'confirm' ? 'on' : ''}" href="#/c/mail/confirm"><span>Confirm auto-replies</span>${me.confirm ? `<span class="cnt">${me.confirm}</span>` : ''}</a>
  ${me.setup ? `<a class="tab ${on === 'settings' ? 'on' : ''}" href="#/c/mail/settings">Settings</a>` : ''}</div>`;

/* ================= the mail list ================= */
async function list(main, me) {
  const st = (() => { try { return JSON.parse(sessionStorage.getItem('mailf') || '{}'); } catch { return {}; } })();
  st.lane ||= 'needs_reply'; st.status ||= 'active';
  const draw = async () => {
    const qs = new URLSearchParams(Object.entries(st).filter(([, v]) => v)).toString(), d = await H.api('/maildesk/threads?' + qs), c = d.counts || {};
    const shadow = me.channels.filter(x => x.mode !== 'live');
    main.innerHTML = `${subnav(me, 'list')}
      ${shadow.length && me.role !== 'officer' ? `<p class="muted small">${shadow.map(x => `${e(x.address)}: ${e(MODE[x.mode])}`).join(' · ')}. Mail of a mailbox in shadow mode is read and sorted here, but no reply is sent and officers do not see it yet.</p>` : ''}
      <div class="card mt"><div class="mt-h"><div class="mt-t"><h2>Mail</h2><span class="mt-n">${d.threads.length} mail${d.threads.length === 1 ? '' : 's'}</span></div>
        <div class="mt-tools"><label class="search">${H.I('search', 18)}<input id="mq" type="search" aria-label="Search mail" placeholder="Search by MAIL-…, subject or sender" value="${e(st.q || '')}"></label>
          ${me.channels.length > 1 ? sel('channel', [['', 'All mailboxes'], ...me.channels.map(x => [x.id, x.address])], st.channel, 'id="mch" aria-label="Mailbox"') : ''}
          ${sel('status', [['active', 'Open, in progress, on hold'], ['closed', 'Closed'], ['rejected', 'Rejected'], ['forwarded', 'Forwarded to a service'], ['all', 'All']], st.status, 'id="mst" aria-label="Status"')}</div></div>
        <div class="tabs mt-tabs">${[['', 'All lanes'], ...LANES].map(([k, l]) => `<button class="tab ${st.lane === k || (!k && st.lane === 'all') ? 'on' : ''}" data-lane="${k || 'all'}"><span>${l}</span>${k && c[k] ? `<span class="cnt">${c[k]}</span>` : ''}</button>`).join('')}</div>
        ${d.threads.length ? `<div class="tblbox"><table class="ttable"><thead><tr><th>Mail</th><th>From</th><th>Lane</th><th>Reply target</th><th>Status</th><th>Received</th></tr></thead><tbody>
          ${d.threads.map(t => `<tr data-href="#/c/mail/t/${t.ref_no}"><td><a href="#/c/mail/t/${t.ref_no}" class="tt-main"><span class="mono tt-no">${e(t.ref)}</span><b>${e(t.subject || '(no subject)')}</b><span class="tt-svc">${e(t.address)}${t.n_in > 1 ? ` · ${t.n_in} messages` : ''}${t.mode !== 'live' ? ' · shadow' : ''}</span><span class="muted small">${e(t.preview)}</span></a></td>
            <td><span class="tt-req">${H.avatar(t.requester_name || t.requester_email, 28)}<span>${e(t.requester_name || t.requester_email)}</span></span></td><td>${laneChip(t.lane)}</td>
            <td>${slaChip(t.sla_state, t.first_response_due_at, !!t.first_responded_at)}</td><td>${statusPill(t.status)}</td><td><span class="tt-when">${H.shortDate(t.created_at)}</span></td></tr>`).join('')}</tbody></table></div>
          <div class="tcards">${d.threads.map(t => `<a class="tcard" href="#/c/mail/t/${t.ref_no}"><span class="tc-r1"><span class="mono tc-no">${e(t.ref)}</span>${laneChip(t.lane)}<span class="sp"></span>${slaChip(t.sla_state, t.first_response_due_at, !!t.first_responded_at)}${statusPill(t.status)}</span>
            <span class="tc-r2"><b class="tc-title">${e(t.subject || '(no subject)')}</b><span class="tc-loc">${e(t.requester_name || t.requester_email)} · ${e(t.address)}</span></span></a>`).join('')}</div>`
          : `<div class="mt-empty">${H.emptyState('No mail here', 'Nothing matches this lane and filter.')}</div>`}</div>`;
    const set = (k, v) => { st[k] = v; sessionStorage.setItem('mailf', JSON.stringify(st)); draw(); };
    main.querySelectorAll('[data-lane]').forEach(b => b.onclick = () => set('lane', b.dataset.lane));
    main.querySelectorAll('tr[data-href]').forEach(tr => tr.onclick = ev => { if (!ev.target.closest('a')) location.hash = tr.dataset.href; });
    main.querySelector('#mq').onchange = ev => set('q', ev.target.value.trim());
    main.querySelector('#mst').onchange = ev => set('status', ev.target.value);
    if (main.querySelector('#mch')) main.querySelector('#mch').onchange = ev => set('channel', ev.target.value);
  };
  await draw(); every(30000, draw, '#/c/mail');
}

/* ================= one thread ================= */
async function thread(main, ref, me) {
  const d = await H.api('/maildesk/threads/' + encodeURIComponent(ref)), t = d.thread, can = d.can;
  document.title = `${t.ref} · ONE Desk`;
  const msg = m => m.dir === 'in'
    ? `<article class="card mmsg in"><div class="mm-h">${H.avatar(m.from_name || m.from_email, 32)}<div><b>${e(m.from_name || m.from_email)}</b> <span class="muted small">&lt;${e(m.from_email)}&gt;${m.cc_list.length ? ` · cc ${e(m.cc_list.join(', '))}` : ''}</span><div class="muted small">${H.shortDate(m.received_at)}${m.has_attachments ? ' · has attachments (open in Outlook)' : ''}${m.ai ? ` · read by ${e(m.ai_provider)}: ${e(m.ai.summary)}` : ''}</div></div></div>
        <div class="mm-b">${e(m.body_text || '').replace(/\n/g, '<br>')}</div></article>`
    : `<article class="card mmsg out ${m.state}"><div class="mm-h"><span class="mchip mail">${m.origin === 'auto_ack' ? 'Auto-reply' : 'Reply'}</span><div><b>${e(m.sent_by || d.channel.display_name || d.channel.address)}</b> <span class="muted small">to ${e(m.to_list.join(', '))}${m.cc_list.length ? ` · cc ${e(m.cc_list.join(', '))}` : ''}</span>
        <div class="muted small">${{ pending_approval: 'Waiting for Confirm', queued: `Sending ${H.shortDate(m.send_after)}`, sending: 'Sending…', sent: `Sent ${H.shortDate(m.sent_at)}`, cancelled: 'Cancelled', failed: `Not sent: ${e(m.error || '')}` }[m.state]}</div></div>
        ${['queued', 'pending_approval'].includes(m.state) && can.work ? `<button type="button" class="btn" data-undo="${m.id}">${m.state === 'queued' ? 'Undo' : 'Cancel'}</button>` : ''}</div>
        <div class="mm-b">${e(m.body_text).replace(/\n/g, '<br>')}</div></article>`;
  main.innerHTML = `<div class="mthread">
    <div class="card"><div class="mt-h"><div><div class="eyebrow"><span class="mono">${e(t.ref)}</span> · ${e(d.channel.address)}${d.channel.mode !== 'live' ? ' · shadow mode: nothing is sent' : ''}</div><h2 style="margin:4px 0">${e(t.subject || '(no subject)')}</h2>
        <div class="mbar">${statusPill(t.status)}${laneChip(t.lane)}${slaChip(t.sla_state, t.first_response_due_at, !!t.first_responded_at)}
          <span class="muted small">${t.owner ? `Taken by ${e(t.owner)}` : 'Not taken yet'}${t.category ? ` · ${e(t.category)}` : ''}${t.first_response_due_at && !t.first_responded_at ? ` · reply by ${H.shortDate(t.first_response_due_at)}` : ''}</span></div></div></div>
      ${can.work && t.status !== 'forwarded' ? `<div class="mbar" style="margin-top:10px">
        ${['open', 'in_progress', 'hold'].includes(t.status) && t.owner_user_id !== undefined ? `<button type="button" class="btn" id="claim">${H.I('user', 16)}Take it</button>` : ''}
        <label class="small mbar">Lane ${sel('lane', LANES.filter(([k]) => k !== 'review'), t.lane === 'review' ? '' : t.lane, 'id="lane"')}</label>
        ${t.status !== 'hold' && ['open', 'in_progress'].includes(t.status) ? '<button type="button" class="btn" data-st="hold">Hold</button>' : ''}
        ${t.status === 'hold' ? '<button type="button" class="btn" data-st="in_progress">Resume</button>' : ''}
        ${['open', 'in_progress', 'hold'].includes(t.status) ? '<button type="button" class="btn" data-st="closed">Close</button><button type="button" class="btn" data-st="rejected">Reject</button>' : '<button type="button" class="btn" data-st="open">Open again</button>'}
        ${can.forward ? `<button type="button" class="btn primary" id="fwd">${H.I('swap', 16)}Forward to service${d.suggested_service ? `: ${e(d.suggested_service.name)}` : ''}</button>` : ''}</div>` : ''}
      ${d.desk ? `<div class="queuebar" style="margin-top:10px">${H.I('ticket', 20)}<span><b>Desk ticket #${e(d.desk.ticket_no)} · ${e(d.desk.service)}</b><span class="small">Status: ${e(STATUS[d.desk.status] || d.desk.status)} (from the desk, updated ${H.shortDate(d.desk.updated_at)}). The desk handles it from here.</span></span><a class="btn" href="#/c/t/${e(d.desk.id)}">Open ticket</a></div>` : ''}</div>
    ${d.messages.map(msg).join('')}
    ${can.reply ? `<form class="card" id="rf"><label for="rb" style="margin-top:0">Reply from ${e(d.channel.address)} to ${e(t.requester_email)}</label>
      ${d.templates.length ? sel('tpl', [['', 'Quick answer…'], ...d.templates.map(x => [x.id, x.name])], '', 'id="tpl" aria-label="Quick answer"') : ''}
      <textarea id="rb" name="body" rows="7" required maxlength="20000" placeholder="Write the reply. The mailbox signature is added below it."></textarea>
      <label for="rcc">Copy (cc) <small>(optional, comma-separated)</small></label><input id="rcc" name="cc" placeholder="name@smru.edu.in">
      <p class="mbar"><button class="btn primary" value="send">${H.I('send', 16)}Send</button><button class="btn" value="close">Send and close</button></p>
      <p class="muted small">You have ${10} seconds to undo after pressing Send.</p></form>` : ''}
    <section class="card"><div class="chead">${H.I('pencil', 16)}<span>Internal notes</span><span class="muted small">never mailed</span></div>
      ${d.notes.map(n => `<div class="mnote"><b>${e(n.author || 'ONE Desk')}</b> <span class="muted small">${H.shortDate(n.created_at)}</span><div>${e(n.body).replace(/\n/g, '<br>')}</div></div>`).join('') || '<p class="muted small">No notes yet.</p>'}
      ${can.work ? '<form id="nf" class="mbar"><input name="body" required maxlength="4000" placeholder="Add a note for the team" aria-label="Note"><button class="btn">Add</button></form>' : ''}</section>
    ${d.others.length ? `<section class="card"><div class="chead">${H.I('history', 16)}<span>Earlier mail from this sender</span></div>${d.others.map(o => `<p><a href="#/c/mail/t/${o.ref_no}"><span class="mono">${e(o.ref)}</span> ${e(o.subject || '(no subject)')}</a> <span class="muted small">${e(STATUS[o.status] || o.status)} · ${H.shortDate(o.created_at)}</span></p>`).join('')}</section>` : ''}</div>`;
  const redraw = () => thread(main, ref, me);
  const act = async (fn, okMsg) => { try { await fn(); if (okMsg) H.toast(okMsg); redraw(); } catch (er) { H.toast(er.message); } };
  main.querySelectorAll('[data-undo]').forEach(b => b.onclick = () => act(() => H.api(`/maildesk/outbound/${b.dataset.undo}/cancel`, { method: 'POST' }), 'Not sent'));
  main.querySelector('#claim')?.addEventListener('click', () => act(async () => { try { await H.api(`/maildesk/threads/${ref}/claim`, { method: 'POST' }); }
    catch (er) { if (/already on this mail/.test(er.message) && confirm(`${er.message}. Take it over?`)) await H.api(`/maildesk/threads/${ref}/claim`, { method: 'POST', body: { take: true } }); else throw er; } }, 'It is yours'));
  main.querySelector('#lane')?.addEventListener('change', ev => act(() => H.api(`/maildesk/threads/${ref}/lane`, { method: 'POST', body: { lane: ev.target.value } }), 'Lane changed'));
  main.querySelectorAll('[data-st]').forEach(b => b.onclick = () => {
    const s = b.dataset.st;
    if (['hold', 'rejected'].includes(s)) { H.dlg(`<h2>${s === 'hold' ? 'Put on hold' : 'Reject'}</h2><label>Why? <small>(an internal note)</small></label><textarea name="note" rows="3" ${s === 'rejected' ? 'required' : ''} maxlength="2000"></textarea>`,
      async f => { await H.api(`/maildesk/threads/${ref}/status`, { method: 'POST', body: { status: s, note: f.note.value } }); H.toast(STATUS[s]); redraw(); }); return; }
    act(() => H.api(`/maildesk/threads/${ref}/status`, { method: 'POST', body: { status: s } }), STATUS[s]);
  });
  const tpl = main.querySelector('#tpl'); if (tpl) tpl.onchange = () => { const x = d.templates.find(y => y.id === tpl.value); if (x) { const rb = main.querySelector('#rb'); rb.value = (rb.value ? rb.value + '\n\n' : '') + x.body.replace(/\{\{\s*first_name\s*\}\}/g, (t.requester_name || '').split(/\s+/)[0] || 'Sir/Madam').replace(/\{\{\s*ref\s*\}\}/g, t.ref).replace(/\{\{\s*\w+\s*\}\}/g, ''); } tpl.value = ''; };
  const rf = main.querySelector('#rf'); if (rf) rf.onsubmit = async ev => { ev.preventDefault(); const sb = ev.submitter; if (sb.disabled) return; sb.disabled = true;
    try { const r = await H.api(`/maildesk/threads/${ref}/reply`, { method: 'POST', body: { body: rf.body.value, cc: rf.cc.value.split(/[,;\s]+/).filter(Boolean), close: sb.value === 'close' } });
      undoToast(r.id, redraw); redraw(); } catch (er) { H.toast(er.message); sb.disabled = false; } };
  const nf = main.querySelector('#nf'); if (nf) nf.onsubmit = ev => { ev.preventDefault(); act(() => H.api(`/maildesk/threads/${ref}/notes`, { method: 'POST', body: { body: nf.body.value } }), 'Note added'); };
  main.querySelector('#fwd')?.addEventListener('click', () => forwardDlg(d, ref));
  if (d.messages.some(m => m.state === 'queued' || m.state === 'sending')) every(4000, redraw, location.hash.split('?')[0]); else clearInterval(pollT);
}
function undoToast(id, after) {
  const el = document.createElement('div'); el.className = 'mundo'; el.setAttribute('role', 'status');
  let n = 10; const paint = () => { el.innerHTML = `<span>Sending in ${n} s</span><button type="button" class="btn">Undo</button>`; el.querySelector('button').onclick = async () => {
    try { await H.api(`/maildesk/outbound/${id}/cancel`, { method: 'POST' }); H.toast('Not sent'); } catch (er) { H.toast(er.message); } el.remove(); clearInterval(tm); after(); }; };
  paint(); document.body.append(el); const tm = setInterval(() => { if (--n <= 0) { clearInterval(tm); el.remove(); after(); } else paint(); }, 1000);
}
// Forward to service: the desk's own ticket form (the service's questions), filled from the mail; the desk makes the ticket
async function forwardDlg(d, ref) {
  const services = (await H.api('/services')).filter(s => s.is_active), t = d.thread, first = d.messages.find(m => m.dir === 'in');
  if (!services.length) return H.toast('This campus has no services yet');
  const pick = d.suggested_service?.id || d.channel.default_service_id || services[0].id;
  const dl = H.dlg(`<h2>Forward to a service</h2><p class="muted small">This makes a normal desk ticket for ${e(t.requester_email)}. The desk sends its usual mails and the service handles it from there. This mail leaves the mail list.</p>
    <label>Service</label>${sel('service_id', services.map(s => [s.id, s.name]), pick, 'id="fsvc"')}
    <label>Name</label><input name="name" value="${e(t.requester_name || '')}" required maxlength="120">
    <label>Subject</label><input name="subject" value="${e(t.subject || '')}" required maxlength="200">
    <div id="floc"><label>Location</label><input name="location" maxlength="200"></div><div id="ftf"></div><div id="fcf"></div>
    <label>Description</label><textarea name="description" rows="5" maxlength="8000">${e(first?.body_text || '')}</textarea>`,
    async f => { const svc = services.find(s => s.id === f.service_id.value), fd = H.collectForm(f, svc);
      const r = await H.api(`/maildesk/threads/${ref}/forward`, { method: 'POST', body: { service_id: svc.id, name: f.name.value, subject: f.subject.value, location: f.location.value || undefined, description: f.description.value, form_data: fd } });
      H.toast(`Desk ticket #${r.ticket_no} made`); location.hash = '#/c/t/' + r.ticket_id; });
  dl.querySelector('button[value=ok]').textContent = 'Forward';
  const draw = () => { const svc = services.find(s => s.id === dl.querySelector('#fsvc').value), gen = H.isGeneral(svc.form_schema || {});
    dl.querySelector('#ftf').innerHTML = H.typeFields(svc); dl.querySelector('#fcf').innerHTML = H.customFields(svc);
    dl.querySelector('#floc').style.display = gen ? '' : 'none'; dl.querySelector('[name=location]').required = gen; };
  draw(); dl.querySelector('#fsvc').onchange = draw;
}

/* ================= Confirm queue ================= */
async function confirmPage(main, me) {
  const rows = await H.api('/maildesk/confirm');
  main.innerHTML = `${subnav(me, 'confirm')}<div class="card"><div class="mt-h"><div class="mt-t"><h2>Auto-replies waiting for you</h2><span class="mt-n">${rows.length}</span></div>
    ${rows.length > 1 ? '<button type="button" class="btn primary" id="call">Confirm all ticked</button>' : ''}</div>
    <p class="muted small">Each new mail gets a "we received it" reply. Check it, change the words if needed, then Confirm. Nothing goes out without a click. Red: waiting over a day.</p>
    ${rows.map(r => `<div class="card mconf ${r.stale ? 'stale' : ''}" data-id="${r.id}"><div class="mbar"><input type="checkbox" aria-label="Tick ${e(r.ref)}" checked>
      <a href="#/c/mail/t/${r.ref_no}"><span class="mono">${e(r.ref)}</span> ${e(r.subject || '(no subject)')}</a><span class="muted small">to ${e(r.requester_name || r.requester_email)} · ${e(r.address)} · ${H.shortDate(r.created_at)}</span></div>
      <details><summary class="small">Their mail</summary><div class="mm-b small">${e(r.their_text || '').replace(/\n/g, '<br>')}</div></details>
      <textarea rows="6" aria-label="Reply for ${e(r.ref)}">${e(r.body_text)}</textarea>
      <p class="mbar"><button type="button" class="btn primary" data-ok>Confirm</button><button type="button" class="btn" data-no>Don't send</button></p></div>`).join('') || H.emptyState('All clear', 'No auto-reply is waiting.')}</div>`;
  const redraw = () => confirmPage(main, { ...me, confirm: Math.max(0, me.confirm - 1) });
  main.querySelectorAll('.mconf').forEach(c => { const id = c.dataset.id, orig = rows.find(r => r.id === id).body_text, ta = c.querySelector('textarea');
    c.querySelector('[data-ok]').onclick = async () => { try { await H.api(`/maildesk/outbound/${id}/confirm`, { method: 'POST', body: ta.value !== orig ? { body: ta.value } : {} }); H.toast('Confirmed: sending'); redraw(); } catch (er) { H.toast(er.message); } };
    c.querySelector('[data-no]').onclick = async () => { try { await H.api(`/maildesk/outbound/${id}/cancel`, { method: 'POST' }); H.toast('Not sent'); redraw(); } catch (er) { H.toast(er.message); } }; });
  main.querySelector('#call')?.addEventListener('click', async () => { const ids = [...main.querySelectorAll('.mconf')].filter(c => c.querySelector('input[type=checkbox]').checked && c.querySelector('textarea').value === rows.find(r => r.id === c.dataset.id).body_text).map(c => c.dataset.id);
    if (!ids.length) return H.toast('Tick the replies to send (an edited reply is confirmed on its own)');
    try { const r = await H.api('/maildesk/confirm-bulk', { method: 'POST', body: { ids } }); H.toast(`${r.confirmed} confirmed`); redraw(); } catch (er) { H.toast(er.message); } });
}

/* ================= Settings ================= */
async function settings(main, me) {
  const d = await H.api('/maildesk/settings'), people = d.people, pOpts = [['', '—'], ...people.map(p => [p.id, `${p.name} (${p.email})`])];
  const hoursTxt = h => h ? `${h.days.map(x => DAYS[x]).join(', ')} · ${h.from}–${h.to}` : 'Same as the campus';
  const chCard = c => {
    const off = Object.fromEntries(c.officers.map(o => [o.role, o])), def = c.sla.find(p => !p.lane), imp = c.sla.find(p => p.lane === 'important');
    return `<section class="card mset" data-ch="${c.id}"><div class="mt-h"><div><h2 style="margin:0">${e(c.address)}</h2><div class="muted small">${e(c.display_name || '')} · ${e(MODE[c.mode])}${c.subscribed ? ' · receiving mail' : c.mode !== 'off' ? ' · not subscribed yet' : ''}${c.last_synced_at ? ` · last sync ${H.shortDate(c.last_synced_at)}` : ''}</div>
        ${c.last_error ? `<div class="err small">${e(c.last_error)}</div>` : ''}</div><div class="mbar"><button type="button" class="btn" data-test>Test connection</button>${c.mode !== 'off' ? '<button type="button" class="btn" data-sync>Check for new mail</button>' : ''}</div></div>
      <form data-f="box"><div class="row"><div><label>Mode</label>${sel('mode', Object.entries(MODE), c.mode)}</div><div><label>"We received it" reply</label>${sel('ack_mode', [['approve', 'Wait for Confirm (recommended)'], ['auto', 'Send by itself']], c.ack_mode)}</div></div>
        <div class="row"><div><label>Display name</label><input name="display_name" value="${e(c.display_name || '')}" maxlength="120" placeholder="Admissions, St. Mary's"></div><div><label>Usual service for Forward</label>${sel('default_service_id', [['', '—'], ...d.services.map(s => [s.id, s.name])], c.default_service_id)}</div></div>
        <label>Signature <small>(added under every reply)</small></label><textarea name="signature" rows="3" maxlength="1000">${e(c.signature || '')}</textarea>
        <label>Office hours <small>(the reply clock counts only these)</small></label><div class="muted small">${e(hoursTxt(c.office_hours))}</div>
        <div class="mbar"><label class="small"><input type="checkbox" name="own_hours" ${c.office_hours ? 'checked' : ''}> Own hours:</label>
          ${DAYS.map((x, i) => `<label class="small"><input type="checkbox" name="d${i}" ${(c.office_hours?.days || [1, 2, 3, 4, 5, 6]).includes(i) ? 'checked' : ''}>${x}</label>`).join('')}
          <input type="time" name="from" value="${e(c.office_hours?.from || '09:30')}" aria-label="From"><input type="time" name="to" value="${e(c.office_hours?.to || '17:00')}" aria-label="To"></div>
        <p><button class="btn primary">Save mailbox</button></p></form>
      <form data-f="off"><b>Officers</b><div class="muted small">New mail shows on both nodal officers' Home. No reply in time: a reminder at the first mark, then the escalation officer, then the campus mail managers.</div>
        ${['nodal_1', 'nodal_2', 'escalation'].map(r => `<div class="row"><div><label>${ROLE[r]}${r === 'nodal_1' ? ' *' : ''}</label>${sel(r, pOpts, off[r]?.user_id)}</div><div><label>Backup while on leave</label>${sel('b_' + r, pOpts, off[r]?.backup_user_id)}</div></div>`).join('')}
        <p><button class="btn primary">Save officers</button></p></form>
      <form data-f="sla"><b>Reply targets</b> <span class="muted small">(working minutes; 450 = one office day of 7½ h)</span>
        ${[['', 'Needs reply / Review', def], ['important', 'Important', imp]].map(([lane, l, p]) => `<div class="row" data-lane="${lane}"><div><label>${l}: reply within (min)</label><input type="number" name="m" min="5" max="20000" value="${p?.first_response_mins || (lane ? 240 : 450)}"></div>
          <div><label>Reminder at %</label><input type="number" name="w" min="10" max="99" value="${p?.warn_at_pct || 75}"></div><div><label>Escalate at %</label><input type="number" name="x" min="50" max="500" value="${p?.escalate_at_pct || 100}"></div>
          <div><label>Again at % <small>(empty: no)</small></label><input type="number" name="x2" min="101" max="1000" value="${p?.second_escalate_at_pct || ''}"></div></div>`).join('')}
        <p><button class="btn primary">Save targets</button></p></form>
      <form data-f="mem"><b>Other people on this mailbox</b> <span class="muted small">(e.g. the HR team on hr@)</span>
        <div data-list>${c.members.map(m => `<div class="row" data-m><div>${sel('u', pOpts, m.user_id)}</div><div>${sel('r', [['replier', 'Can reply'], ['viewer', 'Can read'], ['hr', 'HR']], m.role)}</div><button type="button" class="btn" data-rm>Remove</button></div>`).join('')}</div>
        <p class="mbar"><button type="button" class="btn" data-addm>Add person</button><button class="btn primary">Save people</button></p></form></section>`;
  };
  main.innerHTML = `${subnav(me, 'settings')}
    <section class="card"><div class="chead">${H.I('settings', 16)}<span>Connection</span></div>
      <p class="small">Microsoft 365: ${d.graph.ready ? '<b>connected</b> (keys in .env)' : '<b>not connected</b>: set MS_TENANT_ID, MS_CLIENT_ID and MS_CLIENT_SECRET in .env and restart'}. Notification address: <span class="mono">${e(d.graph.notify_url)}</span>${d.graph.client_state ? '' : ' · set GRAPH_CLIENT_STATE in .env'}.</p>
      <p class="small">Jobs waiting: ${d.jobs?.queued || 0} · failed: ${d.jobs?.failed || 0}${d.ai_today.length ? ` · AI today: ${d.ai_today.map(a => `${e(a.provider)} ${a.calls} calls${a.failures ? `, ${a.failures} failed` : ''}`).join('; ')}` : ''}</p>
      ${d.admin ? `<label class="small"><input type="checkbox" id="kill" ${d.auto_reply_paused ? 'checked' : ''}> Pause every auto-reply (all mailboxes)</label>` : ''}</section>
    ${d.channels.map(chCard).join('')}
    <form class="card" id="newch"><div class="chead">${H.I('plus', 16)}<span>Add a mailbox</span></div><div class="row"><div><label>Address</label><input name="address" type="email" required placeholder="reach@smru.edu.in"></div><div><label>Display name</label><input name="display_name" maxlength="120"></div></div>
      <p class="muted small">A new mailbox starts Off. Pick the officers, then switch it to Shadow for a week (mail is read and sorted, nothing is sent), then Live.</p><p><button class="btn primary">Add mailbox</button></p></form>
    <section class="card"><div class="chead">${H.I('mail', 16)}<span>Reply templates</span></div><p class="muted small">Fill-ins: {{first_name}}, {{name}}, {{ref}}, {{campus}}, {{team}}, {{eta}}, {{mailbox_name}}, {{post}}, {{subject}}. "Received" templates are the auto-reply; "Quick answer" templates appear in the reply box.</p>
      ${d.templates.map(t => `<div class="mbar mtpl"><b>${e(t.name)}</b><span class="mchip">${e({ auto_ack: 'Received', status: 'Status', manual: 'Quick answer' }[t.kind])}</span><span class="muted small">${t.channel_id ? e(d.channels.find(c => c.id === t.channel_id)?.address || '') : 'all mailboxes'}${t.category ? ` · ${e(t.category)}` : ''}${t.active ? '' : ' · off'}${t.tenant_id ? '' : ' · default'}</span><span class="sp"></span>
        ${t.tenant_id || d.admin ? `<button type="button" class="btn" data-tpl="${t.id}">Edit</button>` : ''}</div>`).join('')}
      <p><button type="button" class="btn" data-tpl="">Add template</button></p></section>
    <section class="card"><div class="chead">${H.I('filter', 16)}<span>Sorting rules</span></div><p class="muted small">Checked before the AI. Noise wins over Important, Important over Auto.</p>
      ${d.rules.map(r => `<div class="mbar"><span>${e({ sender: 'Sender is', domain: 'Domain is', subject_contains: 'Subject has', header: 'Header' }[r.match])} <b>${e(r.value)}</b> → ${e({ noise: 'Noise', important: 'Important', auto: 'Auto-handled', skip_ai: 'Do not send to the AI' }[r.action])}</span><span class="muted small">${r.channel_id ? e(d.channels.find(c => c.id === r.channel_id)?.address || '') : 'all mailboxes'}</span><span class="sp"></span><button type="button" class="btn" data-delrule="${r.id}">Remove</button></div>`).join('') || '<p class="muted small">No rules yet.</p>'}
      <form id="newrule" class="mbar">${sel('match', [['sender', 'Sender is'], ['domain', 'Domain is'], ['subject_contains', 'Subject has'], ['header', 'Header (name:value)']], 'domain')}<input name="value" required maxlength="255" placeholder="e.g. newsletter.com">
        ${sel('action', [['noise', 'Noise'], ['important', 'Important'], ['auto', 'Auto-handled'], ['skip_ai', 'Do not send to the AI']], 'noise')}${sel('channel_id', [['', 'All mailboxes'], ...d.channels.map(c => [c.id, c.address])], '')}<button class="btn">Add rule</button></form></section>
    <section class="card"><div class="chead">${H.I('swap', 16)}<span>Suggested service by category</span></div><p class="muted small">When the AI reads a mail's category, Forward suggests this service. An officer always presses Forward.</p>
      ${d.routes.map(r => `<div class="mbar"><span><b>${e(r.category)}</b> → ${e(r.service)}</span><span class="sp"></span><button type="button" class="btn" data-delroute="${r.id}">Remove</button></div>`).join('')}
      <form id="newroute" class="mbar"><input name="category" required maxlength="80" placeholder="e.g. Hostel">${sel('service_id', d.services.map(s => [s.id, s.name]), '')}<button class="btn">Add</button></form></section>
    <section class="card"><div class="chead">${H.I('clock', 16)}<span>Officers on leave</span></div><p class="muted small">While on leave, an officer's backup gets the mail and the alerts.</p>
      ${d.leave.map(l => `<div class="mbar"><span><b>${e(l.name)}</b> ${e(l.from_day)} to ${e(l.to_day)}</span><span class="sp"></span><button type="button" class="btn" data-delleave="${l.id}">Remove</button></div>`).join('')}
      <form id="newleave" class="mbar">${sel('user_id', pOpts, '')}<input type="date" name="from_day" required aria-label="From"><input type="date" name="to_day" required aria-label="To"><button class="btn">Add leave</button></form></section>
    <section class="card"><div class="chead">${H.I('users', 16)}<span>Mail managers</span></div><p class="muted small">See every mailbox of the campus and get the second escalation. Campus admins are managers already.</p>
      ${d.roles.map(r => `<div class="mbar"><b>${e(r.name)}</b><span class="sp"></span><button type="button" class="btn" data-delrole="${r.user_id}">Remove</button></div>`).join('')}
      <form id="newrole" class="mbar">${sel('user_id', pOpts, '')}<button class="btn">Add manager</button></form></section>
    ${d.admin ? `<section class="card"><div class="chead">${H.I('bolt', 16)}<span>AI providers</span></div><p class="muted small">Tried in order; if one fails (no credit, too busy, a bad answer) the next one is tried, and with none the rules decide or the mail waits in Review. Names, phone numbers and emails are masked before any text is sent. Keys are stored encrypted and never shown again.</p>
      ${d.integrations.map(i => `<div class="mbar"><b>${i.priority}. ${e(i.name)}</b><span class="muted small">${e(i.config.model || '')} · ${e(i.config.baseURL || '')} · ${i.active ? 'on' : 'off'}${i.has_key ? '' : ' · no key'}${i.last_test_result ? ` · ${e(i.last_test_result)}` : ''}</span><span class="sp"></span>
        <button type="button" class="btn" data-ai="${i.id}">Edit</button><button type="button" class="btn" data-aitest="${i.id}">Test</button></div>`).join('') || '<p class="muted small">None yet: every mail goes by the rules, else to Review.</p>'}
      <p><button type="button" class="btn" data-ai="">Add AI provider</button></p></section>` : ''}`;

  const redraw = () => settings(main, me), go = async (fn, m) => { try { await fn(); H.toast(m); redraw(); } catch (er) { H.toast(er.message); } };
  main.querySelectorAll('.mset').forEach(sec => { const id = sec.dataset.ch, c = d.channels.find(x => x.id === id);
    sec.querySelector('[data-test]').onclick = async () => { try { const r = await H.api(`/maildesk/channels/${id}/test`, { method: 'POST' }); H.toast(r.message); } catch (er) { H.toast(er.message); } };
    sec.querySelector('[data-sync]')?.addEventListener('click', () => go(() => H.api(`/maildesk/channels/${id}/sync`, { method: 'POST' }), 'Checking the inbox'));
    sec.querySelector('[data-f=box]').onsubmit = ev => { ev.preventDefault(); const f = ev.target, days = DAYS.map((_, i) => i).filter(i => f['d' + i].checked);
      go(() => H.api(`/maildesk/channels/${id}`, { method: 'PATCH', body: { mode: f.mode.value, ack_mode: f.ack_mode.value, display_name: f.display_name.value, signature: f.signature.value, default_service_id: f.default_service_id.value,
        office_hours: f.own_hours.checked ? { days, from: f.from.value, to: f.to.value } : null } }), 'Mailbox saved'); };
    sec.querySelector('[data-f=off]').onsubmit = ev => { ev.preventDefault(); const f = ev.target;
      go(() => H.api(`/maildesk/channels/${id}/officers`, { method: 'PUT', body: { nodal_1: f.nodal_1.value, nodal_2: f.nodal_2.value || null, escalation: f.escalation.value || null,
        backups: { nodal_1: f.b_nodal_1.value || null, nodal_2: f.b_nodal_2.value || null, escalation: f.b_escalation.value || null } } }), 'Officers saved'); };
    sec.querySelector('[data-f=sla]').onsubmit = ev => { ev.preventDefault();
      const policies = [...ev.target.querySelectorAll('[data-lane]')].map(r => ({ lane: r.dataset.lane || null, first_response_mins: Number(r.querySelector('[name=m]').value), warn_at_pct: Number(r.querySelector('[name=w]').value),
        escalate_at_pct: Number(r.querySelector('[name=x]').value), second_escalate_at_pct: r.querySelector('[name=x2]').value ? Number(r.querySelector('[name=x2]').value) : null }));
      go(() => H.api(`/maildesk/channels/${id}/sla`, { method: 'PUT', body: { policies } }), 'Targets saved'); };
    const mf = sec.querySelector('[data-f=mem]'), wireRm = () => mf.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => b.closest('[data-m]').remove());
    mf.querySelector('[data-addm]').onclick = () => { mf.querySelector('[data-list]').insertAdjacentHTML('beforeend', `<div class="row" data-m><div>${sel('u', pOpts, '')}</div><div>${sel('r', [['replier', 'Can reply'], ['viewer', 'Can read'], ['hr', 'HR']], 'replier')}</div><button type="button" class="btn" data-rm>Remove</button></div>`); wireRm(); };
    wireRm(); mf.onsubmit = ev => { ev.preventDefault(); const members = [...mf.querySelectorAll('[data-m]')].map(r => ({ user_id: r.querySelector('[name=u]').value, role: r.querySelector('[name=r]').value })).filter(m => m.user_id);
      go(() => H.api(`/maildesk/channels/${id}/members`, { method: 'PUT', body: { members } }), 'People saved'); };
    void c; });
  main.querySelector('#newch').onsubmit = ev => { ev.preventDefault(); go(() => H.api('/maildesk/channels', { method: 'POST', body: { address: ev.target.address.value, display_name: ev.target.display_name.value } }), 'Mailbox added'); };
  main.querySelector('#kill')?.addEventListener('change', ev => go(() => H.api('/maildesk/switches', { method: 'PUT', body: { auto_reply_paused: ev.target.checked } }), ev.target.checked ? 'Auto-replies paused' : 'Auto-replies on'));
  main.querySelector('#newrule').onsubmit = ev => { ev.preventDefault(); const f = ev.target; go(() => H.api('/maildesk/rules', { method: 'POST', body: { match: f.match.value, value: f.value.value, action: f.action.value, channel_id: f.channel_id.value || null } }), 'Rule added'); };
  main.querySelectorAll('[data-delrule]').forEach(b => b.onclick = () => go(() => H.api('/maildesk/rules/' + b.dataset.delrule, { method: 'DELETE' }), 'Rule removed'));
  main.querySelector('#newroute').onsubmit = ev => { ev.preventDefault(); go(() => H.api('/maildesk/routes', { method: 'POST', body: { category: ev.target.category.value, service_id: ev.target.service_id.value } }), 'Saved'); };
  main.querySelectorAll('[data-delroute]').forEach(b => b.onclick = () => go(() => H.api('/maildesk/routes/' + b.dataset.delroute, { method: 'DELETE' }), 'Removed'));
  main.querySelector('#newleave').onsubmit = ev => { ev.preventDefault(); const f = ev.target; go(() => H.api('/maildesk/leave', { method: 'POST', body: { user_id: f.user_id.value, from_day: f.from_day.value, to_day: f.to_day.value } }), 'Leave added'); };
  main.querySelectorAll('[data-delleave]').forEach(b => b.onclick = () => go(() => H.api('/maildesk/leave/' + b.dataset.delleave, { method: 'DELETE' }), 'Removed'));
  main.querySelector('#newrole').onsubmit = ev => { ev.preventDefault(); go(() => H.api('/maildesk/roles', { method: 'PUT', body: { user_id: ev.target.user_id.value, role: 'manager' } }), 'Manager added'); };
  main.querySelectorAll('[data-delrole]').forEach(b => b.onclick = () => go(() => H.api('/maildesk/roles', { method: 'PUT', body: { user_id: b.dataset.delrole, role: null } }), 'Removed'));
  main.querySelectorAll('[data-tpl]').forEach(b => b.onclick = () => { const t = d.templates.find(x => x.id === b.dataset.tpl) || { kind: 'manual', active: 1 };
    const dl = H.dlg(`<h2>${t.id ? 'Edit template' : 'New template'}</h2><label>Kind</label>${sel('kind', [['auto_ack', 'Received (auto-reply)'], ['manual', 'Quick answer'], ['status', 'Status']], t.kind)}
      <label>Name</label><input name="name" required maxlength="120" value="${e(t.name || '')}"><label>Mailbox</label>${sel('channel_id', [['', 'All mailboxes'], ...d.channels.map(c => [c.id, c.address])], t.channel_id)}
      <label>Only for category <small>(optional, as the AI names it)</small></label><input name="category" maxlength="80" value="${e(t.category || '')}">
      <label>Text</label><textarea name="body" rows="9" required maxlength="8000">${e(t.body || '')}</textarea><label class="small"><input type="checkbox" name="active" ${t.active ? 'checked' : ''}> On</label>
      ${t.id ? '<p><button type="button" class="btn" id="tdel">Delete template</button></p>' : ''}`,
      async f => { const body = { kind: f.kind.value, name: f.name.value, channel_id: f.channel_id.value || null, category: f.category.value || null, body: f.body.value, active: f.active.checked };
        await H.api(t.id ? '/maildesk/templates/' + t.id : '/maildesk/templates', { method: t.id ? 'PATCH' : 'POST', body }); H.toast('Template saved'); redraw(); });
    dl.querySelector('#tdel')?.addEventListener('click', async () => { if (!confirm('Delete this template?')) return; try { await H.api('/maildesk/templates/' + t.id, { method: 'DELETE' }); dl.close(); H.toast('Deleted'); redraw(); } catch (er) { H.toast(er.message); } }); });
  main.querySelectorAll('[data-ai]').forEach(b => b.onclick = () => { const i = d.integrations.find(x => x.id === b.dataset.ai) || { config: {}, priority: d.integrations.length + 1 };
    const dl = H.dlg(`<h2>${i.id ? 'Edit AI provider' : 'Add AI provider'}</h2><p class="muted small">Any OpenAI-compatible API: OpenAI, Groq, xAI, a local Ollama.</p>
      <label>Name</label><input name="name" required maxlength="120" value="${e(i.name || '')}" placeholder="OpenAI nano"><label>API address</label><input name="baseURL" required value="${e(i.config.baseURL || '')}" placeholder="https://api.openai.com/v1">
      <label>Model</label><input name="model" required value="${e(i.config.model || '')}" placeholder="gpt-5-nano"><label>Key ${i.has_key ? '<small>(leave empty to keep the saved key)</small>' : ''}</label><input name="apiKey" type="password" autocomplete="off" ${i.id ? '' : 'required'}>
      <div class="row"><div><label>Order</label><input name="priority" type="number" min="1" max="99" value="${i.priority}"></div><div><label>Reasoning effort <small>(optional)</small></label><input name="reasoningEffort" value="${e(i.config.reasoningEffort || '')}" placeholder="minimal"></div></div>
      <label class="small"><input type="checkbox" name="noTemperature" ${i.config.noTemperature ? 'checked' : ''}> The model takes no temperature setting</label><label class="small"><input type="checkbox" name="active" ${i.active || !i.id ? 'checked' : ''}> On</label>
      ${i.id ? '<p><button type="button" class="btn" id="aidel">Delete provider</button></p>' : ''}`,
      async f => { const body = { name: f.name.value, baseURL: f.baseURL.value, model: f.model.value, priority: Number(f.priority.value), reasoningEffort: f.reasoningEffort.value, noTemperature: f.noTemperature.checked, active: f.active.checked, ...(f.apiKey.value ? { apiKey: f.apiKey.value } : {}) };
        await H.api(i.id ? '/maildesk/integrations/' + i.id : '/maildesk/integrations', { method: i.id ? 'PATCH' : 'POST', body }); H.toast('Saved'); redraw(); });
    dl.querySelector('#aidel')?.addEventListener('click', async () => { if (!confirm('Delete this AI provider?')) return; try { await H.api('/maildesk/integrations/' + i.id, { method: 'DELETE' }); dl.close(); redraw(); } catch (er) { H.toast(er.message); } }); });
  main.querySelectorAll('[data-aitest]').forEach(b => b.onclick = async () => { b.disabled = true; try { const r = await H.api(`/maildesk/integrations/${b.dataset.aitest}/test`, { method: 'POST' }); H.toast(r.message); redraw(); } catch (er) { H.toast(er.message); b.disabled = false; } });
}
