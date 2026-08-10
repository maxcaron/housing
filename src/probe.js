import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logInit, log, ContractError } from './log.js';
import { centrisSession, fetchPage, parseCards } from './centris.js';
import * as duproprio from './duproprio.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const searches = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'searches.json'), 'utf8'));

const firstBySource = (source) => searches.find((s) => s.source === source);

async function probeCentris(search) {
  const session = await centrisSession();
  const firstPage = await fetchPage(session, search.query, 1);
  const cards = parseCards(firstPage.html, 1);
  return { reported: firstPage.count, parsedOnFirstPage: cards.length };
}

async function probeDuproprio(search) {
  const { listings, count } = await duproprio.crawlSearch(search);
  return { reported: count, parsedOnFirstPage: listings.size };
}

function failureFields(error) {
  if (error instanceof ContractError) {
    return { check: error.check, message: error.message, ...error.context };
  }
  return { check: 'transport', message: String(error?.message ?? error) };
}

async function run(source, probe) {
  const search = firstBySource(source);
  if (!search) {
    log.warn('probe_skipped', { source, reason: 'no search configured for this source' });
    return true;
  }
  log.info('probe_start', { source, search: search.name });
  try {
    const result = await probe(search);
    if (result.reported === 0) {
      log.error('probe_empty', { source, search: search.name, ...result });
      return false;
    }
    log.info('probe_ok', { source, search: search.name, ...result });
    return true;
  } catch (error) {
    log.error('probe_failed', { source, search: search.name, ...failureFields(error) });
    return false;
  }
}

logInit('probe');
log.info('probe_runner', {
  egressIp: await fetch('https://api.ipify.org')
    .then((r) => r.text())
    .catch(() => 'unknown'),
});

const centrisReachable = await run('centris', probeCentris);
const duproprioReachable = await run('duproprio', probeDuproprio);

log.info('probe_summary', { centrisReachable, duproprioReachable });
process.exit(centrisReachable && duproprioReachable ? 0 : 1);
