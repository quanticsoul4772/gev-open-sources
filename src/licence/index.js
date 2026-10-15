/**
 * Licence job — no humans. Per entry:
 *  tier 1  known licence (URL or SPDX id)          → decided
 *  GBFS    system_information licence, else the catalogue's (if known);
 *          none on v3.x → CC0 per the GBFS spec
 *  tier 2  operator terms page, Claude, mechanical acceptance (terms.js)
 *  else    referral-only (display false)
 * A borrowed licence URL (from the static feed) is accepted only via tier 1.
 */
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { readEntries, readState, writeEntry, writeState } from '../store.js';
import { fetchCapped } from '../util/http.js';
import { hostOfUrl, runPooled } from '../util/pool.js';
import { knownLicence } from './known.js';
import {
  MAX_CLASSIFICATIONS_PER_RUN,
  MIN_TEXT_CHARS,
  classifyTerms,
  createClient,
  htmlToText,
  judge,
  needsReclassification,
  PROMPT_VERSION,
  recheckReason,
  sentenceSignature,
} from './terms.js';

const isHttp = (value) => /^https?:\/\/\S+$/i.test(String(value || ''));
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const nowIso = () => new Date().toISOString();

const undecided = (entry, reason) => ({
  licence: { ...entry.licence, id: null, display: false, commercial: null },
  licence_decision: { by: 'none', evidence: reason ? [{ field: 'reason', quote: reason }] : [], terms_sha256: null, at: null },
});

function fromKnown(entry, known, source, attribution) {
  return {
    licence: {
      id: known.id,
      url: isHttp(source) ? source : null,
      display: known.display,
      commercial: known.commercial,
      attribution: attribution || entry.provider,
    },
    licence_decision: { by: 'known-licence', evidence: [{ field: 'licence', quote: source }], terms_sha256: null, at: null },
  };
}

/**
 * A GBFS text field as a plain string: v1/v2 send a string, v3 a list of
 * {text, language} (English preferred, else the first non-empty one).
 * @returns {string|null}
 */
export function gbfsText(value) {
  if (typeof value === 'string') return value.trim() || null;
  if (!Array.isArray(value)) return null;
  const texts = value.filter((t) => typeof t?.text === 'string' && t.text.trim());
  const pick = texts.find((t) => /^en(-|$)/i.test(t.language || '')) || texts[0];
  return pick ? pick.text.trim() : null;
}

/** GBFS: licence fields from system_information. */
/** Whether an entry is a GBFS feed (stations or vehicles), decided from system_information. */
const isGbfs = (e) => e.format.startsWith('gbfs.');

/**
 * system_information `data`, or null. A stations entry without the related URL
 * falls back to its sibling file; a vehicles entry must name it (guessing would
 * read the vehicle feed, and a v3 system would then default to CC0).
 * `memo` shares one fetch per URL between a system's entries in a run.
 */
async function systemInformation(entry, fetchImpl, memo) {
  const url =
    entry.access.related?.system_information ||
    (entry.format === 'gbfs.station-status' ? entry.access.url.replace(/station_status(\.json)?$/, 'system_information$1') : null);
  // The sibling guess changed nothing (e.g. `station_status?lang=en`): reading the
  // entry's own feed as system_information would find no licence and, on v3,
  // grant the CC0 default by mistake.
  if (!url || url === entry.access.url) return null;
  if (!memo.has(url))
    memo.set(
      url,
      fetchCapped(url, { fetchImpl, timeoutMs: 15_000, maxBytes: 2 ** 20 }).then(
        (res) => (res.status === 200 ? JSON.parse(new TextDecoder().decode(res.body))?.data || null : null),
        () => null,
      ).catch(() => null),
    );
  return memo.get(url);
}

