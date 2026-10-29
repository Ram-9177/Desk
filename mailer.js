// Outbound email through a Power Automate HTTP-triggered flow, configured from the Email page.
import { all, run } from './db.js';

// Settings are read on every email, so they live in memory: loaded once at start, updated on every save (one app process).
let settings = {};
export const loadSettings = async () => { settings = Object.fromEntries((await all('SELECT key, value FROM app_settings')).map(r => [r.key, r.value])); };
export const getSettings = () => settings;
export async function setSetting(k, v) {
  await run('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value=excluded.value', k, v);
  settings = { ...settings, [k]: v };
}

// ---------- templates ----------
// Fill-in fields an admin can use in subjects and messages. {{name}} is replaced with the value.
export const VARS = {
  requestor_name: 'Requestor’s name', ticket_no: 'Ticket number, e.g. 0042', subject: 'Ticket subject', description: 'What the requestor wrote',
  service: 'Service (team) name', location: 'Location / room', campus: 'Campus name', status: 'Status in words', priority: 'Priority',
  due: 'Target close time', providers: 'Provider names', ticket_link: 'Requestor’s ticket page link', staff_link: 'Staff link to the ticket',
  portal_link: 'Campus portal link', note: 'Note / reason typed at this step', actor_name: 'Person who made the change',
  hold_reason: 'Hold reason', resume_by: 'Expected resume time', reopen_days: 'Days allowed to reopen',
  from_service: 'Previous service', to_service: 'New service', staff_name: 'Staff member’s name', staff_email: 'Staff sign-in email',
  escalated_to_name: 'Person the ticket was escalated to', temp_password: 'Temporary password', password: 'The new password they chose', role_name: 'Staff member’s role', services: 'Services they handle', login_link: 'ONE Desk sign-in link', count: 'Number of tickets', ticket_list: 'List of tickets',
  progress: 'Block: progress tracker and what happens next', ticket_details: 'Block: all ticket details and form answers', timeline: 'Block: latest updates and notes',
  guide: 'Block: link to the step-by-step guide (a requestor’s first ticket)',
};
// Block fields: put one alone on its own line and it becomes a designed section of the email.
export const BLOCKS = ['progress', 'ticket_details', 'timeline', 'guide'];
const T = ['requestor_name', 'ticket_no', 'subject', 'description', 'service', 'location', 'campus', 'status', 'priority', 'due', 'providers', 'ticket_link', 'staff_link', 'portal_link', ...BLOCKS];
const STAFF = ['staff_name', 'staff_email', 'temp_password', 'login_link', 'campus', 'role_name', 'services'];
const STAFF_PW = ['staff_name', 'staff_email', 'password', 'login_link', 'campus', 'role_name', 'services'];

