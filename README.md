# ONE Desk

Service desk for the St. Mary's Group campuses. Requestors raise and track tickets without logging in; service providers work the tickets within a working-hours SLA; admins set up campuses, services, people and emails.

- **Requestors**: raise a ticket (email required), service-specific questions (Location: Block · Floor · Room; Student: Branch · Student ID · Department), photos, track by ticket number, add notes, reopen within 7 days.
- **Service providers**: ticket cards, hold / resume / close / reject / transfer with notes, SLA clock on working hours (09:00–17:00, Mon–Sat by default), hold reasons with their own limits, points.
- **Admins**: campuses, services with form types and question builder, people (add, reset password, deactivate), SLA & points, attention list, reports, audit log.
- **Email**: sent through a Power Automate HTTP flow from the Digital Services mailbox, with editable templates per step (progress tracker, ticket details, latest updates).

Stack: Node.js 24, Express, SQLite (`node:sqlite`), plain JavaScript front end. All data lives in `data/` (database + uploads).

## Run locally

```bash
npm install
cp .env.example .env      # set SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD; leave NODE_ENV empty locally
npm start                 # http://localhost:4300
```

On the first start with an empty database the server creates the super admin from `SUPER_ADMIN_EMAIL` / `SUPER_ADMIN_PASSWORD`. Remove those two lines from `.env` afterwards. (`npm run create-admin` does the same without starting the server.)

## Deploy (https://desk.supercxo.ai)

### Docker

```bash
docker build -t one-desk .
docker run -d --name one-desk --restart unless-stopped -p 127.0.0.1:4300:4300 \
  -v onedesk-data:/app/data \
  -e JWT_SECRET="$(openssl rand -hex 32)" \
  -e SUPER_ADMIN_EMAIL='…' -e SUPER_ADMIN_PASSWORD='…' \
  one-desk
```

After the first sign-in, recreate the container without the two `SUPER_ADMIN_*` variables (keep the same `JWT_SECRET` and volume).

### Node (Ubuntu)

```bash
npm ci --omit=dev
cp .env.example .env      # NODE_ENV=production, JWT_SECRET, SUPER_ADMIN_* for the first start
npm install -g pm2 && pm2 start npm --name one-desk -- start && pm2 save && pm2 startup
```

### HTTPS with Caddy

```
desk.supercxo.ai {
    reverse_proxy 127.0.0.1:4300
}
```

The server refuses to start with `NODE_ENV=production` unless `JWT_SECRET` is set (32+ characters).

## First-time setup in the app

1. Sign in as the super admin (Staff login).
2. **Tenants**: add each campus (code, name, URL slug).
3. Switch to the campus (top right) → **People**: add the campus admin and service providers.
4. **Services**: create each service, pick its form type, set blocks/floors, assign one or two providers, add extra questions.
5. **SLA & points**: confirm working hours, targets per priority and hold reasons.
6. **Email → Connection**: paste the Power Automate flow URL and secret key, set the public address to `https://desk.supercxo.ai`, Save, Send test. The **Setup guide** tab has the flow steps and the SPF / DKIM / DMARC records.
7. Put up QR codes: `https://desk.supercxo.ai/#/d/<campus-slug>` (or `…?service=CODE` for one service).

## Backups

Back up the `data/` folder (or the `onedesk-data` volume) daily. It holds the database, uploaded photos and the email connection settings.
