# AI connection: Claude in replies, reports and the bot

Date: 2026-11-28. Status: draft for approval.

## Intent

ONE Desk gets one Claude API connection, set up and controlled entirely from the web app by a super admin, with a
separate monthly spend limit for each of the three places that use it:

1. **Replies.** In "Check before sending", the provider's note is rewritten by Claude (spelling, grammar, sentence
   form, same meaning) instead of the dictionary polisher. The provider still sees the rewrite next to their original,
   can edit it, and nothing is saved or sent until they tap Send.
2. **Reports.** A short written summary, in plain words, on the desk Reports page and at the top of the daily, weekly
   and monthly food feedback emails.
3. **Bot.** The ONE Desk Bot (students without login, and staff) understands natural questions and answers in natural
   language, in the language the person wrote in, from the same live data it uses today.

**Why:** the owner has a small API budget (about $10 a month) and wants it used across the app, with the spend visible
and capped per area, and with everything configured in the app's own settings rather than on the server.

## Goals

- One key, pasted once on an **AI** settings page (super admin only), stored like the Power Automate secret, masked.
- Three independent switches and three independent monthly limits in USD. Spend so far this month shown next to each.
- Every feature falls back to today's behaviour, silently for the end user, when: no key, the switch is off, the
  limit is reached, the API errors, or the call takes too long. Nothing in the app ever depends on the API being up.
- Spend is computed from the tokens the API reports, per call, and stored, so the page and the limits are exact.
- The existing test suite keeps passing with no key (every feature off), and new tests cover the AI paths through a
  stub API server so no real money is spent in tests.

## Non-goals

- No free-form chat agent with tools (bot option 2). Claude never runs database queries or picks what to look up;
  the existing bot code does the lookups.
- No AI anywhere else (ticket forms, notices, canteen, emails other than the report summary).
- No per-campus (tenant) keys or limits. One connection, one set of limits, for the whole installation.
- No streaming UI. Replies and bot answers are short; a single request each.

## Anti-goals (what would make this a failure)

- A student or provider seeing an error, a blank screen or a slower screen because the API was slow or down.
- A bill above the limits. A limit is a hard stop for that area until the next month.
- The bot inventing a ticket status, a date or a rule that is not in the data it was given.
- A reply rewrite that changes the meaning, adds information, drops a name, place, code or link, or adds a greeting
  or sign-off (the email template already supplies those).
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

### How the bot uses Claude

- **1. Answer from live data only (chosen).** Two small calls per typed question: Claude first names which of the bot's
  existing answers fits the question (and any ticket number, and the language), the existing code runs that lookup,
  then Claude phrases the answer from those facts in the user's language. Links and chips are the existing ones.
  Cheap and cannot invent facts. Tapping a chip skips the AI entirely: the chip text already maps to one answer.
- **2. Free conversation with tools.** Claude decides which lookups to run and chains them. More capable, several
  calls per question, much harder to keep inside a small budget, answers less predictable for students. Deferred.

### Reports summary: when it is generated

- **On every load of the Reports page.** The home page also loads `/reports?days=7` on every visit, so this would
  spend money constantly. Rejected.
- **A separate summary endpoint, called only by the Reports page, cached by the numbers it describes (chosen).** The
  statistics the paragraph is written from are hashed; the same numbers return the stored paragraph, so a quiet day
  costs nothing after the first view. Food emails are generated once a day anyway.

### Model

A dropdown on the AI page: Claude Opus 5.5 (most capable), Claude Sonnet 5.5, Claude Haiku 5.5 (cheapest). **My call,
open to change:** default to Claude Haiku 5.5 because of the stated $10 budget. Rough cost per use at Haiku prices is
well under a tenth of a cent for a reply or a bot question; at Opus prices a bot question is about a cent, so the
dropdown is there if quality matters more than volume.

## The design

### Settings (super admin)

New **AI** item in the admin navigation (super admins only, next to Tenants), route `#/c/ai`. One page, two cards:

