# AI connection: Claude in replies, reports and the bot

Date: 2026-11-28. Status: reviewed, awaiting approval.

## Intent

ONE Desk gets one Claude API connection, set up and controlled entirely from the web app by a super admin, with a
separate monthly spend limit for each of the three places that use it:

1. **Replies.** In "Check before sending", the provider's short note becomes a full reply written by Claude from the
   ticket (what the requester described and said since) and the provider's note, in the step's tone. The provider sees
   the suggested reply next to their own note, can edit it or ask for another, and nothing is saved or sent until they
   tap Send.
2. **Reports.** A short written summary, in plain words, on the desk Reports page and at the top of the daily, weekly
   and monthly food feedback emails.
3. **Super Bot.** The staff bot becomes an "ask anything about the campus" assistant. Campus admins and super admins can
   ask any question about their campus's tickets, teams, people, food scores, notices and reports; providers get the
   same assistant limited to what they can already see (their services and tickets escalated to them). It looks things
   up itself, combines them, and answers in natural language, with links to the tickets it mentions.

**Why:** the owner has a small API budget (about $10 a month) and wants it used across the app, with the spend visible
and capped per area, and with everything configured in the app's own settings rather than on the server.

## Goals

- One key, pasted once on an **AI** settings page (super admin only), stored like the Power Automate secret, masked.
- Three independent switches, monthly limits in USD and model choices, one row per area. Spend so far this month shown
  next to each. The owner set $5 a month for each area.
- Every feature falls back to today's behaviour, silently for the end user, when: no key, the switch is off, the
  limit is reached, the API errors, or the call takes too long. Nothing in the app ever depends on the API being up.
- Spend is computed from the tokens the API reports, per call, and stored, so the page and the limits are exact.
- The existing test suite keeps passing with no key (every feature off), and new tests cover the AI paths through a
  stub API server so no real money is spent in tests.

## Non-goals

- No AI in the public student bot. It stays the keyword bot it is today: the owner judged the app's own answers enough
  for requesters, and it needs no login, so it is the easiest place for someone to run up a bill.
- The Super Bot only reads. It never changes a ticket, sends an email or edits a setting.
- No AI anywhere else (ticket forms, notices, canteen, emails other than the report summary).
- No per-campus (tenant) keys or limits. One connection, one set of limits, for the whole installation.
- No streaming UI. Replies and bot answers are short; a single request each.

## Anti-goals (what would make this a failure)

- A student or provider seeing an error, a blank screen or a slower screen because the API was slow or down.
- A bill above the limits. A limit is a hard stop for that area until the next month.
- The Super Bot inventing a ticket status, a date or a rule that is not in the data it was given.
- The Super Bot showing a provider anything outside their services and escalations, or a campus admin anything from
  another campus. Every lookup runs with the same access rules as the screens.
- A suggested reply that promises or claims anything the provider's note and the ticket do not say (a date, a part, a
  cause), drops a name, place, code or link, or adds a greeting or sign-off (the email template supplies those).
- Sending more personal data than needed. Emails and phone numbers are stripped from text before it is sent.

## Constraints

- Node 24, Express, Postgres, plain JS front end; no build step. Official SDK `@anthropic-ai/sdk` (the one new
  dependency).
- Settings live in `app_settings` through the existing `getSettings` / `setSetting` helpers in `mailer.js`.
- The polisher, the bot and the report builders stay as they are and remain the fallback.
- Anthropic bills by UTC calendar month, so "this month" for the limits is the UTC month.
- The README's statement that the polisher and bot send nothing off the server must be corrected to describe what is
  sent when the AI is on.

## Approaches considered

### Where the key lives

- **A. `.env` on the server.** Simplest, but the owner asked for the app's settings UI. Rejected.
- **B. AI page in the app, key in `app_settings` (chosen).** Same pattern as the Email → Connection tab: masked when
  shown, change audited, test button. Takes effect without a restart.

### How the staff bot uses Claude

