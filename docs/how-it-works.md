# How the directory is built

Every six hours a GitHub Actions run (`.github/workflows/directory.yml`):

1. **Discovers** keyless feeds:
   - GTFS-Realtime vehicle positions from the [Mobility Database](https://mobilitydatabase.org)
     catalog, [Transitland Atlas](https://github.com/transitland/transitland-atlas),
     [Transitous](https://github.com/public-transport/transitous) and
     [transport.data.gouv.fr](https://transport.data.gouv.fr). Catalogue
     feeds are fetched once and added only if they carry vehicle positions;
     failures are retried after a week (`harvest-rejects.json`). Mobility
     Database feeds not tagged as vehicle positions are checked the same way.
   - Bike-share systems from MobilityData's [GBFS systems list](https://github.com/MobilityData/gbfs),
     Transitous and transport.data.gouv.fr: docked stations (`bikeshare.stations`, `gbfs.station-status`)
     and free-floating vehicles (`sharedmobility.vehicles`, `gbfs.vehicle-status`:
     scooters, bikes, mopeds and cars from `vehicle_status`, or
     `free_bike_status` before v3). A system with both gets one entry for
     each. Vehicles entries count only vehicles without a `station_id`
     (docked ones belong to the stations entry) and list
     `gbfs.form_factors` from `vehicle_types` (empty means unknown).
     Peer-to-peer car sharing (Getaround and similar: private owners' cars,
     often parked at home) is left out; fleet car sharing stays.
   - USGS [earthquake summary feeds](https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php)
     (`hazards.earthquakes`, GeoJSON, public domain).
   - GDACS [latest Orange and Red disaster alerts](https://www.gdacs.org/)
     (`hazards.disasters`, format `geojson.gdacs-events`): earthquakes,
     tropical cyclones, floods, volcanoes, droughts and wildfires, one point
     per event (`properties.iscurrent` marks active ones). Public domain by
     GDACS's own declaration in its RSS feed; the licence job re-reads that
     declaration every run and drops to referral-only if it is gone.
   - NASA [FIRMS active fires](https://firms.modaps.eosdis.nasa.gov/active_fire/)
     (`hazards.fires`, format `csv.firms-active-fire`): the keyless worldwide
     CSV files for MODIS and VIIRS on NOAA-20 and NOAA-21, regenerated
     hourly. Each holds the previous UTC day plus the current one (24–48 h),
     so trim to the window you want. Detections arrive up to 3 h after the
     satellite pass, so these entries are stale only after 6 h (other
     formats: 15 min). Suomi NPP is left out (it ends 2 Nov 2026); MODIS is
     due to end in 2026–27. Licence: NASA's open-data policy (the FIRMS FAQ's
     "NASA promotes full and open sharing of data"), a known licence that is
     not re-read: earthdata.nasa.gov answers 403 to the Actions runner. Cite
     "NASA FIRMS"; data are
     provided as is, and may not be used to imply NASA's endorsement. The
     file names are fixed: if NASA moves them behind Earthdata Login, the
     probes fail rather than following the redirect.
   - Canadian fire perimeters (`hazards.perimeters`, format
     `geojson.fire-perimeters`, class `regional`): British Columbia's current
     season (BC Wildfire Service), Alberta's active fires (Alberta Wildfire)
     and Ontario's in-year fires (Ontario Ministry of Natural Resources), as
     ArcGIS queries simplified at the source (about 20 m). Each entry's
     `mapping` names the properties holding the fire number, size in hectares,
     mapping date (epoch ms or `YYYY-MM-DD[Z]`) and, for BC and Alberta, the
     fire's status as the province reports it; BC alone has an incident page;
     `region` gives the ISO 3166-2 code. BC reports `Out of Control`,
     `Being Held`, `Under Control` or `Out` (may be null); Alberta reports the
     first three plus `Assistance Started` (mutual aid) and `Turned Over`,
     which apps may not colour. Ontario's own `STATUS` is the perimeter's
     (F final, I interim), not the fire's, so it is not mapped. Sizes are each
     province's official estimate, which can differ from the drawn polygon;
     Alberta's date is when the perimeter was captured, often weeks before
     its latest status, and only mapped (mostly larger) fires have a
     perimeter.
     No freshness check: perimeters are mapped irregularly. An empty feed out
     of season is idle: a verified entry turns degraded after 7 days, and a
     new entry that has never had records (Alberta out of season) stays a
     candidate, not usable by apps, until its first fire. A server frozen on
     old data stays verified. A cut-off response, non-lon/lat coordinates or
     a renamed id field fail the probe.
     Licences: Open Government Licence – British Columbia 2.0 (with BC's API
     terms: identify yourself, limits may change without notice), – Alberta
     2.2 and – Ontario 1.0. Alberta's reaches the layer through the
     open.alberta.ca dataset `alberta-wildfire-status-map` (licence OGLA),
     whose only resource is the status map that uses this layer; the layer's
     own item names no licence. The version is pinned in the known licence
     (`OGL-AB-2.2`), not re-read: licence pages may be blocked from the
     Actions runner. Credit each feed with its `licence.attribution`, use no
     provincial logos, and present the perimeters as reference only (each
     province publishes them "as is"; Alberta's updates "can take several
     hours or more").
     BC rolls its layer over on 1 April (a few late-winter fires may remain);
     Alberta's view is filtered by status, not year; Ontario's URL pins ArcGIS
     layer 51 and Alberta's service name contains `(PROD)`, so a republished
     or renamed service needs the entry fixed by hand. With three entries, one
     dropping out is a 33 % fall, and an app that refuses large drops (as
     God's Eye View does) keeps its previous copy of the domain.
   - [Sensor.Community](https://sensor.community/) particulate sensors
     (`airquality.sensors`, format `json.sensor-community`, class `global`):
     the keyless `data.1h.json` file, each volunteer sensor's mean over the
     last hour, mostly in Europe (about 9,300 outdoor PM sensors). PM sensors
     report `P1` (PM10) and `P2` (PM2.5) in µg/m³; other sensor types share
     the file. `timestamp` is the sensor's last sample, in UTC without a
     zone. The probe counts outdoor sensors with a PM value from 0 to under
     999 (the SDS011's ceiling); the entry is stale after 3 h. The file is
     8.7 MB and served uncompressed. These are uncalibrated low-cost
     sensors: indicative, not regulatory, and they read high in humid air.
     Licence: the site footer's "DB Contents License" is the Open Data
     Commons DbCL 1.0 (known licence `DbCL-1.0`), which requires complying
     with the ODbL for the database: credit Sensor.Community and keep a
     published derived database under the ODbL. Sensor.Community doesn't
     name the ODbL itself; that follows from the DbCL. The API asks clients
     to send a User-Agent that identifies them.
   - Still traffic cameras (`cameras.stills`, format `cameras.list`): Finland's
     Digitraffic weather cameras (CC BY 4.0), TfL JamCams and Caltrans CCTV
     (12 districts). Each entry carries a `mapping` that says where each
     camera's id, position and image sit in the list; the prober also checks
     one sample image (200, an image type, at least 2 KB). TfL and Caltrans
     stay referral-only until the licence job verifies their terms.

   URLs that carry a credential parameter, and catalogue entries marked as
   needing a key, are skipped. Cross-domain permalinks are pointed at their
   final URL, and plain-http feeds move to https when it serves the same data.

   Feeds on the never-list, `excluded.json`, are never listed: discovery
   skips them, and the harvest removes any entry they match. Each item has a
   feed `url` (for a GBFS system, its discovery URL: the whole system goes), a
   `reason` and, optionally, an entry `id`. A URL matches over http or https,
   and also matches a permalink that led to the feed. Copies retired as a
   removed feed's duplicates stay out with it. Taking an item off the list
   lets the feed back on the next harvest. A malformed item fails the run.
2. **Decides licences** with no human step: a known open licence
   (`src/licence/known-licences.json`). A transit feed with no licence of its
   own takes the one Transitland Atlas records for it, or (borrowed, known
   licences only) for its own static feed. A GBFS system whose feed names no
   licence takes the known licence its operator declares on its own open-data
   page for those feed URLs (`DECLARED_GBFS_LICENCES` in
   `src/licence/index.js`, with the page and its quote as evidence; pinned,
   not re-read): Vélib' Métropole (`gbfs-paris`), Licence Ouverte 2.0.
   GBFS 3.x systems with no licence are CC0 per the spec; operator terms pages are read by Claude and accepted only
   when every quote is verbatim in the page, two runs agree, and every
   obligation is one an app meets on its own. Everything else is
   referral-only (`licence.display: false`).
3. **Probes** every entry with the decoder an app would use, and moves it
   through `candidate → verified ⇄ degraded → dead` (verified: 3 passes in a
   row with records seen in 7 days). A passing candidate is probed up to three
   times in one run, 5 minutes apart, so a working new feed is verified in the
   run that finds it. Dead for 30 days → removed. A vehicle-position entry
   whose vehicle ids (5 or more) are nearly the same as another's (MinHash
   similarity ≥ 0.9, vehicle counts within 10 %, overlapping areas), two runs
   in a row, serves the same feed under another URL: one is kept (hand-written,
   else not dead, else cleared for display, else verified, else the one probed
   first) and the others are removed and tombstoned (`reason: 'duplicate'`,
   `of`: the kept id). Once the kept entry is dead or removed, the tombstones
   of its copies are dropped and discovery adds them again.
4. **Publishes** `v1/directory.json` to GitHub Pages:
   `https://quanticsoul4772.github.io/gev-open-sources/v1/directory.json`.

An entry is usable when `health.status === 'verified'` and
`licence.display === true`. Schema: [`schema/entry.schema.json`](../schema/entry.schema.json).
