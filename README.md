# ONE Desk

Service desk for the St. Mary's Group campuses. Requestors raise and track tickets without logging in; service providers work the tickets within a working-hours SLA; admins set up campuses, services, people and emails.

- **Requestors**: raise a ticket (email required), service-specific questions (Location: Block · Floor · Room; Student: Branch · Student ID · Department), photos, track by ticket number, add notes, reopen within 7 days.
- **Service providers**: ticket cards, hold / resume / close / reject / transfer with notes, SLA clock on working hours (09:00–17:00, Mon–Sat by default), hold reasons with their own limits, points.
- **Admins**: campuses, services with form types and question builder, people (add, reset password, deactivate), SLA & points, attention list, reports, audit log.
- **Email**: sent through a Power Automate HTTP flow from the Digital Services mailbox, with editable templates per step (progress tracker, ticket details, latest updates).

Stack: Node.js 24, Express, PostgreSQL (`pg`), plain JavaScript front end. The database holds everything except uploaded photos, which live in `data/uploads/`. Photos are kept as JPEG, PNG, GIF or WebP so every browser and email app shows them: the app shrinks photos to JPEG (at most 1920 px) on the phone before upload, and the server turns HEIC photos (iPhone and many Android cameras) into JPEG with `heic-decode`, which needs nothing installed on the server. The schema is created automatically on start.

## Run locally

Needs Node 24 and a local Postgres (e.g. `brew install postgresql@17 && brew services start postgresql@17`).

```bash
npm install
createdb onedesk
cp .env.example .env      # DATABASE_URL=postgres://localhost/onedesk, SUPER_ADMIN_EMAIL / SUPER_ADMIN_PASSWORD; leave NODE_ENV and HOST empty locally
npm start                 # http://localhost:4300
```

On the first start with an empty database the server creates the super admin from `SUPER_ADMIN_EMAIL` / `SUPER_ADMIN_PASSWORD`. Remove those two lines from `.env` afterwards. (`npm run create-admin` does the same without starting the server.)

## Deploy (https://stmarys-desk.supercxo.ai)