```
┌ Claude API ──────────────────────────────────────────┐  ┌ Test ─────────────────────┐
│ [●] Connected · last call 28 Nov, 9:14 PM            │  │ Uses the key in the form, │
│ API key   [ Saved (••••••••ab12). Leave empty… ]     │  │ even before you save.     │
│ Model     [ Claude Haiku 5.5 (cheapest) ▾ ]          │  │ [ Test connection ]       │
│                                     [ Save ]         │  │ ✓ Replied in 0.8 s        │
└──────────────────────────────────────────────────────┘  └───────────────────────────┘
┌ Where it is used · November (UTC) ──────────────────────────────────────────────────┐
│ Replies    [on ]  limit $ [ 3.00 ]   spent $0.42 · 128 calls  ▓▓▓░░░░░░░             │
│ Reports    [on ]  limit $ [ 2.00 ]   spent $0.10 ·  12 calls  ▓░░░░░░░░░             │
│ Bot        [off]  limit $ [ 5.00 ]   spent $0.00 ·   0 calls  ░░░░░░░░░░             │
│ Total this month $0.52 of $10.00                                        [ Save ]     │
│ When an area reaches its limit it quietly goes back to the built-in behaviour until  │
│ the 1st of next month.                                                               │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

- Settings keys: `ai_key`, `ai_model`, `ai_on_replies`, `ai_on_reports`, `ai_on_bot`, `ai_limit_replies`,
  `ai_limit_reports`, `ai_limit_bot`, `ai_last_ok_at`. Defaults: all off, limits 3 / 2 / 5.
- Endpoints under the existing super-admin router (`/api/mail` today holds the mail config; the AI ones go under a new
  `/api/ai` router with the same `superOnly` guard): `GET /ai/config`, `PUT /ai/config`, `POST /ai/test`,
  `GET /ai/usage` (this month per feature, plus the last 50 calls for the log).
- The key is never returned in full. Saving logs `ai.config` in the audit trail with the key shown as "(changed)".
- Test connection: one tiny request ("Reply with OK") with the form's key and model; shows the reply time or the
  API's error message in plain words (wrong key, no credit, network).

### Usage and limits

- New table `ai_usage`: `id, created_at, feature, tenant_id, model, input_tokens, output_tokens, cache_read_tokens,
  cache_write_tokens, cost_usd, ok, error`. One row per API call, including failed ones (cost 0).
- Cost is computed from the API's `usage` object with a price table per model held in `ai.js` (input, output, cache
  read, cache write per million tokens), updated by hand when prices change.
- `spent(feature)` = sum of `cost_usd` for the UTC month. Checked **before** every call; if `spent >= limit` the call
  is skipped and the fallback is used. A call that starts under the limit may finish slightly over it; that is the
  accepted tolerance (a fraction of a cent).
- Every call has a timeout (8 s for replies and bot, 20 s for reports) and no SDK retries beyond one; on timeout or
  error the fallback is used and the error is stored in `ai_usage`.

### Module `ai.js`

One module exports: `aiReady(feature)` (key present, switch on, under limit), `aiRewriteNote`, `aiBotIntent`,
`aiBotPhrase`, `aiReportSummary`, `aiTest`, plus `aiConfig` / `aiUsage` for the settings endpoints. It owns the SDK
client (rebuilt when the key changes), the price table, the usage rows and the limit check. No other file touches
the SDK. Text sent to the API passes through one `scrub()` that removes emails and phone numbers.

### Replies

- In `POST /tickets/:id/preview`, when `aiReady('replies')` and `text_as_is` is not set: call `aiRewriteNote(raw,
  { keep, context })` where `keep` is today's keep-word list (subject, location, requester name, service, campus) and
  `context` is the step (work started, on hold, closed…). On any failure or when not ready, the dictionary polisher
  runs exactly as today.
- Instructions to Claude: tidy spelling, grammar and sentence form in British English; keep the meaning and roughly
  the length; keep every name, place, code, number, email and link exactly; do not add information, greetings or
  sign-offs; return the note only, as plain text. `max_tokens` about 400.
- Response to the client gains `by: 'ai' | 'rules'`. The preview sheet shows "Rewritten by AI, meaning kept" with the
  Corrected / My original tabs as today (the rules path keeps its word-by-word list). Editing in the sheet still
  re-renders with `text_as_is`, so the provider's final text is never rewritten again.
- Send time is unchanged: every public note goes through the preview, so the text saved is what the provider approved.

### Reports

- **Desk:** new `GET /reports/summary` taking the same `days` / `from` / `to` as `/reports`, scoped to the user's
  services like `/reports`. It builds the same `counts` and `by_service`, hashes them, and returns the stored paragraph
  for that hash if there is one; otherwise asks Claude for 3 to 5 sentences (what moved, what is late, which team is
  busiest, one suggestion) and stores it in a new `ai_cache (hash, text, created_at)`. The Reports page loads it after
  the numbers, into a "In short" card above the chart, and shows nothing if the feature is off or it fails.
- **Food emails:** `buildReport` in `food.js` gets an "In short" paragraph at the top when `aiReady('reports')`,
  written from the summary object (averages, per-meal scores, top issues, top words, up to 10 comments). Cached the
  same way, so the Power Automate endpoint and the 10 PM send do not pay twice for the same day.
- Instructions: plain English for a kitchen or facilities team, no markdown, no numbers the data does not contain,
  British spelling. `max_tokens` about 350.

### Bot

- Both `publicBot` and `staffBot` are restructured so that each existing branch has a key (`track`, `raise`,
  `teams`, `limit`, `reopen`, `photos`, `time`, `guide`, `food`, `hello`; staff: `overdue`, `due_today`, `queue`,
  `food`, `hold`, `escalated`, `points`, `no_provider`, `places`, `workload`, `summary`, `open`, `hello`) and a
  one-line description. The keyword matcher stays as the fallback mapping from text to key.
- A chip tap sends the chip text; chips map straight to a key with no API call.
- Typed text, when `aiReady('bot')`: **call 1** `aiBotIntent(q, keys)` returns `{ key, ticket_no, language }` using
  structured output; unknown questions return `key: 'unknown'`. The existing branch for that key runs and yields the
  facts text, items and chips as today. **Call 2** `aiBotPhrase(q, factsText, language)` rewrites the facts text as a
  direct answer to the question, in the user's language (English, Telugu, Hindi or mixed as written), keeping every
  number, date, name and status exactly. Items and chips are passed through untouched. `max_tokens` about 300 each.
- Staff bot facts can include ticket subjects and requester names; the student bot includes the requester's own
  ticket. The question is scrubbed of emails and phone numbers before call 1.
- Any failure at either step returns the keyword bot's answer. The bot panel's subtitle changes from "Answers from
  ONE Desk itself" to "Answers from ONE Desk's own data" when the AI is on, so nobody is misled about where the text
  comes from.

### What the README says

The "no API, nothing leaves the machine" sentences for the polisher and the bot become: "with the AI connection off
(the default) nothing leaves the server; when a super admin turns it on, the provider's note, the bot question with
the facts used to answer it, and report statistics are sent to Anthropic's API, with emails and phone numbers
removed." Plus a short section on the AI page and the limits.

### Tests

- Existing `npm test` runs with no key: every path is the old one; all existing checks hold.
- New section in `test/e2e.mjs`: a tiny stub HTTP server playing the Messages API (returns a fixed message with a
  `usage` block; can be told to fail or to sleep). The app is started with `ANTHROPIC_BASE_URL` pointing at it (the SDK
  reads that variable). Checks: config saves and masks the key; test connection reports OK and failure; preview
  returns `by: 'ai'` with the stub text and the rules path when the switch is off; a typed bot question goes through
  intent and phrase and keeps items and chips; a chip tap makes no API call; report summary is cached (second request,
  no new usage row); a reached limit falls back and the usage row count stops growing; a stub failure falls back.

## Left to the builder

- Exact wording of the three system prompts, the AI page copy, and the error messages in plain words.
- Icons and placement of the "In short" card and the AI nav item within the existing style.
- The hash function and cache size cap for `ai_cache` (keep the last few thousand rows).
- How the stub server is wired into the test harness.
