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
timeline, a map (houses in blue price quintiles, lots in brown; needs internet
for tiles), price-change / listings / sold-delisted tables with thumbnails and
per-column filters (`>500000`, `1990-2005`, or plain text), global area + type +
date-range filters, and light/dark themes. It also shows a stale-data
banner when the last crawl failed or is older than 48h. Regenerate it after each
crawl (add `&& node src/report-html.js` to the cron line).

## Automation & hosting

`.github/workflows/daily.yml` runs the whole pipeline on GitHub Actions four
times a day: crawl → regenerate dashboard → copy to `docs/index.html` → commit &
push. GitHub Pages serves `docs/` on `main`, so the push is the deploy. The
dashboard is regenerated and published **even when a search fails** — its
stale-data banner reaching the hosted page is the alerting, and the job still
goes red. Run it off-schedule from the Actions tab ("crawl" → Run workflow).

The four cron lines are UTC, anchored to Eastern *daylight* time, so from
November to March each run lands an hour earlier locally:

| cron (UTC) | EDT   | EST   |
| ---------- | ----- | ----- |
| `37 8`     | 04:37 | 03:37 |
| `37 14`    | 10:37 | 09:37 |
| `37 18`    | 14:37 | 13:37 |
| `37 0`     | 20:37 | 19:37 |

The `37` is deliberate: GitHub queues scheduled jobs hardest on the hour, and a
run can be delayed by tens of minutes when it is scheduled there.

Runs are serialized by a `concurrency` group rather than cancelled, so a slow
crawl delays the next one instead of losing it.

`data/housing.db` is committed alongside `docs/index.html` because it is the
diff baseline: without the previous state there is no history to derive. It is
the one thing under `data/` that git tracks. Raw responses and crawl logs are
uploaded as build artifacts (90 and 30 days) rather than committed.

The price of tracking the database is that **a local crawl and the scheduled run
both change a file git cannot merge**. Pull before working in the repo, and
don't run the pipeline locally just to look at something — resolving a conflict
on `housing.db` means picking one side and throwing away the other side's day.
Use the probe workflow to test the scrapers instead; it writes nothing. If a
local run really is needed: pull, run, push immediately.

This used to run on the laptop via launchd, which does not fire while the Mac is
asleep — it runs the job at the next wake and coalesces everything it missed, so
a lid shut over a weekend silently costs whole days (2026-08-08 has no crawl at
all). `bin/launchd.plist.example` and `bin/daily.sh` are kept for running the
pipeline by hand; the launchd agent should stay unloaded while Actions owns the
schedule, or the two will both crawl and fight over the same commit.

Nothing in the pipeline is keyed to the calendar day — `listing` is current
state and `event` is an append-only log of timestamped diffs — so a crawl that
finds no change simply writes no events and publishes no commit. Crawling more
often buys finer timestamps on price changes and delistings; it also means a
listing that flickers out of one crawl's results is recorded as delisted and
relisted hours later rather than a day later.

`crawl.js` distinguishes its exit codes: `1` means a search failed and the run
should still publish, `2` means it refused to crawl at all (see below). The
status is also in the `run` table.

## The empty-baseline guard

`openDb()` creates a database if none exists, which makes "state was never
restored" look exactly like "first run ever". Crawling then records every
listing as newly listed and delists them all the next day, destroying
days-on-market. So `crawl.js` aborts with exit 2 before any request when the
`listing` table is empty. A genuine first run needs `--bootstrap`:

```sh
node src/crawl.js --bootstrap
```

## Checking the scrapers from CI

`.github/workflows/probe.yml` (manual trigger) hits both sources from a runner
and reports the egress IP, without writing to the database or archiving
anything. It answers "are we blocked from this network" — worth running before
blaming the parser.

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
