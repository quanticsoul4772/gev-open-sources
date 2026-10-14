/**
 * Still traffic cameras (domain cameras.stills, format cameras.list): one
 * entry per keyless camera list, read through its `mapping`. Each list is
 * fetched once when first added, for its coverage bbox; the prober then checks
 * the list and one sample image every run.
 *
 * Licences: Digitraffic is CC BY 4.0 (tier 1). TfL and Caltrans terms pages
 * can't be read automatically today (TfL answers 403 to bots; Caltrans' page is
 * read by tier 2), so those entries stay referral-only until the licence job
 * verifies them (decided with parallax, 2026-10-14).
 */
import { cameraRecords } from '../adapters/cameras.js';
import { fetchCapped } from '../util/http.js';
import { hostOfUrl, runPooled } from '../util/pool.js';
import { pointsBbox } from './catalogue.js';

const CALTRANS_DISTRICTS = Array.from({ length: 12 }, (_, i) => i + 1);

const entry = ({ id, name, provider, url, countries, mapping, licenceUrl, attribution, minInterval, provenance }) => ({
  id,
  domain: 'cameras.stills',
  name,
  provider,
  coverage: { bbox: null, countries },
  access: { url, redirectHosts: [], unzip: null, headers: {}, min_interval_s: minInterval },
  format: 'cameras.list',
  mapping,
  licence: { id: null, url: licenceUrl, display: false, commercial: null, attribution },
  licence_decision: { by: 'none', evidence: [], terms_sha256: null, at: null },
  provenance,
});

export const CAMERA_SOURCES = [
  entry({
    id: 'cameras-digitraffic-weathercam',
    name: 'Digitraffic road weather cameras — Finland',
    provider: 'Fintraffic',
    url: 'https://tie.digitraffic.fi/api/weathercam/v1/stations',
    countries: ['FI'],
    mapping: {
      items: 'features',
      id: 'properties.id',
      name: 'properties.name',
      lat: 'geometry.coordinates.1',
      lon: 'geometry.coordinates.0',
      image: 'properties.presets.0.id',
      image_template: 'https://weathercam.digitraffic.fi/{value}.jpg',
    },
    licenceUrl: 'https://creativecommons.org/licenses/by/4.0/',
    attribution: 'Source: Fintraffic / digitraffic.fi, license CC 4.0 BY',
    minInterval: 300,
    provenance: ['cameras:digitraffic-weathercam'],
  }),
  entry({
    id: 'cameras-tfl-jamcams',
    name: 'TfL JamCams — London',
    provider: 'Transport for London',
    url: 'https://api.tfl.gov.uk/Place/Type/JamCam',
    countries: ['GB'],
    mapping: {
      items: '',
      id: 'id',
      name: 'commonName',
      lat: 'lat',
      lon: 'lon',
      image: 'additionalProperties[key=imageUrl].value',
      active: 'additionalProperties[key=available].value',
    },
    licenceUrl: 'https://tfl.gov.uk/corporate/terms-and-conditions/transport-data-service',
    attribution: 'Powered by TfL Open Data',
    minInterval: 120,
    provenance: ['cameras:tfl-jamcams'],
  }),
  ...CALTRANS_DISTRICTS.map((d) => {
    const nn = String(d).padStart(2, '0');
    return entry({
      id: `cameras-caltrans-d${nn}`,
      name: `Caltrans CCTV — District ${d}`,
      provider: 'Caltrans',
      url: `https://cwwp2.dot.ca.gov/data/d${d}/cctv/cctvStatusD${nn}.json`,
      countries: ['US'],
      mapping: {
        items: 'data',
        id: 'cctv.index',
        name: 'cctv.location.locationName',
        lat: 'cctv.location.latitude',
        lon: 'cctv.location.longitude',
        image: 'cctv.imageData.static.currentImageURL',
        active: 'cctv.inService',
      },
      licenceUrl: 'https://dot.ca.gov/conditions-of-use',
      attribution: 'Caltrans',
      minInterval: 120,
      provenance: [`cameras:caltrans-d${nn}`],
    });
  }),
];

/**
 * Camera entries not yet in the directory, each with a bbox from its cameras.
 * A list that can't be read now is skipped and tried again next run.
 * @param {{knownIds: Set<string>, fetchImpl?: typeof fetch}} options
 */
export async function harvestCameras({ knownIds, fetchImpl }) {
  const todo = CAMERA_SOURCES.filter((e) => !knownIds.has(e.id));
  const results = await runPooled(
    todo,
    (e) => hostOfUrl(e.access.url),
    async (e) => {
      const res = await fetchCapped(e.access.url, { fetchImpl, timeoutMs: 60_000 });
      if (res.status !== 200) return null;
      const cameras = cameraRecords(JSON.parse(new TextDecoder().decode(res.body)), e.mapping);
      if (!cameras.length) return null;
      return { ...e, coverage: { ...e.coverage, bbox: pointsBbox(cameras.map((c) => [c.lat, c.lon])) } };
    },
    { global: 6, perHost: 2 },
  );
  return results.filter((r) => r && !r.error);
}