export async function gbfsDecision(entry, fetchImpl, memo = new Map()) {
  const info = await systemInformation(entry, fetchImpl, memo);
  // The licence a catalogue (Transitous) declared for the system: used only
  // when the system publishes none itself, and only if it is a known licence.
  const catalogue = entry.gbfs?.catalogue_licence || null;
  const catalogueKnown = knownLicence(catalogue);
  if (!info)
    return catalogueKnown
      ? { decided: fromKnown(entry, catalogueKnown, catalogue, entry.provider) }
      : { decided: undecided(entry, 'system_information unavailable') };
  const attribution = gbfsText(info.attribution_organization_name) || gbfsText(info.operator) || entry.provider;
  const id = info.license_id || null;
  const licenceUrl = isHttp(info.license_url) ? info.license_url : null;
  const known = knownLicence(id) || knownLicence(licenceUrl);
  if (known) return { decided: fromKnown(entry, known, licenceUrl || id, attribution) };
  if (licenceUrl) return { termsUrl: licenceUrl, attribution };
  if (catalogueKnown) return { decided: fromKnown(entry, catalogueKnown, catalogue, attribution) };
  if (String(entry.gbfs?.version || '').startsWith('3'))
    return {
      decided: {
        licence: { id: 'CC0-1.0', url: null, display: true, commercial: true, attribution },
        licence_decision: {
          by: 'gbfs-v3-default',
          evidence: [{ field: 'version', quote: `GBFS ${entry.gbfs.version}: no license_id/license_url, default CC0-1.0` }],
          terms_sha256: null,
          at: null,
        },
      },
    };
  return { decided: undecided(entry, 'no licence published') };
}

/** Fetch a terms page as text, or a reason it can't be read. */
async function termsText(url, fetchImpl) {
  try {
    const res = await fetchCapped(url, { fetchImpl, timeoutMs: 20_000, maxBytes: 4 * 2 ** 20 });
    if (res.status !== 200) return { reason: `HTTP ${res.status}` };
    const type = res.headers.get('content-type') || '';
    if (/pdf/i.test(type) || /\.pdf$/i.test(url)) return { reason: 'pdf terms' };
    const text = htmlToText(new TextDecoder().decode(res.body));
    if (text.length < MIN_TEXT_CHARS) return { reason: 'terms page has no readable text' };
    return { text };
  } catch {
    return { reason: 'terms page unreachable' };
  }
}

