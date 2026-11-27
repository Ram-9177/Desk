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

### Add a super admin, or reset a forgotten super admin password

**Built-in owner:** `sriram@smru.edu.in` is always kept an active super admin. On a deploy where that account is missing (or not a super admin), it is created and its temporary password is emailed **and written to the log**; an existing account (e.g. a campus admin) is simply made super admin and keeps its password (`pm2 logs one-desk --lines 30 --nostream`, look for "Temporary password"). It always signs in as super admin. (`OWNER_EMAIL` in `.env` changes or, left empty, turns this off.)

**Quickest, and works even when email doesn't:** on the server,

```bash
cd ~/one-desk && npm run add-super-admin
```

It uses `SUPER_ADMIN_EMAIL` from `.env`, makes that account an active super admin with a fresh temporary password, **prints the password on the screen**, emails it, says whether the email went out (and why not), and lists the last emails sent to that address. Sign in, choose your own password, done.

Or let the app do it on restart:

On the server, put the account in `.env` (never in the repo, which is public) and restart:

```bash
cd ~/one-desk && nano .env      # add:  SUPER_ADMIN_EMAIL=you@example.com   (SUPER_ADMIN_PASSWORD is optional)
pm2 restart one-desk && pm2 logs one-desk --lines 5 --nostream    # expect "Super admin you@example.com: created; the sign-in details were emailed"
```

With only the email, a temporary password is generated and emailed (once; later restarts say "already set up"). Forgot it later? Use **Forgot password?** on the sign-in page: a temporary password, valid 1 hour, is emailed (this works for every staff account). With `SUPER_ADMIN_PASSWORD` too, that account becomes a super admin with that password as a **temporary** one: the sign-in details are emailed to it, and the first sign-in must choose a new password (which is emailed too). Nobody else is changed. Each email + password pair is applied once, so later restarts keep the chosen password; change the line to reset it again. (`npm run add-super-admin` with the same two variables does it without a restart.)

## Add a new campus (tenant)

Super admin → **Tenants → Add**: code (e.g. `VJA`), name, slug (e.g. `vijayawada`). The campus gets its own link `/#/d/<slug>`, its own ticket numbers from 0001, its own people, teams, sub-teams, limits, queue and escalation. A code or slug already in use is refused, so existing campus links never change. Then switch to it (top right) and add People, Services and SLA as below.

## First-time setup in the app

1. Sign in as the super admin (Staff login).
2. **Tenants**: add each campus (code, name, URL slug).
3. Switch to the campus (top right) → **People**: add the campus admin and service providers.
4. **Services**: create each service, pick its form type, set blocks/floors, assign one or two providers, add extra questions.
5. **SLA & points**: confirm working hours, targets per priority and hold reasons.
6. **Email → Connection**: paste the Power Automate flow URL and secret key, set the public address to `https://stmarys-desk.supercxo.ai`, Save, Send test. The **Setup guide** tab has the flow steps and the SPF / DKIM / DMARC records.
7. Put up QR codes: `https://stmarys-desk.supercxo.ai/#/d/<campus-slug>` (or `…?service=CODE` for one service).

## Food & catering: feedback or complaint

Set a service's **form type to Food** (Services → Edit). Tapping it then shows two stacked choices on one screen: **Share feedback** (open by default: the day, the meal, stars, quick tags, a review; no ticket, one rating per meal per device a day) and **Report a problem** (a normal ticket; photos optional; the same category at the same mess on the same day joins one ticket). Meals, serving times, feedback tags and messes / canteens are set per campus under Food scores → Meals, places & tags (Breakfast, Lunch, Dinner until then).

- **Food scores** (staff menu; the food team and admins): today's score per meal, trends, top issues, comments, CSV export, the complaints queue, and for admins the messes / canteens and meal times.
- **Reports** (feedback only) go to the food service's providers at 10:00 PM campus time: daily, weekly on Sunday, monthly on the last day. Charts are PNG images so Outlook shows them. ONE Desk sends them itself through the email connection; set `FOOD_REPORT_AUTOSEND=0` to send them from Power Automate instead.
- **Report endpoints** for Power Automate: `GET /api/reports/food/daily|weekly|monthly?tenant=<slug>&format=json` with the header `X-Report-Key: <FOOD_REPORT_KEY>` return `{ to, subject, html }` (without `format=json`: the HTML itself). Set `FOOD_REPORT_KEY` (a long random value) in `.env`; without it the endpoints answer 503.

## Notice board

Teams post notices for students (Notices in the staff menu): a title, a message, up to 3 files (photos, PDF, Word, Excel; 10 MB each), who it is for, an optional start and end, and an **Important** switch. Campus admins post for any team or the whole campus; a team's providers post for their own team (and its sub-teams). New teams appear in the team list as soon as they are created.

- **Campus page**: a Notice board card (important first, then the latest three; "See all" for the rest; an "I'm" filter).
- **Before a ticket**: when a student picks a team that has a live notice, the notice pops up first with **This answers my question** (no ticket) and **I still need to raise a ticket** (the form). A ticket raised after that carries an internal line "The requester read the notice …".
- Each notice counts how often it was seen, how many found their answer, and how many raised a ticket anyway.

