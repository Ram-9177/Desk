// Add a super admin, or make an existing account one and set its password. Works on a database that already has users.
// Credentials come from the environment, never from code (the repo is public):
//   SUPER_ADMIN_EMAIL=you@org SUPER_ADMIN_PASSWORD='…' SUPER_ADMIN_NAME='Your Name' npm run add-super-admin
// Also the way back in after a forgotten super admin password.
import { pool, uid, one, run, insert, hashPw } from './db.js';

const email = String(process.env.SUPER_ADMIN_EMAIL || '').trim(), pw = String(process.env.SUPER_ADMIN_PASSWORD || '');
const name = String(process.env.SUPER_ADMIN_NAME || '').trim() || 'Super admin';
const done = async (msg, ok = true) => { console.log(msg); await pool.end(); process.exit(ok ? 0 : 1); };
if (!/^\S+@\S+\.\S+$/.test(email)) await done('Set SUPER_ADMIN_EMAIL to the email to sign in with.', false);
if (pw.length < 10) await done('Set SUPER_ADMIN_PASSWORD (at least 10 characters).', false);
const u = await one('SELECT id FROM users WHERE lower(email)=lower(?)', email);
if (u) {
  await run("UPDATE users SET role='super_admin', tenant_id=NULL, password_hash=?, is_active=1, must_change_pw=1 WHERE id=?", hashPw(pw), u.id);
  await done(`${email} is a super admin now, with this temporary password. Sign in at /#/login and choose a new one.`);
}
await insert('users', { id: uid(), tenant_id: null, name, email, role: 'super_admin', password_hash: hashPw(pw), is_active: 1, must_change_pw: 1 });
await done(`Super admin ${email} created. Sign in at /#/login and choose a new password.`);
