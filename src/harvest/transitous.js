/**
 * Transitous (github.com/public-transport/transitous): one feeds/<region>.json
 * per region, each source with a `spec` (gtfs-rt | gbfs) and an SPDX licence.
 * Sources marked skip, or carrying headers, an api-key or a url-override, need
 * a credential or a fix-up and are left out; `mobility-database` and
 * `transitland-atlas` sources point back into catalogues read directly.
 * GTFS-RT sources don't say which entity they carry, so each is checked for
 * vehicle positions before it is added.
 */
import { fetchCapped } from '../util/http.js';
import { normalizeUrl, slugId } from '../util/ids.js';
import { hostOfUrl, runPooled } from '../util/pool.js';
import { readZipEntries } from '../util/zip.js';
import { catalogueLicenceUrl, recentlyRejected, resolveTransitCandidates } from './catalogue.js';
import { resolveGbfsSystem } from './gbfs.js';

export const TRANSITOUS_ZIP_URL =
  'https://codeload.github.com/public-transport/transitous/zip/refs/heads/main';

/** ISO country of a Transitous region file name: `us-ca` → US; `eu` → none. */
export const regionCountry = (region) =>
  /^[a-z]{2}(-|$)/.test(region) && !region.startsWith('eu') ? region.slice(0, 2).toUpperCase() : null;

/**
 * Keyless GTFS-RT and GBFS sources from region documents.
 * @param {Array<{region: string, doc: object}>} docs parsed feeds/*.json
 * @returns {{rt: object[], gbfs: object[]}} transit candidates and GBFS systems
 */
export function transitousSources(docs) {
  const rt = [];
  const gbfs = [];
  for (const { region, doc } of docs) {
    const country = regionCountry(region);
    const usedIds = new Set();
    for (const s of doc.sources || []) {
      if (s.type !== 'url' || s.skip || s.headers || s['api-key'] || s['url-override']) continue;
      if (!/^https:\/\//.test(s.url || '') && !(s.spec === 'gtfs-rt' && /^http:\/\//.test(s.url || ''))) continue;
      let id = slugId('transitous', `${region}-${s.name}`);
      if (usedIds.has(id)) id = slugId('transitous', `${region}-${s.name}-${s.url}`);
      usedIds.add(id);
      const licenceUrl = catalogueLicenceUrl(s.license?.['spdx-identifier'], s.license?.url);
      const provenance = [`transitous:${region}/${s.name}`];
      if (s.spec === 'gtfs-rt')
        rt.push({
          id,
          name: s.name,
          provider: s.license?.publisher || s.name,
          url: s.url,
          licenceUrl,
          attribution: s.license?.publisher || null,
          countries: country ? [country] : [],
          provenance,
        });
      else if (s.spec === 'gbfs')
        gbfs.push({
          id,
          name: s.name,
          provider: s.license?.publisher || s.name,
          country,
          discoveryUrl: s.url,
          systemId: null,
          catalogueLicence: licenceUrl,
          provenance,
        });
    }
  }
  return { rt, gbfs };
}

/**
 * @param {{knownIds: Set<string>, knownUrls: Set<string>, rejects: object, now: number,
 *   fetchImpl?: typeof fetch}} options
 */
export async function harvestTransitous(options) {
  const { knownIds, knownUrls, rejects, now, fetchImpl } = options;
  const res = await fetchCapped(TRANSITOUS_ZIP_URL, { maxBytes: 64 * 2 ** 20, timeoutMs: 120_000, fetchImpl });
  if (res.status !== 200) throw new Error(`Transitous: HTTP ${res.status}`);
  const files = readZipEntries(res.body, (name) => /^[^/]+\/feeds\/[^/]+\.json$/.test(name));
  const docs = [...files].map(([name, bytes]) => ({
    region: name.split('/').at(-1).replace(/\.json$/, ''),
    doc: JSON.parse(new TextDecoder().decode(bytes)),
  }));
  const { rt, gbfs } = transitousSources(docs);
  const rtEntries = await resolveTransitCandidates(rt, options);
  // GBFS: resolve systems not known by id or discovery URL and not rejected recently.
  const todo = gbfs.filter(
    (s) => !knownIds.has(s.id) && !knownUrls.has(normalizeUrl(s.discoveryUrl)) && !recentlyRejected(rejects, s.discoveryUrl, now),
  );
  const resolved = await runPooled(todo, (s) => hostOfUrl(s.discoveryUrl), (s) => resolveGbfsSystem(s, { fetchImpl, anyRedirect: true }), {
    global: 24,
    perHost: 3,
  });
  const gbfsEntries = [];
  todo.forEach((s, i) => {
    const entry = resolved[i];
    if (entry && !entry.error) gbfsEntries.push(entry);
    else rejects[s.discoveryUrl] = { reason: entry?.error ? `resolve: ${entry.error.message}`.slice(0, 120) : 'no keyless station feeds', at: now };
  });
  return { candidates: rt.length + gbfs.length, entries: [...rtEntries, ...gbfsEntries] };
}
