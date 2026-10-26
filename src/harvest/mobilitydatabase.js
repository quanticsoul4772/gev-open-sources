import { parseCsv } from '../util/csv.js';
import { fetchCapped } from '../util/http.js';
import { hasCredential } from '../util/secrets.js';
import { normalizeUrl, slugId } from '../util/ids.js';
import { NOT_VEHICLES, plausibleBbox, resolveTransitCandidates } from './catalogue.js';

export const MDB_CSV_URL = 'https://files.mobilitydatabase.org/feeds_v2.csv';

const bboxOf = (row) => {
  const v = [
    'location.bounding_box.minimum_latitude',
    'location.bounding_box.minimum_longitude',
    'location.bounding_box.maximum_latitude',
    'location.bounding_box.maximum_longitude',
  ].map((k) => Number.parseFloat(row[k]));
  // A catalogue box wider than one service area is usually an error (a flipped
  // sign, a stray stop); leave it out and fill coverage from the vehicles.
  return plausibleBbox(v) ? v : null;
};

/**
 * Keyless GTFS-Realtime feeds from the Mobility Database catalog: those
 * tagged as vehicle positions as directory entries (licence undecided), the
 * rest as candidates to check for vehicles (an untagged feed may carry them).
 * `rejected` counts the tagged feeds only.
 * @param {Array<Record<string,string>>} rows parsed feeds_v2.csv
 * @returns {{entries: object[], untagged: object[], rejected: {keyed: number, inactive: number}}}
 */
export function mobilityDatabaseEntries(rows) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const entries = [];
  const untagged = [];
  const rejected = { keyed: 0, inactive: 0 };
  for (const row of rows) {
    if (row.data_type !== 'gtfs_rt') continue;
    const tagged = row.entity_type.split('|').includes('vp');
    const url = row['urls.direct_download'];
    if (row['urls.authentication_type'] !== '0' || hasCredential(url)) {
      if (tagged) rejected.keyed += 1;
      continue;
    }
    if (row.status !== 'active' || !/^https?:\/\//.test(url)) {
      if (tagged) rejected.inactive += 1;
      continue;
    }
    // Licence: the row's own, else its static feed's when the provider matches
    // (the licence job accepts a borrowed URL only if it is a known licence).
    let licenceUrl = row['urls.license'] || null;
    const provenance = [`mobilitydatabase:${row.id}`];
    if (!licenceUrl) {
      const stat = byId.get(row.static_reference);
      if (stat?.['urls.license'] && stat.provider === row.provider) {
        licenceUrl = stat['urls.license'];
        provenance.push(`licence-borrowed:${stat.id}`);
      }
    }
    const countries = row['location.country_code'] ? [row['location.country_code']] : [];
    if (!tagged) {
      if (NOT_VEHICLES.test(url)) continue;
      untagged.push({
        taggedOther: row.entity_type.split('|').some(Boolean),
        id: slugId('mdb', row.id),
        name: row.name || row.provider,
        provider: row.provider,
        url,
        licenceUrl,
        attribution: row.provider,
        countries,
        provenance,
      });
      continue;
    }
    entries.push({
      id: slugId('mdb', row.id),
      domain: 'transit.vehicles',
      name: row.name || row.provider,
      provider: row.provider,
      coverage: { bbox: bboxOf(row), countries },
      access: {
        url,
        redirectHosts: [],
        unzip: null,
        headers: {},
        min_interval_s: 15,
      },
      format: 'gtfs-rt.vehicle-positions',
      licence: {
        id: null,
        url: licenceUrl,
        display: false,
        commercial: null,
        attribution: row.provider,
      },
      licence_decision: { by: 'none', evidence: [], terms_sha256: null, at: null },
      provenance,
    });
  }
  return { entries, untagged, rejected };
}

/**
 * Tagged feeds as entries, and the untagged ones that serve vehicles (about
 * 950 to check on a first run, most of them trip updates or alerts).
 * Untagged feeds already in the directory or among the tagged ones are not
 * fetched.
 * @param {{knownUrls: Set<string>, rejects: object, now: number, fetchImpl?: typeof fetch,
 *   checkPhase?: {leftMs: number}}} options `rejects` is updated in place
 * @returns {Promise<{entries: object[], checked: object[], untagged: number,
 *   rejected: {keyed: number, inactive: number}}>} `checked`: the untagged feeds among `entries`
 */
export async function harvestMobilityDatabase(options) {
  const { knownUrls, fetchImpl } = options;
  const res = await fetchCapped(MDB_CSV_URL, { maxBytes: 64 * 2 ** 20, timeoutMs: 120_000, fetchImpl });
  if (res.status !== 200) throw new Error(`Mobility Database CSV: HTTP ${res.status}`);
  const { entries, untagged, rejected } = mobilityDatabaseEntries(parseCsv(new TextDecoder().decode(res.body)));
  const known = new Set([...knownUrls, ...entries.map((e) => normalizeUrl(e.access.url))]);
  const checked = await resolveTransitCandidates(untagged, { ...options, knownUrls: known });
  return { entries: [...entries, ...checked], checked, untagged: untagged.length, rejected };
}
