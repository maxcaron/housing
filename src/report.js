// Quick terminal report: recent events, market snapshot per search, failed runs.
// Usage: node src/report.js [--days=14]

import { openDb } from './db.js';

const days = Number(process.argv.find((a) => a.startsWith('--days='))?.split('=')[1] ?? 14);
const since = new Date(Date.now() - days * 86400_000).toISOString();
const db = openDb();

const fmt = (n) => (n == null ? '—' : n.toLocaleString('en-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 }));
const dom = (first) => Math.round((Date.now() - new Date(first).getTime()) / 86400_000);

console.log(`\n=== Market snapshot ===`);
for (const s of db.prepare(`SELECT DISTINCT search FROM listing`).all()) {
  const row = db
    .prepare(
      `SELECT COUNT(*) n, AVG(current_price) avg_price, MIN(current_price) min_price, MAX(current_price) max_price
       FROM listing WHERE search = ? AND status = 'active'`
    )
    .get(s.search);
  const medDom = db
    .prepare(`SELECT first_seen FROM listing WHERE search = ? AND status = 'active' ORDER BY first_seen LIMIT 1 OFFSET ?`)
    .get(s.search, Math.floor(row.n / 2));
  console.log(
    `${s.search}: ${row.n} active | avg ${fmt(row.avg_price)} | range ${fmt(row.min_price)}–${fmt(row.max_price)}` +
      (medDom ? ` | median tracked-days ${dom(medDom.first_seen)}` : '')
  );
}

console.log(`\n=== Events (last ${days} days) ===`);
const events = db
  .prepare(
    `SELECT e.at, e.kind, e.price, e.old_price, l.address, l.city, l.mls
     FROM event e JOIN listing l ON l.mls = e.mls
     WHERE e.at >= ? ORDER BY e.at DESC LIMIT 100`
  )
  .all(since);
if (events.length === 0) console.log('(none)');
for (const e of events) {
  const when = e.at.slice(0, 10);
  const where = `${e.address}, ${e.city}`;
  if (e.kind === 'price_change') {
    const pct = (((e.price - e.old_price) / e.old_price) * 100).toFixed(1);
    console.log(`${when}  PRICE     ${fmt(e.old_price)} -> ${fmt(e.price)} (${pct}%)  ${where}  [${e.mls}]`);
  } else {
    console.log(`${when}  ${e.kind.toUpperCase().padEnd(8)}  ${fmt(e.price)}  ${where}  [${e.mls}]`);
  }
}

const failed = db
  .prepare(`SELECT started_at, search, error_check, error FROM run WHERE status = 'failed' AND started_at >= ? ORDER BY id DESC`)
  .all(since);
if (failed.length > 0) {
  console.log(`\n=== FAILED RUNS (last ${days} days) — data may be stale ===`);
  for (const r of failed) console.log(`${r.started_at.slice(0, 16)}  ${r.search}  ${r.error_check ?? ''}  ${r.error}`);
}
console.log();
db.close();
