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

### AWS EC2 (t3.micro, Ubuntu 24.04) — Docker Compose + Caddy

1. **Instance**: t3.micro, Ubuntu 24.04, 16–20 GB gp3 disk. Attach an **Elastic IP** (so the address survives stop/start).
2. **Security group**: inbound 22 (your IP only), 80 and 443 (anywhere). Do **not** open 4300.
3. **DNS**: point an `A` record for `desk.supercxo.ai` at the Elastic IP *before* the first start (Caddy needs it to get the certificate).
4. **On the server**:

```bash
# 2 GB swap: t3.micro has 1 GB RAM, and builds plus 5-photo uploads can spike memory
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# Docker
curl -fsSL https://get.docker.com | sudo sh && sudo usermod -aG docker $USER && newgrp docker

# App
git clone <repo-url> one-desk && cd one-desk
cp .env.example .env && sed -i "s/^JWT_SECRET=.*/JWT_SECRET=$(openssl rand -hex 32)/" .env
nano .env                 # set SUPER_ADMIN_EMAIL / SUPER_ADMIN_PASSWORD (and DOMAIN if not desk.supercxo.ai)
docker compose up -d --build
docker compose logs -f app   # expect "Super admin … created"
```

5. Sign in at `https://desk.supercxo.ai/#/login`, then remove the two `SUPER_ADMIN_*` lines from `.env` and run `docker compose up -d`. Never change `JWT_SECRET` (it signs out everyone) or delete the `onedesk-data` volume.

**Update**: `git pull && docker compose up -d --build`.

### Node + pm2 (no Docker)

Install Node 24 (`node:sqlite` needs 22.5+), then:

```bash
npm ci --omit=dev
cp .env.example .env      # NODE_ENV=production, JWT_SECRET, SUPER_ADMIN_* for the first start
npm install -g pm2 && pm2 start npm --name one-desk -- start && pm2 save && pm2 startup
```

and Caddy on the host (`/etc/caddy/Caddyfile`):

```
desk.supercxo.ai {
    request_body {
        max_size 40MB
    }
    reverse_proxy 127.0.0.1:4300
}
```

The server refuses to start with `NODE_ENV=production` unless `JWT_SECRET` is set (32+ characters). It trusts `X-Forwarded-For` only from loopback / private addresses (the proxy), so per-IP rate limits see the real client.

## First-time setup in the app

1. Sign in as the super admin (Staff login).
2. **Tenants**: add each campus (code, name, URL slug).
3. Switch to the campus (top right) → **People**: add the campus admin and service providers.
4. **Services**: create each service, pick its form type, set blocks/floors, assign one or two providers, add extra questions.
5. **SLA & points**: confirm working hours, targets per priority and hold reasons.
6. **Email → Connection**: paste the Power Automate flow URL and secret key, set the public address to `https://desk.supercxo.ai`, Save, Send test. The **Setup guide** tab has the flow steps and the SPF / DKIM / DMARC records.
7. Put up QR codes: `https://desk.supercxo.ai/#/d/<campus-slug>` (or `…?service=CODE` for one service).

## Tests

```bash
npm test
```

Starts ONE Desk on a throwaway database (no email flow connected, so nothing is sent), runs every role's flow through the API — first-run setup, campuses, services and form types, raising and tracking tickets, hold / close / reject / transfer / reopen, points, escalation, emails and templates, people and password resets, campus isolation — and, when Chrome is installed, loads each screen in headless Chrome and checks for script errors.

## Backups

Back up the `data/` folder (or the `onedesk-data` volume) daily. It holds the database, uploaded photos and the email connection settings. Simplest on EC2: a daily **EBS snapshot** via Data Lifecycle Manager. For a file copy, stop the app first (`docker compose stop app`) so the SQLite WAL is flushed, copy, then start it again.
