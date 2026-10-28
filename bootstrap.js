// First-run setup: the one super admin. Everything else (campuses, people, services) is created in the app.
import { uid, one, insert, hashPw } from './db.js';

export function createSuperAdmin(email, password) {
  if (one('SELECT 1 FROM users LIMIT 1')) return { ok: true, message: 'Users already exist; nothing to do.' };
  email = String(email || '').trim();
  if (!/^\S+@\S+\.\S+$/.test(email)) return { ok: false, message: 'Set SUPER_ADMIN_EMAIL to the super admin’s email.' };
  if (String(password || '').length < 10) return { ok: false, message: 'Set SUPER_ADMIN_PASSWORD (at least 10 characters).' };
  insert('users', { id: uid(), tenant_id: null, name: 'Digital Services', email, role: 'super_admin', password_hash: hashPw(password), is_active: 1 });
  return { ok: true, created: true, message: `Super admin ${email} created. Sign in and add your campuses.` };
}
