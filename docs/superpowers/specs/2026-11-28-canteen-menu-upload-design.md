# Canteen menu upload (CSV or Excel)

Status: approved by the owner ("build it") after the field list and flow were described in chat on 28 November 2026.

## Intent

A canteen manager or owner loads a whole menu from a CSV or Excel file instead of adding items one at a time. They pick the file, map its columns to the menu fields, see exactly what will happen, then import. A template and a ready sample menu are downloadable so they can try it.

## Who may do it

Exactly the people who can edit the menu today: `need(req)` in `canteen.js` (`access(req).manage`: the canteen managers, and the campus admins / super admin of a campus whose canteen is on). Counter and kitchen staff and everyone else get 403. The campus is the one in the request (a super admin picks it as usual).

## Fields (what a file column can map to)

| Field | Required | Rule (same as `itemFields`) |
|---|---|---|
| category | no | text up to 60; created when missing; up to 50 categories per campus; an empty cell puts the item under "Uncategorised" |
| name | yes | up to 80 |
| price | yes | rupees, `parsePrice` (accepts `₹`, commas, `40`, `12.50`) |
| description | no | up to 200 |
| is_veg | no | `1/0`, `yes/no`, `y/n`, `true/false`, `veg/non-veg` (any case); default veg |
| sold_out | no | same truthy forms; default 0 |
| active | no | same truthy forms; default 1 |
| sort_order | no | whole number |
| deal_pct | no | 1 to 90 |
| deal_kind | with deal_pct | `discount`, `flash`, `eod` (also accept the labels "Flash sale", "End-of-day sale", case-insensitive) |
| deal_minutes | flash and eod | 5 to 1440 |

Up to 500 items per campus in total (existing cap); a file may hold at most 500 rows and 5 MB.

## Flow

1. Menu tab gets an **Upload menu** button next to Add item / Add category.
2. Dialog step 1: choose a `.csv` or `.xlsx` file; links **Download template** and **Download sample menu**.
3. The server reads the file once and returns the header row, the first 5 rows and every row as plain cells. (CSV: UTF-8 with or without BOM, comma or semicolon or tab delimiter detected, quoted fields; Excel: the first sheet, formulas as their values, a price cell typed as a number is fine.)
4. Step 2 (mapping): one select per menu field listing the file's columns plus "Not in my file"; guessed from header names (case-insensitive, ignoring spaces, underscores and common synonyms: item / item name / dish → name; rate / mrp / amount / cost → price; type / veg → is_veg; section / group → category). `name` and `price` must be mapped to continue. The mapping is remembered in `localStorage` per campus for the next upload.
5. Step 3 (preview): the client applies the mapping and sends the rows to the server with `dry_run: true`; the server validates every row and answers counts and problems: items to add, items to update, categories to create, and a list of rejected rows (row number as in the file, reason). Matching rule: an existing active item with the same name (case-insensitive) in the same category is updated (price, description, flags, order, deal), otherwise a new item is added.
6. **Import** posts the same rows with `dry_run: false`: all valid rows are imported in one transaction; rejected rows are skipped and listed again in the result. Result toast: "Added N, updated M, skipped K".
7. A manager can undo nothing automatically; the preview is the safeguard. Nothing is imported until the Import click.

## API

- `GET /api/canteen/menu-template.csv` and `GET /api/canteen/menu-sample.csv` (manage only): CSV downloads (UTF-8 with BOM so Excel shows ₹ and Telugu correctly). The sample is `test/fixtures/canteen-menu-sample.csv` shipped at `public/`-independent path read by the server (copy it to `canteen-menu-sample.csv` next to `canteen.js` or read from a `samples/` directory; the builder decides, the fixture and the served file must be the same file).
- `POST /api/canteen/menu/read` body `{ name, data }` (`data` a base64 data URL, as photo uploads send) → `{ columns: [...], rows: [[...]], total }`. 400 with a plain message for an unreadable or empty file, an unsupported type or more than 500 rows.
- `POST /api/canteen/menu/import` body `{ rows: [{ category, name, price, description, is_veg, sold_out, active, sort_order, deal_pct, deal_kind, deal_minutes, row }], dry_run }` → `{ added, updated, categories_created, rejected: [{ row, reason }] }`. `row` is the file row number for messages. Validation is the existing `itemFields` rules applied per row (extract a shared pure function; do not copy them).

## Excel

Add one small dependency that reads `.xlsx` from a buffer in Node (the builder picks it: `read-excel-file` or similar; no CDN, no network at run time; must install with `npm ci` on Node 24 and 22). `.xls` (old binary) and `.csv` only otherwise: the dialog says "Save as .xlsx or .csv" for `.xls`.

## Non-goals

No image upload, no deleting items that are absent from the file, no scheduled imports, no per-row editing in the preview.

## Tests (in `test/e2e.mjs`, new section "Canteen: menu upload")

API: permissions (manager ok; counter staff, kitchen staff, a provider who is not a manager, an unauthenticated call all refused; a campus with the canteen off refuses); the shipped sample imports 29 items in 5 categories exactly (and a second import updates 29, adds 0); a CSV with BOM, quoted commas, `₹` prices, yes/no veg and semicolons reads correctly; an `.xlsx` fixture (create `test/fixtures/menu.xlsx` with python `openpyxl`, 4 rows, one price stored as a number, one as text) reads correctly; bad rows (empty name, price "abc", deal_pct 95, flash without minutes, deal_kind "wow") are rejected with their row numbers and good rows still import; dry run changes nothing; the 500-item cap; a file with only headers; a binary file renamed `.csv`. Chrome: the Menu tab shows Upload menu for the manager, the dialog opens, the mapping step appears for the sample file with `name` and `price` guessed, and Import adds the items to the list.

## Amendment (28 November 2026): no duplicate items, download the current menu

Owner: "Template download should be there and also they will upload the same template, with menu data. No duplicate menu items."

- An item name is unique across a campus's active menu, compared without case, outer spaces or repeated inner spaces (`nameKey` in `canteen.js`). This replaces the matching rule in step 5: a file row whose name is on the menu updates that item in any category and moves it when the file names another category (an empty category cell leaves it); a name twice in one file is rejected the second time. The preview counts `added`, `updated` and, of the updated, `moved`.
- Add item, Edit item (renaming, or bringing a removed item back) refuse a name already on the menu: `"<name>" is already on the menu`. Both run under the per-campus menu lock.
- Names already on a menu twice from before the rule are left alone: an import updates the oldest and the preview lists up to five of them (`duplicates: { count, names }`).
- `GET /api/canteen/menu-export.csv` (manage only): the active items in the template columns, prices in rupees, running deals only, in menu order. Uploading it back unchanged adds nothing and changes nothing. The template now has one example row.
