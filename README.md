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

   URLs that carry a credential parameter, and catalogue entries marked as
   needing a key, are skipped. Cross-domain permalinks are pointed at their
   final URL.
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

### For consumers

- The directory is harvested from third-party catalogues: treat it as
  untrusted input and validate every entry yourself. It publishes facts
  (access recipe, coverage, licence, health), never a per-app "compatible"
  flag, so consumer rules can't drift from a copy kept here.
- Its size changes gradually. A harvest adds at most 10 % of the current
  entries per run (the rest wait for later runs), and a directory under 85 %
  or over 180 % of any copy published in the last 30 hours is not published
  (`published.json` in the state). A consumer that refreshes daily can
  therefore reject copies under 80 % or over twice its own.
- Redirects are followed only to the same origin or a host in
  `access.redirectHosts`; transit and bike-share entries carry
  `coverage.bbox`; URLs never carry credentials. New `domain` and `format`
  values may appear: ignore the ones you don't decode.

```
npm ci
npm test
npm run cycle        # harvest → licence → probe → build (ANTHROPIC_API_KEY for tier 2)
```
