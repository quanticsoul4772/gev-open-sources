/**
 * Health state machine, pure. A probe result is one of:
 *   ok      — answered, decoded, fresh, records > 0
 *   idle    — answered, decoded, zero records, and fresh or (out of service
 *             hours, server stopped updating) under IDLE_MAX_AGE_S old
 *   stale   — decoded but the newest timestamp is too old
 *   http / decode / network — failed
 *   blocked — 403/429: the prober is refused; says nothing about the feed
 *
 * candidate|degraded|dead → verified: 3 consecutive passes and records seen in
 *   the last 7 days. verified → degraded: 2 consecutive failures.
 * → dead: failing continuously for 7 days. Dead 30 days → removed.
 */

export const DAY_S = 86_400;
export const STALE_AFTER_S = 15 * 60;
/** Oldest timestamp an empty feed may carry and still count as idle (out of service hours). */
export const IDLE_MAX_AGE_S = 12 * 3600;
export const HISTORY_CAP = 28;

const PASS = new Set(['ok', 'idle']);
const FAIL = new Set(['stale', 'http', 'decode', 'network']);

export function emptyHealth(now) {
  return {
    status: 'candidate',
    firstSeen: now,
    lastProbe: null,
    lastPass: null,
    lastWithRecords: null,
    passes: 0,
    failures: 0,
    failingSince: null,
    deadSince: null,
    records: null,
    history: [],
  };
}

/**
 * Apply one probe result.
 * @param {object} health previous state (or emptyHealth)
 * @param {{at: number, result: string, records?: number, ageS?: number|null, code?: number, inCoverage?: number|null}} probe
 * @param {{record?: boolean}} [options] record: false applies the result to
 *   the state machine without adding it to history (extra rounds in a run)
 * @returns {object} next state
 */
export function applyProbe(health, probe, { record = true } = {}) {
  const h = { ...health, history: record ? [...health.history, probe].slice(-HISTORY_CAP) : [...health.history] };
  h.lastProbe = probe.at;
  if (PASS.has(probe.result)) {
    h.passes += 1;
    h.failures = 0;
    h.failingSince = null;
    h.lastPass = probe.at;
    h.records = probe.records ?? 0;
    if (probe.result === 'ok') h.lastWithRecords = probe.at;
  } else if (FAIL.has(probe.result)) {
    h.failures += 1;
    h.passes = 0;
    h.failingSince ??= probe.at;
  }
  const seenRecently = h.lastWithRecords !== null && probe.at - h.lastWithRecords <= 7 * DAY_S;
  if (h.status !== 'verified' && h.passes >= 3 && seenRecently) {
    h.status = 'verified';
    h.deadSince = null;
  } else if (h.status === 'verified' && (h.failures >= 2 || !seenRecently)) {
    h.status = 'degraded';
  }
  if (h.status !== 'dead' && h.failingSince !== null && probe.at - h.failingSince >= 7 * DAY_S) {
    h.status = 'dead';
    h.deadSince = probe.at;
  }
  return h;
}

/** Classify a probe from its parts (pure, for testing and the runner). */
export function classify({ status, decoded, error, now }) {
  if (error) return { result: error === 'decode' ? 'decode' : 'network' };
  if (status === 403 || status === 429) return { result: 'blocked', code: status };
  if (status !== 200) return { result: 'http', code: status };
  const ageS = decoded.newest === null ? null : Math.max(0, now - decoded.newest);
  // No timestamp at all: freshness can't be judged, so the records decide.
  // An empty feed whose server stopped updating overnight (no vehicles out)
  // is idle while its timestamp is under IDLE_MAX_AGE_S old; older, it is
  // stale, so a frozen server still fails.
  const quietNight = decoded.records === 0 && ageS !== null && ageS <= IDLE_MAX_AGE_S;
  // A decoder may set its own limit (FIRMS data arrive hours after the pass).
  if (ageS !== null && ageS > (decoded.staleAfterS ?? STALE_AFTER_S) && !quietNight)
    return { result: 'stale', ageS, records: decoded.records };
  return {
    result: decoded.records > 0 ? 'ok' : 'idle',
    ageS,
    records: decoded.records,
    inCoverage: decoded.inCoverage,
  };
}

/** Share of passing probes in the last 7 days, and median data age. */
export function summary(h, now) {
  const recent = h.history.filter((p) => now - p.at <= 7 * DAY_S && p.result !== 'blocked');
  const passed = recent.filter((p) => PASS.has(p.result)).length;
  const ages = recent.map((p) => p.ageS).filter(Number.isFinite).sort((a, b) => a - b);
  return {
    status: h.status,
    success_7d: recent.length ? Math.round((passed / recent.length) * 100) / 100 : null,
    median_age_s: ages.length ? ages[Math.floor(ages.length / 2)] : null,
    records: h.records,
    last_ok: h.lastWithRecords,
    last_probe: h.lastProbe,
  };
}
