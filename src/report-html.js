// Generate data/report.html — a self-contained dashboard over the tracked data.
// The template (src/report-template.html) renders everything client-side from one
// embedded JSON blob, so the output file works as a plain local file.
// Usage: node src/report-html.js   (then open data/report.html)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const db = openDb();

const listings = db.prepare(`
  SELECT mls, search, source, type, photo_url, url, address, city, lat, lng, bedrooms, bathrooms,
         rooms, year_built, living_area, lot_size, parking, parking_count,
         assess_year, assess_lot, assess_building, assess_total,
         first_seen, published_at, last_seen, current_price AS price, status
  FROM listing ORDER BY current_price DESC
`).all();

const events = db.prepare(`
  SELECT mls, at, kind, price, old_price, old_mls FROM event ORDER BY at DESC
`).all();

const searches = db.prepare(`SELECT DISTINCT search FROM listing ORDER BY search`).all().map((r) => r.search);

// Stale-data warning: surface crawl failures on the page itself, not only in logs.
let staleWarning = null;
const lastRun = db.prepare(`SELECT started_at, status, error_check, error FROM run ORDER BY id DESC LIMIT 1`).get();
const lastOk = db.prepare(`SELECT finished_at FROM run WHERE status = 'ok' ORDER BY id DESC LIMIT 1`).get();
if (lastRun && lastRun.status === 'failed') {
  staleWarning = `The most recent crawl failed (${lastRun.error_check ?? 'error'}: ${lastRun.error}).`;
} else if (lastOk && Date.now() - new Date(lastOk.finished_at).getTime() > 48 * 3600_000) {
  staleWarning = `The last successful crawl was ${lastOk.finished_at.slice(0, 16)} — more than 48h ago.`;
}
if (!lastOk) staleWarning = 'No successful crawl recorded yet.';

const data = {
  generatedAt: new Date().toISOString(),
  lastCrawlAt: lastOk?.finished_at ?? null,
  searches,
  listings,
  events,
  staleWarning,
};

const template = fs.readFileSync(path.join(ROOT, 'src', 'report-template.html'), 'utf8');
// JSON is injected into a <script> block: escape the only sequence that could
// terminate it early.
const json = JSON.stringify(data).replace(/</g, '\\u003c');
const html = template.replace('__DATA__', json);

const out = path.join(ROOT, 'data', 'report.html');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);
console.log(`wrote ${path.relative(ROOT, out)} (${listings.length} listings, ${events.length} events)`);
db.close();
