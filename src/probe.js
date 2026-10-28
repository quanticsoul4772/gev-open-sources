/**
 * Health job: probe every entry with its own request recipe and decoder, and
 * advance its health state. A passing candidate is probed up to three times
 * in one run (probeRounds), so a working new feed is verified the run it is
 * found. Dead entries are probed once a day; dead for 30 days → entry removed
 * and tombstoned so discovery doesn't re-add it (hand-written entries stay).
 * A vehicle-position entry with nearly the same vehicle ids as another, in an
 * overlapping area, two runs in a row serves the same feed under another URL:
 * all but one are retired the same way (retireDuplicates), so the app doesn't
 * draw every vehicle twice. Once the kept entry is dead or gone, its retired
 * copies are released (releaseDuplicates, harvest/index.js) and discovery adds
 * them again.
 */
import { pathToFileURL } from 'node:url';
import { ADAPTERS, fingerprintSimilarity } from './adapters/index.js';
import { readExcluded } from './harvest/excluded.js';
import { releaseDuplicates } from './harvest/index.js';
import { isStaticEntry } from './harvest/static.js';
import { DAY_S, HISTORY_CAP, applyProbe, classify, emptyHealth } from './health.js';
import { readEntries, readState, removeEntry, writeState } from './store.js';
import { fetchCapped } from './util/http.js';
import { hostOfUrl, runPooled } from './util/pool.js';
import { readZipEntry } from './util/zip.js';

/**
 * Larger limits for formats whose files can be big (FIRMS VIIRS files reach
 * about 26 MB in peak fire season; a record BC fire season was 8 MB at full
 * detail); every other format keeps fetchCapped's 8 MiB and 20 s.
 */
export const PROBE_LIMITS_BY_FORMAT = Object.freeze({
  'csv.firms-active-fire': { maxBytes: 48 * 2 ** 20, timeoutMs: 60_000 },
  'geojson.fire-perimeters': { maxBytes: 32 * 2 ** 20, timeoutMs: 60_000 },
  'json.sensor-community': { maxBytes: 24 * 2 ** 20, timeoutMs: 60_000 },
});

/** Probe one entry; never throws. */
export async function probeEntry(entry, { now, fetchImpl } = {}) {
  let res;
  try {
    res = await fetchCapped(entry.access.url, {
      headers: entry.access.headers,
      redirectHosts: entry.access.redirectHosts,
      fetchImpl,
      ...PROBE_LIMITS_BY_FORMAT[entry.format],
    });
  } catch {
    return { at: now, ...classify({ error: 'network' }) };
  }
  // 204 No Content: the feed has nothing to send (Oise buses at night and on
  // weekends), an empty feed rather than a failure.
  if (res.status === 204) return { at: now, ...classify({ status: 200, decoded: { records: 0, newest: null }, now }) };
  if (res.status !== 200) return { at: now, ...classify({ status: res.status }) };
  try {
    const body = entry.access.unzip ? readZipEntry(res.body, entry.access.unzip) : res.body;
    const decoded = ADAPTERS[entry.format](body, entry.coverage.bbox, entry);
    if (decoded.sample) {
      const sample = await checkSample(decoded.sample, fetchImpl);
      if (sample) return { at: now, ...sample };
    }
    const result = classify({ status: 200, decoded, now });
    return { at: now, ...result, ...(result.result === 'ok' && decoded.fingerprint ? { fingerprint: decoded.fingerprint } : {}) };
  } catch {
    return { at: now, ...classify({ error: 'decode' }) };
  }
}

/** A sample (camera image) smaller than this is a placeholder, not a picture. */
export const MIN_SAMPLE_BYTES = 2_000;