// Every step that sends mail, with its default template.
export const MAIL_EVENTS = [
  { key: 'created', label: 'Ticket received', who: 'Requestor', when: 'A ticket is raised (portal, walk-in or phone)', vars: [...T, 'guide'],
    subject: '[{{ticket_no}}] Ticket received: {{subject}}',
    body: 'Hi {{requestor_name}},\nThank you, we have received your request and the {{service}} team has been notified. You don\'t need to do anything else.\n{{progress}}\n[[View your ticket|{{ticket_link}}]]\n{{ticket_details}}\n{{guide}}' },
  { key: 'new_ticket', label: 'New ticket in the queue', who: 'Service providers', when: 'A ticket arrives in their service', vars: T,
    subject: '[{{ticket_no}}] New ticket: {{subject}}',
    body: 'A new ticket has arrived in **{{service}}**. Target: {{due}}.\n[[Open the ticket|{{staff_link}}]]\n{{ticket_details}}' },
  { key: 'status_in_progress', label: 'Work started', who: 'Requestor', when: 'A provider starts working on it', vars: [...T, 'note', 'actor_name'],
    subject: '[{{ticket_no}}] Work has started on your ticket',
    body: 'Hi {{requestor_name}},\n{{actor_name}} has started working on "{{subject}}".\n{{note}}\n{{progress}}\n[[View your ticket|{{ticket_link}}]]\n{{ticket_details}}' },
  { key: 'status_hold', label: 'Ticket on hold', who: 'Requestor', when: 'A provider puts it on hold', vars: [...T, 'note', 'actor_name', 'hold_reason', 'resume_by'],
    subject: '[{{ticket_no}}] Your ticket is on hold',
    body: 'Hi {{requestor_name}},\nYour ticket "{{subject}}" is paused for a short while. Here is what {{actor_name}} wrote:\n{{note}}\n{{progress}}\n[[View your ticket|{{ticket_link}}]]\n{{timeline}}\n{{ticket_details}}' },
  { key: 'status_open', label: 'Work resumed', who: 'Requestor', when: 'A hold ends', vars: [...T, 'note', 'actor_name'],
    subject: '[{{ticket_no}}] Work has resumed on your ticket',
    body: 'Hi {{requestor_name}},\nGood news: work has resumed on "{{subject}}".\n{{note}}\n{{progress}}\n[[View your ticket|{{ticket_link}}]]\n{{timeline}}\n{{ticket_details}}' },
  { key: 'status_closed', label: 'Ticket closed', who: 'Requestor', when: 'A provider closes it', vars: [...T, 'note', 'actor_name', 'reopen_days'],
    subject: '[{{ticket_no}}] Your ticket is closed',
    body: 'Hi {{requestor_name}},\nYour ticket "{{subject}}" has been resolved by {{actor_name}}:\n{{note}}\n{{progress}}\n[[View or reopen your ticket|{{ticket_link}}]]\n{{timeline}}\n{{ticket_details}}' },
  { key: 'status_rejected', label: 'Ticket rejected', who: 'Requestor', when: 'A provider rejects it', vars: [...T, 'note', 'actor_name'],
    subject: '[{{ticket_no}}] Your ticket could not be accepted',
    body: 'Hi {{requestor_name}},\nYour ticket "{{subject}}" could not be accepted.\nReason: {{note}}\n{{progress}}\n[[Raise a new ticket|{{portal_link}}]]\n{{ticket_details}}' },
  { key: 'note', label: 'Update from the provider', who: 'Requestor', when: 'A provider adds a public note', vars: [...T, 'note', 'actor_name'],
    subject: '[{{ticket_no}}] New update on your ticket',
    body: 'Hi {{requestor_name}},\n{{actor_name}} added an update to "{{subject}}":\n{{note}}\n{{progress}}\n[[View your ticket|{{ticket_link}}]]\n{{timeline}}' },
  { key: 'requestor_note', label: 'Requestor added a note', who: 'Service providers', when: 'The requestor adds a note on the ticket page', vars: [...T, 'note'],
    subject: '[{{ticket_no}}] {{requestor_name}} added a note',
    body: '{{requestor_name}} added a note to "{{subject}}":\n{{note}}\n[[Open the ticket|{{staff_link}}]]\n{{timeline}}\n{{ticket_details}}' },
  { key: 'transferred', label: 'Ticket transferred', who: 'Old and new service providers', when: 'A ticket moves to another service', vars: [...T, 'note', 'actor_name', 'from_service', 'to_service'],
    subject: '[{{ticket_no}}] Ticket moved to {{to_service}}',
    body: '"{{subject}}" was moved from {{from_service}} to **{{to_service}}** by {{actor_name}}.\nReason: {{note}}\n[[Open the ticket|{{staff_link}}]]\n{{ticket_details}}\n{{timeline}}' },
  { key: 'transferred_requestor', label: 'Ticket moved to another team', who: 'Requestor', when: 'A ticket moves to another service', vars: [...T, 'note', 'actor_name', 'from_service', 'to_service'],
    subject: '[{{ticket_no}}] Your ticket moved to {{to_service}}',
    body: 'Hi {{requestor_name}},\nYour ticket "{{subject}}" is now with the **{{to_service}}** team, who can help you best.\n{{note}}\n{{progress}}\n[[View your ticket|{{ticket_link}}]]\n{{ticket_details}}' },
  { key: 'reopened', label: 'Ticket reopened', who: 'Service providers', when: 'The requestor (or staff) reopens a closed ticket', vars: [...T, 'note', 'actor_name'],
    subject: '[{{ticket_no}}] Ticket reopened: {{subject}}',
    body: '"{{subject}}" was reopened by {{actor_name}}.\nReason: {{note}}\nNew target: {{due}}\n[[Open the ticket|{{staff_link}}]]\n{{timeline}}\n{{ticket_details}}' },
  { key: 'escalated', label: 'Ticket escalated', who: 'Escalation person and service providers', when: 'A ticket misses its target by the campus’s escalate-after days', vars: [...T, 'note', 'escalated_to_name'],
    subject: '[{{ticket_no}}] Escalated to {{escalated_to_name}}: {{subject}}',
    body: 'This ticket has been escalated to **{{escalated_to_name}}**.\n{{note}}\nPlease take it forward and update the requestor.\n[[Open the ticket|{{staff_link}}]]\n{{ticket_details}}\n{{timeline}}' },
  { key: 'escalated_requestor', label: 'Escalation acknowledgement', who: 'Requestor', when: 'Their ticket is escalated', vars: [...T, 'escalated_to_name'],
    subject: '[{{ticket_no}}] We have escalated your ticket',
    body: 'Hi {{requestor_name}},\nYour ticket "{{subject}}" is taking longer than we planned, so it has been escalated to **{{escalated_to_name}}** for faster help. We are sorry for the wait.\n{{progress}}\n[[View your ticket|{{ticket_link}}]]\n{{ticket_details}}' },
  { key: 'invite', label: 'New staff account', who: 'New staff member', when: 'An admin adds a person', vars: STAFF,
    subject: '[ONE Desk] Welcome to ONE Desk, your sign-in details',
    body: 'Hi {{staff_name}},\nWelcome to **ONE Desk**, the service desk of {{campus}}. Students and staff raise their requests here, and you help solve them.\n'
      + 'Your role: {{role_name}}\nYour services: {{services}}\n**How it works**\n'
      + '• You get an email when a new ticket arrives in your services. It also shows on your ONE Desk home screen.\n'
      + '• Open the ticket, choose the status (In progress, On hold, Closed) and add a short note. The requestor is emailed every update.\n'
      + '• Every ticket has a target time, counted in working hours only. Closing on time earns you points; tickets that miss it are escalated.\n'
      + '**Your sign-in details**\nEmail: {{staff_email}}\nTemporary password: {{temp_password}}\n[[Sign in to ONE Desk|{{login_link}}]]\n'
      + 'You will be asked to choose your own password the first time you sign in. Please keep these details private.' },
  { key: 'password_changed', label: 'Password changed', who: 'Staff member', when: 'They set their own password (first sign-in or Profile)', vars: STAFF_PW,
    subject: '[ONE Desk] Your password was changed',
    body: 'Hi {{staff_name}},\nYour ONE Desk password was changed just now. Here are your sign-in details for your records.\nEmail: {{staff_email}}\nPassword: {{password}}\n[[Sign in to ONE Desk|{{login_link}}]]\n'
      + 'If you did not make this change, tell your admin straight away so they can reset it. Keep this email private, or delete it once your password is saved somewhere safe.' },
  { key: 'password_reset', label: 'Password reset', who: 'Staff member', when: 'An admin resets their password', vars: STAFF,
    subject: '[ONE Desk] Your password was reset',
    body: 'Hi {{staff_name}},\nAn admin reset your ONE Desk password.\nEmail: {{staff_email}}\nTemporary password: {{temp_password}}\nYou will be asked to choose a new password when you sign in.\n[[Sign in to ONE Desk|{{login_link}}]]' },
  { key: 'digest', label: 'Daily digest (08:30)', who: 'Providers and admins', when: 'Each morning, if they have overdue or on-hold tickets', vars: ['staff_name', 'campus', 'count', 'ticket_list', 'login_link'],
    subject: '[Digest] {{count}} tickets need your attention',
    body: 'Good morning {{staff_name}},\nThese tickets are overdue or on hold:\n{{ticket_list}}\n[[Open ONE Desk|{{login_link}}]]' },
];
export const eventByKey = k => MAIL_EVENTS.find(e => e.key === k);

