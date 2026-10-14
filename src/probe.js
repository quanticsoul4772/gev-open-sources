/**
 * Health job: probe every entry with its own request recipe and decoder, and
 * advance its health state. Dead entries are probed once a day; dead for 30
 * days → entry removed and tombstoned so discovery doesn't re-add it.
 */
import { pathToFileURL } from 'node:url';
import { ADAPTERS } from './adapters/index.js';
import { DAY_S, applyProbe, classify, emptyHealth } from './health.js';
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
    const decoded = ADAPTERS[entry.format](body, entry.coverage.bbox);
    return { at: now, ...classify({ status: 200, decoded, now }) };
  } catch {
    return { at: now, ...classify({ error: 'decode' }) };
  }
}

export async function probeAll({ fetchImpl, now = Math.floor(Date.now() / 1000) } = {}) {
  const entries = readEntries();
  const health = readState('health.json', {});
  const tombstones = readState('tombstones.json', {});
  const due = [...entries.values()].filter((e) => {
    const h = health[e.id];
    return !h || h.status !== 'dead' || now - (h.lastProbe ?? 0) >= DAY_S;
  });
  const results = await runPooled(
    due,
    (e) => hostOfUrl(e.access.url),
    (e) => probeEntry(e, { now, fetchImpl }),
    { global: 24, perHost: 2 },
  );
  const counts = {};
  due.forEach((entry, i) => {
    const probe = results[i]?.error ? { at: now, result: 'network' } : results[i];
    counts[probe.result] = (counts[probe.result] || 0) + 1;
    health[entry.id] = applyProbe(health[entry.id] || emptyHealth(now), probe);
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
  console.log(`probe: ${due.length} probed ${JSON.stringify(counts)}; status ${JSON.stringify(statuses)}`);
  return { counts, statuses };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await probeAll();
