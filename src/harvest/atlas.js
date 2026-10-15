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
 * comes first; else the licence of a feed run by the same operator (usually
 * its static GTFS), marked `borrowed`, which the licence job accepts only
 * when it is a known licence.
 * @param {Array<{doc: object}>} docs parsed feeds/*.dmfr.json
 * @returns {Map<string, {licenceUrl: string, attribution: string|null, feedId: string, borrowed: boolean}>}
 *   keyed by normalized vehicle-positions URL
 */
export function atlasLicences(docs) {
  const feeds = new Map();
  const group = new Map(); // feed id → ids of feeds with the same operator
  const join = (ids) => {
    const all = new Set(ids.filter(Boolean));
    for (const id of [...all]) for (const other of group.get(id) || []) all.add(other);
    for (const id of all) group.set(id, all);
  };
  for (const { doc } of docs) {
    for (const feed of doc.feeds || []) {
      feeds.set(feed.id, feed);
      join([feed.id, feed.id.replace(/~rt$/, '')]);
      for (const op of feed.operators || []) join([feed.id, ...(op.associated_feeds || []).map((f) => f.feed_onestop_id)]);
    }
    for (const op of doc.operators || []) join((op.associated_feeds || []).map((f) => f.feed_onestop_id));
  }
  const out = new Map();
  for (const feed of feeds.values()) {
    const url = feed.urls?.realtime_vehicle_positions;
    if (feed.spec !== 'gtfs-rt' || !/^https?:\/\//.test(url || '')) continue;
    let source = citable(feed.license) ? feed : null;
    const borrowed = !source;
    if (!source) source = [...(group.get(feed.id) || [])].map((id) => feeds.get(id)).find((f) => citable(f?.license)) || null;
    if (!source) continue;
    const licenceUrl = catalogueLicenceUrl(source.license.spdx_identifier, source.license.url);
    if (!licenceUrl || hasCredential(licenceUrl)) continue;
    out.set(normalizeUrl(url), { licenceUrl, attribution: source.license.attribution_text || null, feedId: source.id, borrowed });
  }
  return out;
}

/**
 * Transit entries given a licence from Atlas: those with none, and those
 * holding a borrowed one when Atlas has the realtime feed's own.
 * @param {object[]} entries
 * @param {ReturnType<typeof atlasLicences>} licences
 * @returns {Map<string, object>} id → entry with the Atlas licence
 */
export function withAtlasLicences(entries, licences) {
  const out = new Map();
  for (const e of entries) {
    if (e.domain !== 'transit.vehicles') continue;
    const urls = [e.access.url, ...e.provenance.filter((p) => p.startsWith('via:')).map((p) => p.slice(4))];
    const hit = urls.map((u) => licences.get(normalizeUrl(u))).find(Boolean);
    if (!hit || hit.licenceUrl === e.licence.url) continue;
    const holdsBorrowed = e.provenance.some((p) => p.startsWith('licence-borrowed:'));
    if (e.licence.url && !(holdsBorrowed && !hit.borrowed)) continue;
    out.set(e.id, {
      ...e,
      licence: { ...e.licence, url: hit.licenceUrl, attribution: hit.attribution || e.licence.attribution },
      provenance: [
        ...e.provenance.filter((p) => !p.startsWith('licence-borrowed:') && !p.startsWith('licence-atlas:')),
        hit.borrowed ? `licence-borrowed:atlas:${hit.feedId}` : `licence-atlas:${hit.feedId}`,
      ],
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
