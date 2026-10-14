import { parseCsv } from '../util/csv.js';
import { fetchCapped, hasCredentialParam } from '../util/http.js';
import { slugId } from '../util/ids.js';
import { hostOfUrl, runPooled } from '../util/pool.js';

export const GBFS_SYSTEMS_URL =
  'https://raw.githubusercontent.com/MobilityData/gbfs/master/systems.csv';

const json = (bytes) => JSON.parse(new TextDecoder().decode(bytes));

/**
 * Feed list from a gbfs.json document: v3 `data.feeds`, v1/v2
 * `data.<lang>.feeds` (English preferred).
 * @returns {{version: string|null, feeds: Record<string,string>}}
 */
export function gbfsFeeds(doc) {
  const data = doc?.data || {};
  let list = Array.isArray(data.feeds) ? data.feeds : null;
  if (!list) {
    const lang = data.en ? 'en' : Object.keys(data).find((k) => Array.isArray(data[k]?.feeds));
    list = lang ? data[lang].feeds : [];
  }
  const feeds = {};
  for (const f of list || []) if (f?.name && f?.url) feeds[f.name] = f.url;
  return { version: doc?.version ? String(doc.version) : null, feeds };
}

/** bbox [minLat, minLon, maxLat, maxLon] of a station_information document. */
export function stationBbox(doc) {
  const stations = doc?.data?.stations || [];
  let b = null;
  for (const s of stations) {
    const lat = Number(s.lat);
    const lon = Number(s.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) continue;
    b = b
      ? [Math.min(b[0], lat), Math.min(b[1], lon), Math.max(b[2], lat), Math.max(b[3], lon)]
      : [lat, lon, lat, lon];
  }
  if (!b) return null;
  const r = (v) => Math.round(v * 1e4) / 1e4;
  return b.map(r);
}

/** Keyless systems from systems.csv rows. */
export function keylessSystems(rows) {
  return rows.filter(
    (r) =>
      !r['Authentication Type'] &&
      /^https:\/\//.test(r['Auto-Discovery URL']) &&
      !hasCredentialParam(r['Auto-Discovery URL']),
  );
}

/**
 * Resolve each keyless system not already known into a station-status entry.
 * @param {{known: Set<string>, fetchImpl?: typeof fetch}} options
 */
export async function harvestGbfs({ known, fetchImpl } = {}) {
  const res = await fetchCapped(GBFS_SYSTEMS_URL, { fetchImpl });
  if (res.status !== 200) throw new Error(`GBFS systems.csv: HTTP ${res.status}`);
  const systems = keylessSystems(parseCsv(new TextDecoder().decode(res.body))).filter(
    (r) => !known.has(slugId('gbfs', r['System ID'])),
  );
  const results = await runPooled(
    systems,
    (r) => hostOfUrl(r['Auto-Discovery URL']),
    async (r) => {
      const discovery = await fetchCapped(r['Auto-Discovery URL'], { fetchImpl, timeoutMs: 15_000 });
      if (discovery.status !== 200) return null;
      const { version, feeds } = gbfsFeeds(json(discovery.body));
      const status = feeds.station_status;
      const info = feeds.station_information;
      if (!status || !info || hasCredentialParam(status)) return null;
      const stations = await fetchCapped(info, { fetchImpl, timeoutMs: 15_000 });
      const bbox = stations.status === 200 ? stationBbox(json(stations.body)) : null;
      if (!bbox) return null;
      return {
        id: slugId('gbfs', r['System ID']),
        domain: 'bikeshare.stations',
        name: `${r.Name}${r.Location ? ` — ${r.Location}` : ''}`,
        provider: r.Name,
        coverage: { bbox, countries: r['Country Code'] ? [r['Country Code']] : [] },
        access: {
          url: status,
          related: {
            station_information: info,
            ...(feeds.system_information ? { system_information: feeds.system_information } : {}),
            gbfs: r['Auto-Discovery URL'],
          },
          redirectHosts: [],
          unzip: null,
          headers: {},
          min_interval_s: 60,
        },
        format: 'gbfs.station-status',
        gbfs: { system_id: r['System ID'], version },
        licence: { id: null, url: null, display: false, commercial: null, attribution: r.Name },
        licence_decision: { by: 'none', evidence: [], terms_sha256: null, at: null },
        provenance: [`gbfs-systems:${r['System ID']}`],
      };
    },
    { global: 24, perHost: 3 },
  );
  return results.filter((e) => e && !e.error);
}
