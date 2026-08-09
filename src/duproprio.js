// DuProprio client. No browser: the site's own api-proxy accepts plain HTTP once
// a session cookie is held.
//
// Flow (validated 2026-08-09):
//   1. GET a search page once to obtain the Laravel session cookies.
//   2. GET /fr/api-proxy/map-search?province=1&cities[]=…&min_latitude=… ->
//      {data: [{id, price, latitude, longitude, address, type, is_sold, …}], meta}
//      One request returns the whole result set — there is no pagination.
//   3. GET /fr/api-proxy/listing/<id> -> the full listing as JSON, including
//      published_at, room counts, municipal assessment and taxes.
//
// The bounding box is mandatory and is a viewport, not a filter: it returns
// everything visible, with in_search=1 marking the rows that actually match the
// city list. Filtering on that flag is what makes the result set mean "our
// searches" rather than "whatever was nearby".
//
// province is the sharpest trap here: province=1 works, province='QC' is
// accepted and silently returns zero rows. Every assumption is an explicit
// ContractError so breakage is loud and named, never a quietly empty dataset.

import { log, ContractError } from './log.js';

const BASE = 'https://duproprio.com';
const SESSION_PATH = '/fr/rechercher/liste?search=true&is_for_sale=1';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const THROTTLE_MS = 1200;
const QUEBEC_PROVINCE_ID = 1;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function snippet(text) {
  return String(text).slice(0, 300).replace(/\s+/g, ' ');
}

export async function duproprioSession() {
  const res = await fetch(BASE + SESSION_PATH, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'fr-CA,fr;q=0.9' },
  });
  const body = await res.text();
  if (res.status !== 200) {
    throw new ContractError('dp_session_http_status', `GET ${SESSION_PATH} returned ${res.status}`, {
      status: res.status,
      body: snippet(body),
    });
  }
  const setCookies = res.headers.getSetCookie();
  if (setCookies.length === 0) {
    throw new ContractError('dp_session_no_cookies', 'search page set no cookies; api-proxy will reject the call', {});
  }
  const cookie = setCookies.map((c) => c.split(';')[0]).join('; ');
  log.debug('dp_session_established', { cookies: setCookies.length });
  return { cookie };
}

async function getJson(session, url, check) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'application/json',
      'Accept-Language': 'fr-CA,fr;q=0.9',
      'X-Requested-With': 'XMLHttpRequest',
      Referer: BASE + '/fr/rechercher/carte',
      Cookie: session.cookie,
    },
  });
  const text = await res.text();
  if (res.status !== 200) {
    throw new ContractError(`${check}_http_status`, `GET ${url} returned ${res.status}`, {
      url,
      status: res.status,
      body: snippet(text),
    });
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ContractError(`${check}_not_json`, 'api-proxy did not return JSON — endpoint moved or bot-walled?', {
      url,
      body: snippet(text),
    });
  }
  // the proxy reports upstream 4xx as a 200 carrying {message}
  if (json && typeof json.message === 'string') {
    throw new ContractError(`${check}_upstream_error`, `api-proxy relayed an upstream error: ${snippet(json.message)}`, {
      url,
      message: json.message,
    });
  }
  return json;
}

function mapSearchUrl(search) {
  const p = new URLSearchParams();
  p.set('search', 'true');
  p.set('is_for_sale', '1');
  p.set('province', String(QUEBEC_PROVINCE_ID));
  for (const id of search.cities) p.append('cities[]', String(id));
  for (const [k, v] of Object.entries(search.bounds)) p.set(k, String(v));
  return `${BASE}/fr/api-proxy/map-search?${p}`;
}

// map-search rows carry everything the Centris cards do except room counts,
// which come from the per-listing endpoint.
function toListing(row, search) {
  const a = row.address ?? {};
  const photo = row.photo_primary?.uri_1024 ?? row.photo_primary?.uri ?? null;
  return {
    mls: `dp-${row.id}`,
    price: row.price,
    url: `${BASE}/fr/${row.id}`,
    address: a.street ?? '',
    city: search.cityNames?.[a.city_id] ?? a.city ?? '',
    lat: typeof row.latitude === 'number' ? row.latitude : null,
    lng: typeof row.longitude === 'number' ? row.longitude : null,
    bedrooms: null,
    bathrooms: null,
    category: row.property_type ?? null,
    photo: photo ? `https://photos.duproprio.com/${photo}` : null,
  };
}