/** A failed probe result when a sample URL isn't a real image, else null. */
async function checkSample(url, fetchImpl) {
  let res;
  try {
    res = await fetchCapped(url, { fetchImpl, timeoutMs: 15_000, maxBytes: 5 * 2 ** 20 });
  } catch {
    return classify({ error: 'network' });
  }
  if (res.status !== 200) return classify({ status: res.status });
  const type = res.headers.get('content-type') || '';
  if (!/^image\//i.test(type) || res.body.byteLength < MIN_SAMPLE_BYTES) return classify({ error: 'decode' });
  return null;
}

/** Probes per run for a candidate that keeps passing: 1 + EXTRA_ROUNDS. */
export const EXTRA_ROUNDS = 2;
/** Least time between two probes of one entry in a run (and ≥ its min_interval_s). */
export const ROUND_SPACING_S = 300;
/** No round starts later than this after the first, so the job ends well inside its 60 min. */
export const ROUNDS_BUDGET_S = 30 * 60;

const nowS = () => Math.floor(Date.now() / 1000);
const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Probe entries in rounds. Every entry is probed once; a candidate whose
 * probe passed is probed again, spaced ROUND_SPACING_S apart, up to
 * 1 + EXTRA_ROUNDS times, so a working new feed is verified in one run
 * rather than three. Each probe uses a fresh clock; every round counts toward
 * the state machine, but only the run's final result enters history.
 * @param {object[]} entries
 * @param {Record<string, object>} health updated in place
 * @param {{probe: (entry: object, at: number) => Promise<object>, clock?: () => number,
 *   sleep?: (ms: number) => Promise<void>, budgetS?: number}} options
 * @returns {Promise<{counts: Record<string, number>, rounds: number}>}
 */
export async function probeRounds(entries, health, { probe, clock = nowS, sleep = sleepMs, budgetS = ROUNDS_BUDGET_S }) {
  const start = clock();
  const last = new Map();
  let batch = entries;
  let rounds = 0;
  while (batch.length) {
    rounds += 1;
    const results = await runPooled(batch, (e) => hostOfUrl(e.access.url), (e) => probe(e, clock()), { global: 24, perHost: 2 });
    batch.forEach((entry, i) => {
      const p = results[i]?.error ? { at: clock(), result: 'network' } : results[i];
      last.set(entry.id, p);
      health[entry.id] = applyProbe(health[entry.id] || emptyHealth(p.at), p, { record: false });
    });
    if (rounds > EXTRA_ROUNDS) break;
    batch = batch.filter((e) => health[e.id].status === 'candidate' && ['ok', 'idle'].includes(last.get(e.id).result));
    if (!batch.length) break;
    const startAt = Math.max(...batch.map((e) => last.get(e.id).at + Math.max(ROUND_SPACING_S, e.access.min_interval_s || 0)));
    if (startAt - start > budgetS) break;
    await sleep(Math.max(0, startAt - clock()) * 1000);
  }
  const counts = {};
  for (const [id, p] of last) {
    // The fingerprint is kept once per entry, not in every history record.
    const { fingerprint, ...record } = p;
    health[id] = { ...health[id], history: [...health[id].history, record].slice(-HISTORY_CAP) };
    if (fingerprint) health[id].fingerprint = fingerprint;
    counts[p.result] = (counts[p.result] || 0) + 1;
  }
  return { counts, rounds };
}

/**
 * Take the last run's vehicle fingerprints out of `health` (id → fingerprint),
 * so after this run's probes only entries that passed this run carry one.
 */
export function takeFingerprints(health) {
  const previous = {};
  for (const [id, h] of Object.entries(health)) {
    if (h.fingerprint) previous[id] = h.fingerprint;
    delete h.fingerprint;
  }
  return previous;
}

/**
 * The entry of a duplicate group to keep: a hand-written one, else one not
 * dead (a dead one is retired after 30 days), else one cleared for display,
 * else a verified one (over a degraded one that keeps failing), else the one
 * probed first (health firstSeen: longest in the directory, so the URL
 * consumers already know), else the lowest id.
 */
function keeperOf(ids, entries, health) {
  const harvested = (id) => (isStaticEntry(entries.get(id)) ? 0 : 1);
  const dead = (id) => (health[id].status === 'dead' ? 1 : 0);
  const referral = (id) => (entries.get(id).licence?.display ? 0 : 1);
  const unverified = (id) => (health[id].status === 'verified' ? 0 : 1);
  const seen = (id) => health[id].firstSeen ?? Infinity;
  return [...ids].sort((a, b) => harvested(a) - harvested(b) || dead(a) - dead(b) || referral(a) - referral(b) || unverified(a) - unverified(b) || seen(a) - seen(b) || a.localeCompare(b))[0];
}

/**
 * Least estimated Jaccard similarity of two entries' vehicle ids for them to
 * count as one feed. Copies of one feed fetched seconds apart measured 0.96–1;
 * at 0.96 the estimate falls under 0.9 about one run in 70 (the match waits a
 * run). The closest feeds that are not copies measured 0.70–0.75: one carrying
 * part of the other's fleet, and two that write some ids differently (`7` and
 * `0007`). At 0.745 the estimate reaches 0.8 about one run in 7, 0.9 about
 * one in 900.
 */
export const DUPLICATE_SIMILARITY = 0.9;
/**
 * Least ratio of two copies' vehicle counts this run. Counts are exact where
 * the similarity is an estimate: a feed carrying 70 % of another's fleet
 * (Autolinee Toscane, 648 of 924) is never taken for a copy of it.
 */
export const DUPLICATE_COUNT_RATIO = 0.9;

const overlaps = (a, b) => Boolean(a && b) && a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];

/**
 * Pairs of entries (`"<id> <id>"`, ids in order) whose fingerprints match:
 * similar vehicle ids and overlapping coverage. The coverage check keeps apart
 * unrelated feeds whose ids are both plain 1..N numbers.
 * @param {Record<string, string>} fingerprints id → fingerprint
 * @param {Map<string, object>} entries
 * @returns {Set<string>}
 */
export function matchingPairs(fingerprints, entries) {
  const ids = Object.keys(fingerprints).filter((id) => entries.has(id)).sort();
  const pairs = new Set();
  for (let i = 0; i < ids.length; i += 1)
    for (let j = i + 1; j < ids.length; j += 1) {
      const [a, b] = [ids[i], ids[j]];
      if (!overlaps(entries.get(a).coverage?.bbox, entries.get(b).coverage?.bbox)) continue;
      if (fingerprintSimilarity(fingerprints[a], fingerprints[b]) >= DUPLICATE_SIMILARITY) pairs.add(`${a} ${b}`);
    }
  return pairs;
}

