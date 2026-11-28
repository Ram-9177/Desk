# Own Numbers on a Shared Ticket Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every report of a same-day problem gets its own ticket number and link, the provider works one ticket that holds every report, joining happens only on a near-exact match, and the provider can join or split by hand.

**Architecture:** One `tickets` row per problem stays the unit of work, SLA and reporting. Each report is a `ticket_requestors` row that now carries its own number, token and complaint. The public ticket page, the emails and the requester note handlers become per-viewer: staff events for everyone, a student's own notes and photos only for that student. Two new provider actions (join, split) move rows between tickets; a joined-away ticket is closed with `joined_into` set and excluded from every count.

**Tech Stack:** Node 24 (runs on 22), Express, PostgreSQL via `pg` (schema in `db.js`, idempotent), plain JavaScript front end (`public/app.js`), email templates in `mailer.js`, one end-to-end test file `test/e2e.mjs` run with `npm test` against a throwaway database (`TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1/postgres`, `CHROME=<wrapper adding --no-sandbox>` for the screen checks).

**Spec:** `docs/superpowers/specs/2026-11-28-own-numbers-shared-ticket-design.md`

## Global Constraints

- Schema changes go in `db.js` with `ADD COLUMN IF NOT EXISTS` / `CREATE ... IF NOT EXISTS`; backfills use `WHERE ... IS NULL` so a restart is a no-op.
- Ticket numbers come only from `nextTicketNo(tenant)` (`server.js:176`), 4 digits, never reused.
- The public page opens by number alone (`findPublic`, `server.js:607`); never widen what it shows.
- 200 reports at once must still make one ticket: the advisory lock in `createTicket` (`server.js:487`) stays.
- Students never see another student's name, contact, complaint, note or photo, on screen or in email.
- `ticket_events` is append-only (trigger `ev_no_change`): history is copied or summarised, never moved.
- A ticket with `joined_into` set counts nowhere (reports, brief, bot, lists, CSV, points, Fair Score).
- Every email goes through `notify()` and a template in `MAIL_EVENTS`; new keys get a label, `who`, `when`, `vars`, `subject`, `body`.
- Each task ends with `npm test` green (the whole file; there is no per-section runner) and a commit on `claude/sharp-dirac-exxamq`.
- No AI, no outside service, no complaint text leaving the server.

## Review Focus

1. A student who reports twice (same contact) on the same problem gets back the number they already have, never a second one. Test in Task 3.
2. A student's note added from a joiner's page shows on the provider's ticket but not on any other student's page or email. Test in Task 5.
3. A provider join where one person is already on both tickets: no duplicate row, no crash on `UNIQUE (ticket_id, contact)`, that person emailed once. Test in Task 7.
4. The joined-away ticket's old number, opened by its first requestor, shows the survivor's progress under their own number, and the staff list and reports do not count it. Test in Task 7.
5. Split out of a ticket whose priority a provider set by hand leaves that priority alone; split of an auto-raised one lowers it. Test in Task 8.

---

### Task 1: Stricter "Other" matching with filler words stripped

**Files:**
- Modify: `merge.js` (SIMILARITY, problemOf)
- Modify: `server.js:541-549` (findMatch)
- Test: `test/e2e.mjs` (section "Same-day duplicate reports", around line 661, and a new section "Own numbers on a shared ticket" started here)

**Interfaces:**
- Produces: `export const SIMILARITY_STRICT = 0.85` and `export const FILLER = ['is','are','was','the','a','an','my','our','in','at','of','it','its','there','here','please','pls']` in `merge.js`; `export const stripFiller = s => string` (normText applied, filler words removed, single spaces); `problemOf` returns `{ key: 'other:' + stripFiller(typed), label, fuzzy: true }` for "Other" answers.
- Consumes: `normText`, `similarity` already in `merge.js`.

- [ ] **Step 1: Write the failing tests** (new block after the "Same-day duplicate reports" section; it reuses `raise`, `base`, `qHelp`, `oth` from the "Raise form" block, so copy those four one-liners into the new block)

```js
sec('Own numbers on a shared ticket');
{ await stop(); await start();
  const { stripFiller, SIMILARITY_STRICT, similarity } = await import('../merge.js');
  check('filler words go, "not" stays', stripFiller('The fan is not working, please') === 'fan not working' && stripFiller('fan not working') === 'fan not working');
  check('"fan not working" vs "fan is not working" is identical once stripped', similarity(stripFiller('fan not working'), stripFiller('fan is not working')) === 1);
  check('"fan not working" vs "fan making noise" is well under the bar', similarity(stripFiller('fan not working'), stripFiller('fan making noise')) < SIMILARITY_STRICT - 0.2);
  const s1 = (await raise('alpha', { ...base('Stra'), form_data: { [qHelp]: 'Other: Projector is not turning on' } })).data;
  const s2 = (await raise('alpha', { ...base('Strb'), form_data: { [qHelp]: 'Other: projector not turning on!!' } })).data;
  const s3 = (await raise('alpha', { ...base('Strc'), form_data: { [qHelp]: 'Other: projector remote missing' } })).data;
  check('nearly identical "Other" text joins; a different problem in the same place does not', s2.merged && !s3.merged, JSON.stringify([s1, s2, s3]));
```

