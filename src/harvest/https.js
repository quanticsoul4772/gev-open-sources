/**
 * http → https: an entry fetched over plain http switches to the https form
 * of its URL when that answers 200 with the same content type as the http
 * URL and a body the entry's own decoder reads. Related URLs (GBFS) switch on
 * 200, the same content type and JSON that parses. The http original stays in
 * provenance (`via:`), so catalogues listing it don't re-add the feed. A failed
 * upgrade is remembered in harvest-rejects (keyed by the https URL) and
 * retried after REJECT_RETRY_S.
 */
import { ADAPTERS } from '../adapters/index.js';
import { fetchCapped } from '../util/http.js';
import { hostOfUrl, runPooled } from '../util/pool.js';
import { readZipEntry } from '../util/zip.js';
import { recentlyRejected } from './catalogue.js';

const secureForm = (url) => (url.startsWith('http://') ? `https://${url.slice('http://'.length)}` : null);
const mime = (res) => (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();

/**
 * Fetch an http URL and its https form; the https response if it may replace it.
 * @returns {Promise<{ok: true, body: Uint8Array} | {ok: false, reason: string}>}
 */
async function compare(url, entry, fetchImpl) {
  const target = secureForm(url);
  const options = { headers: entry.access.headers, redirectHosts: entry.access.redirectHosts, fetchImpl };
  let secure;
  try {
    secure = await fetchCapped(target, options);
  } catch (error) {
    return { ok: false, reason: `https: ${error.message}`.slice(0, 120) };
  }
  if (secure.status !== 200) return { ok: false, reason: `https: HTTP ${secure.status}` };
  let plain = null;
  try {
    plain = await fetchCapped(url, options);
  } catch {
    plain = null;
  }
  if (plain?.status === 200 && mime(plain) !== mime(secure))
    return { ok: false, reason: `https: content type ${mime(secure)} vs ${mime(plain)}` };
  return { ok: true, body: secure.body };
}

/** The entry over https, or why not. */
export async function httpsVariant(entry, { fetchImpl } = {}) {
  let next = entry;
  if (entry.access.url.startsWith('http://')) {
    const r = await compare(entry.access.url, entry, fetchImpl);
    if (!r.ok) return r;
    try {
      const body = entry.access.unzip ? readZipEntry(r.body, entry.access.unzip) : r.body;
      ADAPTERS[entry.format](body, entry.coverage.bbox, entry);
    } catch {
      return { ok: false, reason: 'https: body does not decode' };
    }
    next = {
      ...next,
      access: { ...next.access, url: secureForm(entry.access.url) },
      provenance: [...next.provenance, `via:${entry.access.url}`],
    };
  }
  for (const [name, url] of Object.entries(entry.access.related || {})) {
    if (!url.startsWith('http://')) continue;
    const r = await compare(url, entry, fetchImpl);
    if (!r.ok) continue;
    try {
      JSON.parse(new TextDecoder().decode(r.body));
    } catch {
      continue;
    }
    next = { ...next, access: { ...next.access, related: { ...next.access.related, [name]: secureForm(url) } } };
  }
  return next === entry ? { ok: false, reason: 'https: no URL switched' } : { ok: true, entry: next };
}

const hasHttp = (e) => [e.access.url, ...Object.values(e.access.related || {})].some((u) => u.startsWith('http://'));

/**
 * Try https for every entry that still uses http and wasn't tried recently.
 * @param {object[]} entries
 * @param {{rejects: object, now: number, fetchImpl?: typeof fetch}} options `rejects` updated in place
 * @returns {Promise<Map<string, object>>} id → upgraded entry
 */
export async function upgradeToHttps(entries, { rejects, now, fetchImpl }) {
  const key = (e) => secureForm(e.access.url) || e.id;
  const todo = entries.filter((e) => hasHttp(e) && !recentlyRejected(rejects, key(e), now));
  const results = await runPooled(todo, (e) => hostOfUrl(e.access.url), (e) => httpsVariant(e, { fetchImpl }), {
    global: 16,
    perHost: 2,
  });
  const upgraded = new Map();
  todo.forEach((e, i) => {
    const r = results[i]?.error ? { ok: false, reason: 'https: error' } : results[i];
    if (r.ok) {
      upgraded.set(e.id, r.entry);
      delete rejects[key(e)];
    } else rejects[key(e)] = { reason: r.reason, at: now };
  });
  return upgraded;
}