/**
 * Retire entries serving the same feed as another under a different URL: the
 * same pair matches (matchingPairs) on this run's fingerprints and on the
 * last run's (`previous`, from takeFingerprints). Matching pairs are joined
 * into groups; one of each group is kept (keeperOf), and the members that
 * match the kept entry itself are tombstoned with `reason: 'duplicate'` and the
 * kept id, so discovery doesn't re-add them. A member matching only another
 * member (a chain) stays. Hand-written entries are never retired.
 * Updates `health` and `tombstones` in place.
 * @returns {string[]} ids of the entries to remove
 */
export function retireDuplicates(health, previous, entries, tombstones, now) {
  const current = {};
  for (const [id, h] of Object.entries(health)) if (h.fingerprint) current[id] = h.fingerprint;
  const before = matchingPairs(previous, entries);
  const root = new Map();
  const find = (id) => (root.get(id) === id ? id : find(root.get(id)));
  const matched = new Set();
  for (const pair of matchingPairs(current, entries)) {
    const [a, b] = pair.split(' ');
    const [few, many] = [health[a].records, health[b].records].sort((x, y) => x - y);
    if (!before.has(pair) || few < DUPLICATE_COUNT_RATIO * many) continue;
    matched.add(pair);
    for (const id of [a, b]) if (!root.has(id)) root.set(id, id);
    root.set(find(a), find(b));
  }
  const groups = new Map();
  for (const id of root.keys()) groups.set(find(id), [...(groups.get(find(id)) || []), id]);
  const retired = [];
  for (const ids of groups.values()) {
    const kept = keeperOf(ids, entries, health);
    for (const id of ids) {
      if (id === kept || isStaticEntry(entries.get(id)) || !matched.has([kept, id].sort().join(' '))) continue;
      tombstones[id] = { url: entries.get(id).access.url, at: now, reason: 'duplicate', of: kept };
      delete health[id];
      retired.push(id);
    }
  }
  return retired;
}

/**
 * Drop health for entries that are gone, and retire entries dead for 30 days:
 * tombstoned so discovery doesn't re-add them. Hand-written entries are never
 * retired; they stay dead (unpublished) and recover by themselves.
 * Updates `health` and `tombstones` in place.
 * @returns {string[]} ids of the entries to remove
 */
export function retireDead(health, entries, tombstones, now) {
  const retired = [];
  for (const [id, h] of Object.entries(health)) {
    if (!entries.has(id)) {
      delete health[id];
      continue;
    }
    if (h.status === 'dead' && now - h.deadSince >= 30 * DAY_S && !isStaticEntry(entries.get(id))) {
      tombstones[id] = { url: entries.get(id).access.url, at: now };
      delete health[id];
      retired.push(id);
    }
  }
  return retired;
}

/**
 * One run over loaded state, in order: take the last run's fingerprints, probe
 * the due entries (dead ones once a day), retire entries dead for 30 days,
 * release copies of entries dead or gone, then retire duplicates among the rest. Updates `health` and `tombstones` in place.
 * @param {{now: number, probe: (entry: object, at: number) => Promise<object>,
 *   clock?: () => number, sleep?: (ms: number) => Promise<void>}} options
 * @returns {Promise<{due: number, counts: Record<string, number>, rounds: number, retired: string[]}>}
 *   retired: ids of the entries to remove
 */
export async function probeRun(entries, health, tombstones, { now, probe, clock, sleep }) {
  const due = [...entries.values()].filter((e) => {
    const h = health[e.id];
    return !h || h.status !== 'dead' || now - (h.lastProbe ?? 0) >= DAY_S;
  });
  const previous = takeFingerprints(health);
  const { counts, rounds } = await probeRounds(due, health, { probe, clock, sleep });
  const retired = retireDead(health, entries, tombstones, now);
  for (const id of releaseDuplicates(health, entries, tombstones, readExcluded())) console.log(`probe: released ${id}: the entry it duplicated is dead or gone`);
  for (const id of retireDuplicates(health, previous, entries, tombstones, now)) {
    retired.push(id);
    console.log(`probe: retired ${id}: same vehicles as ${tombstones[id].of}, two runs in a row`);
  }
  return { due: due.length, counts, rounds, retired };
}

export async function probeAll({ fetchImpl, now = nowS() } = {}) {
  const entries = readEntries();
  const health = readState('health.json', {});
  const tombstones = readState('tombstones.json', {});
  const { due, counts, rounds, retired } = await probeRun(entries, health, tombstones, {
    now,
    probe: (e, at) => probeEntry(e, { now: at, fetchImpl }),
  });
  for (const id of retired) removeEntry(id);
  writeState('health.json', health);
  writeState('tombstones.json', tombstones);
  const statuses = {};
  for (const h of Object.values(health)) statuses[h.status] = (statuses[h.status] || 0) + 1;
  console.log(`probe: ${due} probed in ${rounds} round(s) ${JSON.stringify(counts)}; status ${JSON.stringify(statuses)}`);
  return { counts, statuses };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await probeAll();
