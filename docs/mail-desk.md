# Mail desk: connection steps and API

The mail desk handles a campus's shared mailboxes (admissions@, exams@, fees@, hostel@, hr@ …) inside ONE Desk.
It is off unless `MAIL_ENABLED=true`.

- [Part 1: Connection steps](#part-1-connection-steps), once, about 30 minutes
- [Part 2: API](#part-2-api)

---

## Part 1: Connection steps

Who does what:

| Step | Who | Where |
|---|---|---|
| 1–3 | Microsoft 365 admin | entra.microsoft.com, Exchange PowerShell |
| 4 | Whoever runs the server | the server's `.env` |
| 5–8 | ONE Desk super admin | ONE Desk → Mail → Settings |
| 9 | Campus admin | ONE Desk → Mail → Settings |

### 1. Register the ONE Desk app in Entra

1. Open **entra.microsoft.com**. Go to **Identity → Applications → App registrations → New registration**.
2. Fill in:
   - **Name:** `ONE Desk`
   - **Supported account types:** *Accounts in this organizational directory only*
   - **Redirect URI:** leave empty
3. Press **Register**.
4. On the app's **Overview** page, copy:
   - **Application (client) ID**
   - **Directory (tenant) ID** (St. Mary's: `0206568c-1515-49fd-90d4-f6dad0784500`)
5. Go to **Certificates & secrets → Client secrets → New client secret**.
   - Description: `ONE Desk`. Expiry: 24 months. Put a reminder in your calendar a month before it expires.
   - Copy the **Value**, not the Secret ID. It is shown only once.

### 2. Give the app its permissions

1. Go to **API permissions → Add a permission → Microsoft Graph → Application permissions**. Choose *Application*, not *Delegated*.
2. Add:

   | Permission | Why |
   |---|---|
   | `Mail.ReadWrite` | Read new mail, tag it "ONE ✓", and make reply drafts |
   | `Mail.Send` | Send replies from the mailbox itself |
   | `Files.ReadWrite.All` | Keep resumes and CVs in OneDrive. Skip it if OneDrive is not used yet. |

3. Press **Grant admin consent for St. Mary's**. Every permission must show a green tick under *Status*.

### 3. Limit the app to the mailboxes ONE Desk handles (strongly recommended)

Application permissions reach **every mailbox in the organisation**. Limit them to the shared mailboxes, so that ONE Desk can never open a person's own mailbox.

In Exchange Online PowerShell:

```powershell
Connect-ExchangeOnline
# a mail-enabled security group holding only the shared mailboxes ONE Desk handles
New-DistributionGroup -Name "ONE Desk mailboxes" -Type Security -PrimarySmtpAddress onedesk-mailboxes@smru.edu.in
Add-DistributionGroupMember -Identity "ONE Desk mailboxes" -Member reach@smru.edu.in
Add-DistributionGroupMember -Identity "ONE Desk mailboxes" -Member hr@smru.edu.in
# … one line per mailbox (admissions@, exams@, fees@ …)
New-ApplicationAccessPolicy -AppId <Application (client) ID> -PolicyScopeGroupId onedesk-mailboxes@smru.edu.in -AccessRight RestrictAccess -Description "ONE Desk: shared mailboxes only"
# check: the first should say Granted, a person's own mailbox Denied
Test-ApplicationAccessPolicy -Identity reach@smru.edu.in -AppId <Application (client) ID>
Test-ApplicationAccessPolicy -Identity someone.personal@smru.edu.in -AppId <Application (client) ID>
```

- Microsoft also offers the newer *RBAC for Applications* (`New-ManagementScope` and `New-ManagementRoleAssignment`) for the same purpose. Either one works.
- When you add a mailbox to ONE Desk later, add it to this group too. Otherwise its test says "access denied".
- The policy can take up to an hour to apply.
- If OneDrive is used, the OneDrive account (e.g. hr@) must be a real user account with a licence that includes OneDrive. It must also have signed in once, so its OneDrive exists.

### 4. Server: switch the mail desk on

Add to `.env` on the server:

```bash
MAIL_ENABLED=true
INTEGRATIONS_KEY=<64 hex characters>
```

- Make `INTEGRATIONS_KEY` once with `openssl rand -hex 32`.
- Keep it in your password manager. It encrypts the saved Microsoft secret and the AI keys. If it is lost or changed, they must be entered again.

Then:

```bash
pm2 restart one-desk
```

```bash
pm2 logs one-desk --lines 20
```

The log should say `Mail desk on (MAIL_ENABLED=true): Microsoft 365 not connected yet`.

**Notifications:** Microsoft sends new-mail notices to `https://stmarys-desk.supercxo.ai/api/inbound/graph`.
- It must be reachable from the internet over **HTTPS**. The existing nginx already passes `/api` to ONE Desk, so nothing changes there.
- A different public address can be set with `MAIL_NOTIFY_URL`.

**`.env` instead of the screen (optional):** `MS_TENANT_ID`, `MS_CLIENT_ID` and `MS_CLIENT_SECRET` still work. Details saved on screen take their place. `GRAPH_CLIENT_STATE` is made automatically if not set.

### 5. Connect Microsoft 365 (ONE Desk, super admin)

1. Open **ONE Desk → Mail → Settings**. The **Microsoft 365 (the mailboxes)** card is at the top.
2. Paste the **Directory (tenant) ID**, the **Application (client) ID** and the **Client secret** (the Value).
3. Type one mailbox in *Mailbox to test with*, e.g. `reach@smru.edu.in`.
4. Press **Save and test**. Two ticks should appear:
   - Signed in to Microsoft 365 with the app
   - Read the inbox of reach@smru.edu.in: N mails (Mail.ReadWrite works)

If a step shows a cross, see [Troubleshooting](#troubleshooting).

### 6. Connect OneDrive (optional, for resumes and CVs)

1. On the **OneDrive (resumes and CVs)** card, fill in:
   - **OneDrive of:** `hr@smru.edu.in`
   - **Folder:** `Resumes`
2. Press **Save and test**. Four ticks should appear: opened the drive, folder ready, test file saved, test file removed.
3. **Open the folder** shows it in OneDrive.

### 7. AI providers (optional, for sorting)

Go to **Mail → Settings → AI providers → Add AI provider**, once per provider, in order:

| Order | Name | API address | Model | Notes |
|---|---|---|---|---|
| 1 | OpenAI nano | `https://api.openai.com/v1` | `gpt-5-nano` | Reasoning effort `minimal`; tick *takes no temperature* |
| 2 | Groq | `https://api.groq.com/openai/v1` | `llama-3.1-8b-instant` | |
| 3 | xAI | `https://api.x.ai/v1` | the cheapest from its model list | Use a new key: the old one was exposed |

- Press **Test** on each one.
- Without any provider, mail is sorted by your rules only, and anything else waits in **Review**.

### 8. Add the mailboxes (super admin)

Go to **Mail → Settings → Add a mailbox**, once per address, e.g. `admissions@smru.edu.in` with display name `Admissions`.
- A new mailbox starts **Off**.
- Each one belongs to the campus picked at the top.

### 9. Set up each mailbox and go live (campus admin)

On each mailbox's card:

1. **Officers:**
   - Add the **nodal officers**, as many as needed. All of them get its mail on their Home and its reminders.
   - Add one or more **escalation officers**.
   - Optionally, give each a **backup** for leave.
   - Press **Save officers**.
2. **Reply targets:** the default is 450 working minutes (one office day) for *Needs reply / Review*, and 240 for *Important*. Change if needed and press **Save targets**.
3. Fill in the **Display name** and **Signature**. Set **Office hours** if they differ from the campus. Press **Save mailbox**.
4. Press **Test connection**. It should say "Connected: Inbox has N mails".
5. Set **Mode → Shadow** and save.
   - For a week, mail is read and sorted in ONE Desk. Nothing is sent, and officers don't see it yet. Staff keep answering in Outlook.
   - Check the sorting in **Mail** (lanes Important, Needs reply, Review…) and add **Sorting rules** for anything sorted wrongly.
6. Set **Mode → Live** and save.
   - The shadow week's mail is closed, since it was already answered in Outlook.
   - New mail now reaches the nodal officers.
   - "We received it" replies wait in **Confirm auto-replies** until someone clicks, unless *Send by itself* is chosen.

Go live one mailbox at a time.

### Checks after going live

- Send a test mail to the mailbox from a personal address.
- Within about 10 seconds it shows on the nodal officers' Home, numbered `SMRU-0001`.
- Confirm the auto-reply. It arrives as `RE: [SMRU-0001] …`.
- Reply from ONE Desk. The reply arrives in the same conversation, with the number in the subject.
- Press **Forward to service** on a test mail. A normal desk ticket is made, and the desk sends its usual mails.

### Troubleshooting

| Message | Fix |
|---|---|
| Microsoft sign-in failed: AADSTS7000215 (invalid client secret) | Paste the secret's **Value**, not its ID. Make a new secret if it has expired. |
| Microsoft sign-in failed: AADSTS700016 (application not found) | Wrong Application (client) ID, or the app is in another directory. |
| … access denied. Add Mail.ReadWrite and Mail.Send … | Add the permissions (step 2) and press **Grant admin consent**. If the access policy is used, add the mailbox to the group (step 3) and wait up to an hour. |
| … no such mailbox in this Microsoft 365 | Check the address. It must be a mailbox in your Microsoft 365, not an alias of one. |
| … has no OneDrive yet | Sign in once at office.com with that account. Check it has a OneDrive licence. |
| Mailbox card says "not subscribed yet" | The notification address is not reachable over HTTPS. Mail still arrives through the 5-minute catch-up. Check `https://<site>/api/inbound/graph` from outside. |
| A reply says "may or may not have gone" | Microsoft did not confirm the send. Look in the mailbox's Sent Items before sending again. |
| The saved secret cannot be opened (in the log) | `INTEGRATIONS_KEY` changed. Enter the Microsoft secret and AI keys again. |

**Switch it off:** set `MAIL_ENABLED=false` and run `pm2 restart one-desk`. The desk runs as before.
**Remove the data too:** `psql onedesk -c 'DROP SCHEMA mail CASCADE'`. Desk tickets made by Forward stay.

---

## Part 2: API

The mail desk API lives under `https://<site>/api/maildesk/…`. It uses the same sign-in and the same rules as the rest of ONE Desk.

**Sign-in:** call `POST /api/auth/login` with `{ "email", "password" }`. It returns `{ "data": { "token" } }`. Send `Authorization: Bearer <token>` on every call.

**Campus:** a super admin picks the campus with the header `x-tenant-id: <campus id>`. Other staff are always on their own campus.

**Answers:**
- Success: `{ "data": … }`.
- Error: `{ "error": { "code", "message", "details" } }` with HTTP 400, 403, 404, 409 or 429.
- `message` is written for people and can be shown as it is.

**Access:**
- **Admin:** super admin.
- **Manager:** a campus admin, or a mail manager added in Settings.
- **Officer:** a nodal or escalation officer of a mailbox, or their backup.
- **Member:** viewer, replier or hr on a mailbox.
- A mail or mailbox that a person may not see answers **404**, not 403, so its existence is not revealed.
- Every view, reply, confirm, forward and settings change is recorded in `mail.audit_log`.

**Mail numbers:** a mail is addressed by its number, e.g. `SMRU-0001`, in any letter case. An old internal number such as `1001` still works.

### Work

| Method and path | Who | Body / query | Returns |
|---|---|---|---|
| `GET /maildesk/me` | anyone signed in | | `{ role: 'admin'\|'manager'\|'officer'\|null, setup, admin, open, confirm, channels: [{ id, address, display_name, mode, my_roles, member }] }` |
| `GET /maildesk/my-work` | officers | | Rows for the desk Home, in the desk's row shape: `[{ kind: 'mail', id, ref, title, requester, where, status, lane, sla, due_at, responded, updated_at, my_role, link }]` |
| `GET /maildesk/threads` | members | `?status=active\|open\|in_progress\|hold\|closed\|rejected\|forwarded\|all` `&lane=important\|needs_reply\|review\|auto\|noise` `&channel=<id>` `&q=<words or number>` `&mine=1` | `{ threads: [{ ref, subject, requester_email, requester_name, lane, status, sla_state, first_response_due_at, address, preview, n_in, … }], counts: { lane: n } }` |
| `GET /maildesk/threads/:ref` | members | | `{ thread, channel, messages: [{ dir: 'in'\|'out', … }], notes, events, desk, suggested_service, templates, others, can: { work, forward, reply } }` |
| `POST /maildesk/threads/:ref/claim` | officers, repliers | `{ take?: true }` (`take` takes it over from someone else) | `{ ok }`. 409 if someone else has it. |
| `POST /maildesk/threads/:ref/reply` | officers, repliers | `{ body, to?, cc?: [emails], close?: true }`. `to` must be someone who wrote in the mail (default: the sender). | `{ id, send_after, undo_seconds: 10 }` |
| `POST /maildesk/outbound/:id/cancel` | officers, repliers | | Undo within 10 s, or drop a waiting auto-reply. 409 if it has already gone. |
| `POST /maildesk/threads/:ref/status` | officers, repliers | `{ status: 'open'\|'in_progress'\|'hold'\|'closed'\|'rejected', note? }` | `{ ok }` |
| `POST /maildesk/threads/:ref/lane` | officers, repliers | `{ lane: 'important'\|'needs_reply'\|'auto'\|'noise' }` | `{ ok }`. The reply target is worked out again. |
| `POST /maildesk/threads/:ref/notes` | officers, repliers | `{ body }` (internal, never mailed) | `{ ok }` |
| `POST /maildesk/threads/:ref/forward` | officers, repliers | `{ service_id, name?, subject?, description?, location?, form_data?, requestor_type? }`. The same rules as the desk's own ticket form. | `{ ticket_id, ticket_no }`. Forwarding again returns the same ticket. |
| `GET /maildesk/confirm` | officers, repliers | | Auto-replies waiting: `[{ id, ref, subject, requester_email, body_text, their_text, address, stale }]` |
| `POST /maildesk/outbound/:id/confirm` | officers, repliers | `{ body? }` (edited text) | `{ ok }`. It goes after the 10 s undo window. |
| `POST /maildesk/confirm-bulk` | officers, repliers | `{ ids: [...] }` | `{ confirmed, skipped: [{ id, why }] }` |

### Mailboxes (campus)

| Method and path | Who | Body | Notes |
|---|---|---|---|
| `GET /maildesk/settings` | admins, campus admins | | Everything on the Settings screen. Keys are never included. |
| `POST /maildesk/channels` | super admin | `{ address, display_name?, signature?, ack_mode?, default_service_id?, office_hours? }` | Starts **off**, with default reply targets. |
| `PATCH /maildesk/channels/:id` | admins, campus admins | Any of: `mode: 'off'\|'shadow'\|'live'`, `ack_mode: 'approve'\|'auto'`, `display_name`, `signature`, `default_service_id`, `office_hours: { days: [0–6], from: 'HH:MM', to: 'HH:MM' } \| null`, `address` (super admin, only while off) | Live needs at least one nodal officer. Leaving live cancels unsent replies. |
| `PUT /maildesk/channels/:id/officers` | admins, campus admins | `{ officers: [{ user_id, role: 'nodal'\|'escalation', backup_user_id? }] }` | Any number of each. At least one nodal officer. Mail held by someone removed goes back to the officers. |
| `PUT /maildesk/channels/:id/members` | admins, campus admins | `{ members: [{ user_id, role: 'viewer'\|'replier'\|'hr' }] }` | |
| `PUT /maildesk/channels/:id/sla` | admins, campus admins | `{ policies: [{ lane: null\|'important'\|…, first_response_mins, warn_at_pct, escalate_at_pct, second_escalate_at_pct?, business_hours_only?, pause_on_hold? }] }` | Working minutes. Each mail keeps the target it started with. |
| `POST /maildesk/channels/:id/test` | admins, campus admins | | `{ ok, message }` |
| `POST /maildesk/channels/:id/sync` | admins, campus admins | | Checks the inbox for missed mail now. |
| `DELETE /maildesk/channels/:id` | super admin | | Only while off and with no mail. Otherwise 400 or 409. |
| `POST /maildesk/leave` · `DELETE /maildesk/leave/:id` | admins, campus admins | `{ user_id, from_day: 'YYYY-MM-DD', to_day }` | The backup covers during leave. |
| `POST /maildesk/templates` · `PATCH`/`DELETE /maildesk/templates/:id` | admins, campus admins | `{ kind: 'auto_ack'\|'manual'\|'status', name, body, subject?, channel_id?, category?, active? }` | Fill-ins: `{{first_name}} {{name}} {{ref}} {{campus}} {{team}} {{eta}} {{mailbox_name}} {{post}} {{subject}}` |
| `POST /maildesk/rules` · `DELETE /maildesk/rules/:id` | admins, campus admins | `{ match: 'sender'\|'domain'\|'subject_contains'\|'header', value, action: 'noise'\|'important'\|'auto'\|'skip_ai', channel_id? }` | Checked before the AI. |
| `POST /maildesk/routes` · `DELETE /maildesk/routes/:id` | admins, campus admins | `{ category, service_id }` | The service suggested for Forward. |
| `PUT /maildesk/roles` | admins, campus admins | `{ user_id, role: 'manager'\|null }` | Mail managers get the second escalation. |

### Connections and keys (super admin)

| Method and path | Body | Notes |
|---|---|---|
| `GET /maildesk/connections` | | `{ ms365: { connected, source: 'app'\|'env'\|null, tenant_id, client_id, has_secret, notify_url, last_test }, onedrive: { connected, account, folder, web_url, last_test }, permissions }` |
| `PUT /maildesk/connections/ms365` | `{ tenant_id, client_id, client_secret? }` | The secret is sealed (AES-256-GCM) and never returned. Leave it out to keep the saved one. |
| `POST /maildesk/connections/ms365/test` | `{ mailbox? }` | `{ ok, steps: [{ ok, text }], at }` |
| `DELETE /maildesk/connections/ms365` | | Falls back to `.env` keys, if any. |
| `PUT /maildesk/connections/onedrive` | `{ account, folder? }` | Folder `Resumes` by default. |
| `POST /maildesk/connections/onedrive/test` | | Opens the drive, makes the folder, saves and removes a test file. |
| `DELETE /maildesk/connections/onedrive` | | Files already saved stay in OneDrive. |
| `POST /maildesk/integrations` · `PATCH`/`DELETE /maildesk/integrations/:id` | `{ name, baseURL, model, apiKey?, priority?, active?, reasoningEffort?, noTemperature? }` | Any OpenAI-compatible API. Tried in `priority` order. |
| `POST /maildesk/integrations/:id/test` | | `{ ok, message }` |
| `PUT /maildesk/switches` | `{ auto_reply_paused: true\|false }` | Pauses every auto-reply in all mailboxes. |

### For Microsoft only

| Method and path | Notes |
|---|---|
| `POST /api/inbound/graph` | Microsoft Graph's new-mail notices. No sign-in: each notice must carry the subscription's secret check value, or it is ignored. Answers 202 at once; the mail is read in the background. With `?validationToken=…` it echoes the token, which is Graph's check when subscribing. |

### Example: reply to a mail from a script

```bash
TOKEN=$(curl -s https://stmarys-desk.supercxo.ai/api/auth/login -H 'content-type: application/json' \
  -d '{"email":"nita@smru.edu.in","password":"…"}' | jq -r .data.token)
curl -s https://stmarys-desk.supercxo.ai/api/maildesk/my-work -H "authorization: Bearer $TOKEN" | jq '.data[] | {ref, title, sla, due_at}'
curl -s https://stmarys-desk.supercxo.ai/api/maildesk/threads/SMRU-0001/reply -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"body":"Dear Ria,\nThe fee details are on our website.","close":true}'
```
