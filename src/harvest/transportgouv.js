/**
 * transport.data.gouv.fr, France's national access point: one keyless JSON
 * list of datasets, each with a licence and resources tagged by format.
 * GTFS-RT resources that carry vehicle positions (by their detected
 * features, or, when none are listed, by a URL that doesn't name alerts or
 * trip updates) are checked before they are added; GBFS resources go to the
 * GBFS resolver. Resources are read at their `original_url` (the `url` is a
 * data.gouv.fr permalink that redirects there), so feeds other catalogues
 * already list are recognised before any fetch. Unavailable resources and
 * community resources are left out.
 */
import { fetchCapped } from '../util/http.js';
import { normalizeUrl, slugId } from '../util/ids.js';
import { hasCredential } from '../util/secrets.js';
import { catalogueLicenceUrl, namesNotVehicles, recentlyRejected, resolveTransitCandidates } from './catalogue.js';
import { resolveGbfsSystems } from './gbfs.js';

export const TRANSPORT_GOUV_URL = 'https://transport.data.gouv.fr/api/datasets';

/** SPDX id of a dataset licence; others (notspecified, fr-lo, mobility-licence) are left to the licence job. */
const LICENCE_SPDX = { lov2: 'etalab-2.0', 'odc-odbl': 'ODbL-1.0' };

const urlOf = (r) => r.original_url || r.url || '';

/**
 * Keyless GTFS-RT and GBFS sources from the dataset list. A dataset lists one
 * network, often at several addresses (the operator's, a
 * proxy.transport.data.gouv.fr copy, a combined feed, GBFS files listed
 * beside their gbfs.json): when the directory already serves one of its
 * resources of a format (`knownUrls`, which holds permalinks too), the others
 * of that format are left out. The served GBFS resource itself is passed on,
 * so the resolver can add the output it still lacks. A dataset gives at most
 * one GTFS-RT candidate per run, the first keyless one not rejected recently
 * (listed vehicle feeds first).
 * @param {object[]} datasets parsed /api/datasets
 * @param {{knownUrls?: Set<string>, rejects?: object, now?: number}} [options]
 * @returns {{rt: object[], gbfs: object[]}} transit candidates and GBFS systems
 */
export function transportGouvSources(datasets, { knownUrls = new Set(), rejects = {}, now = 0 } = {}) {
  const rt = [];
  const gbfs = [];
  for (const d of datasets) {
    const spdx = LICENCE_SPDX[d.licence];
    const licenceUrl = spdx ? catalogueLicenceUrl(spdx, null) : null;
    const provider = d.publisher?.name || d.title;
    const resources = d.resources || [];
    const known = (r) => [r.url, r.original_url].some((u) => u && knownUrls.has(normalizeUrl(u)));
    const served = (format) => resources.some((r) => r.format === format && known(r));
    const source = (r) => ({ id: slugId('transportgouv', String(r.id)), provenance: [`transport.data.gouv.fr:${d.id}/${r.id}`] });
    const available = resources.filter((r) => r.is_available);
    if (!served('gtfs-rt')) {
      const listed = (r) => (r.features || []).includes('vehicle_positions');
      const pick = available
        .filter((r) => r.format === 'gtfs-rt' && /^https?:\/\//.test(urlOf(r)) && !hasCredential(urlOf(r)))
        .filter((r) => (r.features?.length ? listed(r) : !namesNotVehicles(urlOf(r))))
        .sort((a, b) => Number(listed(b)) - Number(listed(a)))
        .find((r) => !recentlyRejected(rejects, urlOf(r), now));
      if (pick)
        rt.push({ ...source(pick), name: d.title, provider, url: urlOf(pick), licenceUrl, attribution: provider, countries: ['FR'] });
    }
    const gbfsServed = served('gbfs');
    for (const r of available)
      if (r.format === 'gbfs' && /^https:\/\//.test(urlOf(r)) && (!gbfsServed || known(r)))
        gbfs.push({
          ...source(r),
          vehicleId: slugId('transportgouv', `${r.id}-vehicles`),
          name: d.title,
          provider,
          country: 'FR',
          discoveryUrl: urlOf(r),
          systemId: null,
          catalogueLicence: licenceUrl,
        });
  }
  return { rt, gbfs };
}

/**
 * Entries from the dataset list. A list that can't be read gives no entries
 * and leaves the rest of the harvest running.
 * @param {Parameters<typeof import('./transitous.js').harvestTransitous>[0]} options
 * @returns {Promise<{candidates: number, entries: object[], error?: string}>}
 */
export async function harvestTransportGouv(options) {
  let datasets;
  try {
    const res = await fetchCapped(TRANSPORT_GOUV_URL, { maxBytes: 32 * 2 ** 20, timeoutMs: 60_000, fetchImpl: options.fetchImpl });
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    datasets = JSON.parse(new TextDecoder().decode(res.body));
    if (!Array.isArray(datasets)) throw new Error('not a dataset list');
  } catch (error) {
    console.warn(`harvest: transport.data.gouv.fr skipped: ${error.message}`);
    return { candidates: 0, entries: [], error: error.message };
  }
  const { rt, gbfs } = transportGouvSources(datasets, options);
  const rtEntries = await resolveTransitCandidates(rt, options);
  const gbfsEntries = await resolveGbfsSystems(gbfs, { ...options, anyRedirect: true });
  return { candidates: rt.length + gbfs.length, entries: [...rtEntries, ...gbfsEntries] };
}
