// SQLite store. Two ideas matter here:
//   1. `listing` is current state; `event` is the append-only history that answers
//      every tracking question (price corrections, days on market, delistings).
//   2. Diffing against the previous crawl only happens after a fully successful
//      crawl — a partial crawl must never be interpreted as "everything else got
//      delisted".

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from './log.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DB_PATH = path.join(ROOT, 'data', 'housing.db');

export function openDb() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS run (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      search      TEXT NOT NULL,
      started_at  TEXT NOT NULL,
      finished_at TEXT,
      status      TEXT NOT NULL DEFAULT 'running', -- running | ok | failed
      count       INTEGER,
      error_check TEXT,
      error       TEXT
    );
    CREATE TABLE IF NOT EXISTS listing (
      mls           TEXT PRIMARY KEY,
      search        TEXT NOT NULL,
      url           TEXT,
      address       TEXT,
      city          TEXT,
      lat           REAL,
      lng           REAL,
      bedrooms      INTEGER,
      bathrooms     INTEGER,
      category      TEXT,
      first_seen    TEXT NOT NULL,
      last_seen     TEXT NOT NULL,
      current_price INTEGER,
      status        TEXT NOT NULL DEFAULT 'active' -- active | delisted
    );
    CREATE TABLE IF NOT EXISTS event (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      mls       TEXT NOT NULL,
      at        TEXT NOT NULL,
      kind      TEXT NOT NULL, -- listed | price_change | delisted | relisted
      price     INTEGER,
      old_price INTEGER,
      run_id    INTEGER,
      FOREIGN KEY (mls) REFERENCES listing(mls)
    );
    CREATE INDEX IF NOT EXISTS idx_event_mls ON event(mls, at);
    CREATE INDEX IF NOT EXISTS idx_event_kind ON event(kind, at);
    CREATE INDEX IF NOT EXISTS idx_listing_search ON listing(search, status);
  `);
  // detail-page fields, added after the first schema shipped — migrate in place
  const have = new Set(db.prepare(`PRAGMA table_info(listing)`).all().map((c) => c.name));
  const wanted = {
    rooms: 'INTEGER',            // pièces
    year_built: 'INTEGER',
    living_area: 'INTEGER',      // sq ft
    lot_size: 'INTEGER',         // sq ft
    parking: 'TEXT',             // raw, e.g. "Allée (10), Garage (2)"
    parking_count: 'INTEGER',
    assess_year: 'INTEGER',
    assess_lot: 'INTEGER',
    assess_building: 'INTEGER',
    assess_total: 'INTEGER',
    detail_fetched_at: 'TEXT',
  };
  for (const [col, type] of Object.entries(wanted)) {
    if (!have.has(col)) db.exec(`ALTER TABLE listing ADD COLUMN ${col} ${type}`);
  }
  return db;
}

export function saveDetails(db, mls, d) {
  db.prepare(`
    UPDATE listing SET rooms = @rooms, year_built = @year_built, living_area = @living_area,
      lot_size = @lot_size, parking = @parking, parking_count = @parking_count,
      assess_year = @assess_year, assess_lot = @assess_lot,
      assess_building = @assess_building, assess_total = @assess_total,
      detail_fetched_at = @now
    WHERE mls = @mls
  `).run({ ...d, mls, now: new Date().toISOString() });
}

export function runStart(db, search) {
  const r = db
    .prepare(`INSERT INTO run (search, started_at) VALUES (?, ?)`)
    .run(search, new Date().toISOString());
  return r.lastInsertRowid;
}

export function runFinish(db, runId, { status, count = null, errorCheck = null, error = null }) {
  db.prepare(
    `UPDATE run SET finished_at = ?, status = ?, count = ?, error_check = ?, error = ? WHERE id = ?`
  ).run(new Date().toISOString(), status, count, errorCheck, error, runId);
}

export function lastOkCount(db, search) {
  return db
    .prepare(`SELECT count FROM run WHERE search = ? AND status = 'ok' ORDER BY id DESC LIMIT 1`)
    .get(search)?.count;
}

// Apply one successful crawl atomically; returns event counts for the run summary.
export function applyCrawl(db, runId, search, listings) {
  const now = new Date().toISOString();
  const stats = { listed: 0, price_change: 0, delisted: 0, relisted: 0, unchanged: 0 };

  const getListing = db.prepare(`SELECT mls, current_price, status FROM listing WHERE mls = ?`);
  const insertListing = db.prepare(`
    INSERT INTO listing (mls, search, url, address, city, lat, lng, bedrooms, bathrooms, category,
                         first_seen, last_seen, current_price, status)
    VALUES (@mls, @search, @url, @address, @city, @lat, @lng, @bedrooms, @bathrooms, @category,
            @now, @now, @price, 'active')
  `);
  const touchListing = db.prepare(`
    UPDATE listing SET last_seen = ?, current_price = ?, status = 'active',
                       url = ?, address = ?, city = ?, lat = ?, lng = ?, bedrooms = ?, bathrooms = ?
    WHERE mls = ?
  `);
  const insertEvent = db.prepare(`
    INSERT INTO event (mls, at, kind, price, old_price, run_id) VALUES (?, ?, ?, ?, ?, ?)
  `);
  const activeMls = db.prepare(`SELECT mls, current_price FROM listing WHERE search = ? AND status = 'active'`);
  const markDelisted = db.prepare(`UPDATE listing SET status = 'delisted' WHERE mls = ?`);

  db.transaction(() => {
    for (const l of listings.values()) {
      const prev = getListing.get(l.mls);
      if (!prev) {
        insertListing.run({ ...l, search, now });
        insertEvent.run(l.mls, now, 'listed', l.price, null, runId);
        stats.listed++;
        log.info('event_listed', { mls: l.mls, price: l.price, address: l.address });
        continue;
      }
      if (prev.status === 'delisted') {
        insertEvent.run(l.mls, now, 'relisted', l.price, prev.current_price, runId);
        stats.relisted++;
        log.info('event_relisted', { mls: l.mls, price: l.price, address: l.address });
      }
      if (prev.current_price !== l.price && prev.status !== 'delisted') {
        insertEvent.run(l.mls, now, 'price_change', l.price, prev.current_price, runId);
        stats.price_change++;
        log.info('event_price_change', {
          mls: l.mls,
          old_price: prev.current_price,
          new_price: l.price,
          address: l.address,
        });
      }
      if (prev.status === 'active' && prev.current_price === l.price) stats.unchanged++;
      touchListing.run(now, l.price, l.url, l.address, l.city, l.lat, l.lng, l.bedrooms, l.bathrooms, l.mls);
    }
    for (const row of activeMls.all(search)) {
      if (!listings.has(row.mls)) {
        markDelisted.run(row.mls);
        insertEvent.run(row.mls, now, 'delisted', row.current_price, null, runId);
        stats.delisted++;
        log.info('event_delisted', { mls: row.mls, last_price: row.current_price });
      }
    }
  })();

  return stats;
}