// Sample values for previews on the Email page.
export const SAMPLE = { requestor_name: 'Meena', ticket_no: '0042', subject: 'Fan not working', description: 'Ceiling fan stopped working this morning.',
  service: 'Electrical', location: 'Hostel H2, room 214', campus: "St. Mary's Rehabilitation University", status: 'Open', priority: 'Medium',
  due: '29 Oct 2026, 3:15 pm', providers: 'Suresh Babu', escalated_to_name: 'Priya Reddy', note: 'The electrician will replace the fan motor.', actor_name: 'Suresh Babu',
  hold_reason: 'Waiting for parts / material', resume_by: '30 Oct 2026, 3:15 pm', reopen_days: 7, from_service: 'Electrical', to_service: 'IT Support',
  staff_name: 'Kiran Kumar', staff_email: 'kiran@yourcampus.edu', temp_password: 'Sample-Pass-42', password: 'MyNewPass2026', role_name: 'Service provider', services: 'Electrical, IT Support', count: 2,
  ticket_list: '0042 · on hold · Fan not working\n0039 · overdue · Projector not working',
  progress: { status: 'open', service: 'Electrical', due: '29 Oct 2026, 3:15 pm', hold_reason: 'Waiting for parts / material', resume_by: '30 Oct 2026, 3:15 pm', reopen_days: 7, closed_at: '28 Oct 2026, 5:40 pm' },
  ticket_details: [['Ticket', '0042'], ['Service', 'Electrical'], ['Subject', 'Fan not working'], ['Description', 'Ceiling fan stopped working this morning.'],
    ['Location', 'Hostel H2, room 214'], ['Issue', 'Fan'], ['Priority', 'Medium'], ['Raised on', '28 Oct 2026, 9:05 am'], ['Target', '29 Oct 2026, 3:15 pm'], ['Handled by', 'Suresh Babu']],
  timeline: [{ at: '28 Oct, 11:20 am', label: 'Note from Suresh Babu', body: 'The electrician will replace the fan motor.' }, { at: '28 Oct, 9:05 am', label: 'Ticket received', body: '' }] };
