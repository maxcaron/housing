// Orchestrator: crawl every configured search, archive the raw responses, diff
// against the previous state, and record events. One failed search does not stop
// the others, but any failure makes the process exit non-zero so a scheduler
// (cron/launchd) can alert on it.
//
// Usage:
//   node src/crawl.js                 # all searches in config/searches.json
//   node src/crawl.js --search=NAME   # just one

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { log, logInit, ContractError } from './log.js';
import { crawlSearch, fetchDetail, parseDetail, DETAIL_THROTTLE_MS } from './centris.js';
import { openDb, runStart, runFinish, lastOkCount, applyCrawl, saveDetails } from './db.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function archiveRaw(search, rawPages) {
  const dir = path.join(ROOT, 'data', 'raw', search);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, new Date().toISOString().replace(/[:.]/g, '-') + '.json.gz');
  fs.writeFileSync(file, zlib.gzipSync(JSON.stringify(rawPages)));
  return file;
}

// Detail pages (rooms, year built, land size, parking, municipal assessment)
// are fetched once per MLS number — the values don't change. A failed page is
// logged and retried on the next run (detail_fetched_at stays NULL); it never
// blocks the listing/event diff, which has already been applied.
async function fetchMissingDetails(db, search) {
  const missing = db.prepare(
    `SELECT mls, url FROM listing WHERE search = ? AND status = 'active' AND detail_fetched_at IS NULL`
  ).all(search);
  const out = { detail_ok: 0, detail_failed: 0 };
  if (missing.length === 0) return out;
  log.info('detail_fetch_start', { search, missing: missing.length });
  const rawDir = path.join(ROOT, 'data', 'raw', 'details');
  fs.mkdirSync(rawDir, { recursive: true });
  for (const [i, l] of missing.entries()) {
    await new Promise((r) => setTimeout(r, DETAIL_THROTTLE_MS));
    try {
      const html = await fetchDetail(l.url);
      const d = parseDetail(html, l.mls);
      fs.writeFileSync(path.join(rawDir, `${l.mls}.html.gz`), zlib.gzipSync(html));
      saveDetails(db, l.mls, d);
      out.detail_ok++;
      log.debug('detail_saved', { mls: l.mls, ...d });
    } catch (e) {
      out.detail_failed++;
      log.error('detail_fetch_failed', {
        mls: l.mls,
        url: l.url,
        check: e instanceof ContractError ? e.check : null,
        message: e.message,
      });
    }
    if ((i + 1) % 20 === 0) log.info('detail_fetch_progress', { done: i + 1, total: missing.length });
  }
  return out;
}

async function runOne(db, search) {
  const runId = runStart(db, search.name);
  log.info('crawl_start', { search: search.name, label: search.label });
  try {
    const { listings, count, rawPages } = await crawlSearch(search);

    // Centris ignores filters it can't parse and happily returns all of Quebec
    // (~25k listings), and a half-broken query can also return far too little.
    // A wild swing vs the last good run is treated as an error, not data.
    const prev = lastOkCount(db, search.name);
    if (prev !== undefined && prev >= 10 && (count > prev * 2 || count < prev * 0.5)) {
      // --accept-count-swing: for intentional search-config changes (new area,
      // new filters), where a big jump is expected — accepts the new baseline once
      if (process.argv.includes('--accept-count-swing')) {
        log.warn('count_swing_accepted', { search: search.name, previous: prev, current: count });
      } else {
        throw new ContractError('count_swing', `result count swung from ${prev} to ${count} — filters silently dropped?`, {
          search: search.name,
          previous: prev,
          current: count,
        });
      }
    }

    const rawFile = archiveRaw(search.name, rawPages);
    const stats = applyCrawl(db, runId, search, listings);
    const details = await fetchMissingDetails(db, search.name);
    runFinish(db, runId, { status: 'ok', count });
    log.info('crawl_ok', { search: search.name, count, raw: path.relative(ROOT, rawFile), ...stats, ...details });
    return details.detail_failed === 0 || details.detail_ok > 0;
  } catch (e) {
    const check = e instanceof ContractError ? e.check : null;
    runFinish(db, runId, { status: 'failed', errorCheck: check, error: e.message });
    log.error('crawl_failed', {
      search: search.name,
      check,
      message: e.message,
      ...(e instanceof ContractError ? { context: e.context } : { stack: e.stack }),
    });
    return false;
  }
}

const only = process.argv.find((a) => a.startsWith('--search='))?.split('=')[1];
let searches = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'searches.json'), 'utf8'));
if (only) {
  searches = searches.filter((s) => s.name === only);
  if (searches.length === 0) {
    console.error(`no search named "${only}" in config/searches.json`);
    process.exit(2);
  }
}

logInit('crawl');
const db = openDb();
let ok = true;
for (const search of searches) {
  ok = (await runOne(db, search)) && ok;
}
db.close();
process.exit(ok ? 0 : 1);
