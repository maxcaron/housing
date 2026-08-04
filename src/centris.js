// Centris.ca client. No browser: the site's own AJAX endpoint accepts plain HTTP.
//
// Flow (validated 2026-08-04):
//   1. GET a search page once to obtain the ASP.NET session cookie.
//   2. POST /Property/GetInscriptions with {mode, searchView, sort, pageSize, page, query}
//      -> {d: {Succeeded, Result: {count, html, inscNumberPerPage, ...}}}
//      where html holds 20 listing cards per page.
//
// This endpoint has been renamed before (GetInlineListings -> GetInscriptions), and
// Centris silently ignores malformed queries instead of erroring (returns all of
// Quebec). Every assumption is therefore an explicit ContractError so breakage is
// loud and named, never a quietly wrong dataset.

import zlib from 'node:zlib';
import { log, ContractError } from './log.js';

const BASE = 'https://www.centris.ca';
const SESSION_PATH = '/fr/maison~a-vendre';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const THROTTLE_MS = 1200;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function snippet(text) {
  return String(text).slice(0, 300).replace(/\s+/g, ' ');
}

export async function centrisSession() {
  const res = await fetch(BASE + SESSION_PATH, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'fr-CA,fr;q=0.9' },
  });
  const body = await res.text();
  if (res.status !== 200) {
    throw new ContractError('session_http_status', `GET ${SESSION_PATH} returned ${res.status}`, {
      status: res.status,
      body: snippet(body),
    });
  }
  const setCookies = res.headers.getSetCookie();
  if (setCookies.length === 0) {
    throw new ContractError('session_no_cookies', 'search page set no cookies; session-based endpoint will likely fail', {});
  }
  const cookie = setCookies.map((c) => c.split(';')[0]).join('; ');
  log.debug('session_established', { cookies: setCookies.length });
  return { cookie };
}

export async function fetchPage(session, query, page) {
  const payload = {
    mode: 'Result',
    searchView: 'Thumbnail',
    sort: 'None',
    sortSeed: 1, // fixed seed => stable ordering across pages within a run
    pageSize: 20,
    page,
    region: null,
    query,
  };
  const res = await fetch(BASE + '/Property/GetInscriptions', {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      Referer: BASE + SESSION_PATH,
      Cookie: session.cookie,
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (res.status !== 200) {
    throw new ContractError('inscriptions_http_status', `GetInscriptions page ${page} returned ${res.status}`, {
      page,
      status: res.status,
      body: snippet(text),
    });
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ContractError('inscriptions_not_json', 'GetInscriptions did not return JSON — endpoint moved or bot-walled?', {
      page,
      body: snippet(text),
    });
  }
  const result = json?.d?.Result;
  if (json?.d?.Succeeded !== true || typeof result?.count !== 'number' || typeof result?.html !== 'string') {
    throw new ContractError('inscriptions_shape_changed', 'response shape differs from d.{Succeeded,Result.{count,html}}', {
      page,
      keys: Object.keys(json?.d?.Result ?? json?.d ?? json ?? {}),
      message: json?.d?.Message ?? null,
    });
  }
  return result;
}

// Cards are server-rendered HTML. We extract with anchored regexes and then verify
// the extraction internally agrees (same number of MLS numbers, prices, addresses).
const RE_MLS = /data-mlsnumber='(\d+)'/g;
const RE_CARD_SPLIT = /class="property-thumbnail-item/g;

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .trim();
}

function field(card, re, name, mls) {
  const m = card.match(re);
  if (!m) throw new ContractError('card_missing_field', `card ${mls}: could not extract "${name}"`, { mls, field: name, card: snippet(card) });
  return m[1];
}

export function parseCards(html, page) {
  const chunks = html.split(RE_CARD_SPLIT).slice(1);
  const listings = [];
  for (const card of chunks) {
    const mlsMatches = [...card.matchAll(RE_MLS)].map((m) => m[1]);
    if (mlsMatches.length === 0) {
      throw new ContractError('card_missing_field', 'card has no data-mlsnumber', { page, card: snippet(card) });
    }
    const mls = mlsMatches[0];
    const price = Number(field(card, /itemprop="price" content="(\d+)"/, 'price', mls));
    const url = field(card, /class="property-thumbnail-summary-link" href="([^"]+)"/, 'url', mls);
    const addrBlock = field(card, /class="address">([\s\S]*?)<\/div>\s*<\/div>/, 'address', mls);
    // the captured block loses the last inner </div>, so don't require one
    const addrParts = [...addrBlock.matchAll(/<div>([^<]*)/g)].map((m) => decodeEntities(m[1])).filter(Boolean);
    const lat = card.match(/data-lat="([0-9.-]+)"/)?.[1];
    const lng = card.match(/data-lng="([0-9.-]+)"/)?.[1];
    const category = card.match(/class="category"[^>]*>\s*<div[^>]*>([\s\S]*?)</)?.[1];
    const photo = card.match(/<img itemprop="image" src="([^"]+)"/)?.[1]?.replace(/&amp;/g, '&') ?? null;
    listings.push({
      mls,
      price,
      url: BASE + url,
      address: addrParts[0] ?? '',
      city: addrParts.slice(1).join(', '),
      lat: lat ? Number(lat) : null,
      lng: lng ? Number(lng) : null,
      bedrooms: Number(card.match(/class='cac'>(\d+)</)?.[1] ?? null),
      bathrooms: Number(card.match(/class='sdb'>(\d+)</)?.[1] ?? null),
      category: category ? decodeEntities(category) : null,
      photo,
    });
  }
  return listings;
}

