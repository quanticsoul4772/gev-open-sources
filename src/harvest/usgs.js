/**
 * USGS earthquake summary feeds (earthquake.usgs.gov/earthquakes/feed/v1.0):
 * fixed, keyless GeoJSON files rebuilt every minute. One entry per magnitude
 * band, each with the shortest window that reliably holds events (the health
 * rule wants records within 7 days). all_month (≈7 MB) is left out.
 */
const BASE = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary';
export const USGS_LICENCE_URL = 'https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits';

const FEEDS = [
  ['all_hour', 'All earthquakes, past hour'],
  ['all_day', 'All earthquakes, past day'],
  ['1.0_week', 'M1.0+ earthquakes, past week'],
  ['2.5_week', 'M2.5+ earthquakes, past week'],
  ['4.5_month', 'M4.5+ earthquakes, past month'],
];

export const USGS_ENTRIES = FEEDS.map(([feed, title]) => ({
  id: `usgs-eq-${feed.replace('.', '-').replace('_', '-')}`,
  domain: 'hazards.earthquakes',
  name: `USGS ${title}`,
  provider: 'U.S. Geological Survey',
  coverage: { bbox: [-90, -180, 90, 180], countries: [] },
  access: {
    url: `${BASE}/${feed}.geojson`,
    redirectHosts: [],
    unzip: null,
    headers: {},
    min_interval_s: 60,
  },
  format: 'geojson.earthquakes',
  licence: {
    id: null,
    url: USGS_LICENCE_URL,
    display: false,
    commercial: null,
    attribution: 'U.S. Geological Survey',
  },
  licence_decision: { by: 'none', evidence: [], terms_sha256: null, at: null },
  provenance: ['usgs:earthquake-summary-feeds'],
}));