// Preview the progress block in the state that matches the email.
const SAMPLE_STATE = { created: 'open', new_ticket: 'open', status_hold: 'hold', status_closed: 'closed', status_rejected: 'rejected' };
export const sampleVars = (base, key) => ({ ...SAMPLE, ticket_details: [...SAMPLE.ticket_details, ['Photos', [{ url: `${base}/logo-mark.png`, name: 'photo.jpg' }]]], guide: { kind: 'requestor', url: `${base}/guide/requestor.html` }, progress: { ...SAMPLE.progress, status: SAMPLE_STATE[key] || 'in_progress' }, ticket_link: `${base}/#/d/smru/t/0042`, staff_link: `${base}/#/c`, portal_link: `${base}/#/d/smru`, login_link: `${base}/#/login` });

// Values typed by people are cleaned so they can't add buttons or bold to an email.
const clean = v => String(v ?? '').replace(/\[\[/g, '[ [').replace(/\]\]/g, '] ]').replace(/\*\*/g, '* *').replace(/\{\{/g, '{ {');
// Replace {{fields}}; a line whose fields are all empty is left out.
export function fill(tpl, vars) {
  return String(tpl || '').split('\n').flatMap(line => {
    const names = [...line.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map(m => m[1]);
    const blk = /^\s*\{\{\s*(\w+)\s*\}\}\s*$/.exec(line);
    if (blk && BLOCKS.includes(blk[1])) return vars[blk[1]] && (!Array.isArray(vars[blk[1]]) || vars[blk[1]].length) ? [`{{${blk[1]}}}`] : [];
    if (names.length && names.every(n => BLOCKS.includes(n) || clean(vars[n]).trim() === '')) return [];
    return [line.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, n) => BLOCKS.includes(n) ? '' : clean(vars[n]))];
  }).join('\n');
}
export const unknownVars = (tpl, allowed) => [...new Set([...String(tpl).matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map(m => m[1]))].filter(n => !allowed.includes(n));
export const templateFor = (cfg, key) => ({ ...(({ subject, body }) => ({ subject, body }))(eventByKey(key) || {}), ...(cfg.templates[key] || {}) });
export function renderTemplate(cfg, key, vars) {
  const t = templateFor(cfg, key);
  return { subject: fill(t.subject, vars).replace(/\s*\n\s*/g, ' ').trim().slice(0, 250), body: fill(t.body, vars) };
}
// Plain-text version: buttons become "label: link", bold markers dropped.
const STEP_TEXT = { open: 'Open', in_progress: 'In progress', hold: 'On hold', closed: 'Closed', rejected: 'Not accepted' };
export const toText = (body, blocks = {}) => String(body).split('\n').map(line => {
  const b = /^\s*\{\{(\w+)\}\}\s*$/.exec(line)?.[1];
  if (b === 'progress' && blocks.progress) return `Status: ${STEP_TEXT[blocks.progress.status] || blocks.progress.status}. ${nextStep(blocks.progress)}`;
  if (b === 'ticket_details' && blocks.ticket_details) return '\nTicket details\n' + blocks.ticket_details.map(([k, v]) => `${k}: ${Array.isArray(v) ? v.map(p => p.url).join(' ') : v}`).join('\n');
  if (b === 'timeline' && blocks.timeline) return '\nLatest updates\n' + blocks.timeline.map(e => `${e.at} · ${e.label}${e.body ? `: ${e.body}` : ''}${e.photos?.length ? `\nPhotos: ${e.photos.map(p => p.url).join(' ')}` : ''}`).join('\n');
  if (b === 'guide' && blocks.guide) { const c = GUIDE_COPY[blocks.guide.kind] || GUIDE_COPY.requestor; return `\n${c.title}${/[?.!]$/.test(c.title) ? '' : '.'} ${c.label}: ${blocks.guide.url}`; }
  if (b && BLOCKS.includes(b)) return '';
  return line.replace(/\[\[([^|\]]+)\|([^\]]+)\]\]/g, '$1: $2').replace(/\*\*(.+?)\*\*/g, '$1');
}).join('\n');
// One reassuring sentence about what happens next, per status.
export function nextStep(p) {
  const working = p.escalated_to ? `Escalated to ${p.escalated_to}, who is now following it up with the ${p.service} team.` : `The ${p.service} team is working on it. Target: ${p.due}.`;
  return { open: p.escalated_to ? working : `The ${p.service} team has received it and will pick it up shortly. Target: ${p.due}.`, in_progress: working,
    hold: `Paused: ${p.hold_reason || 'waiting on something'}.${p.resume_by ? ` Expected to resume by ${p.resume_by}.` : ''} We'll email you when work resumes.`,
    closed: `Completed${p.closed_at ? ` on ${p.closed_at}` : ''}. Not fixed? You can reopen it within ${p.reopen_days} days.`,
    rejected: 'This ticket was not accepted. You can raise a new one any time.' }[p.status] || '';
}