AWS EC2 t3.micro, Ubuntu 26.04: **nginx** (HTTPS via Let's Encrypt) → **pm2** (one Node process) → **PostgreSQL** on the same box.

### 1. AWS

- **Disk**: 20 GB gp3 (the default 8 GB fills up quickly).
- **Elastic IP** attached, so the address survives stop/start.
- **Security group**: inbound 22 (your IP only), 80 and 443 (anywhere). Do **not** open 4300 or 5432.
- **DNS**: an `A` record for `stmarys-desk.supercxo.ai` → the Elastic IP (certbot needs it).

### 2. Server packages

```bash
sudo apt update && sudo apt upgrade -y

# swap: t3.micro has 1 GB RAM shared by Node, Postgres and nginx (skip if `swapon --show` already lists one)
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# Node 24 (Ubuntu's own package is Node 22)
curl -fsSL https://deb.nodesource.com/setup_24.x -o /tmp/nodesource_setup.sh && sudo bash /tmp/nodesource_setup.sh
sudo apt install -y nodejs
sudo npm install -g pm2

# PostgreSQL (Ubuntu 26.04 ships 18), nginx, certbot
sudo apt install -y postgresql nginx certbot python3-certbot-nginx
```

### 3. Database

Postgres listens on localhost only by default; keep it that way.

```bash
DBPW=$(openssl rand -hex 24); echo "Postgres password: $DBPW"   # goes into DATABASE_URL below
sudo -u postgres psql -c "CREATE ROLE onedesk LOGIN PASSWORD '$DBPW'" -c "CREATE DATABASE onedesk OWNER onedesk"
```

### 4. App

```bash
git clone git@github.com:Ram-9177/Desk.git one-desk && cd one-desk
npm ci --omit=dev
cp .env.example .env
sed -i "s/^JWT_SECRET=.*/JWT_SECRET=$(openssl rand -hex 32)/; s/CHANGE_ME/$DBPW/" .env
nano .env                 # set SUPER_ADMIN_EMAIL / SUPER_ADMIN_PASSWORD
chmod 600 .env

pm2 start ecosystem.config.cjs && pm2 logs one-desk --lines 20   # expect "Super admin … created"
pm2 save && pm2 startup   # then run the sudo command it prints, so the app starts on boot
pm2 install pm2-logrotate
```

### 5. nginx + HTTPS

```bash
sudo cp deploy/nginx.conf /etc/nginx/sites-available/one-desk
sudo ln -s /etc/nginx/sites-available/one-desk /etc/nginx/sites-enabled/ && sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d stmarys-desk.supercxo.ai --redirect -m you@example.com --agree-tos -n
```

Certbot renews automatically (systemd timer).

### 6. First sign-in

Sign in at `https://stmarys-desk.supercxo.ai/#/login`, then remove the two `SUPER_ADMIN_*` lines from `.env` and `pm2 restart one-desk`. Never change `JWT_SECRET` (it signs everyone out).

**Update**: `git pull && npm ci --omit=dev && pm2 restart one-desk`. New entries in `provision/` are added on that restart (see below).

**Is it deployed?** Open `https://stmarys-desk.supercxo.ai/api/version`. `commit` is what the running app started from, `on_disk` is what is checked out; `restart_needed: true` means you pulled but have not restarted yet. Compare `commit` with the latest commit on GitHub.

The server refuses to start with `NODE_ENV=production` unless `JWT_SECRET` is set (32+ characters). It listens on `HOST` (127.0.0.1) and trusts `X-Forwarded-For` only from loopback, i.e. nginx, so per-IP rate limits see the real client. Run exactly **one** process (the pm2 file does): the email queue, rate limits and settings cache are in memory.

## First-time setup in the app

1. Sign in as the super admin (Staff login).
2. **Tenants**: add each campus (code, name, URL slug).
3. Switch to the campus (top right) → **People**: add the campus admin and service providers.
4. **Services**: create each service, pick its form type, set blocks/floors, assign one or two providers, add extra questions.
5. **SLA & points**: confirm working hours, targets per priority and hold reasons.
6. **Email → Connection**: paste the Power Automate flow URL and secret key, set the public address to `https://stmarys-desk.supercxo.ai`, Save, Send test. The **Setup guide** tab has the flow steps and the SPF / DKIM / DMARC records.
7. Put up QR codes: `https://stmarys-desk.supercxo.ai/#/d/<campus-slug>` (or `…?service=CODE` for one service).

## Tests

```bash
npm test
```

Needs a local Postgres where you can create databases (default `postgres://localhost/postgres`; override with `TEST_DATABASE_URL`). Starts ONE Desk on a throwaway database, dropped afterwards (no email flow connected, so nothing is sent), runs every role's flow through the API — first-run setup, campuses, services and form types, raising and tracking tickets, hold / close / reject / transfer / reopen, points, escalation, emails and templates, people and password resets, campus isolation — and, when Chrome is installed, loads each screen in headless Chrome and checks for script errors.

## Campus data from files (provision/)

On every start the server reads `provision/*.json` and adds anything missing, then remembers it, so later changes made in the app (renames, removed providers, deleted items) are never undone.

- `provision/hyderabad.json` (in the repo): the St.Mary's University - Hyderabad campus and its 12 services.
- `provision/budampadu.json`, `provision/chebrolu.json` (in the repo): the other two campuses (no services yet).
- `provision/hyderabad.private.json` (**git-ignored**, the repo is public): staff from the nodal officer sheet, who serves which service, each service's escalation person, and the Power Automate email connection (used only if the server has none yet; the Email page stays in charge). Copy it to the server once:

```bash
scp provision/hyderabad.private.json ubuntu@SERVER:~/one-desk/provision/
```

Staff are added as providers who must set their own password; their invite emails are **held**, not sent. Send them from **Email → Delivery log → Send held or failed** (or per person with People → Reset password). Every addition is listed in the Audit log as `provision`.

## Backups

Two things to back up: the **database** and **`data/uploads/`** (photos). The email connection settings and templates are in the database.

```bash
# nightly at 02:00 server time (check `timedatectl`; Ubuntu on EC2 may be UTC or IST): database dump + uploads, kept 14 days
mkdir -p ~/backups && crontab -e
0 2 * * * cd ~/one-desk && pg_dump -Fc "$(grep ^DATABASE_URL .env | cut -d= -f2-)" > ~/backups/onedesk-$(date +\%F).dump && tar czf ~/backups/uploads-$(date +\%F).tgz data/uploads && find ~/backups -mtime +14 -delete
```

Restore: `pg_restore --clean -d "$DATABASE_URL" onedesk-YYYY-MM-DD.dump`. Copy the backups off the server too (S3), or add a daily **EBS snapshot** via Data Lifecycle Manager.