- [ ] **Step 2: Run the suite, see the new checks fail** (`stripFiller` undefined)

Run: `CHROME=/tmp/claude-0/-home-user-Desk/32dda714-db54-5bdd-b231-d7727c60e425/scratchpad/chrome.sh TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1/postgres npm test 2>&1 | grep -E "✗|passed"`
Expected: the new section's checks ✗, everything else as before.

- [ ] **Step 3: Implement in `merge.js`**: `FILLER`, `stripFiller`, `SIMILARITY_STRICT`; in `problemOf` the "Other" branch uses `stripFiller(typed)` for the key. Keep `SIMILARITY` exported (nothing else should use it after this task; remove the import in `server.js` if unused).

- [ ] **Step 4: Implement in `server.js` `findMatch`**: import `SIMILARITY_STRICT` and use it in both the `pg_trgm` query and the in-process fallback; `typed` is already the stripped key after Step 3.

- [ ] **Step 5: Run the suite**: existing pair at line 661 ("Lost my ID card!!" joins, "water tap leaking" does not) still passes; the new checks pass.

- [ ] **Step 6: Commit** `git commit -am "Same-day reports: typed 'Other' problems join only when nearly identical (filler words dropped, 85% alike)"`

### Task 2: Schema: numbers, tokens and complaints on `ticket_requestors`; `joined_into` on tickets

**Files:**
- Modify: `db.js` (after line 104, the ticket_requestors backfill)

**Interfaces:**
- Produces columns: `ticket_requestors.tenant_id TEXT`, `ticket_no TEXT`, `tracking_token TEXT`, `subject TEXT`, `description TEXT`, `form_data TEXT`, `detached_at TEXT`, `detached_to TEXT`; `tickets.joined_into TEXT`; unique index `tr_no ON ticket_requestors(tenant_id, ticket_no) WHERE ticket_no IS NOT NULL`; index `t_joined ON tickets(joined_into) WHERE joined_into IS NOT NULL`.
- Backfill (one UPDATE ... FROM tickets): every `is_first=1` row with `ticket_no IS NULL` gets the ticket's `tenant_id, ticket_no, tracking_token, subject, description, form_data`. Rows with `is_first=0` get `tenant_id` only; their `ticket_no` stays NULL (they keep working under the shared number).

- [ ] **Step 1: Write the failing test** (in the new section)

```js
  const cols = (await q("SELECT column_name c FROM information_schema.columns WHERE table_name='ticket_requestors'")).map(x => x.c);
  check('ticket_requestors carries number, token and complaint', ['tenant_id','ticket_no','tracking_token','subject','description','form_data','detached_at','detached_to'].every(c => cols.includes(c)));
  const firstRows = await q("SELECT count(*)::int n FROM ticket_requestors WHERE is_first=1 AND (ticket_no IS NULL OR tenant_id IS NULL)");
  check('every first requestor row was backfilled with its ticket number', firstRows[0].n === 0);
```

- [ ] **Step 2: Run, see them fail** (columns missing).
- [ ] **Step 3: Add the DDL and backfill to `db.js`** in the migration block right after line 104, in the same style as the lines above it.
- [ ] **Step 4: Run the suite, see them pass; start the server twice on the same database** (`npm test` does this: it stops and starts several times) to prove idempotence.
- [ ] **Step 5: Commit** `git commit -am "Schema: each report on a ticket can carry its own number, token and complaint; tickets remember what they were joined into"`

### Task 3: A joiner gets their own number and link

**Files:**
- Modify: `server.js:451-537` (createTicket), `server.js:551-564` (joinTicket), `server.js:623-632` (POST /:slug/tickets response)
- Modify: `public/app.js:455-462` (the "Ticket raised" screen copy) and `public/app.js:489` (`knownIssue`)
- Test: `test/e2e.mjs` new section

**Interfaces:**
- Produces: `joinTicket(t, r, b, contact, actor, ts, tenant)` returns `{ ticket, again, count, row }` where `row` is the `ticket_requestors` row (with `ticket_no`, `tracking_token`). `createTicket` returns, for a merged report, `Object.assign(t, { merged: true, affected_count, own_no: row.ticket_no, own_token: row.tracking_token })`.
- Produces: `recount(t, ts, { allowDown = false })` extracted from `joinTicket`: recomputes `affected_count` from non-detached rows, sets priority by `priorityFor` (raises always; lowers only when `allowDown` and `!t.priority_by_staff`), recomputes `due_at`, writes the `priority_changed` event; returns `{ n, priority, due_at }`. Task 7 and 8 call it.
- The first requestor's row insert (line 513) now also stores `tenant_id, ticket_no, tracking_token, subject, description, form_data`.