export function mailConfig(defaultBase) {
  const s = getSettings();
  let events = {}; try { events = JSON.parse(s.mail_events || '{}'); } catch { /* keep defaults */ }
  let templates = {}; try { templates = JSON.parse(s.mail_templates || '{}'); } catch { /* keep defaults */ }
  return { templates, url: s.pa_url ?? process.env.PA_EMAIL_FLOW_URL ?? '', key: s.pa_key ?? process.env.PA_EMAIL_FLOW_KEY ?? '',
    base: s.public_base_url || process.env.PUBLIC_BASE_URL || defaultBase, sending: s.mail_enabled !== '0', events,
    last_ok_at: s.mail_last_ok_at || null };
}
export const eventOn = (cfg, key) => cfg.events[key] !== false;

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// Branded, email-client-safe HTML (tables + inline styles). Lines ending in a link become a button.
export function renderEmail({ subject, body, campus, blocks = {} }) {
  const m = /^\[([^\]]+)\]\s*(.*)$/.exec(subject || ''), ref = m?.[1], title = m ? m[2] : subject;
  const bold = h => h.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  // [[Text|link]] inside a sentence becomes a plain link (alone on its line it is a button)
  const links = h => h.replace(/\[\[([^|\]]+)\|\s*(https?:\/\/[^\]\s]+)\s*\]\]/g, '<a href="$2" style="color:#1e4b8f;font-weight:700;text-decoration:underline">$1</a>');
  const html = String(body || '').split('\n').filter(l => l.trim()).map(line => {
    const blk = /^\s*\{\{(\w+)\}\}\s*$/.exec(line)?.[1];
    if (blk && BLOCKS.includes(blk)) return blocks[blk] ? BLOCK_HTML[blk](blocks[blk]) : '';
    const btn = /^\s*\[\[([^|\]]+)\|\s*(https?:\/\/[^\]\s]+)\s*\]\]\s*$/.exec(line);
    if (btn) return `<p style="margin:18px 0 8px"><a href="${esc(btn[2])}" style="display:inline-block;background:#1e4b8f;color:#ffffff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:10px">${esc(btn[1])}</a></p>`;
    const kv = /^([A-Z][A-Za-z ]{1,24}):\s+(.+)$/.exec(line);
    if (kv) return `<p style="margin:6px 0"><span style="color:#8b8fa8">${esc(kv[1])}:</span> <b${/password|ticket/i.test(kv[1]) ? ' style="font-family:Consolas,monospace;font-size:16px"' : ''}>${bold(esc(kv[2]))}</b></p>`;
    return `<p style="margin:0 0 10px;line-height:1.55">${links(bold(esc(line)))}</p>`;
  }).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0;background:#f3f4fb;font-family:'Segoe UI',Arial,sans-serif;color:#1c1d2e">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4fb;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #eceef5">
