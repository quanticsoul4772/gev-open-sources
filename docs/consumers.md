# Using the directory

## Contract and versions

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

## Rules for consumers

- The directory is harvested from third-party catalogues: treat it as
  untrusted input and validate every entry yourself. It publishes facts
  (access recipe, coverage, licence, health), never a per-app "compatible"
  flag.
- Two rules are shared with gods-eye-view on purpose: which URLs and request
  headers carry a credential, and how large a coverage box of each class
  (`regional`, `national`, `global`) may be. Their cases live in
  [`conformance/cases.json`](../conformance/cases.json); this repo's tests run
  every case, and the app vendors the file, so the two copies can't drift.
- `coverage.class` is optional; absent means `regional`. Deliberately wide
  entries carry a hand-set class (Amtrak is `national`), and hazard feeds
  default to `global` unless the entry sets a class (fire perimeters are
  `regional`). Other worldwide feeds set `global` themselves
  (Sensor.Community).
- `coverage.countries` comes from the catalogue, dropping a code whose
  country misses the bbox. An entry the catalogue gave none (every Transitland
  Atlas feed) takes the one country holding most of its bbox, from simplified
  Natural Earth outlines (`src/harvest/country-outlines.json`), or, for a
  small coastal bbox the outlines put all at sea, the country whose coast is
  nearest its centre within 25 km. Global and continental feeds, and feeds
  whose bbox lies farther out at sea, keep an empty list.
- Hand-written entries (USGS, GDACS, FIRMS, fire perimeters,
  Sensor.Community) are never
  redirect-rewritten and never tombstoned: after a long outage they stay
  dead (unpublished) and come back when the source answers again. A change
  to one of them in the code doesn't reach its existing `entries/` file;
  edit that file by hand.
- Its size changes gradually. A harvest adds at most 8 % of the current
  entries, and of each domain's, per run (the rest wait for later runs), and
  a directory whose total is under 85 % or over 180 % of any copy published
  in the last 30 hours is not published (`published.json` in the state). A
  domain of 50 or more entries that moves out of that range only logs a
  warning: one operator going dark must not stop every domain publishing. A
  consumer that refreshes daily can reject copies under 80 % or over twice
  its own in total, and should keep its own copy of a domain file that moves
  out of range.
- Free-floating vehicle feeds carry per-vehicle ids and rental links. GBFS
  2.0+ asks operators to rotate ids after each trip, but not all do (car
  sharing in particular): don't keep per-vehicle history or trails.
- Redirects are followed only to the same origin or a host in
  `access.redirectHosts`. New entries carry `coverage.bbox`; a few older
  transit candidates still have `null` (unknown) until their vehicles are
  seen. URLs carry no credential the gate recognises (`src/util/secrets.js`),
  but treat that as a filter, not a proof. Feed URLs may be plain http, an
  IP address or a non-default port: apply your own URL policy. New `domain`
  and `format` values may appear: ignore the ones you don't decode.
