# gev-open-sources

A self-maintaining directory of live data sources that need no API key, for
[God's Eye View](https://github.com/bilawalsidhu/gods-eye-view). Every six
hours a GitHub Actions run:

1. **Discovers** keyless feeds:
   - GTFS-Realtime vehicle positions from the [Mobility Database](https://mobilitydatabase.org)
     catalog, [Transitland Atlas](https://github.com/transitland/transitland-atlas)
     and [Transitous](https://github.com/public-transport/transitous). Catalogue
     feeds are fetched once and added only if they carry vehicle positions;
     failures are retried after a week (`harvest-rejects.json`).
   - Bike-share systems from MobilityData's [GBFS systems list](https://github.com/MobilityData/gbfs)
     and Transitous.
   - USGS [earthquake summary feeds](https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php)
     (`hazards.earthquakes`, GeoJSON, public domain).
   - Still traffic cameras (`cameras.stills`, format `cameras.list`): Finland's
     Digitraffic weather cameras (CC BY 4.0), TfL JamCams and Caltrans CCTV
     (12 districts). Each entry carries a `mapping` that says where each
     camera's id, position and image sit in the list; the prober also checks
     one sample image (200, an image type, at least 2 KB). TfL and Caltrans
     stay referral-only until the licence job verifies their terms.

   URLs that carry a credential parameter, and catalogue entries marked as
   needing a key, are skipped. Cross-domain permalinks are pointed at their
   final URL, and plain-http feeds move to https when it serves the same data.
2. **Decides licences** with no human step: a known open licence
   (`src/licence/known-licences.json`); GBFS 3.x systems with no licence are
   CC0 per the spec; operator terms pages are read by Claude and accepted only
   when every quote is verbatim in the page, two runs agree, and every
   obligation is one an app meets on its own. Everything else is
   referral-only (`licence.display: false`).
3. **Probes** every entry with the decoder an app would use, and moves it
   through `candidate → verified ⇄ degraded → dead` (verified: 3 passes in a
   row with records seen in 7 days). A passing candidate is probed up to three
   times in one run, 5 minutes apart, so a working new feed is verified in the
   run that finds it. Dead for 30 days → removed.
4. **Publishes** `directory.json` to GitHub Pages:
   `https://quanticsoul4772.github.io/gev-open-sources/directory.json`.

An entry is usable when `health.status === 'verified'` and
`licence.display === true`. Schema: `schema/entry.schema.json`.

### Contract and versions

Published files, contract version 1:

| Path | Contents |
|---|---|
| `v1/directory.json` | every entry, with its health summary |
| `v1/<domain>.json` | one domain's entries, e.g. `v1/transit.vehicles.json` |
| `v1/index.json` | `generated_at`, and each file's path, domain, entry counts and bytes |
| `v1/entry.schema.json` | the entry schema; its `$id` names the version |
| `directory.json`, `entry.schema.json` | aliases of the v1 files |
| `state/*.json` | job state for the next run; not part of the contract |

Pages serves every file gzipped with an ETag, so a daily conditional GET of
the domain files a consumer reads costs little.

Version policy:

- **Additive changes keep the version**: a new optional field, a new
  `domain` or `format` value, a new per-domain file.
- **Breaking changes bump it**: removing or renaming a field, changing a
  field's type or meaning, or weakening a documented guarantee. The new
  version is published as `v2/` beside `v1/`, and `v1/` keeps being
  generated from the same data for at least 30 days before it is retired.
- Every document carries `version`. Pin `v1/` paths; the unversioned aliases
  follow the newest version.

### For consumers

- The directory is harvested from third-party catalogues: treat it as
  untrusted input and validate every entry yourself. It publishes facts
  (access recipe, coverage, licence, health), never a per-app "compatible"
  flag, so consumer rules can't drift from a copy kept here.
- Its size changes gradually. A harvest adds at most 10 % of the current
  entries per run (the rest wait for later runs), and a directory under 85 %
  or over 180 % of any copy published in the last 30 hours is not published
  (`published.json` in the state). Both rules also hold per domain, for a
  domain that had at least 50 entries (smaller domains never block a
  publish). A consumer that refreshes daily can
  therefore reject copies under 80 % or over twice its own, in total or per
  domain file.
- Redirects are followed only to the same origin or a host in
  `access.redirectHosts`; transit and bike-share entries carry
  `coverage.bbox`; URLs never carry credentials. New `domain` and `format`
  values may appear: ignore the ones you don't decode.

```
npm ci
npm test
npm run cycle        # harvest → licence → probe → build (ANTHROPIC_API_KEY for tier 2)
node src/scan-secrets.js entries dist   # gate: no credentials in any output
node src/validate-dist.js entries dist  # gate: every entry valid against the schema
```