export async function crawlSearch(search) {
  const session = await duproprioSession();
  await sleep(THROTTLE_MS);

  const url = mapSearchUrl(search);
  const body = await getJson(session, url, 'dp_map_search');
  if (!Array.isArray(body?.data) || typeof body?.meta !== 'object') {
    throw new ContractError('dp_map_search_shape_changed', 'response shape differs from {data: [], meta: {}}', {
      keys: Object.keys(body ?? {}),
    });
  }
  const rows = body.data;
  // in_search separates the city filter from viewport spillover. If the flag
  // ever disappears we would silently widen to the whole bounding box.
  if (rows.length > 0 && rows.every((r) => r.in_search === undefined)) {
    throw new ContractError('dp_in_search_missing', 'rows carry no in_search flag — cannot tell matches from viewport spillover', {
      sample: Object.keys(rows[0]),
    });
  }
  const matched = rows.filter((r) => r.in_search === 1 && r.is_rental !== 1);
  const wanted = matched.filter((r) => search.types.includes(r.type));

  const stray = wanted.filter((r) => !search.cities.includes(r.address?.city_id));
  if (stray.length > 0) {
    throw new ContractError('dp_city_filter_leaked', 'in_search rows fell outside the requested cities', {
      cities: search.cities,
      leaked: [...new Set(stray.map((r) => r.address?.city_id))],
    });
  }

  const listings = new Map();
  for (const row of wanted) {
    const l = toListing(row, search);
    if (!listings.has(l.mls)) listings.set(l.mls, l);
  }
  log.info('dp_search_size', {
    search: search.name,
    returned: rows.length,
    in_search: matched.length,
    kept: listings.size,
  });
  return { listings, count: listings.size, rawPages: [body] };
}

//- Detail --------------------------------------------------------------------
// One fetch per listing id. Unlike Centris these are cheap JSON, but the same
// once-ever rule applies: rooms, year built, land size and the assessment do not
// change. published_at is DuProprio's own listing date — we keep it, but
// first_seen still governs days-on-market so both sources stay comparable.

const num = (s) => {
  if (s == null) return null;
  const digits = String(s).replace(/[^\d]/g, '');
  return digits ? Number(digits) : null;
};

// One session serves every detail call in a run — re-fetching the search page
// per listing would triple the request count for nothing.
let detailSession = null;

export async function fetchDetail(url) {
  const id = url.match(/\/(\d+)$/)?.[1];
  if (!id) {
    throw new ContractError('dp_detail_bad_url', `cannot read a listing id out of ${url}`, { url });
  }
  if (!detailSession) detailSession = await duproprioSession();
  return getJson(detailSession, `${BASE}/fr/api-proxy/listing/${id}`, 'dp_detail');
}

export function parseDetail(json, mls) {
  const main = json?.characteristics?.main;
  const props = json?.characteristics?.property ?? {};
  if (!main || typeof main !== 'object') {
    throw new ContractError('dp_detail_shape_changed', `listing ${mls} has no characteristics.main`, {
      mls,
      keys: Object.keys(json ?? {}),
    });
  }
  const parking = props['Nombre de stationnement extérieur'] ?? props['Nombre de stationnement intérieur'] ?? null;
  const yearRaw = props['Année de construction'];
  const rooms = [main.nb_bedrooms, main.nb_bathrooms, main.nb_half_bathrooms]
    .filter((n) => typeof n === 'number')
    .reduce((a, b) => a + b, 0);
  return {
    rooms: rooms || null,
    year_built: yearRaw && /^\d{4}$/.test(yearRaw) ? Number(yearRaw) : null,
    living_area: main.living_space_square_foot?.raw ? Math.round(main.living_space_square_foot.raw) : null,
    lot_size: main.lot_size_square_foot?.raw ? Math.round(main.lot_size_square_foot.raw) : null,
    parking,
    parking_count: num(parking),
    // DuProprio publishes one assessment figure, not the lot/building split
    assess_year: null,
    assess_lot: null,
    assess_building: null,
    assess_total: num(props['Évaluation municipale']),
    // the map row carries no room counts, so they arrive here
    bedrooms: main.nb_bedrooms ?? null,
    bathrooms: main.nb_bathrooms ?? null,
    published_at: typeof json?.published_at === 'string' ? json.published_at : null,
  };
}

export const DETAIL_THROTTLE_MS = THROTTLE_MS;