## Replies to requesters

Every public reply (a note, work started, on hold, resumed, closed, rejected) is tidied on this server before the requester sees it (`polish.js`: a British English dictionary, short-forms and four safe typing-slip rules; no API, nothing leaves the machine; names, places, codes, emails and links stay as typed), shown to the provider in **Check before sending** with the exact email, and sent inside a Hi / note / Thank you template signed with the provider's name and team. Ready-made sentences per step are edited on the Email page (whole campus or one team). Brand lines (logo, Learn · Live · Grow, the ONE strip, the welcome message) are edited there too.

## Morning brief and Fair Score

- **Morning brief** (08:30 campus time, working days): campus admins get the whole campus's counts and open tickets; each provider gets their own team's. "Send this campus's brief now" is on the Email page.
- **Fair Score** (SLA & points): providers are ranked against their own team's usual pace, on-time rate, reopens and load, so busy and quiet teams compare fairly. Weights, the minimum number of tickets and the windows are set per campus.

## Mail desk (shared mailboxes: reach@, apply@, hr@ …)

Off unless `MAIL_ENABLED=true`. Off, `mail.js` is not even loaded and ONE Desk is exactly as before. On, it adds:

- **Mail** in the header (`#/c/mail`) for nodal officers, mail managers and admins. Each mail gets a number per campus, like `SMRU-0001`. Every mail the sender gets carries it in the subject (`RE: [SMRU-0001] …`), so both sides quote the same number, and a mail quoting it joins the same thread. Mail is sorted into a lane (Important, Needs reply, Review, Auto-handled, Noise) by your rules first, then the AI. It has a reply target, and replies are sent from the mailbox itself, with 10 seconds to undo.
- **The same Home**: a nodal officer's open mail sits in the same table and counts as their tickets, marked **Mail**.
- **Mailboxes per campus** (5–6 is typical): a super admin adds, re-addresses and deletes them; a campus admin sets each one up. Each mailbox has **any number of nodal officers** (all of them get its mail on their Home and its reminders) and any number of escalation officers, each with an optional backup for leave.
- **Reply targets**: at 75 % the nodal officers get a reminder, at 100 % the escalation officers are told, at 200 % the campus mail managers (or the campus admins). Targets count office hours only and pause on hold.
- **"We received it" replies**: these wait in **Confirm** until someone clicks, unless a mailbox is set to send them by itself. They never go to no-reply senders, auto-responders or mailing lists, and at most one goes to each sender a day.
- **Forward to service**: makes a normal desk ticket with the desk's own form and rules (channel "mail"). The desk sends its usual mails, and the thread shows the ticket's status.

Kept apart from the desk: every mail table is in its own Postgres schema `mail`, and no desk table is changed. The jobs (reading mail, sending, the reply-target tick, renewing the Graph subscription, catch-up every 5 min) run inside the same single process, from a job table in Postgres. There is no Redis and no second process.

`.env` (then `pm2 restart one-desk`):

```bash
MAIL_ENABLED=true
INTEGRATIONS_KEY=<64 hex characters: encrypts the saved Microsoft secret and AI keys; openssl rand -hex 32; keep it, or they must be entered again>
```

**Connections are made on screen** (super admin, Mail → Settings):

- **Microsoft 365 (the mailboxes)**: the Directory (tenant) ID, Application (client) ID and client secret of an Entra app with the Application permissions Mail.ReadWrite and Mail.Send, plus admin consent. **Save and test** signs in and reads a mailbox's inbox, showing each step. The secret is stored encrypted and never shown again. `MS_TENANT_ID`, `MS_CLIENT_ID` and `MS_CLIENT_SECRET` in `.env` still work; details saved on screen take their place.
- **OneDrive (resumes and CVs)**: the account whose OneDrive keeps the files (a shared one such as hr@) and a folder (default `Resumes`). It uses the same app, which also needs Files.ReadWrite.All. **Save and test** opens the drive, makes the folder, and saves and removes a test file.

Microsoft posts new-mail notices to `https://<site>/api/inbound/graph`, which must be reachable over HTTPS (nginx already passes `/api`). The check value for those notices is made automatically (or set `GRAPH_CLIENT_STATE`). AI keys are entered in Mail → Settings → AI providers (super admin) and stored encrypted. Names, phone numbers and emails are masked before any text goes to an AI.

Step-by-step connection (Entra app, permissions, limiting it to the shared mailboxes, first mailbox live) and the full API: [docs/mail-desk.md](docs/mail-desk.md).

Rollout per mailbox: add it (it starts **Off**) → pick the officers → **Shadow** for a week (mail is read and sorted, nothing is sent, officers do not see it yet) → **Live**. On going live, the shadow week's mail is closed, since it was answered in Outlook.

Rollback: set `MAIL_ENABLED=false` and restart. To remove the data too: `psql onedesk -c 'DROP SCHEMA mail CASCADE'`. Desk tickets already made by Forward stay as normal tickets.

## Tests

```bash
npm test
npm run test:mail   # the mail desk, with stand-ins for Microsoft 365 and an AI provider
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
