/**
 * Seed the directory from the sources God's Eye View already ships, plus the
 * BODS England bulk feed. Licences start undecided; the licence job decides.
 * Usage: node src/seed.js [path-to-gods-eye-view]
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeEntry } from './store.js';

/** bbox [minLat, minLon, maxLat, maxLon] around a centre. */
export function bboxAround(lat, lon, radiusKm) {
  const dLat = radiusKm / 111.32;
  const dLon = radiusKm / (111.32 * Math.max(0.05, Math.cos((lat * Math.PI) / 180)));
  const r = (v) => Math.round(v * 1e4) / 1e4;
  return [
    r(Math.max(-90, lat - dLat)),
    r(Math.max(-180, lon - dLon)),
    r(Math.min(90, lat + dLat)),
    r(Math.min(180, lon + dLon)),
  ];
}

const UNDECIDED = (url = null, attribution = null) => ({
  licence: { id: null, url, display: false, commercial: null, attribution },
  licence_decision: { by: 'none', evidence: [], terms_sha256: null, at: null },
});

export const BODS_ENTRY = {
  id: 'bods-england',
  domain: 'transit.vehicles',
  name: 'Bus Open Data Service — England',
  provider: 'Department for Transport',
  coverage: { bbox: [49.86, -6.42, 55.82, 1.77], countries: ['GB'] },
  access: {
    url: 'https://data.bus-data.dft.gov.uk/avl/download/gtfsrt',
    redirectHosts: ['download.bus-data.dft.gov.uk'],
    unzip: 'gtfsrt.bin',
    headers: {},
    min_interval_s: 20,
  },
  format: 'gtfs-rt.vehicle-positions',
  ...UNDECIDED(
    'https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/',
    'Contains Department for Transport Bus Open Data Service data',
  ),
  provenance: ['seed:bods'],
};

export async function seedEntries(appRoot) {
  const load = (rel) => import(pathToFileURL(path.join(appRoot, rel)).href);
  const { TRANSIT_FEED_REGISTRY } = await load('src/data/transitFeeds.js');
  const { GBFS_CITY_REGISTRY } = await load('src/layers/bikeshare/registry.js');
  const entries = [BODS_ENTRY];
  for (const feed of TRANSIT_FEED_REGISTRY)
    entries.push({
      id: feed.id,
      domain: 'transit.vehicles',
      name: feed.name,
      provider: feed.operator,
      coverage: {
        bbox: bboxAround(feed.center.lat, feed.center.lon, feed.loadRadiusKm),
        countries: [],
      },
      access: {
        url: feed.url,
        redirectHosts: [],
        unzip: null,
        headers: { ...(feed.headers || {}) },
        min_interval_s: 15,
      },
      format: 'gtfs-rt.vehicle-positions',
      ...UNDECIDED(feed.licenseUrl || null, feed.attribution || null),
      provenance: ['seed:gods-eye-view'],
    });
  for (const city of GBFS_CITY_REGISTRY)
    entries.push({
      id: `gbfs-${city.id}`,
      domain: 'bikeshare.stations',
      name: `${city.provider} — ${city.city}`,
      provider: city.provider,
      coverage: {
        bbox: bboxAround(city.centerLat, city.centerLon, city.loadRadiusKm),
        countries: [],
      },
      access: {
        url: city.stationStatusUrl,
        related: { station_information: city.stationInformationUrl },
        redirectHosts: [],
        unzip: null,
        headers: {},
        min_interval_s: 60,
      },
      format: 'gbfs.station-status',
      ...UNDECIDED(null, city.provider),
      provenance: ['seed:gods-eye-view'],
    });
  return entries;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const appRoot = path.resolve(process.argv[2] || '../gods-eye-view');
  const entries = await seedEntries(appRoot);
  let written = 0;
  for (const entry of entries) if (writeEntry(entry)) written += 1;
  console.log(`seed: ${entries.length} entries, ${written} written`);
}