- [ ] **Step 1: Write the failing tests**

```js
  const own = async (n, extra = {}) => (await raise('alpha', { ...elecBody(n, `${n.toLowerCase()}@own.example.com`), form_data: { loc_block: 'Science block', loc_floor: '1st floor', loc_room: '101', issue: 'Fan' }, ...extra })).data;
  const a1 = await own('Owna'), a2 = await own('Ownb'), a3 = await own('Ownc');
  check('the first report keeps its number; each joiner gets the next number, not the shared one', !a1.merged && a2.merged && a3.merged && a2.ticket_no !== a1.ticket_no && a3.ticket_no !== a2.ticket_no && a2.tracking_token && a2.tracking_token !== a1.tracking_token, JSON.stringify([a1, a2, a3]));
  const rows = await q('SELECT ticket_no, is_first, description FROM ticket_requestors WHERE ticket_id=(SELECT id FROM tickets WHERE tenant_id=? AND ticket_no=?) ORDER BY raised_at', alpha.id, a1.ticket_no);
  check('three rows on one ticket, each with its own number and complaint', rows.length === 3 && rows.map(r => r.ticket_no).join() === [a1, a2, a3].map(x => x.ticket_no).join() && rows.every(r => r.description === 'Something is broken.'));
  const again = await own('Ownb');
  check('the same person reporting again gets the number they already have, no new one', again.ticket_no === a2.ticket_no && (await q('SELECT last_number FROM ticket_counters WHERE tenant_id=?', alpha.id))[0].last_number === Number(a3.ticket_no));
  check("the joiner's email carries their own number and link", (await q("SELECT subject, body FROM notifications WHERE template_key='created' AND recipient='ownb@own.example.com'"))[0]?.subject.includes(`[${a2.ticket_no}]`) && (await q("SELECT body FROM notifications WHERE template_key='created' AND recipient='ownb@own.example.com'"))[0].body.includes(`/t/${a2.ticket_no}?k=${a2.tracking_token}`));
  const burst = await Promise.all(Array.from({ length: 50 }, (_, i) => own(`Many${i}`, { form_data: { loc_block: 'Science block', loc_floor: '1st floor', loc_room: '150', issue: 'Light' } })));
  check('50 at once: one ticket, 50 different numbers', new Set(burst.map(x => x.ticket_no)).size === 50 && (await q("SELECT count(*)::int n FROM tickets WHERE tenant_id=? AND location_key='science block:150'", alpha.id))[0].n === 1);
```
Also change the existing check at line 630 (`a second report … joins it: 2 affected`) so it asserts `d2.ticket_no !== d1.ticket_no` and reads the shared ticket through `tk(d1.ticket_no)`; the later `d3.ticket_no === d1.ticket_no` style checks in that section become `(await q('SELECT ticket_id FROM ticket_requestors WHERE ticket_no=?', d3.ticket_no))[0].ticket_id === (await tk(d1.ticket_no)).id`. Update `'…and every one of them got that ticket number'` (line 677) to "…and 50 different numbers". Update the "confirm mode" checks the same way.

- [ ] **Step 2: Run, see the new and changed checks fail.**
- [ ] **Step 3: Implement** `recount`, the `joinTicket` changes (take `nextTicketNo`, a token from `crypto.randomBytes(24).toString('base64url')`, store subject/description/form_data as JSON string, `tenant_id`), the first-row insert, the `createTicket` merged return, and in `P.post('/:slug/tickets')` return `ticket_no: t.own_no || t.ticket_no, tracking_token: t.own_token || t.tracking_token`. The merged acknowledgement email (line 526) must be built with the joiner's number and link: pass `ticket_no: row.ticket_no, ticket_link: <trackUrl with row number and token>` as extra vars (Task 4 generalises this; here do it inline).
- [ ] **Step 4: Client copy**: in `public/app.js` raise result (line 456) replace `r.merged ? 'Added to the ticket for this problem. Your number is' : 'Ticket raised! Your number is'` with `'Ticket raised! Your number is'`; `knownIssue(n)` text becomes `Known issue: ${n - 1} other${n === 2 ? '' : 's'} reported this too. The team is fixing it as one job. You will get every update by email, under your own number.`
- [ ] **Step 5: Run the suite to green.**
- [ ] **Step 6: Commit** `git commit -am "Same-day reports: every student gets their own ticket number and link; the team still works one ticket"`

### Task 4: Per-person emails

**Files:**
- Modify: `server.js:235-271` (ticketVars), `server.js:566-571` (notifyRequestors), `server.js:278` (trackUrl)
- Modify: `mailer.js:15-29` (VARS), `MAIL_EVENTS` (`created` body unchanged)
- Test: `test/e2e.mjs` new section