export async function decideLicences({ fetchImpl, client = createClient() } = {}) {
  const entries = readEntries();
  const cache = readState('licence-cache.json', {});
  const plan = new Map(); // id → {decided} | {termsUrl, attribution}
  const gbfs = [...entries.values()].filter(isGbfs);
  const memo = new Map();
  const gbfsResults = await runPooled(gbfs, (e) => hostOfUrl(e.access.url), (e) => gbfsDecision(e, fetchImpl, memo), { global: 24, perHost: 3 });
  gbfs.forEach((e, i) => plan.set(e.id, gbfsResults[i]?.error ? { decided: undecided(e, 'system_information error') } : gbfsResults[i]));
  for (const e of entries.values()) {
    if (isGbfs(e)) continue;
    const known = knownLicence(e.licence.url);
    if (known) plan.set(e.id, { decided: fromKnown(e, known, e.licence.url, e.licence.attribution) });
    else if (e.licence.url && !e.provenance.some((p) => p.startsWith('licence-borrowed:')))
      plan.set(e.id, { termsUrl: e.licence.url, attribution: e.licence.attribution });
    else plan.set(e.id, { decided: undecided(e, e.licence.url ? 'borrowed licence is not a known licence' : 'no licence published') });
  }

  // Tier 2, once per distinct terms URL; reuse the cached result while the text is unchanged.
  const termsUrls = [...new Set([...plan.values()].map((p) => p.termsUrl).filter(Boolean))];
  const termsResults = new Map();
  let classified = 0;
  let deferred = 0;
  const decideTerms = async (url) => {
    const page = await termsText(url, fetchImpl);
    if (!page.text) return { accepted: false, reason: page.reason, hash: null };
    const hash = sha256(page.text);
    const signature = sentenceSignature(page.text);
    if (cache[url] && !needsReclassification(cache[url], signature, Date.now())) return cache[url];
    if (!client) return cache[url] || { accepted: false, reason: 'no ANTHROPIC_API_KEY', hash };
    if (classified >= MAX_CLASSIFICATIONS_PER_RUN) {
      deferred += 1;
      return cache[url] || { accepted: false, reason: 'awaiting classification', hash };
    }
    classified += 1;
    const sample = [...entries.values()].find((e) => e.licence.url === url) || { name: url, provider: hostOfUrl(url), access: { url }, licence: { url } };
    try {
      const [a, b] = await Promise.all([classifyTerms(client, sample, page.text), classifyTerms(client, sample, page.text)]);
      cache[url] = {
        hash,
        signature,
        version: PROMPT_VERSION,
        ...judge(a, b, page.text),
        decision: a,
        // Only run a is kept; the lower confidence lets a later, stricter bar re-check both runs.
        min_confidence: Math.min(a.confidence, b.confidence),
        at: nowIso(),
      };
    } catch (error) {
      // No `at`: a classifier error (overload, rate limit) is retried next run, not cached for weeks.
      cache[url] = { hash: null, signature, version: PROMPT_VERSION, accepted: false, reason: `classifier error: ${error.message}`.slice(0, 200), at: null };
    }
    return cache[url];
  };
  const decisions = await runPooled(termsUrls, hostOfUrl, decideTerms, { global: 6, perHost: 1 });
  termsUrls.forEach((url, i) => termsResults.set(url, decisions[i]?.error ? { accepted: false, reason: 'terms error' } : decisions[i]));
  // Terms pages no entry refers to any more: drop them (each holds a signature of up to 4,000 numbers).
  for (const url of Object.keys(cache)) if (!termsUrls.includes(url)) delete cache[url];
  writeState('licence-cache.json', cache);

  const tally = {};
  for (const [id, p] of plan) {
    const entry = entries.get(id);
    let decided = p.decided;
    if (!decided) {
      const r = termsResults.get(p.termsUrl);
      // Re-check cached decisions against the current rules (no API call).
      const failed = r?.accepted ? recheckReason(r.decision, r.min_confidence) : r?.reason;
      decided = r?.accepted && !failed
        ? {
            licence: {
              id: `terms:${hostOfUrl(p.termsUrl)}`,
              url: p.termsUrl,
              display: true,
              commercial: r.decision.commercial,
              // The model's attribution text only if it is on the page; otherwise the provider.
              attribution: (r.attribution_verbatim && r.decision.attribution_text) || p.attribution || entry.provider,
              obligations: [...new Set(r.decision.obligations.map((o) => o.type))].sort(),
            },
            licence_decision: { by: 'llm-terms', evidence: r.decision.evidence, terms_sha256: r.hash, at: r.at },
          }
        : { ...undecided(entry, failed), licence: { ...entry.licence, url: p.termsUrl, id: null, display: false, commercial: null } };
    }
    const next = { ...entry, ...decided };
    // Keep the original decision time when nothing about the decision changed.
    if (JSON.stringify({ ...next.licence_decision, at: null }) === JSON.stringify({ ...entry.licence_decision, at: null }))
      next.licence_decision = entry.licence_decision;
    else next.licence_decision = { ...next.licence_decision, at: next.licence_decision.at || nowIso() };
    writeEntry(next);
    const k = `${next.licence_decision.by}:${next.licence.display ? 'display' : 'referral'}`;
    tally[k] = (tally[k] || 0) + 1;
  }
  console.log(`licence: ${termsUrls.length} terms pages, ${classified} classified this run (${deferred} deferred, cap ${MAX_CLASSIFICATIONS_PER_RUN}); ${JSON.stringify(tally)}`);
  return tally;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await decideLicences();
