/**
 * GDACS (Global Disaster Alert and Coordination System, a UN and European
 * Commission framework): the latest Orange and Red alerts for earthquakes,
 * tropical cyclones, floods, volcanoes, droughts and wildfires, as keyless
 * GeoJSON. One point per event; `properties.iscurrent` says whether it is
 * still active.
 *
 * Licence: GDACS's own feed declares `<copyright>public domain</copyright>`
 * (the RSS channel at GDACS_LICENCE_URL); its terms page holds only
 * disclaimers. Credit GDACS as the source.
 */
export const GDACS_LICENCE_URL = 'https://www.gdacs.org/xml/rss.xml';

export const GDACS_ENTRIES = [
  {
    id: 'gdacs-latest-alerts',
    domain: 'hazards.disasters',
    name: 'GDACS latest Orange and Red disaster alerts',
    provider: 'GDACS (United Nations and European Commission)',
    coverage: { bbox: [-90, -180, 90, 180], countries: [] },
    access: {
      url: 'https://www.gdacs.org/gdacsapi/api/events/geteventlist/LATEST',
      redirectHosts: [],
      unzip: null,
      headers: {},
      min_interval_s: 300,
    },
    format: 'geojson.gdacs-events',
    licence: {
      id: null,
      url: GDACS_LICENCE_URL,
      display: false,
      commercial: null,
      attribution: 'GDACS',
    },
    licence_decision: { by: 'none', evidence: [], terms_sha256: null, at: null },
    provenance: ['gdacs:geteventlist-latest'],
  },
];