- **1. Answer from live data only.** Claude names which of the bot's existing answers fits the question, the existing
  code runs that lookup, Claude phrases the result. Cheap and cannot invent facts, but only ever answers the dozen
  questions the bot knows today. Not what the owner asked for ("ask anything", "all kinds of answers").
- **2. Free conversation with tools (chosen).** Claude is given read-only lookup tools over the campus data, each
  already scoped to the signed-in user's access, decides which to call, chains them, and answers. Several calls per
  question, so it gets its own budget and a per-user daily cap.
- The public student bot was considered for option 1 and left out: the owner finds the app's own answers enough there.

### Where the Super Bot's loop runs

- **Anthropic Managed Agents.** Anthropic runs the agent loop and a sandbox; our lookups would be custom tools answered
  by the app. It bills session runtime on top of tokens, keeps session history on Anthropic's side, and adds a round
  trip per lookup. Poor fit for a $5 budget and for lookups that must run inside the app with the user's permissions.
- **Messages API with tool use, loop in the app (chosen).** The app sends the question and the tool list, runs each
  lookup Claude asks for against Postgres with the user's scope, returns the results, and repeats until Claude
  answers. Costs tokens only; the data never leaves except what Claude asked for and was allowed to see.

### Reports summary: when it is generated

- **On every load of the Reports page.** The home page also loads `/reports?days=7` on every visit, so this would
  spend money constantly. Rejected.
- **A separate summary endpoint, called only by the Reports page, cached by the numbers it describes (chosen).** The
  statistics the paragraph is written from are hashed; the same numbers return the stored paragraph, so a quiet day
  costs nothing after the first view. Food emails are generated once a day anyway.

### Model

A model dropdown per area on the AI page: Claude Opus 5.5 (most capable), Claude Sonnet 5.5, Claude Haiku 5.5
(cheapest). **My call, open to change:** default every area to Claude Haiku 5.5 because of the stated budget. Rough
cost per use at Haiku prices: well under a tenth of a cent for a reply, about a third of a cent for a Super Bot
question (several lookups and a longer context), so $5 is roughly 1,500 Super Bot questions or many thousands of
replies. At Sonnet prices a Super Bot question is a few cents, at Opus about 5 cents; the dropdown is there when
quality matters more than volume, and the Super Bot is the row most likely to deserve it.

## The design

### Settings (super admin)

New **AI** item in the admin navigation (super admins only, next to Tenants), route `#/c/ai`. One page, two cards:

