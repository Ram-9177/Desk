// Creates the first super admin on an empty database. Credentials come from the environment, never from code:
//   SUPER_ADMIN_EMAIL=you@org SUPER_ADMIN_PASSWORD='…' npm run create-admin
// (The server does the same automatically on first start when both variables are set.)
import { createSuperAdmin } from './bootstrap.js';

const r = createSuperAdmin(process.env.SUPER_ADMIN_EMAIL, process.env.SUPER_ADMIN_PASSWORD);
console.log(r.message); process.exit(r.ok ? 0 : 1);
