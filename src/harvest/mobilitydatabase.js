import { parseCsv } from '../util/csv.js';
import { fetchCapped } from '../util/http.js';
import { hasCredential } from '../util/secrets.js';
import { slugId } from '../util/ids.js';

export const MDB_CSV_URL = 'https://files.mobilitydatabase.org/feeds_v2.csv';

const bboxOf = (row) => {
  const v = [
    'location.bounding_box.minimum_latitude',
    'location.bounding_box.minimum_longitude',
    'location.bounding_box.maximum_latitude',
    'location.bounding_box.maximum_longitude',
  ].map((k) => Number.parseFloat(row[k]));
  return v.every(Number.isFinite) && v[0] <= v[2] && v[1] <= v[3] ? v : null;
};

/**
 * Keyless GTFS-Realtime vehicle-position feeds from the Mobility Database
 * catalog, as directory entries (licence undecided).
 * @param {Array<Record<string,string>>} rows parsed feeds_v2.csv
 * @returns {{entries: object[], rejected: {keyed: number, inactive: number}}}
 */
export function mobilityDatabaseEntries(rows) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const entries = [];
  const rejected = { keyed: 0, inactive: 0 };
  for (const row of rows) {
    if (row.data_type !== 'gtfs_rt') continue;
    if (!row.entity_type.split('|').includes('vp')) continue;
    const url = row['urls.direct_download'];
    if (row['urls.authentication_type'] !== '0' || hasCredential(url)) {
      rejected.keyed += 1;
      continue;
    }
    if (row.status !== 'active' || !/^https?:\/\//.test(url)) {
      rejected.inactive += 1;
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
    entries.push({
      id: slugId('mdb', row.id),
      domain: 'transit.vehicles',
      name: row.name || row.provider,
      provider: row.provider,
      coverage: {
        bbox: bboxOf(row),
        countries: row['location.country_code'] ? [row['location.country_code']] : [],
      },
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
  return { entries, rejected };
}

export async function harvestMobilityDatabase({ fetchImpl } = {}) {
  const res = await fetchCapped(MDB_CSV_URL, { maxBytes: 64 * 2 ** 20, timeoutMs: 120_000, fetchImpl });
  if (res.status !== 200) throw new Error(`Mobility Database CSV: HTTP ${res.status}`);
  return mobilityDatabaseEntries(parseCsv(new TextDecoder().decode(res.body)));
}
