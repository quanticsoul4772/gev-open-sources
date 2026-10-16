/**
 * NASA FIRMS (Fire Information for Resource Management System): worldwide
 * satellite active-fire detections, as the keyless CSV files FIRMS
 * regenerates every hour. Each file holds the previous UTC day plus the
 * current one (24–48 h), so a reader trims to the window it wants.
 *
 * MODIS (Terra/Aqua) and VIIRS on NOAA-20 and NOAA-21. Suomi NPP is left out:
 * NASA ends its observations on 2 Nov 2026. MODIS is due to end in 2026–27.
 *
 * Licence: the FIRMS FAQ says "NASA promotes full and open sharing of data"
 * and asks for the citation "NASA FIRMS"; NASA's data-use guidance licenses
 * mission data as CC0. Data are provided as is, and may not be used to imply
 * NASA's endorsement. A published agency policy, so it is a plain known
 * licence, not re-read each run (earthdata.nasa.gov answers 403 to the
 * Actions runner).
 */
export const FIRMS_LICENCE_URL = 'https://www.earthdata.nasa.gov/data/tools/firms/faq';

const BASE = 'https://firms.modaps.eosdis.nasa.gov/data/active_fire';

const FILES = [
  { id: 'firms-modis-24h', name: 'MODIS (Terra/Aqua)', path: 'modis-c6.1/csv/MODIS_C6_1_Global_24h.csv' },
  { id: 'firms-viirs-noaa20-24h', name: 'VIIRS NOAA-20', path: 'noaa-20-viirs-c2/csv/J1_VIIRS_C2_Global_24h.csv' },
  { id: 'firms-viirs-noaa21-24h', name: 'VIIRS NOAA-21', path: 'noaa-21-viirs-c2/csv/J2_VIIRS_C2_Global_24h.csv' },
];

export const FIRMS_PROVENANCE = 'firms:active-fire-24h';

export const FIRMS_ENTRIES = FILES.map(({ id, name, path }) => ({
  id,
  domain: 'hazards.fires',
  name: `NASA FIRMS active fires, ${name}, worldwide`,
  provider: 'NASA FIRMS',
  coverage: { bbox: [-90, -180, 90, 180], countries: [] },
  access: {
    url: `${BASE}/${path}`,
    redirectHosts: [],
    unzip: null,
    headers: {},
    min_interval_s: 300,
  },
  format: 'csv.firms-active-fire',
  licence: {
    id: null,
    url: FIRMS_LICENCE_URL,
    display: false,
    commercial: null,
    attribution: 'NASA FIRMS',
  },
  licence_decision: { by: 'none', evidence: [], terms_sha256: null, at: null },
  provenance: [FIRMS_PROVENANCE],
}));