<tr><td style="background:#1e4b8f;padding:18px 24px;color:#ffffff;font-size:16px;font-weight:700;border-bottom:4px solid #f29a1f">ONE Desk${campus ? `<span style="font-weight:400;opacity:.85"> · ${esc(campus)}</span>` : ''}</td></tr>
<tr><td style="padding:24px 24px 10px">${ref && !/^(ONE Desk|Digest)$/.test(ref) ? `<div style="font:700 12px Consolas,monospace;color:#8b8fa8;letter-spacing:.5px">TICKET ${esc(ref)}</div>` : ''}
<h1 style="font-size:20px;line-height:1.3;margin:6px 0 16px">${esc(title)}</h1>${html}</td></tr>
<tr><td style="padding:14px 24px;background:#fafbfe;color:#8b8fa8;font-size:12px;line-height:1.5">Automated message from the St. Mary's Group service desk. Please don't reply to this email; use the ticket link to add a note.</td></tr>
</table></td></tr></table></body></html>`;
}

// The guide section's words (the requestor guide is served by the app at /guide/requestor.html).
const GUIDE_COPY = {
  requestor: { title: 'New to ONE Desk?', text: 'See how to raise and track a ticket, step by step, in 2 minutes. In English with a voice that reads it out, or in Telugu.', label: 'Open the guide' },
};
// Photos in an email: linked pictures 120 px wide that wrap on a phone; a tap opens the full photo.
const photosHtml = list => list.map((p, i) => `<a href="${esc(p.url)}" style="display:inline-block;margin:4px 8px 4px 0;text-decoration:none"><img src="${esc(p.url)}" width="120" alt="${esc(p.name || `Photo ${i + 1}`)}" style="display:block;width:120px;max-width:120px;height:auto;border:1px solid #eceef5;border-radius:10px"></a>`).join('');
// Designed sections (email-safe tables, inline styles).
const sectionTitle = t => `<p style="margin:22px 0 8px;font-size:12px;font-weight:700;letter-spacing:.6px;color:#8b8fa8;text-transform:uppercase">${t}</p>`;
const BLOCK_HTML = {
  progress(p) {
    const st = p.status, C = { done: '#1e4b8f', open: '#1e4b8f', hold: '#f59e0b', ok: '#1a9a56', bad: '#ef4444', todo: '#d6d8e6' };
    const steps = st === 'rejected' ? [['Received', 'done'], ['Not accepted', 'bad']]
      : [['Received', st === 'open' ? 'open' : 'done'], ['In progress', st === 'in_progress' ? 'open' : st === 'open' ? 'todo' : 'done'], ...(st === 'hold' ? [['On hold', 'hold']] : []), ['Closed', st === 'closed' ? 'ok' : 'todo']];
    const cur = steps.findIndex(s => s[1] !== 'done');
    const cells = steps.map(([label, k], i) => {
      const on = k !== 'todo', isCur = i === cur, mark = k === 'done' || k === 'ok' ? '&#10003;' : k === 'bad' ? '&#10005;' : String(i + 1);
      return `<td align="center" valign="top" style="padding:0 4px;width:${Math.floor(100 / steps.length)}%">
        <div style="width:30px;height:30px;line-height:30px;border-radius:50%;margin:0 auto;font-size:14px;font-weight:700;background:${on ? C[k] : '#ffffff'};color:${on ? '#ffffff' : '#9aa0b4'};border:2px solid ${C[k]}">${mark}</div>
        <div style="margin-top:6px;font-size:12px;font-weight:${isCur ? 700 : 500};color:${isCur ? '#1c1d2e' : on ? '#1e4b8f' : '#9aa0b4'}">${esc(label)}</div></td>`;
    }).join('');
    const tone = { open: ['#e8eff9', '#1e4b8f'], in_progress: ['#e8eff9', '#1e4b8f'], hold: ['#fff3dc', '#a16207'], closed: ['#e3f6ec', '#15803d'], rejected: ['#fde8e8', '#b91c1c'] }[st] || ['#e8eff9', '#1e4b8f'];
    return `${sectionTitle('Progress')}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #eceef5;border-radius:12px;padding:16px 8px 12px"><tr>${cells}</tr></table>
      <p style="margin:10px 0 0;padding:12px 14px;border-radius:10px;background:${tone[0]};color:${tone[1]};font-size:14px;line-height:1.5"><b>What happens next:</b> ${esc(nextStep(p))}</p>`;
  },
  ticket_details(rows) {
    return `${sectionTitle('Ticket details')}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #eceef5;border-radius:12px;border-collapse:separate;overflow:hidden">${rows.map(([k, v], i) =>
      `<tr><td valign="top" style="padding:9px 14px;width:34%;color:#8b8fa8;font-size:13px;${i ? 'border-top:1px solid #f0f1f6;' : ''}">${esc(k)}</td>
       <td valign="top" style="padding:9px 14px;font-size:14px;color:#1c1d2e;${i ? 'border-top:1px solid #f0f1f6;' : ''}${k === 'Ticket' ? 'font-family:Consolas,monospace;font-weight:700;' : ''}">${Array.isArray(v) ? photosHtml(v) : esc(v).replace(/\n/g, '<br>')}</td></tr>`).join('')}</table>`;
  },
  guide(g) {
    const c = GUIDE_COPY[g.kind] || GUIDE_COPY.requestor;
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:18px 0 8px;background:#fff7ea;border:1px solid #f6d9a8;border-radius:12px"><tr><td style="padding:14px 16px">
      <div style="font-size:15px;font-weight:700;color:#1c1d2e">${esc(c.title)}</div>
      <div style="font-size:14px;color:#3a3b4f;line-height:1.5;margin:4px 0 12px">${esc(c.text)}</div>
      <a href="${esc(g.url)}" style="display:inline-block;background:#f29a1f;color:#1c1d2e;text-decoration:none;font-weight:700;padding:10px 18px;border-radius:10px">${esc(c.label)}</a></td></tr></table>`;
  },
  timeline(items) {
    return `${sectionTitle('Latest updates')}<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${items.map(e =>
      `<tr><td valign="top" style="width:14px;padding-top:6px"><div style="width:10px;height:10px;border-radius:50%;background:#1e4b8f"></div></td>
       <td style="padding:0 0 14px 10px;border-left:0"><div style="font-size:12px;color:#8b8fa8">${esc(e.at)}</div><div style="font-size:14px;font-weight:700;color:#1c1d2e">${esc(e.label)}</div>
       ${e.body ? `<div style="font-size:14px;color:#3a3b4f;line-height:1.5;margin-top:2px">${esc(e.body).replace(/\n/g, '<br>')}</div>` : ''}${e.photos?.length ? `<div style="margin-top:6px">${photosHtml(e.photos)}</div>` : ''}</td></tr>`).join('')}</table>`;
  },
};