// Full crawl of one saved search: paginate, parse, dedupe. Returns
// {listings: Map<mls, listing>, count, rawPages} — rawPages so the caller can
// archive exactly what Centris served (re-parseable if parsing here has a bug).
export async function crawlSearch(search) {
  const session = await centrisSession();
  await sleep(THROTTLE_MS);

  const first = await fetchPage(session, search.query, 1);
  const count = first.count;
  const perPage = first.inscNumberPerPage || 20;
  const pages = Math.max(1, Math.ceil(count / perPage));
  log.info('search_size', { search: search.name, count, pages });

  const rawPages = [first];
  const listings = new Map();
  let duplicates = 0;

  const ingest = (result, page) => {
    for (const l of parseCards(result.html, page)) {
      if (listings.has(l.mls)) duplicates++;
      else listings.set(l.mls, l);
    }
  };
  ingest(first, 1);

  for (let page = 2; page <= pages; page++) {
    await sleep(THROTTLE_MS);
    const result = await fetchPage(session, search.query, page);
    rawPages.push(result);
    ingest(result, page);
  }

  if (duplicates > 0) {
    log.warn('pagination_duplicates', { search: search.name, duplicates });
  }
  // count can drift while we paginate (listings added/removed mid-crawl); small
  // drift is normal, large drift means pagination or the query itself is broken.
  const drift = Math.abs(listings.size - count);
  if (drift > Math.max(3, count * 0.05)) {
    throw new ContractError('count_mismatch', `parsed ${listings.size} unique listings but Centris reported ${count}`, {
      search: search.name,
      parsed: listings.size,
      reported: count,
    });
  }
  return { listings, count, rawPages };
}

//- Detail pages ------------------------------------------------------------
// One fetch per listing, ever: rooms, year built, land size, parking and the
// municipal assessment never change for a given MLS number. Individual missing
// fields are data (vacant lots have no year built), but a page with none of the
// expected structure is a contract break.

function decode(s) {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&')
    .replace(/\u00a0/g, ' ')
    .trim();
}
const num = (s) => {
  if (s == null) return null;
  const digits = String(s).replace(/[^\d]/g, '');
  return digits ? Number(digits) : null;
};

export async function fetchDetail(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'fr-CA,fr;q=0.9' },
  });
  const html = await res.text();
  if (res.status !== 200) {
    throw new ContractError('detail_http_status', `GET ${url} returned ${res.status}`, {
      url,
      status: res.status,
    });
  }
  return html;
}

export function parseDetail(html, mls) {
  const caracs = {};
  for (const m of html.matchAll(/carac-title">([^<]+)<\/div>\s*<div class="carac-value"><span>([^<]+)</g)) {
    caracs[decode(m[1])] = decode(m[2]);
  }
  const roomsM = html.match(/class="[^"]*\bpiece\b[^"]*">\s*(\d+)\s*pi/);

  // municipal assessment: its own table under "Évaluation municipale (YYYY)"
  const decoded = decode(html);
  const assessM = decoded.match(/valuation municipale \((\d{4})\)/);
  let assess = { year: null, lot: null, building: null, total: null };
  if (assessM) {
    const section = decoded.slice(assessM.index, decoded.indexOf('</table>', assessM.index));
    const row = (label) => {
      const m = section.match(new RegExp(label + '\\s*</td>\\s*<td[^>]*>\\s*([\\d ]+)\\s*\\$'));
      return m ? num(m[1]) : null;
    };
    assess = { year: Number(assessM[1]), lot: row('Terrain'), building: row('Bâtiment'), total: row('Total') };
  }

  if (Object.keys(caracs).length === 0 && !roomsM && !assessM) {
    throw new ContractError('detail_shape_changed', `detail page for ${mls} has none of the expected sections`, {
      mls,
      body: snippet(html),
    });
  }

  const parking = caracs['Stationnement total'] ?? null;
  const yearRaw = caracs['Année de construction'];
  return {
    rooms: roomsM ? Number(roomsM[1]) : null,
    year_built: yearRaw && /^\d{4}$/.test(yearRaw) ? Number(yearRaw) : null,
    living_area: num(caracs['Superficie habitable']),
    lot_size: num(caracs['Superficie du terrain']),
    parking,
    parking_count: parking ? [...parking.matchAll(/\((\d+)\)/g)].reduce((a, m) => a + Number(m[1]), 0) || null : null,
    assess_year: assess.year,
    assess_lot: assess.lot,
    assess_building: assess.building,
    assess_total: assess.total,
  };
}

export const DETAIL_THROTTLE_MS = THROTTLE_MS;

// The q= URL parameter is the query JSON, gzipped then base64url-encoded.
export function decodeSearchUrl(url) {
  const q = new URL(url).searchParams.get('q');
  if (!q) throw new ContractError('url_no_q', 'URL has no q= parameter', { url });
  let buf;
  try {
    buf = zlib.gunzipSync(Buffer.from(q, 'base64url'));
  } catch (e) {
    throw new ContractError('url_q_corrupt', 'q= parameter does not gunzip — URL was truncated or mangled in copy/paste', {
      cause: e.message,
      qLength: q.length,
    });
  }
  return JSON.parse(buf.toString('utf8'));
}

export function encodeSearchQuery(query) {
  return zlib.gzipSync(Buffer.from(JSON.stringify(query))).toString('base64url');
}
