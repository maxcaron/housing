# housing

Tracks Centris.ca for-sale listings over time. Centris only shows *current* state —
no price history, no listing date, no sold prices — so this tool crawls saved
searches on a schedule, archives the raw responses, and diffs against the previous
state to build the history itself:

- **listed** — new MLS number appears (days-on-market counts from here)
- **price_change** — asking price differs from the last crawl
- **delisted** — listing disappeared (sold or withdrawn; Centris doesn't say which)
- **relisted** — a delisted MLS number came back

## Usage

```sh
npm install
node src/crawl.js                  # crawl all searches in config/searches.json
node src/crawl.js --search=NAME    # just one
node src/report.js [--days=14]     # market snapshot + recent events + failed runs
node src/report-html.js            # generate data/report.html (the dashboard)
node src/decode-url.js "<url>"     # turn a Centris search URL into query JSON
```

The dashboard (`data/report.html`) is a single self-contained file — open it in a
browser. It has KPI tiles, price distribution, per-area inventory, an activity
timeline, a map (needs internet for tiles), price-change and listings tables, an
area filter + date range, and light/dark themes. It also shows a stale-data
banner when the last crawl failed or is older than 48h. Regenerate it after each
crawl (add `&& node src/report-html.js` to the cron line).

Schedule it daily (the diff is what creates history — no crawl, no data):

```sh
# crontab -e
30 6 * * * cd ~/Development/housing && /usr/local/bin/node src/crawl.js >> logs/cron.log 2>&1
```

`crawl.js` exits non-zero if any search failed, so a scheduler can alert on it.

## Adding a search

Build the search in the Centris UI, copy the URL, then:

```sh
node src/decode-url.js "<url>"
```

and paste the output as the `query` of a new entry in `config/searches.json`.
If the URL got mangled in copy/paste the decode fails loudly (`url_q_corrupt`)
instead of silently searching all of Quebec — Centris itself does NOT fail on a
corrupt `q=`; it drops the filters and returns ~25k listings.

## How the crawl works

No browser. Centris's own AJAX endpoint accepts plain HTTP (validated 2026-08-04):

1. `GET /fr/maison~a-vendre` → ASP.NET session cookie
2. `POST /Property/GetInscriptions` with `{mode, searchView, sort, sortSeed,
   pageSize, page, query}` → `{d: {Succeeded, Result: {count, html}}}`,
   20 server-rendered cards per page; each card has `data-mlsnumber`, price
   (schema.org microdata), address, coords, detail URL.

Requests are throttled to ~1/sec. Every raw page is archived to
`data/raw/<search>/<timestamp>.json.gz` before parsing, so parser bugs never
lose data — history can be rebuilt from the archives.

## Error handling philosophy

Centris has renamed this endpoint before (`GetInlineListings` →
`GetInscriptions`) and silently ignores queries it can't parse. Every assumption
is therefore an explicit, named contract check (`ContractError.check`), and a
failed check fails the run — the diff is never applied to partial data (a partial
crawl would otherwise mark the missing listings "delisted"). Notable checks:

| check | meaning |
|---|---|
| `session_http_status` / `session_no_cookies` | can't establish a session |
| `inscriptions_http_status` / `inscriptions_not_json` | endpoint moved or bot-walled |
| `inscriptions_shape_changed` | response JSON shape changed |
| `card_missing_field` | card HTML structure changed |
| `count_mismatch` | parsed listings disagree with Centris's reported count |
| `count_swing` | result count doubled/halved vs last good run — filters silently dropped? |

Logs are JSONL in `logs/` (one file per run, `LOG_LEVEL=debug` for more console
output); runs and their failures are also recorded in the `run` table, and
`report.js` surfaces recent failed runs so stale data is visible.

## Data model (`data/housing.db`, SQLite)

- `listing` — current state per MLS number (`first_seen`, `last_seen`,
  `current_price`, `status`), plus one-time detail-page fields: `rooms`,
  `year_built`, `living_area`, `lot_size` (sq ft), `parking` / `parking_count`,
  and the municipal assessment (`assess_year`, `assess_lot`, `assess_building`,
  `assess_total`). Details are fetched once per MLS number after each crawl's
  diff (they never change); a failed detail page is retried next run and never
  blocks event tracking.
- `event` — append-only history (`listed` / `price_change` / `delisted` /
  `relisted`), the table every tracking question is answered from
- `run` — one row per crawl attempt with status and error