// One call to the flow. Returns { ok, status, ms, hint, body }.
export async function postToFlow(cfg, payload) {
  const t0 = Date.now();
  if (!cfg.url) return { ok: false, status: 0, ms: 0, hint: 'No flow URL saved yet.' };
  try {
    const r = await fetch(cfg.url, { method: 'POST', signal: AbortSignal.timeout(20000),
      headers: { 'content-type': 'application/json', 'x-desk-key': cfg.key || '' }, body: JSON.stringify(payload) });
    const body = (await r.text()).slice(0, 300), ms = Date.now() - t0;
    const hint = r.ok ? (r.status === 202 ? 'Accepted. Add a Response step (200) to the flow so failures are reported back.' : 'Delivered to Power Automate.')
      : ({ 401: "The secret key doesn't match the one in the flow's Condition step.", 400: "The flow rejected the data. Check the trigger's JSON schema.",
        404: 'Flow not found. The URL is wrong, or the flow was deleted or turned off.', 403: 'Not allowed. Set "Who can trigger the flow?" to Anyone.',
        429: 'Power Automate is rate-limiting this flow. Try again in a minute.' })[r.status] || `The flow answered ${r.status}. Open the flow's run history for details.`;
    return { ok: r.ok, status: r.status, ms, hint, body };
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - t0, hint: e.name === 'TimeoutError' ? 'No answer within 20 seconds.' : `Could not reach the URL (${e.message}).` };
  }
}
