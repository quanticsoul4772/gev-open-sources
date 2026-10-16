/**
 * Canadian fire perimeters, as mapped by the provinces' wildfire agencies:
 * British Columbia's current season (BC Wildfire Service) and Ontario's
 * in-year fires (Ontario Ministry of Natural Resources). Both are ArcGIS
 * queries simplified at the source (`maxAllowableOffset=0.0002`, about 20 m).
 *
 * One format for both: each entry's `mapping` names the properties that hold
 * the fire number, size in hectares, date and (BC only) status and incident
 * page, and gives the region code. Ontario's own STATUS field says whether the
 * perimeter is final or interim, not whether the fire is active, so it is
 * left unmapped.
 *
 * Licences: Open Government Licence – British Columbia 2.0 (plus BC's API
 * terms: identify yourself; limits may change without notice) and Open
 * Government Licence – Ontario 1.0. Both data sets are for reference only.
 */
const BC_LICENCE = 'https://www2.gov.bc.ca/gov/content/data/policy-standards/data-policies/open-data/open-government-licence-bc';
const ON_LICENCE = 'https://www.ontario.ca/page/open-government-licence-ontario';

const entry = ({ id, name, provider, bbox, url, mapping, licenceUrl, attribution, provenance }) => ({
  id,
  domain: 'hazards.perimeters',
  name,
  provider,
  coverage: { bbox, countries: ['CA'], class: 'regional' },
  access: { url, redirectHosts: [], unzip: null, headers: {}, min_interval_s: 300 },
  format: 'geojson.fire-perimeters',
  mapping,
  licence: { id: null, url: licenceUrl, display: false, commercial: null, attribution },
  licence_decision: { by: 'none', evidence: [], terms_sha256: null, at: null },
  provenance: [provenance],
});

export const PERIMETER_ENTRIES = [
  entry({
    id: 'bc-wildfire-perimeters-current',
    name: 'British Columbia wildfire perimeters, current season',
    provider: 'BC Wildfire Service',
    bbox: [47.7, -139.6, 60.5, -113.5],
    url:
      'https://services6.arcgis.com/ubm4tcTYICKBpist/arcgis/rest/services/BCWS_FirePerimeters_PublicView/FeatureServer/0/query' +
      '?where=1%3D1&outFields=FIRE_NUMBER,FIRE_SIZE_HECTARES,FIRE_STATUS,TRACK_DATE,FIRE_URL&outSR=4326&maxAllowableOffset=0.0002&geometryPrecision=5&f=geojson',
    mapping: { id: 'FIRE_NUMBER', size_ha: 'FIRE_SIZE_HECTARES', updated: 'TRACK_DATE', status: 'FIRE_STATUS', url: 'FIRE_URL', region: 'CA-BC' },
    licenceUrl: BC_LICENCE,
    attribution: 'BC Wildfire Service. Contains information licensed under the Open Government Licence – British Columbia.',
    provenance: 'perimeters:bc-current',
  }),
  entry({
    id: 'ontario-fire-perimeters-in-year',
    name: 'Ontario forest fire perimeters, this year',
    provider: 'Ontario Ministry of Natural Resources',
    bbox: [41.1, -95.7, 57.4, -73.8],
    url:
      'https://ws.lioservices.lrc.gov.on.ca/arcgis2/rest/services/LIO_OPEN_DATA/LIO_Open09/MapServer/51/query' +
      '?where=1%3D1&outFields=FIRENUMB,CUR_SIZE,STATUS,DATE_MAPPED&outSR=4326&maxAllowableOffset=0.0002&geometryPrecision=5&f=geojson',
    mapping: { id: 'FIRENUMB', size_ha: 'CUR_SIZE', updated: 'DATE_MAPPED', region: 'CA-ON' },
    licenceUrl: ON_LICENCE,
    attribution: 'Ontario Ministry of Natural Resources. Contains information licensed under the Open Government Licence – Ontario.',
    provenance: 'perimeters:on-in-year',
  }),
];
