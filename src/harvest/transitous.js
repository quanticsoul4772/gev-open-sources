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
import { slugId } from '../util/ids.js';
import { readZipEntries } from '../util/zip.js';
import { catalogueLicenceUrl, resolveTransitCandidates } from './catalogue.js';
import { resolveGbfsSystems } from './gbfs.js';

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
          vehicleId: slugId('transitous', `${id}-vehicles`),
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
 * @param {{knownIds: Set<string>, knownUrls: Set<string>, knownOutputs: Set<string>, rejects: object,
 *   now: number, fetchImpl?: typeof fetch, vehicleBudget?: number, deadlineMs?: number}} options
 */
export async function harvestTransitous(options) {
  const { fetchImpl } = options;
  const res = await fetchCapped(TRANSITOUS_ZIP_URL, { maxBytes: 64 * 2 ** 20, timeoutMs: 120_000, fetchImpl });
  if (res.status !== 200) throw new Error(`Transitous: HTTP ${res.status}`);
  const files = readZipEntries(res.body, (name) => /^[^/]+\/feeds\/[^/]+\.json$/.test(name));
  const docs = [...files].map(([name, bytes]) => ({
    region: name.split('/').at(-1).replace(/\.json$/, ''),
    doc: JSON.parse(new TextDecoder().decode(bytes)),
  }));
  const { rt, gbfs } = transitousSources(docs);
  const rtEntries = await resolveTransitCandidates(rt, options);
  // GBFS: the stations and vehicles outputs each system still lacks (shared with systems.csv).
  const gbfsEntries = await resolveGbfsSystems(gbfs, { ...options, anyRedirect: true });
  return { candidates: rt.length + gbfs.length, entries: [...rtEntries, ...gbfsEntries] };
}
