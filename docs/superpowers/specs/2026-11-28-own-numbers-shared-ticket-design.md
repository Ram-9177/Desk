# Own ticket numbers on a shared ticket, and stricter joining

Date: 28 November 2026. Status: draft for approval.

## Intent

When many students report the same problem (a fan in Room 203, a tap in the hostel), the service provider should work **one ticket** that holds every student's complaint, photos and notes, instead of a flood of separate tickets. Each student should still get **their own ticket number and link**, so they never share a number with anyone else. Reports should join a ticket **only when the match is near certain**; a wrong join is worse than a missed one.

## What exists today

`merge.js` and the raise handler in `server.js` already join same-day reports: same campus, same service, same place (`location_key`: building + room, or the typed place), same calendar day (campus time), ticket still open / in progress / on hold, and the same problem (`problem_key`: the service's first dropdown answer, or for "Other" the typed words at 60% trigram similarity). Joiners get a `ticket_requestors` row (name, contact, photo, `is_first`), an internal "Also reported by …" event with their description, and the **same ticket number**. `affected_count` raises priority (3+ High, 10+ Urgent). Every status change emails every requestor by name (`notifyRequestors`). The provider card shows "+ N more"; the workspace shows a Requesters list. A "confirm" merge mode asks the student "Same issue?" first. There is no way for a provider to join or split by hand.

## Goals

1. Every report gets its own ticket number and tracking link, whether it opens a ticket or joins one.
2. The provider sees one ticket per problem with all complaints, photos and notes on it.
3. Automatic joining only on a near-exact match (rules below). Anything else is a new ticket.
4. The provider can join two tickets, or split a report out, by hand, and the students concerned are told.

## Non-goals

- No AI or outside service decides a join. No complaint text leaves the server.
- No change to SLA, points, Fair Score, reports, CSV or the bot beyond keeping them correct (they keep counting one ticket per problem, with `affected_count` people).
- No cross-day joining; "Also close earlier open tickets" stays as it is.

## Anti-goals (what would make this a failure)

- Two different problems, or two different rooms, on one ticket.
- A student opening their number and seeing another student's name, email or complaint.
- A joiner whose emails stop, or who gets emails about a ticket they were split away from.

## Constraints

- Postgres schema is created and migrated in `db.js` on start; migrations must be idempotent (`IF NOT EXISTS`, backfills with `WHERE NOT EXISTS`).
- Ticket numbers are per campus, 4 digits, from `ticket_counters` (`nextTicketNo`), unique per tenant (`t_no` index).
- The public ticket page opens by number alone (`findPublic` does not check the `k=` token today). Keep that behaviour; do not widen what it shows.
- Single Node process; 200 reports at once must still make one ticket (the advisory lock in the raise handler stays).
- The email queue, templates and `[[link]]` syntax in `mailer.js` are the only way students are told anything.

## Approaches considered

**A. One ticket, many numbers (chosen).** Keep one `tickets` row per problem. Each joining report gets its own number from the same counter, stored on its `ticket_requestors` row, plus its own tracking token. The public page resolves a number to either a ticket or a joiner row and shows the shared ticket's progress. Smallest change; reports, SLA and counts unchanged.

**B. Every report is a ticket, grouped under a parent.** Clean on paper, but every status change, SLA clock, report, CSV, bot answer and Fair Score must learn about parents and children, with double counting a constant risk. Two to three times the work for the same screens. Dropped.

**C. Keep the shared number, show "you are 5th in line".** No schema change, but not what was asked, and a mistyped digit lands on someone else's ticket. Dropped.

## Design

### 1. Joining rule (replaces the 60% bar)

A report joins an existing ticket only when **all** of these hold:

- same campus, same service (sub-team counts as its own service, as today);
- same `location_key` (building + room for location forms, same mess for food, same typed place for simple forms, normalised as today: "Room no. 203", "#203", "203 room" are one room);
- same calendar day in campus time, ticket status in `MERGEABLE`;
- same problem: the dropdown answer matches exactly (after `normText`), **or** both are "Other" and the typed text is nearly identical: trigram similarity at or above a new `SIMILARITY_STRICT = 0.85` (both the `pg_trgm` path and the in-process fallback use it). "fan not working" vs "fan is not working" joins; "fan not working" vs "fan making noise" does not.
- Services with no dropdown, and reports with no place, never join (as today).

Everything else makes a new ticket. The "confirm" merge mode (ask the student "Same issue?") stays available and keeps its meaning.

### 2. Own number per report

- `ticket_requestors` gains `ticket_no TEXT`, `tracking_token TEXT`, `description TEXT`, `detached_at TEXT`, `detached_to TEXT` (the ticket a split created). A unique index on `(tenant_id, ticket_no)` across both tables is not possible in one index; instead `ticket_requestors.ticket_no` is unique per ticket's tenant via a unique index on `(ticket_no, ticket_id)` plus the counter guaranteeing no reuse. Backfill: the `is_first` row of every ticket copies the ticket's number and token; existing joiners without a number keep working under the shared number (the public lookup falls back to the ticket).
- `joinTicket` takes the next number from `nextTicketNo(tenant)` for the joiner and a fresh token. The joiner's acknowledgement email and the "Ticket raised" screen show **their own number**, plus "This problem was already reported by N others; you will get the same updates."
- The idempotency guard (same submission twice) must return the same joiner number, not take a second one: look up `ticket_requestors` by `(ticket_id, contact)` first, as `joinTicket` already does.

### 3. Public ticket page by a joiner's number

- `findPublic(slug, no)` tries `tickets.ticket_no`, then `ticket_requestors.ticket_no` (not detached). A joiner's page renders the **shared ticket's** status, timeline (public events only, as now), due time and queue, with the joiner's own number in the header, their own complaint text at the top ("What you reported"), and the people count ("N students reported this"). Never other students' names, contacts or complaints.
- A note added from a joiner's page is recorded as that person's note (actor name = the joiner), visible to the provider on the shared ticket, and emails the providers as today.
- Reopen from a joiner's page works like the first requestor's (one reopen request per ticket, as today).

### 4. Provider's workspace

- The Requesters card lists every person with **their number**, their complaint and their photos (today only name and photo). Each row has **Split out** (below).
- Card and list keep "#0001 · subject · N students".
- **Join another ticket into this one**: an action on the workspace, "Join ticket…", that takes a ticket number of the same campus and service. Allowed only when both are in `MERGEABLE`, same service, same `location_key`; the server refuses anything else with a plain message ("Different room: Room 203 vs Room 204"). The joined ticket's requestors move to this ticket keeping their own numbers; the joined ticket is closed with an event "Joined into #0001" and its own `ticket_no` keeps opening the public page, which now shows the surviving ticket. Every moved student is emailed once ("Your ticket 0007 is being handled together with #0001").
- **Split out**: on a requestor row, "Not the same problem, split out". The server creates a new open ticket for that person from their stored complaint (subject, description, form data, photos re-linked), keeping **their existing number** as the new ticket's number, marks the row `detached_at/detached_to`, recomputes `affected_count` and priority (priority never goes down if a provider set it by hand, as today), adds events on both tickets, and emails the student ("Your ticket 0007 is now handled separately"). The first requestor cannot be split out (split the others instead).
- Both actions are logged in the audit log and allowed for the ticket's providers and admins.

### 5. Emails

- `created` for a joiner: their own number and link; the "Known issue" line stays.
- All status emails to joiners carry their own number in subject and link (`notifyRequestors` passes the row's number and token into the template variables; the template's `{{ticket_no}}` then shows the person's own number).
- New template keys: `joined_into` (moved by a provider join) and `split_out`, editable on the Email page like the others.

### 6. Counts and reports

Unchanged: one ticket per problem, `affected_count` people. A split moves one person from the old ticket's count to a new ticket. A join adds the moved people to the surviving ticket's count. The audit log, CSV ("People affected", "Also reported by") and bot answers read the same fields and need only the number per person where they list people.

### 7. Tests (in `test/e2e.mjs`)

- Joiner gets a new number; the public page by that number shows the shared status and only their own complaint; the first requestor's page is unchanged.
- "Other" text at 85%+ joins, at 60–85% does not (a pair of examples each).
- Same submission twice returns the same joiner number.
- Status change emails each person with their own number.
- Provider join: refused across rooms and services; allowed case moves people, closes the joined ticket, emails each moved student; the joined number still opens a page.
- Split out: new ticket keeps the person's number, counts and priority recomputed, emails sent.
- 50 reports at once still make one ticket and 50 distinct numbers.
- Headless Chrome: the joiner's page, the Requesters card with numbers, Join and Split actions open without script errors.

## Left to the builder

- Exact wording of the two new email templates and the on-screen messages.
- Where "Join ticket…" sits on the workspace (desktop header actions or the More sheet on the phone).
- Whether the joiner's complaint is stored in `ticket_requestors.description` or read back from the merged event; storing it is simpler.
