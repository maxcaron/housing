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
      kind      TEXT NOT NULL, -- listed | price_change | delisted | relisted | renumbered
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
    type: 'TEXT',      // house | lot — from the search's config entry
    photo_url: 'TEXT', // listing thumbnail
    renumbered_to: 'TEXT', // set when a broker relists under a fresh MLS number
    source: 'TEXT',        // centris | duproprio
    published_at: 'TEXT',  // the site's own listing date; only DuProprio publishes one
  };
  for (const [col, type] of Object.entries(wanted)) {
    if (!have.has(col)) db.exec(`ALTER TABLE listing ADD COLUMN ${col} ${type}`);
  }
  // every row that predates the column came from Centris
  db.exec(`UPDATE listing SET source = 'centris' WHERE source IS NULL`);
  const haveEvent = new Set(db.prepare(`PRAGMA table_info(event)`).all().map((c) => c.name));
  if (!haveEvent.has('old_mls')) db.exec(`ALTER TABLE event ADD COLUMN old_mls TEXT`);
  return db;
}

// DuProprio's map rows carry no room counts and Centris's cards do, so bedrooms
// and bathrooms are filled in only when the detail actually supplies them.
export function saveDetails(db, mls, d) {
  db.prepare(`
    UPDATE listing SET rooms = @rooms, year_built = @year_built, living_area = @living_area,
      lot_size = @lot_size, parking = @parking, parking_count = @parking_count,
      assess_year = @assess_year, assess_lot = @assess_lot,
      assess_building = @assess_building, assess_total = @assess_total,
      bedrooms = COALESCE(@bedrooms, bedrooms), bathrooms = COALESCE(@bathrooms, bathrooms),
      published_at = COALESCE(@published_at, published_at),
      detail_fetched_at = @now
    WHERE mls = @mls
  `).run({ bedrooms: null, bathrooms: null, published_at: null, ...d, mls, now: new Date().toISOString() });
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

export function trackedListingCount(db) {
  return db.prepare(`SELECT count(*) AS n FROM listing`).get().n;
}

// Apply one successful crawl atomically; returns event counts for the run summary.
// `search` is the config entry ({name, type, ...}).
// A new MLS matching a same-run vanished listing (same address, city, price) is a
// broker relisting under a fresh number to reset days-on-market — recorded as one
// `renumbered` event instead of delisted+listed, with first_seen carried forward.
export function applyCrawl(db, runId, search, listings) {
  const now = new Date().toISOString();
  const stats = { listed: 0, price_change: 0, delisted: 0, relisted: 0, renumbered: 0, unchanged: 0 };

  const getListing = db.prepare(`SELECT mls, current_price, status FROM listing WHERE mls = ?`);
  const insertListing = db.prepare(`
    INSERT INTO listing (mls, search, source, type, url, address, city, lat, lng, bedrooms, bathrooms, category,
                         photo_url, first_seen, last_seen, current_price, status)
    VALUES (@mls, @search, @source, @type, @url, @address, @city, @lat, @lng, @bedrooms, @bathrooms, @category,
            @photo, @first_seen, @now, @price, 'active')
  `);
  const touchListing = db.prepare(`
    UPDATE listing SET last_seen = ?, current_price = ?, status = 'active', type = ?,
                       url = ?, address = ?, city = ?, lat = ?, lng = ?,
                       bedrooms = COALESCE(?, bedrooms), bathrooms = COALESCE(?, bathrooms),
                       photo_url = COALESCE(?, photo_url)
    WHERE mls = ?
  `);
  const insertEvent = db.prepare(`
    INSERT INTO event (mls, at, kind, price, old_price, old_mls, run_id) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const activeRows = db.prepare(
    `SELECT mls, address, city, current_price, first_seen FROM listing WHERE search = ? AND status = 'active'`
  );
  const markDelisted = db.prepare(`UPDATE listing SET status = 'delisted' WHERE mls = ?`);
  const markRenumbered = db.prepare(`UPDATE listing SET status = 'renumbered', renumbered_to = ? WHERE mls = ?`);

  db.transaction(() => {
    const vanished = activeRows.all(search.name).filter((r) => !listings.has(r.mls));
    const vanishedByKey = new Map();
    for (const r of vanished) {
      const key = `${r.address}|${r.city}|${r.current_price}`;
      if (!vanishedByKey.has(key)) vanishedByKey.set(key, []);
      vanishedByKey.get(key).push(r);
    }
    const renumberedMls = new Set();
    for (const l of listings.values()) {
      const prev = getListing.get(l.mls);
      if (!prev) {
        const old = (vanishedByKey.get(`${l.address}|${l.city}|${l.price}`) ?? [])
          .find((r) => !renumberedMls.has(r.mls));
        if (old) {
          renumberedMls.add(old.mls);
          markRenumbered.run(l.mls, old.mls);
          insertListing.run({ ...l, search: search.name, source: search.source, type: search.type, now, first_seen: old.first_seen });
          insertEvent.run(l.mls, now, 'renumbered', l.price, old.current_price, old.mls, runId);
          stats.renumbered++;
          log.info('event_renumbered', { mls: l.mls, old_mls: old.mls, price: l.price, address: l.address });
        } else {
          insertListing.run({ ...l, search: search.name, source: search.source, type: search.type, now, first_seen: now });
          insertEvent.run(l.mls, now, 'listed', l.price, null, null, runId);
          stats.listed++;
          log.info('event_listed', { mls: l.mls, price: l.price, address: l.address });
        }
        continue;
      }
      if (prev.status !== 'active') {
        insertEvent.run(l.mls, now, 'relisted', l.price, prev.current_price, null, runId);
        stats.relisted++;
        log.info('event_relisted', { mls: l.mls, price: l.price, address: l.address });
      }
      if (prev.current_price !== l.price && prev.status === 'active') {
        insertEvent.run(l.mls, now, 'price_change', l.price, prev.current_price, null, runId);
        stats.price_change++;
        log.info('event_price_change', {
          mls: l.mls,
          old_price: prev.current_price,
          new_price: l.price,
          address: l.address,
        });
      }
      if (prev.status === 'active' && prev.current_price === l.price) stats.unchanged++;
      touchListing.run(now, l.price, search.type, l.url, l.address, l.city, l.lat, l.lng, l.bedrooms, l.bathrooms, l.photo, l.mls);
    }
    for (const row of vanished) {
      if (renumberedMls.has(row.mls)) continue;
      markDelisted.run(row.mls);
      insertEvent.run(row.mls, now, 'delisted', row.current_price, null, null, runId);
      stats.delisted++;
      log.info('event_delisted', { mls: row.mls, last_price: row.current_price });
    }
  })();

  return stats;
}
