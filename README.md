# gev-open-sources

A self-maintaining directory of live data sources that need no API key, built
for [God's Eye View](https://github.com/bilawalsidhu/gods-eye-view). Upstream
God's Eye View does not read it yet; [a fork's `local` branch](https://github.com/quanticsoul4772/gods-eye-view/tree/local)
does.

Every six hours a GitHub Actions run discovers keyless feeds in public
catalogues, decides whether each one's licence allows display, probes each
one with the decoder an app would use, and publishes the result to GitHub
Pages.

## What's in it

One `domain` per kind of data:

- `transit.vehicles`: GTFS-Realtime vehicle positions
- `bikeshare.stations`: docked bike-share stations (GBFS)
- `sharedmobility.vehicles`: free-floating bikes, scooters, mopeds and cars (GBFS)
- `hazards.earthquakes`: USGS earthquake feeds
- `hazards.disasters`: GDACS Orange and Red alerts
- `hazards.fires`: NASA FIRMS active fires
- `hazards.perimeters`: Canadian provincial fire perimeters
- `airquality.sensors`: Sensor.Community particulate sensors
- `cameras.stills`: still traffic cameras

On 28 October 2026 it held 2,263 entries, 1,124 of them usable; the current
counts per domain are in
[`v1/index.json`](https://quanticsoul4772.github.io/gev-open-sources/v1/index.json).

Where each one comes from, and the rules for discovery, licences, health and
duplicates: [docs/how-it-works.md](docs/how-it-works.md).

## Use it

```
https://quanticsoul4772.github.io/gev-open-sources/v1/directory.json
```

An entry is usable when `health.status === 'verified'` and
`licence.display === true`. The published files, the version policy and the
rules a consumer should follow, with a quick start, a sample entry and the
field and format reference: [docs/consumers.md](docs/consumers.md).
Schema: [`schema/entry.schema.json`](schema/entry.schema.json).

## Contributing

- **A feed is wrong, or missing:** open an issue with its URL.
- **You operate a feed listed here** and want it removed or its licence
  corrected: open an issue. A removed feed goes on the never-list,
  `excluded.json`, so later harvests don't add it back.
- **Adding a hand-written source** (one no catalogue lists): write its
  entries in a module in `src/harvest/` and list them in both `STATIC_ENTRIES`
  (`src/harvest/static.js`) and the candidate list in
  `src/harvest/index.js`. A new `domain` or `format` also needs its value in
  `schema/entry.schema.json` and in `DOMAINS` or `FORMATS` in `src/schema.js`,
  and a decoder in `src/adapters/index.js`. Its
  licence is decided like any other entry's (step 2 in
  [docs/how-it-works.md](docs/how-it-works.md)); until then it is
  referral-only. Every pull request must pass the `test` workflow.

## Run it

Requires Node 22 or later (CI runs 24). Without `ANTHROPIC_API_KEY`, the
licence job still fetches operator terms pages but has Claude read none: feeds
that need one keep the result cached from an earlier run, or stay
referral-only.

```
npm ci
npm test
npm run cycle        # harvest → licence → probe → build
node src/scan-secrets.js entries dist   # gate: no credentials in any output
node src/validate-dist.js entries dist  # gate: every entry valid against the schema
```

To run your own copy on GitHub:

- set Pages to deploy from GitHub Actions;
- add `ANTHROPIC_API_KEY` as a repository secret (optional, see above);
- optionally require the `test` status check on `main` with a ruleset, as
  this repository does: the directory run tests its own commit, marks it
  `test: success` and then pushes it to `main`.

The first run finds nothing published and starts from empty state; later runs
restore their state from the published site (`src/restore-state.js`).

## Licence

The code is MIT. Each entry's data is under its own source's licence,
recorded in the entry's `licence` field.