```
┌ Claude API ──────────────────────────────────────────┐  ┌ Test ─────────────────────┐
│ [●] Connected · last call 28 Nov, 9:14 PM            │  │ Uses the key in the form, │
│ API key   [ Saved (••••••••ab12). Leave empty… ]     │  │ even before you save.     │
│                                     [ Save ]         │  │ [ Test connection ]       │
└──────────────────────────────────────────────────────┘  │ ✓ Replied in 0.8 s        │
                                                          └───────────────────────────┘
┌ Where it is used · November (UTC) ───────────────────────────────────────────────────────────┐
│ Replies      [on ]  model [Haiku 5.5 ▾]  limit $[ 5.00 ]  spent $0.42 · 128 calls  ▓░░░░░░░ │
│ Reports      [on ]  model [Haiku 5.5 ▾]  limit $[ 5.00 ]  spent $0.10 ·  12 calls  ░░░░░░░░ │
│ Super Bot    [on ]  model [Sonnet 5.5 ▾] limit $[ 5.00 ]  spent $1.20 ·  41 questions ▓▓░░░ │
│ Total this month $1.72 of $15.00                                                   [ Save ]  │
│ When an area reaches its limit it quietly goes back to the built-in behaviour until the 1st  │
│ of next month. Super Bot: at most 60 questions per person a day.                             │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

- Settings keys: `ai_key`, `ai_last_ok_at`, and per area (`replies`, `reports`, `superbot`): `ai_on_<area>`,
  `ai_model_<area>`, `ai_limit_<area>`; plus `ai_superbot_user_daily` (60). Defaults: all off, Haiku everywhere,
  limits $5 each (the owner's figures).
- Endpoints under the existing super-admin router (`/api/mail` today holds the mail config; the AI ones go under a new
  `/api/ai` router with the same `superOnly` guard): `GET /ai/config`, `PUT /ai/config`, `POST /ai/test`,
  `GET /ai/usage` (this month per feature, plus the last 50 calls for the log).
- The key is never returned in full. Saving logs `ai.config` in the audit trail with the key shown as "(changed)".
- Test connection: one tiny request ("Reply with OK") with the form's key on Claude Haiku 5.5; shows the reply time or
  the API's error message in plain words (wrong key, no credit, network).

### Usage and limits

- New table `ai_usage`: `id, created_at, feature, tenant_id, model, input_tokens, output_tokens, cache_read_tokens,
  cache_write_tokens, cost_usd, ok, error`. One row per API call, including failed ones (cost 0).
- Cost is computed from the API's `usage` object with a price table per model held in `ai.js` (input, output, cache
  read, cache write per million tokens), updated by hand when prices change.
- `spent(feature)` = sum of `cost_usd` for the UTC month. Checked **before** every call; if `spent >= limit` the call
  is skipped and the fallback is used. A call that starts under the limit may finish slightly over it; that is the
  accepted tolerance (a fraction of a cent).
- **Super Bot per-person cap (my call).** At most 60 questions per signed-in user per campus day
  (`ai_superbot_user_daily`), so one heavy user cannot spend the team's $5 in an afternoon. Past the cap, the user is
  told plainly: "You have used today's Super Bot questions. The quick answers below still work." and gets the keyword
  bot.
- Every call has a deadline (8 s for a reply, 20 s for a report, 30 s for a whole Super Bot question across all its
  lookups, at most 8 lookups) with SDK retries off; on
  timeout or error the fallback is used and the error is stored in `ai_usage`. One `ai_usage` row per API call; the
  Super Bot row count on the page is questions, the calls are in the log.
- **Outage guard (my call).** After 3 consecutive failures the API is skipped for 5 minutes (one row in `ai_usage`
  notes it), so a bad key or an outage never makes every screen wait for the timeout.
- **Thinking and length.** The 5.5 models think by default. Calls use effort `low`, thinking off where the model allows
  it, and a `max_tokens` large enough that thinking cannot swallow the answer (the prompt controls the answer's
  length). `stop_reason` is checked: `max_tokens` or `refusal` means fallback.

### Module `ai.js`

One module exports: `aiReady(feature)` (key present, switch on, under limit), `aiWriteReply`, `aiSuperBot`,
`aiReportSummary`, `aiTest`, plus `aiConfig` / `aiUsage` for the settings endpoints. It owns the SDK
client (rebuilt when the key changes), the price table, the usage rows and the limit check. No other file touches
the SDK. Text sent to the API passes through one `scrub()` that removes emails and phone numbers.

### Replies

The provider often types a short note ("bulb replaced, done", "part not available, 2 days"). With the AI on, the
preview shows a proper reply written **from the ticket and that note together**: what the requester reported, what the
provider says now, and what happens next, in the step's tone (work started, on hold, resumed, closed, rejected, update).

- In `POST /tickets/:id/preview`, when `aiReady('replies')` and `text_as_is` is not set: call `aiWriteReply({ note,
  step, ticket })`. The ticket context sent is: subject, description, problem label, location, the requester's first
  name, the requester's public notes on this ticket (latest 3, as written), the provider's earlier public replies
  (latest 2), the hold reason and resume-by date when the step is "on hold", and the service and campus names.
  Emails and phone numbers are scrubbed. On any failure or when not ready, the dictionary polisher runs as today.
- Instructions to Claude: write the body of a reply to the requester, 2 to 4 sentences, British English, warm and
  direct, in the language the provider wrote in (Telugu or mixed stays Telugu or mixed). Say what was reported in the
  requester's terms, what the provider's note says was done or is happening, and what the requester should expect or
  do next. **Only** what the provider's note and the ticket say: no promised dates, times, parts or causes the note
  does not give; no apologies the note does not make. Keep every name, place, code, number and link exactly. No
  greeting, no sign-off, no subject line, no markdown: the email template adds those. Return the reply text only.
  `max_tokens` large enough for thinking plus the answer (see Usage and limits).
- Response to the client gains `by: 'ai' | 'rules'` and keeps `original`. The preview sheet, for the AI path, shows
  "Written from the ticket and your note. Check it says what you mean." with two tabs, **Suggested reply** and **My
  note**, above the editable text and the exact email, as today. The rules path keeps its word-by-word fixes list.
  Editing re-renders with `text_as_is`, so the provider's final text is never rewritten again.
- The provider can also tap **Write again** in the sheet to get a fresh suggestion (a new call, counted). At most 3
  per preview.
- Send time is unchanged for notes that went through the preview: the text saved is what the provider approved.
  The provider's own short note is kept in the event's `meta.original`, as the polisher does today, so staff can see
  what was typed.
- **Notes with no preview (my call).** The transfer note and the reopen-request accept/decline note are sent without a
  preview today and are tidied by the dictionary polisher at send time. They stay that way: Claude writes only what
  the provider can see and edit before sending. Any API client that omits `approved` also gets the dictionary polisher.

### Reports

- **Desk:** new `GET /reports/summary` taking the same `days` / `from` / `to` as `/reports`, scoped to the user's
  services like `/reports`. It builds the same `counts`, `by_service` and the daily raised/closed series, hashes them, and returns the stored paragraph
  for that hash if there is one; otherwise asks Claude for 3 to 5 sentences (what moved, what is late, which team is
  busiest, one suggestion) and stores it in a new `ai_cache (hash, text, created_at)`. The Reports page loads it after
  the numbers, into a "In short" card above the chart, and shows nothing if the feature is off or it fails.
- **Food emails:** `buildReport` in `food.js` gets an "In short" paragraph at the top when `aiReady('reports')`,
  written from the summary object (averages, per-meal scores, top issues, top words, up to 10 comments). Cached the
  same way by the numbers; when new ratings arrive between a Power Automate fetch and the 10 PM send the paragraph is
  written again, which is accepted over showing stale numbers.
- Instructions: plain English for a kitchen or facilities team, no markdown, no numbers the data does not contain,
  British spelling. `max_tokens` about 350.

### Super Bot (staff, `POST /bot`)

- **Who:** every signed-in user of the desk. Admins and super admins see the whole current campus (the one the request
  is for). Providers see their services, their sub-services, and tickets escalated to them: the same `scope` the staff
  bot and Home use today. Canteen-only staff get the canteen tools and nothing else.
- **How:** one request per question. Claude gets a system prompt (what ONE Desk is, today's date and campus time, the
  user's name, role and services, the campus's working hours, SLA rules, reopen window and daily limits, and the rule
  that it may only state what the tools returned), the last 6 question-and-answer turns from the panel (text only,
  kept in the browser and sent with the request), the question, and the tools below. The app runs the loop: it
  executes each lookup Claude asks for, returns the rows, and continues until Claude answers or the deadline or
  lookup cap is hit (then a short "I could not finish that one; try a narrower question").
- **Tools (all read-only, all scoped, all returning at most 30 rows, emails and phone numbers scrubbed):**
  - `search_tickets` — filters: status (open, in progress, on hold, closed, rejected, overdue, escalated, queued,
    reopen requested, suggestions), service, priority, location text, free text over subject and description,
    requester name, date range on raised or closed, sort; returns number, subject, status, priority, due, location,
    service, requester first name, people affected, raised and closed dates.
  - `get_ticket` — one ticket by number: everything the ticket page shows, including description, public and internal
    notes (internal only for staff who can see the ticket), hold reason, escalation, reopen requests, attachments count.
  - `count_tickets` — the same filters as `search_tickets`, grouped by service, status, priority, location, day, week
    or requester type; returns counts and averages (hours to close, on-time %).
  - `list_services` — services with providers' names, daily cap, queue waiting, open and overdue counts.
  - `provider_workload` — admins only: per provider, open, overdue, closed this week, Fair Score.
  - `fair_scores` — my own score and parts; admins: the ranking.
  - `food_summary` — food team and admins: ratings per meal, top issues and words, comments, for a date range.
  - `canteen_today` — canteen staff and admins: orders, revenue by cash and UPI, late orders, stock marked out, when the
    canteen is on.
  - `notices` — live notices and policies for the campus or a team.
  - `desk_report` — the same numbers as the Reports page for a range (counts, per service, daily series).
  - `how_it_works` — short, fixed text about a feature of ONE Desk (SLA, queue, hold, escalation, reopen, points,
    duplicates, photos, food, canteen, notices) taken from the app's own copy, so "how does the queue work" needs no
    guessing.
  A tool asked for something outside the user's access returns a tool error saying so, and Claude tells the user that
  part is for admins or another team.
- **Answer:** structured output `{ answer, tickets: [ticket numbers mentioned], follow_ups: [up to 3 short
  questions] }`. The server turns `tickets` into the panel's item links (only numbers that a tool actually returned)
  and `follow_ups` into chips. The answer is plain text, a few sentences or a short list, in the user's language.
- **Fallback:** when the Super Bot is off, over its limit or cap, or fails, the existing keyword staff bot answers,
  with its chips. The panel header reads "Super Bot" with "Ask anything about your campus" when it is on, and the
  existing title when it is not. The public student bot (`publicBot`, `POST /public/:slug/bot`) is untouched.
- **Audit:** every Super Bot question is stored in `ai_usage` with the user, the tools called (names and filters, not
  rows) and the token counts, so a super admin can see who asked what and what it cost. The AI page shows the last 50.

### What the README says

The "no API, nothing leaves the machine" sentences for the polisher and the bot become: "with the AI connection off
(the default) nothing leaves the server; when a super admin turns it on, the provider's note with the ticket's text,
the staff Super Bot question with the rows it looked up, and report statistics are sent to Anthropic's API, with
emails and phone numbers removed. The public student bot never uses the API." Plus a short section on the AI page,
the three areas, the limits and the cap.

### Tests

- Existing `npm test` runs with no key: every path is the old one; all existing checks hold.
- New section in `test/e2e.mjs`: a tiny stub HTTP server playing the Messages API (returns a fixed message with a
  `usage` block; can be told to fail or to sleep). The app is started with `ANTHROPIC_BASE_URL` pointing at it (the SDK
  reads that variable). Checks: config saves and masks the key; test connection reports OK and failure; preview
  returns `by: 'ai'` with the stub text, and the request to the stub carries the ticket's description and the
  requester's note; the rules path when the switch is off; "Write again" makes a new call and stops at 3; the public
  student bot makes no API call even with everything on; report summary is cached (second request, no new usage row);
  a reached limit falls back and the usage row count stops growing; a stub failure falls back.
- Super Bot checks: the stub plays a two-step conversation (asks for `search_tickets`, then answers naming a ticket);
  the app runs the lookup and the answer carries that ticket as an item; a provider's `search_tickets` never returns
  another service's ticket and `provider_workload` returns the access error; an admin gets the campus; the per-person
  daily cap message appears on the 61st question; the 8-lookup cap ends the loop with the "narrower question" text;
  the usage row records the user and tool names.

## Left to the builder

- Exact wording of the three system prompts, the AI page copy, and the error messages in plain words.
- Icons and placement of the "In short" card and the AI nav item within the existing style.
- The hash function and cache size cap for `ai_cache` (keep the last few thousand rows).
- How the stub server is wired into the test harness.
- The exact JSON schemas of the Super Bot tools, as long as the filters above are covered and every query carries the
  user's scope.