**Interfaces:**
- Produces: `trackUrl(t, row = null)` → link with `row.ticket_no`/`row.tracking_token` when a row with a number is given.
- Produces: `ticketVars(t, extra)` additionally returns `_events` (the last 6 public events, each `{ id, event_type, actor_type, requestor_row (from meta), label, at, body, photos }`) and keeps `timeline` as today for staff emails.
- Produces: `requestorVars(t, vars, row)` → a copy of `vars` with `ticket_no`, `ticket_link`, `requestor_name`, `subject` (the row's own, falling back to the ticket's), `description`, `ticket_details` (Ticket / Subject / Description / Photos replaced by the row's own; Photos from attachments whose `event_id = row.event_id`, or the created event for `is_first`) and `timeline` filtered by `visibleTo(row)`; `_events` removed.
- Produces: `visibleTo(row)` → predicate on an event: `event_type !== 'note' && event_type !== 'reopen_requested'` or `actor_type !== 'requestor'` or (`requestor_row ? requestor_row === row.id : !!row.is_first`).
- `notifyRequestors(t, key, vars)` sends `requestorVars(t, vars, row)` per row (non-detached rows only), keeping the 25-recipient async split.

- [ ] **Step 1: Write the failing tests** (use the three-person ticket from Task 3; `act` from line 254)

```js
  const shared = await tk(a1.ticket_no);
  r = await act(shared.id, { to: 'in_progress', note: 'Electrician on the way' });
  const mails = await q("SELECT recipient, subject, body FROM notifications WHERE template_key='status_in_progress' AND ticket_id=? ORDER BY recipient", shared.id);
  check('one status change: three emails, each under its own number', r.status === 200 && mails.length === 3 && mails.find(m => m.recipient === 'ownb@own.example.com')?.subject.includes(`[${a2.ticket_no}]`) && mails.find(m => m.recipient === 'ownc@own.example.com')?.subject.includes(`[${a3.ticket_no}]`));
  check("a joiner's email never carries the first student's name", !mails.find(m => m.recipient === 'ownb@own.example.com').body.includes('Owna'));
```

- [ ] **Step 2: Run, see them fail.**
- [ ] **Step 3: Implement** `trackUrl(t, row)`, `visibleTo`, `requestorVars`, the `_events` addition in `ticketVars`, and the per-row loop in `notifyRequestors`. Replace the inline vars from Task 3 Step 3 with `requestorVars`.
- [ ] **Step 4: Run the suite to green** (the "Same-day duplicate reports" check "a status change emails all 10 requestors, each greeted by name" must still pass).
- [ ] **Step 5: Commit** `git commit -am "Emails to each student on a shared ticket show their own number, link and complaint"`

### Task 5: The public page per viewer: own number, own complaint, own notes

**Files:**
- Modify: `server.js:591-613` (publicTicket, findPublic), `server.js:633-661` (public ticket, notes, reopen routes), `server.js:683-700` (publicBot number lookup)
- Modify: `public/app.js:495-530` (ticketPage)
- Test: `test/e2e.mjs` new section, and the Chrome section

**Interfaces:**
- Produces: `findPublic(slug, no)` → `{ t, viewer, shown_no }`: `t` from `tickets.ticket_no`; else the non-detached `ticket_requestors` row with that `ticket_no` (then `t` is its ticket); if `t.joined_into` is set, follow it (at most 5 hops) and `viewer` becomes the row on the survivor with the same contact as the old ticket's first row, or null. `viewer` null means the first requestor's row (look it up by `is_first=1`). `shown_no` is `normNo(no)` as opened, so a joined-away ticket's number stays in the header.
- Produces: `publicTicket(t, viewer, shown_no)` → as today plus `ticket_no: shown_no || viewer.ticket_no || t.ticket_no`, `mine: viewer.is_first ? null : { subject, description, raised_at, files }` and `events` filtered by `visibleTo(viewer)`; for non-first viewers the `created` event's `files` is `[]`.
- Public notes and reopen handlers take `viewer` and write `meta.requestor_row = viewer.id`, actor `{ type: 'requestor', id: viewer.requestor_id, name: viewer.name }`.
- `publicBot` resolves a number through `findPublic` and answers with the viewer's number.

- [ ] **Step 1: Write the failing tests**

```js
  const pageB = (await api(`/public/alpha/tickets/${a2.ticket_no}`)).data, pageA = (await api(`/public/alpha/tickets/${a1.ticket_no}`)).data;
  check("a joiner's number opens the shared ticket under their own number, with their own complaint", pageB.ticket_no === a2.ticket_no && pageB.status === 'in_progress' && pageB.affected_count === 3 && pageB.mine?.description === 'Something is broken.' && pageA.mine == null);
  await ok('the joiner adds a note from their page', `/public/alpha/tickets/${a2.ticket_no}/notes`, { method: 'POST', body: { body: 'Still not working at 2 pm' } });
  const pA = (await api(`/public/alpha/tickets/${a1.ticket_no}`)).data, pB = (await api(`/public/alpha/tickets/${a2.ticket_no}`)).data, pC = (await api(`/public/alpha/tickets/${a3.ticket_no}`)).data;
  check('the note shows on their page only; staff updates show on all three', pB.events.some(e => e.body === 'Still not working at 2 pm') && !pA.events.some(e => e.body === 'Still not working at 2 pm') && !pC.events.some(e => e.body === 'Still not working at 2 pm') && [pA, pB, pC].every(p => p.events.some(e => e.body === 'Electrician on the way')));
  check('the provider sees the note with the student and their number', (await api(`/tickets/${shared.id}`, { token: T.pavan })).data.events.some(e => e.body === 'Still not working at 2 pm' && e.actor_name === 'Ownb'));
  r = await act(shared.id, { to: 'closed', note: 'Fixed' });
  const closedMails = await q("SELECT recipient, body FROM notifications WHERE template_key='status_closed' AND ticket_id=?", shared.id);
  check("the closed email to the first student does not carry the joiner's note", !closedMails.find(m => m.recipient === 'owna@own.example.com').body.includes('Still not working') && closedMails.find(m => m.recipient === 'ownb@own.example.com').body.includes('Still not working'));
  check('the bot answers a joiner number with that number', (await api('/public/alpha/bot', { method: 'POST', body: { q: a2.ticket_no } })).data.text.startsWith(`Ticket ${a2.ticket_no}`));
  ids.joinerNo = a2.ticket_no; ids.sharedId = shared.id; // for the Chrome screens
```
Chrome section (after line 1506 `requestor ticket page`): `await visit('a joiner\'s own ticket page', '/d/alpha/t/' + <a2 number, saved in ids>, null, '.mine');` (store `ids.joinerNo = a2.ticket_no` in the API section).

- [ ] **Step 2: Run, see them fail.**
- [ ] **Step 3: Implement the server side** (`findPublic`, `publicTicket`, the three public routes, `publicBot`). The reopen handler reads the name from `viewer`, not `requestors`.
- [ ] **Step 4: Implement the client**: in `ticketPage`, when `t.mine` render a card `<div class="card mine"><div class="eyebrow">What you reported</div><p>…description…</p>…thumbs(files)…</div>` between the stub and "What happened"; the `.mine` class gets a light accent background in `public/style.css` next to `.knownissue`.
- [ ] **Step 5: Run the suite to green.**
- [ ] **Step 6: Commit** `git commit -am "A student's ticket page shows the shared progress under their own number, with only their own complaint and notes"`

### Task 6: The provider's Requesters card: numbers, complaints, photos

**Files:**
- Modify: `server.js:1384-1403` (GET /tickets/:id `requestors` query)
- Modify: `public/app.js:836-837` (Requesters card)
- Test: Chrome section

**Interfaces:**
- `requestors` rows now include `ticket_no, description, detached_at, detached_to, identifier, department` (LEFT JOIN `requestors` on `requestor_id`), ordered by `raised_at`.
- Card markup: one `.rqrow` per row: `<span class="mono">#{no}</span> <b>name</b> First-tag · department · identifier`, the complaint text, `thumbs(...)` by `event_id` (created event for `is_first`), and for non-first, non-detached rows on a live ticket a `<button class="btn sm" data-split="{row.id}">Split out</button>`; detached rows show `Split out → #no` linking to `#/c/t/{detached_to}`. The card shows even with one row (so the number is visible).

- [ ] **Step 1: Add the Chrome check** (after line 1510 `provider ticket workspace`): `await visit('workspace: requesters with their own numbers', '/c/t/' + ids.sharedId, tok.pavan, '.rqrow [data-split]');` with `ids.sharedId = shared.id` saved in the API section.
- [ ] **Step 2: Run, see it fail.**
- [ ] **Step 3: Implement the query and the card.** Wire `data-split` buttons to the dialog defined in Task 8 (until Task 8 lands, a `toast('Coming in the next step')` placeholder is acceptable only within this task's commit).
- [ ] **Step 4: Run the suite to green.**
- [ ] **Step 5: Commit** `git commit -am "Workspace: every student on a ticket with their own number, complaint and photos"`

### Task 7: Provider joins another ticket into this one

**Files:**
- Modify: `server.js` (new route after line 1482 `transfer`), `server.js:1317-1336` (ticketQuery), `server.js:1673-1712` (reports), `server.js:302-310` (briefFor), `server.js:1150-1161` (staff bot counts)
- Modify: `mailer.js` (`VARS` + `MAIL_EVENTS`: `joined_into`)
- Modify: `public/app.js` workspace header actions (near line 830 `Transfer`) and the dialog
- Test: `test/e2e.mjs` new section + Chrome

**Interfaces:**
- Produces: `S.post('/tickets/:id/join')` body `{ ticket_no }` → `{ ok: true, moved: n, survivor_no }`. Refusals (400): "Pick the ticket number to join", "That is this ticket", "Different service: A vs B", `Different room: ${t.location} vs ${o.location}` (or "No place on that ticket"), "That ticket is closed or rejected", "That ticket was already joined into #X". Admins and the ticket's providers (anyone `loadTicket` admits) may join.
- Effects, in one `tx`: rows of the other ticket whose contact is not yet on `t` get `ticket_id = t.id, is_first = 0`; the other ticket's attachments get `ticket_id = t.id, event_id = <summary event>`; summary event on `t`: type `joined`, internal, body `Joined #<no> (<n> student(s)): <subject>${description ? ' — ' + description : ''}`, meta `{ joined_ticket_id, joined_ticket_no, moved: n }`; the other ticket: `status='closed', closed_at=ts, closed_by=NULL, joined_into=t.id, queued=0, updated_at=ts`, event `joined_into` (internal, `to: t.ticket_no`); `recount(t, ts)`; `audit(req, 'ticket.join', 'ticket', t.id, { joined: o.ticket_no })`. After the tx: `notify(t, [row.contact], 'joined_into', requestorVars(t, vars, row))` for each moved row with `joined_from: o.ticket_no`.
- Mail event `joined_into`: who Requestor, when "A provider joins their ticket into another for the same problem", vars `[...T, 'joined_from', 'actor_name']`, subject `[{{ticket_no}}] Your ticket is being handled with others`, body: `Hi {{requestor_name}},\nYour ticket {{joined_from}} reports the same problem as others in {{location}}, so the {{service}} team is fixing them as one job. Your number stays **{{ticket_no}}** and you will get every update.\n{{progress}}\n[[View your ticket|{{ticket_link}}]]\nThank you,\n**{{actor_name}}** · {{service}} team\nONE DESK, {{campus}}\n{{ticket_details}}`. `VARS.joined_from = 'Number of the ticket that was joined'`.
- Counts: add `joined_into IS NULL` to `ticketQuery` (`w.push('t.joined_into IS NULL')`), to `inS` in `/reports`, to `w` in `briefFor`, to `scope` in `staffBot`. `GET /tickets/:id` returns `joined_into_no` (the survivor's number) so the workspace can show a banner "Joined into #0001" with a link.
- Client: a `Join ticket…` button with `id="joinbtn"` next to Transfer (desktop header; on the phone in the `tk-bar`), `dlg()` with `<input name="ticket_no">`; on submit `POST /tickets/${id}/join`, toast `Joined #<no>: <n> student(s) moved`, reload. The dialog shows the server's refusal in `#derr` as `dlg` already does.

- [ ] **Step 1: Write the failing tests**

```js
  const j1 = await own('Joina', { form_data: { loc_block: 'Science block', loc_floor: '1st floor', loc_room: '202', issue: 'Fan' } }); // Fan and Light: two problems in one room, two tickets
  const j2 = await own('Joinb', { form_data: { loc_block: 'Science block', loc_floor: '1st floor', loc_room: '202', issue: 'Light' } });
  const j3 = await own('Joinc', { form_data: { loc_block: 'Science block', loc_floor: '1st floor', loc_room: '202', issue: 'Light' } }); // joins j2
  const other = await own('Joind', { form_data: { loc_block: 'Science block', loc_floor: '1st floor', loc_room: '203', issue: 'Light' } });
  const t1 = await tk(j1.ticket_no), t2 = await tk(j2.ticket_no);
  await fails('join refuses a different room', `/tickets/${t1.id}/join`, { token: T.pavan, method: 'POST', body: { ticket_no: other.ticket_no } }, 400, 'Different room');
  await fails('join refuses itself', `/tickets/${t1.id}/join`, { token: T.pavan, method: 'POST', body: { ticket_no: j1.ticket_no } }, 400);
  const both = await own('Joinb', { form_data: { loc_block: 'Science block', loc_floor: '1st floor', loc_room: '202', issue: 'Fan' } }); check('Joinb reports on both tickets (already on the survivor)', both.merged);
  const closedBefore = (await api('/reports?days=1', { token: T.asha })).data.counts.closed_period;
  const jr = await ok('provider joins the Light ticket into the Fan ticket (same room, same service)', `/tickets/${t1.id}/join`, { token: T.pavan, method: 'POST', body: { ticket_no: j2.ticket_no } });
  const t1b = await tk(j1.ticket_no), t2b = await tk(j2.ticket_no);
  check('people moved, one row per person, count and priority recomputed', jr.moved === 1 && t1b.affected_count === 3 && t1b.priority === 'high' && (await q('SELECT count(*)::int n FROM ticket_requestors WHERE ticket_id=? AND contact=?', t1.id, 'joinb@own.example.com'))[0].n === 1);
  check('the joined ticket is closed with no closer, pointing at the survivor', t2b.status === 'closed' && t2b.closed_by === null && t2b.joined_into === t1.id);
  check('the moved student is emailed once, under their own number', (await q("SELECT count(*)::int n FROM notifications WHERE template_key='joined_into' AND recipient='joinc@own.example.com'"))[0].n === 1 && (await q("SELECT subject FROM notifications WHERE template_key='joined_into' AND recipient='joinc@own.example.com'"))[0].subject.includes(`[${j3.ticket_no}]`));
  const oldPage = (await api(`/public/alpha/tickets/${j2.ticket_no}`)).data;
  check("the joined ticket's number opens the survivor under that number", oldPage.ticket_no === j2.ticket_no && oldPage.affected_count === 3 && oldPage.subject === t1.subject);
  check('the joined ticket is out of the list, the CSV and the reports', !(await api('/tickets?status=closed', { token: T.pavan })).data.some(x => x.id === t2.id) && !(await (await fetch(`${API}/tickets.csv?status=all`, { headers: { authorization: 'Bearer ' + T.pavan } })).text()).includes(`"${j2.ticket_no}"`) && (await api('/reports?days=1', { token: T.asha })).data.counts.closed_period === closedBefore);
  check('the provider sees every complaint on the survivor', (await api(`/tickets/${t1.id}`, { token: T.pavan })).data.events.some(e => e.event_type === 'joined' && e.body.includes(`#${j2.ticket_no}`)));
```
Chrome: `await visit('workspace: Join ticket dialog', '/c/t/' + ids.sharedId, tok.pavan, '#joinbtn'); await js("document.querySelector('#joinbtn').click()"); check('…opens with a number field', await js("return !!document.querySelector('dialog[open] input[name=ticket_no]')"));`

- [ ] **Step 2: Run, see them fail.**
- [ ] **Step 3: Implement the route, the counting filters, the mail event, the `joined_into_no` field.**
- [ ] **Step 4: Implement the client button, dialog and banner.**
- [ ] **Step 5: Run the suite to green.** The Fair Score and points queries already exclude `closed_by IS NULL`; confirm with `grep -n "closed_by IS NOT NULL\|closed_by=u.id" server.js`.
- [ ] **Step 6: Commit** `git commit -am "Providers can join a ticket for the same problem and room into another; students keep their numbers; the joined ticket counts nowhere"`

### Task 8: Provider splits a student out

**Files:**
- Modify: `server.js` (new route next to join), `mailer.js` (`split_out` event, `VARS.split_from`)
- Modify: `public/app.js` (the `data-split` handler from Task 6)
- Test: `test/e2e.mjs` new section

**Interfaces:**
- Produces: `S.post('/tickets/:id/requestors/:rid/split')` body `{ note }` (optional) → `{ ok: true, ticket_id, ticket_no }`. Refusals (400): "That is the first requester; split the others instead", "Already split out", "The ticket is closed" (only `MERGEABLE` statuses).
- Effects, in one `tx`: new ticket `nt` with `ticket_no = row.ticket_no`, `tracking_token = row.tracking_token`, `requestor_id = row.requestor_id`, `subject = row.subject || t.subject`, `description = row.description`, `location = t.location`, `form_data = row.form_data || t.form_data`, `priority 'medium'`, `status 'open'`, `channel = t.channel`, `created_at = ts`, `created_date = dayIn(tz, ts)`, `due_at = dueFrom(tenant, ts, targetHours(..., 'medium') * 60, service)`, `location_key/problem_key/problem_label` from `t`, `affected_count 1`; new first row on `nt` (`is_first 1`, `ticket_no NULL`, `tracking_token NULL`, same contact/name/description); old row `detached_at = ts, detached_to = nt.id`; attachments with `event_id = row.event_id` → `ticket_id = nt.id, event_id = <nt created event>`; events: on `nt` `created` with `to: svc.name`, body `Split out of #${t.ticket_no}; first reported ${fmtIST(row.raised_at)}`, meta `{ split_from: t.ticket_no, reported_at: row.raised_at }`; on `t` `split_out` (internal) body `${row.name} (${row.ticket_no}) split out as its own ticket`, meta `{ to_ticket: nt.id }`; `recount(t, ts, { allowDown: true })`; `audit(req, 'ticket.split', 'ticket', t.id, { to: nt.ticket_no })`. After: `notify(nt, [row.contact], 'split_out', ...)`; no `new_ticket` email to providers.
- Mail event `split_out`: who Requestor, when "A provider separates their report from a shared ticket", vars `[...T, 'split_from', 'actor_name', 'note']`, subject `[{{ticket_no}}] Your ticket is now handled separately`, body `Hi {{requestor_name}},\nThe {{service}} team looked at your report and it is a different problem from ticket {{split_from}}, so it now has its own ticket **{{ticket_no}}** with a fresh target of {{due}}.\n> {{note}}\n{{progress}}\n[[View your ticket|{{ticket_link}}]]\nThank you,\n**{{actor_name}}** · {{service}} team\nONE DESK, {{campus}}\n{{ticket_details}}`. `VARS.split_from = 'Number of the shared ticket the report was split out of'`.
- Client: `data-split` → `dlg()` "Split <name> out of #<no>?" with an optional note; on submit POST, toast `Split out as #<no>`, reload.

- [ ] **Step 1: Write the failing tests**

```js
  const rowC = (await q('SELECT id FROM ticket_requestors WHERE ticket_no=?', j3.ticket_no))[0];
  await fails('the first requester cannot be split out', `/tickets/${t1.id}/requestors/${(await q('SELECT id FROM ticket_requestors WHERE ticket_id=? AND is_first=1', t1.id))[0].id}/split`, { token: T.pavan, method: 'POST', body: {} }, 400, 'first');
  const sp = await ok('provider splits Joinc out', `/tickets/${t1.id}/requestors/${rowC.id}/split`, { token: T.pavan, method: 'POST', body: { note: 'Different fixture' } });
  const nt = await tk(j3.ticket_no), t1c = await tk(j1.ticket_no);
  check('the new ticket keeps the number and token, starts its clock now, and the old one drops to 2 at normal priority', sp.ticket_no === j3.ticket_no && nt.tracking_token === j3.tracking_token && nt.status === 'open' && nt.created_at > t1.created_at && nt.due_at > nt.created_at && t1c.affected_count === 2 && t1c.priority === 'medium');
  check('the student is emailed and their page now shows the new ticket', (await q("SELECT 1 FROM notifications WHERE template_key='split_out' AND recipient='joinc@own.example.com'")).length === 1 && (await api(`/public/alpha/tickets/${j3.ticket_no}`)).data.affected_count === 1);
  await ok('provider sets the priority by hand', `/tickets/${t1.id}/priority`, { token: T.pavan, method: 'POST', body: { priority: 'critical' } });
  const rowB2 = (await q("SELECT id FROM ticket_requestors WHERE ticket_id=? AND is_first=0 AND detached_at IS NULL", t1.id))[0];
  await ok('…and splits another out', `/tickets/${t1.id}/requestors/${rowB2.id}/split`, { token: T.pavan, method: 'POST', body: {} });
  check('a priority set by hand is left alone by a split', (await tk(j1.ticket_no)).priority === 'critical' && (await tk(j1.ticket_no)).affected_count === 1);
  await fails('a split-out row cannot be split again', `/tickets/${t1.id}/requestors/${rowC.id}/split`, { token: T.pavan, method: 'POST', body: {} }, 400, 'Already');
```

- [ ] **Step 2: Run, see them fail.**
- [ ] **Step 3: Implement the route and mail event.**
- [ ] **Step 4: Implement the client dialog (replacing the Task 6 placeholder).**
- [ ] **Step 5: Run the suite to green.**
- [ ] **Step 6: Commit** `git commit -am "Providers can split a student's report out of a shared ticket; they keep their number and get a fresh target"`

### Task 9: README and the Email page

**Files:**
- Modify: `README.md` (a short "Same-day duplicate reports" paragraph under "First-time setup" or a new heading): own numbers, the join rule in one sentence, Join and Split, the two new emails.
- Verify: the Email page lists `joined_into` and `split_out` with sample values (it reads `MAIL_EVENTS`; `SAMPLE_STATE` in `mailer.js:139` needs entries `joined_into: 'in_progress', split_out: 'open'` and `SAMPLE` needs `joined_from: '0012', split_from: '0001'`).

- [ ] **Step 1: Chrome check**: `await visit('email page lists the two new events', '/c/email', tok.asha, '[data-key=joined_into]')` (use the selector the Email page already uses per event; read `public/app.js` `emailPage` to pick it).
- [ ] **Step 2: Run, see it fail; add the samples; write the README paragraph.**
- [ ] **Step 3: Run the suite to green; commit** `git commit -am "README and Email page: own numbers on a shared ticket, join and split"`

### Task 10: Whole-flow check in the browser and push

- [ ] **Step 1: Run `npm test` once more from a clean start; expect `N passed, 0 failed`.**
- [ ] **Step 2: Start a throwaway instance** (as in this session: `NODE_ENV=production JWT_SECRET=<40 chars> OWNER_EMAIL= DATABASE_URL=postgres://postgres:postgres@127.0.0.1/onedesk_manual PORT=4411 SUPER_ADMIN_EMAIL=super@example.com SUPER_ADMIN_PASSWORD=SuperSecret123 node server.js`) and with Playwright (`/opt/node-tools/node_modules/playwright`, `chromium.launch()`): raise two reports on the Hyderabad campus for the same room and problem from two emails, open both numbers, sign in as a provider, open the workspace, split one out, join it back, screenshot each screen to the scratchpad and look at them. Fix anything that does not match the mockups in the design conversation (own number on the stub, "What you reported" card, Requesters table, Join dialog, refusal copy).
- [ ] **Step 3: Push** `git push -u origin claude/sharp-dirac-exxamq`.
