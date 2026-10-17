/**
 * Sensor.Community (formerly luftdaten.info): volunteer low-cost particulate
 * sensors, mostly in Europe. The keyless `data.1h.json` file holds each
 * sensor's mean over the last hour (all sensor types; the PM sensors report
 * P1 = PM10 and P2 = PM2.5 in µg/m³). The API wiki asks clients to send a
 * User-Agent that identifies them; the prober's default one does.
 *
 * Licence: the site footer (sensor.community, "legal") links its "DB Contents
 * License" to the Open Data Commons Database Contents License 1.0. DbCL §2.1
 * allows any use, commercial included; §2.2 requires complying with the ODbL,
 * and §2.3 points to "the ODbL covering the Database". Sensor.Community does
 * not name the ODbL itself: that part is read from the DbCL. A plain known
 * licence: the URL is the licence text, not a page to re-read.
 */
export const SENSOR_COMMUNITY_LICENCE_URL = 'https://opendatacommons.org/licenses/dbcl/1-0/';

export const AIRQUALITY_PROVENANCE = 'sensor-community:pm-1h';

export const AIRQUALITY_ENTRIES = [
  {
    id: 'sensor-community-pm-1h',
    domain: 'airquality.sensors',
    name: 'Sensor.Community particulate sensors (PM2.5, PM10), 1-hour means',
    provider: 'Sensor.Community',
    coverage: { class: 'global', bbox: [-90, -180, 90, 180], countries: [] },
    access: {
      url: 'https://data.sensor.community/static/v2/data.1h.json',
      redirectHosts: [],
      unzip: null,
      headers: {},
      min_interval_s: 300,
    },
    format: 'json.sensor-community',
    licence: {
      id: null,
      url: SENSOR_COMMUNITY_LICENCE_URL,
      display: false,
      commercial: null,
      attribution: 'Sensor.Community (contents DbCL 1.0, database per ODbL 1.0)',
    },
    licence_decision: { by: 'none', evidence: [], terms_sha256: null, at: null },
    provenance: [AIRQUALITY_PROVENANCE],
  },
];
