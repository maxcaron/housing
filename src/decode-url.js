// Turn a Centris search URL (built in their UI) into the query JSON used in
// config/searches.json. Fails loudly if the q= parameter is corrupt — pasted
// Centris URLs get truncated/mangled easily.
// Usage: node src/decode-url.js "<centris search url>"

import { decodeSearchUrl } from './centris.js';

const url = process.argv[2];
if (!url) {
  console.error('usage: node src/decode-url.js "<centris search url>"');
  process.exit(2);
}
try {
  console.log(JSON.stringify(decodeSearchUrl(url), null, 2));
} catch (e) {
  console.error(`${e.message}`);
  if (e.context) console.error(JSON.stringify(e.context));
  process.exit(1);
}
