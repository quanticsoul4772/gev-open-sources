/**
 * Transitland Atlas (github.com/transitland/transitland-atlas, CC-BY-4.0):
 * DMFR records whose GTFS-RT feeds name a `realtime_vehicle_positions` URL.
 * Feeds with an `authorization` block need a key and are skipped. Its GBFS
 * list is a copy of MobilityData's systems.csv, so only GTFS-RT is read.
 * Atlas licences also fill in transit entries found in other catalogues.
 */
import { fetchCapped } from '../util/http.js';
import { normalizeUrl, slugId } from '../util/ids.js';
import { hasCredential } from '../util/secrets.js';
import { readZipEntries } from '../util/zip.js';
import { catalogueLicenceUrl, resolveTransitCandidates } from './catalogue.js';

export const ATLAS_ZIP_URL =
  'https://codeload.github.com/transitland/transitland-atlas/zip/refs/heads/main';

/**
 * Keyless vehicle-position candidates from DMFR documents.
 * @param {Array<{file: string, doc: object}>} docs parsed feeds/*.dmfr.json
 */
export function atlasCandidates(docs) {
  // Operators may sit in another file, and are often tied only to the static
  // feed (`f-x`) of a realtime feed (`f-x~rt`).
  const operatorOf = new Map();
  const link = (feedId, name) => feedId && name && !operatorOf.has(feedId) && operatorOf.set(feedId, name);
  for (const { doc } of docs) {
    for (const op of doc.operators || [])
      for (const f of op.associated_feeds || []) link(f.feed_onestop_id, op.name);
    // An operator nested in a feed belongs to that feed.
    for (const feed of doc.feeds || []) for (const op of feed.operators || []) link(feed.id, op.name);
  }
  const candidates = [];
  for (const { file, doc } of docs) {
    for (const feed of doc.feeds || []) {
      const url = feed.urls?.realtime_vehicle_positions;
      if (feed.spec !== 'gtfs-rt' || feed.authorization || !/^https?:\/\//.test(url || '')) continue;
      const provider =
        operatorOf.get(feed.id) ||
        operatorOf.get(feed.id.replace(/~rt$/, '')) ||
        feed.name ||
        file.replace(/\.dmfr\.json$/, '');
      candidates.push({
        id: slugId('atlas', feed.id),
        name: feed.name || provider,
        provider,
        url,
        licenceUrl: catalogueLicenceUrl(feed.license?.spdx_identifier, feed.license?.url),
        attribution: feed.license?.attribution_text || null,
        countries: [],
        provenance: [`transitland-atlas:${feed.id}`],
      });
    }
  }
  return candidates;
}

/** An Atlas `license` block with something to cite: an SPDX id or a URL. */
const citable = (license) => Boolean(license?.spdx_identifier || license?.url);

/**
 * Licences Atlas records for realtime vehicle-position URLs, whichever
 * catalogue the directory found the feed in. A realtime feed's own licence
 * comes first; else the licence of its own static twin (`f-x` for
 * `f-x~rt`), marked `borrowed`, which the licence job accepts only when it
 * is a known licence. Nothing is borrowed through shared operators: an
 * aggregator that lists many agencies would lend one agency's licence to
 * another.
 * @param {Array<{doc: object}>} docs parsed feeds/*.dmfr.json
 * @returns {Map<string, {licenceUrl: string, attribution: string|null, feedId: string, borrowed: boolean}>}
 *   keyed by normalized vehicle-positions URL
 */
export function atlasLicences(docs) {
  const feeds = new Map();
  for (const { doc } of docs) for (const feed of doc.feeds || []) feeds.set(feed.id, feed);
  const out = new Map();
  for (const feed of feeds.values()) {
    const url = feed.urls?.realtime_vehicle_positions;
    if (feed.spec !== 'gtfs-rt' || !/^https?:\/\//.test(url || '')) continue;
    let source = citable(feed.license) ? feed : null;
    const borrowed = !source;
    const twin = feeds.get(feed.id.replace(/~rt$/, ''));
    if (!source && twin !== feed && citable(twin?.license)) source = twin;
    if (!source) continue;
    const licenceUrl = catalogueLicenceUrl(source.license.spdx_identifier, source.license.url);
    if (!licenceUrl || hasCredential(licenceUrl)) continue;
    out.set(normalizeUrl(url), { licenceUrl, attribution: source.license.attribution_text || null, feedId: source.id, borrowed });
  }
  return out;
}

const isAtlasTag = (p) => p.startsWith('licence-atlas:') || p.startsWith('licence-borrowed:atlas:');

/**
 * Transit entries whose licence changes because of Atlas: those with none,
 * those holding a borrowed one when Atlas has the realtime feed's own, and
 * those holding an Atlas licence that Atlas now gives differently or no
 * longer gives (taken back, so a stale borrowing doesn't stick).
 * @param {object[]} entries
 * @param {ReturnType<typeof atlasLicences>} licences
 * @returns {Map<string, object>} id → entry with its licence from Atlas updated
 */
export function withAtlasLicences(entries, licences) {
  const out = new Map();
  for (const e of entries) {
    if (e.domain !== 'transit.vehicles') continue;
    const urls = [e.access.url, ...e.provenance.filter((p) => p.startsWith('via:')).map((p) => p.slice(4))];
    const hit = urls.map((u) => licences.get(normalizeUrl(u))).find(Boolean);
    const fromAtlas = e.provenance.some(isAtlasTag);
    const others = e.provenance.filter((p) => !isAtlasTag(p));
    if (!hit) {
      if (fromAtlas) out.set(e.id, { ...e, licence: { ...e.licence, url: null, attribution: e.provider }, provenance: others });
      continue;
    }
    const tag = hit.borrowed ? `licence-borrowed:atlas:${hit.feedId}` : `licence-atlas:${hit.feedId}`;
    if (hit.licenceUrl === e.licence.url && e.provenance.includes(tag)) continue;
    const holdsBorrowed = others.some((p) => p.startsWith('licence-borrowed:'));
    if (e.licence.url && !fromAtlas && !(holdsBorrowed && !hit.borrowed)) continue;
    out.set(e.id, {
      ...e,
      licence: { ...e.licence, url: hit.licenceUrl, attribution: hit.attribution || e.provider },
      provenance: [...others.filter((p) => !p.startsWith('licence-borrowed:')), tag],
    });
  }
  return out;
}

/** @param {{knownUrls: Set<string>, rejects: object, now: number, fetchImpl?: typeof fetch}} options */
export async function harvestAtlas(options) {
  const res = await fetchCapped(ATLAS_ZIP_URL, { maxBytes: 64 * 2 ** 20, timeoutMs: 120_000, fetchImpl: options.fetchImpl });
  if (res.status !== 200) throw new Error(`Transitland Atlas: HTTP ${res.status}`);
  const files = readZipEntries(res.body, (name) => /\/feeds\/[^/]+\.dmfr\.json$/.test(name));
  const docs = [...files].map(([name, bytes]) => ({
    file: name.split('/').at(-1),
    doc: JSON.parse(new TextDecoder().decode(bytes)),
  }));
  const candidates = atlasCandidates(docs);
  const entries = await resolveTransitCandidates(candidates, options);
  return { candidates: candidates.length, entries, licences: atlasLicences(docs) };
}
