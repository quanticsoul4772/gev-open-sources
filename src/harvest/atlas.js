/**
 * Transitland Atlas (github.com/transitland/transitland-atlas, CC-BY-4.0):
 * DMFR records whose GTFS-RT feeds name a `realtime_vehicle_positions` URL.
 * Feeds with an `authorization` block need a key and are skipped. Its GBFS
 * list is a copy of MobilityData's systems.csv, so only GTFS-RT is read.
 */
import { fetchCapped } from '../util/http.js';
import { slugId } from '../util/ids.js';
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
  return { candidates: candidates.length, entries };
}
