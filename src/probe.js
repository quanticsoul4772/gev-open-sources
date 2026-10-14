/**
 * Health job: probe every entry with its own request recipe and decoder, and
 * advance its health state. A passing candidate is probed up to three times
 * in one run (probeRounds), so a working new feed is verified the run it is
 * found. Dead entries are probed once a day; dead for 30 days → entry removed
 * and tombstoned so discovery doesn't re-add it.
 */
import { pathToFileURL } from 'node:url';
import { ADAPTERS } from './adapters/index.js';
import { DAY_S, HISTORY_CAP, applyProbe, classify, emptyHealth } from './health.js';
import { readEntries, readState, removeEntry, writeState } from './store.js';
import { fetchCapped } from './util/http.js';
import { hostOfUrl, runPooled } from './util/pool.js';
import { readZipEntry } from './util/zip.js';

/** Probe one entry; never throws. */
export async function probeEntry(entry, { now, fetchImpl } = {}) {
  let res;
  try {
    res = await fetchCapped(entry.access.url, {
      headers: entry.access.headers,
      redirectHosts: entry.access.redirectHosts,
      fetchImpl,
    });
  } catch {
    return { at: now, ...classify({ error: 'network' }) };
  }
  if (res.status !== 200) return { at: now, ...classify({ status: res.status }) };
  try {
    const body = entry.access.unzip ? readZipEntry(res.body, entry.access.unzip) : res.body;
    const decoded = ADAPTERS[entry.format](body, entry.coverage.bbox, entry);
    if (decoded.sample) {
      const sample = await checkSample(decoded.sample, fetchImpl);
      if (sample) return { at: now, ...sample };
    }
    return { at: now, ...classify({ status: 200, decoded, now }) };
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
    health[id] = { ...health[id], history: [...health[id].history, p].slice(-HISTORY_CAP) };
    counts[p.result] = (counts[p.result] || 0) + 1;
  }
  return { counts, rounds };
}

export async function probeAll({ fetchImpl, now = nowS() } = {}) {
  const entries = readEntries();
  const health = readState('health.json', {});
  const tombstones = readState('tombstones.json', {});
  const due = [...entries.values()].filter((e) => {
    const h = health[e.id];
    return !h || h.status !== 'dead' || now - (h.lastProbe ?? 0) >= DAY_S;
  });
  const { counts, rounds } = await probeRounds(due, health, {
    probe: (e, at) => probeEntry(e, { now: at, fetchImpl }),
  });
  for (const [id, h] of Object.entries(health)) {
    if (!entries.has(id)) {
      delete health[id];
      continue;
    }
    if (h.status === 'dead' && now - h.deadSince >= 30 * DAY_S) {
      tombstones[id] = { url: entries.get(id).access.url, at: now };
      removeEntry(id);
      delete health[id];
    }
  }
  writeState('health.json', health);
  writeState('tombstones.json', tombstones);
  const statuses = {};
  for (const h of Object.values(health)) statuses[h.status] = (statuses[h.status] || 0) + 1;
  console.log(`probe: ${due.length} probed in ${rounds} round(s) ${JSON.stringify(counts)}; status ${JSON.stringify(statuses)}`);
  return { counts, statuses };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await probeAll();
