// Make SUPER_ADMIN_EMAIL a super admin with a fresh temporary password, from the server's shell. It always works, even when
// email does not:
//   npm run add-super-admin
// The account: the email given (npm run add-super-admin -- you@org), else SUPER_ADMIN_EMAIL from .env, else the built-in owner
// (sriram@smru.edu.in). Optional SUPER_ADMIN_NAME / SUPER_ADMIN_PASSWORD from .env. It then
//   1. creates the account, or makes the existing one an active super admin, with a temporary password
//      (SUPER_ADMIN_PASSWORD if set, else a generated one); the first sign-in must choose a new password,
//   2. prints the temporary password here (only someone with access to this server sees it),
//   3. emails it through the Power Automate flow saved on the Email page and says whether that worked, and why not,
//   4. lists the last emails ONE Desk tried to send to that address, with their status.
// Also the way back in after a forgotten super admin password.
import crypto from 'node:crypto';
import { pool, uid, one, all, run, insert, hashPw, now } from './db.js';
import { loadSettings, mailConfig, renderTemplate, renderEmail, toText, postToFlow } from './mailer.js';

const email = String(process.argv[2] || process.env.SUPER_ADMIN_EMAIL || process.env.OWNER_EMAIL || 'sriram@smru.edu.in').trim(), given = String(process.env.SUPER_ADMIN_PASSWORD || '');
const name = String(process.env.SUPER_ADMIN_NAME || '').trim() || 'Super admin';
const done = async (msg, ok = true) => { console.log(msg); await pool.end(); process.exit(ok ? 0 : 1); };
if (!/^\S+@\S+\.\S+$/.test(email)) await done('Set SUPER_ADMIN_EMAIL in .env (or run: npm run add-super-admin -- you@example.com).', false);
if (given && given.length < 10) await done('SUPER_ADMIN_PASSWORD is shorter than 10 characters. Remove it to have one generated.', false);

const pw = given || crypto.randomBytes(6).toString('base64url').replace(/[-_]/g, 'x') + Math.floor(10 + Math.random() * 90);
const u = await one('SELECT * FROM users WHERE lower(email)=lower(?)', email);
if (u) await run("UPDATE users SET role='super_admin', tenant_id=NULL, password_hash=?, is_active=1, must_change_pw=1, temp_pw_hash=NULL, temp_pw_expires=NULL WHERE id=?", hashPw(pw), u.id);
else await insert('users', { id: uid(), tenant_id: null, name, email, role: 'super_admin', password_hash: hashPw(pw), is_active: 1, must_change_pw: 1 });
const acct = await one('SELECT * FROM users WHERE lower(email)=lower(?)', email);

await loadSettings();
const cfg = mailConfig(process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 4300}`), login = `${cfg.base}/#/login`;
console.log(`\n${email} is ${u ? 'now' : 'created as'} an active super admin.\n\n  Sign in:            ${login}\n  Temporary password: ${pw}\n\nThe first sign-in asks for a new password. Then the super admin sees every campus (switch at the top) and manages them under More → Tenants.\n`);

// the email, sent right now (not through the server's queue) so the result shows here
const vars = { staff_name: acct.name, staff_email: acct.email, temp_password: pw, campus: 'ONE Desk', role_name: 'Super admin', services: 'All campuses', login_link: login };
const { subject, body } = renderTemplate(cfg, 'password_reset', vars);
if (!cfg.url) console.log('Email NOT sent: no Power Automate flow is connected (Email page → Connection). Use the password above.');
else if (!cfg.sending) console.log('Email NOT sent: sending is paused on the Email page. Use the password above.');
else {
  const r = await postToFlow(cfg, { to: acct.email, subject, html: renderEmail({ subject, body, campus: '' }), text: toText(body) });
  await insert('notifications', { id: uid(), tenant_id: null, recipient: acct.email, template_key: 'password_reset', subject, body: body.replace(pw, '••••••'),
    html: null, text_body: null, status: r.ok ? 'sent' : 'failed', sent_at: r.ok ? now() : null, attempts: 1, last_error: r.ok ? null : `${r.status || 'network'}: ${r.hint}`, created_at: now() });
  console.log(r.ok ? `Email handed to Power Automate (${r.status}). Not in the inbox in a few minutes? Check spam, then the flow's run history in Power Automate.`
    : `Email FAILED: ${r.hint}${r.body ? `\n  Flow answered: ${r.body}` : ''}\nUse the password above, then fix the flow on the Email page.`);
}
const recent = await all('SELECT created_at, template_key, status, last_error FROM notifications WHERE lower(recipient)=lower(?) ORDER BY created_at DESC LIMIT 6', email);
if (recent.length) console.log(`\nLast emails to ${email}:\n${recent.map(n => `  ${String(n.created_at).slice(0, 16).replace('T', ' ')}  ${n.template_key.padEnd(16)} ${n.status}${n.last_error ? '  (' + n.last_error + ')' : ''}`).join('\n')}`);
await done('');
