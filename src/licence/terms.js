/**
 * Tier 2: read an operator's terms page with Claude and accept "display
 * allowed" only when the decision can be checked mechanically:
 *  - every quoted piece of evidence appears verbatim in the fetched text;
 *  - the terms apply to this data, need no click-through acceptance, and
 *    impose only obligations the app meets automatically;
 *  - two independent runs agree on every decision field;
 *  - confidence ≥ 0.9.
 * Anything else → not accepted (the entry stays referral-only).
 */
import Anthropic from '@anthropic-ai/sdk';

export const MODEL = 'claude-opus-5-5';
/** Bump when the prompt or schema changes: cached classifications are redone. */
export const PROMPT_VERSION = 4;
export const MIN_TEXT_CHARS = 500;
const MAX_TEXT_CHARS = 120_000;
/**
 * Obligations the app satisfies on its own (credits, licence link, UA, polite
 * polling), or clauses that ask nothing of it (disclaimers, liability limits,
 * no implied endorsement, lawful use, the provider's right to end access).
 * `no_commercial` sets commercial = false instead of blocking display.
 */
export const MEETABLE = new Set([
  'attribution',
  'licence_link',
  'identify_client',
  'rate_limit',
  'no_endorsement',
  'warranty_disclaimer',
  'liability_limitation',
  'comply_with_law',
  'provider_may_revoke',
  'no_commercial',
  'no_trademark_use',
  'governing_law',
  'provider_owns_data',
  'indemnify',
  'https_only',
  'data_freshness',
  'no_sublicense',
  'no_reverse_engineering',
  'no_misrepresentation',
  'personal_data',
  'keep_current',
  'no_service_disruption',
]);
export const MIN_CONFIDENCE = 0.8;

export const TERMS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'applies_to_this_data',
    'display',
    'commercial',
    'requires_acceptance',
    'attribution_text',
    'obligations',
    'evidence',
    'confidence',
  ],
  properties: {
    applies_to_this_data: { type: 'boolean' },
    display: { type: 'boolean' },
    commercial: { type: 'boolean' },
    requires_acceptance: { type: 'boolean' },
    attribution_text: { type: 'string' },
    obligations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'quote'],
        properties: {
          type: {
            type: 'string',
            enum: [
              'attribution',
              'licence_link',
              'identify_client',
              'rate_limit',
              'no_endorsement',
              'warranty_disclaimer',
              'liability_limitation',
              'comply_with_law',
              'provider_may_revoke',
              'no_commercial',
              'no_trademark_use',
              'governing_law',
              'provider_owns_data',
              'indemnify',
              'https_only',
              'data_freshness',
              'no_sublicense',
              'no_reverse_engineering',
              'no_misrepresentation',
              'personal_data',
              'keep_current',
              'no_service_disruption',
              'registration',
              'no_redistribution',
              'no_modification',
              'other',
            ],
          },
          quote: { type: 'string' },
        },
      },
    },
    evidence: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['field', 'quote'],
        properties: { field: { type: 'string' }, quote: { type: 'string' } },
      },
    },
    confidence: { type: 'number' },
  },
};

/** Visible text of an HTML page. */
export function htmlToText(html) {
  return html
    .replace(/<(script|style|noscript|template)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

/**
 * Sentence fingerprint of a terms page: sorted unique 32-bit hashes of its
 * sentences. Pages that differ only in a date or banner stay highly similar.
 */
export function sentenceSignature(text) {
  const hashes = new Set();
  for (const raw of String(text).split(/(?<=[.!?])\s+|\n/)) {
    const s = raw.replace(/\s+/g, ' ').trim().toLowerCase();
    if (s.length < 20) continue;
    let h = 2166136261;
    for (let i = 0; i < s.length; i += 1) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
    hashes.add(h);
  }
  return [...hashes].sort((a, b) => a - b).slice(0, 4000);
}

/** Jaccard similarity of two sentence signatures (0..1). */
export function signatureSimilarity(a = [], b = []) {
  const setB = new Set(b);
  let both = 0;
  for (const x of a) if (setB.has(x)) both += 1;
  const union = a.length + b.length - both;
  return union ? both / union : 1;
}

/**
 * Whether a cached classification must be redone: only when the text changed
 * materially (sentence similarity < 0.9) and the last run is a week old, or
 * when it is a month old. Noise (dates, banners, rotating news) never re-bills.
 */
export function needsReclassification(cached, signature, nowMs) {
  if (!cached?.at || !cached.signature || cached.version !== PROMPT_VERSION) return true;
  const ageDays = (nowMs - Date.parse(cached.at)) / 86_400_000;
  if (ageDays >= 30) return true;
  return ageDays >= 7 && signatureSimilarity(cached.signature, signature) < 0.9;
}

/** Most pages classified in one run; the rest wait for the next run. */
export const MAX_CLASSIFICATIONS_PER_RUN = 15;

const squash = (s) => String(s).replace(/\s+/g, ' ').trim().toLowerCase();

/** Every quote (evidence and obligations) appears in the text, whitespace-insensitive. */
export function quotesVerbatim(decision, text) {
  const haystack = squash(text);
  const quotes = [
    ...decision.evidence.map((e) => e.quote),
    ...decision.obligations.map((o) => o.quote),
  ];
  return quotes.length > 0 && quotes.every((q) => q && haystack.includes(squash(q)));
}

const DECISION_FIELDS = ['applies_to_this_data', 'display', 'commercial', 'requires_acceptance'];

/**
 * Accept or reject two runs' decisions against the text.
 * @returns {{accepted: boolean, reason: string}}
 */
export function judge(a, b, text) {
  for (const f of DECISION_FIELDS) if (a[f] !== b[f]) return { accepted: false, reason: `runs disagree on ${f}` };
  // Runs may label harmless clauses differently; they must agree on the blocking ones.
  const blocking = (d) =>
    [...new Set(d.obligations.map((o) => o.type).filter((t) => !MEETABLE.has(t)))].sort().join(',');
  if (blocking(a) !== blocking(b)) return { accepted: false, reason: 'runs disagree on blocking obligations' };
  for (const d of [a, b]) {
    if (!quotesVerbatim(d, text)) return { accepted: false, reason: 'quote not found in terms text' };
    if (d.confidence < MIN_CONFIDENCE) return { accepted: false, reason: `confidence below ${MIN_CONFIDENCE}` };
  }
  if (!a.applies_to_this_data) return { accepted: false, reason: 'terms do not apply to this data' };
  if (a.requires_acceptance) return { accepted: false, reason: 'requires acceptance' };
  if (!a.display) return { accepted: false, reason: 'display not allowed' };
  const unmet = a.obligations.filter((o) => !MEETABLE.has(o.type));
  if (unmet.length) return { accepted: false, reason: `obligation ${unmet[0].type}` };
  return { accepted: true, reason: 'accepted' };
}

const PROMPT = (entry, text) => `You classify the licence terms that govern a public live data feed, for an open-source map application that would fetch the feed on its server and display the positions on a map with attribution.

Feed: ${entry.name}
Provider: ${entry.provider}
Feed URL: ${entry.access.url}
Terms page: ${entry.licence.url}

Answer only from the terms text below. Rules:
- applies_to_this_data: true only if these terms govern this provider's open/real-time transit data (not just the website).
- display: true only if the terms allow a third-party application to show this data to its users.
- commercial: true only if commercial use is allowed or not restricted.
- requires_acceptance: true if use requires registering, signing, or clicking to accept an agreement first.
- obligations: every condition or clause that applies to users of the data, each with a verbatim quote, typed as precisely as possible: attribution, licence_link (link to the licence/terms), identify_client (identify the app, e.g. a User-Agent or client name), rate_limit, no_endorsement (must not imply the provider endorses the app), warranty_disclaimer, liability_limitation, comply_with_law, provider_may_revoke (provider can change or end access), no_commercial, no_trademark_use (must not use the provider's names, logos or marks), governing_law, provider_owns_data (provider keeps title or rights), indemnify, https_only, data_freshness (must not show data older than a limit), no_sublicense, no_reverse_engineering (no reverse engineering, scraping or access outside the provided interface), no_misrepresentation (must not misrepresent or distort the data or its source), personal_data (rules about personal data), keep_current (keep data up to date), no_service_disruption (must not overload or disrupt the provider's servers), registration (must register, obtain a key or sign up), no_redistribution, no_modification, other (anything else; use only when none fits).
- evidence: verbatim quotes supporting each decision field (field = the field name).
- Quotes must be copied exactly from the text, at most 300 characters each.
- confidence: 0 to 1 for the whole classification.

Terms text:
"""
${text.slice(0, MAX_TEXT_CHARS)}
"""`;

/** One classification run. */
export async function classifyTerms(client, entry, text) {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 8000,
    output_config: { effort: 'high', format: { type: 'json_schema', schema: TERMS_SCHEMA } },
    messages: [{ role: 'user', content: PROMPT(entry, text) }],
  });
  if (response.stop_reason === 'refusal' || response.stop_reason === 'max_tokens')
    throw new Error(`classification stopped: ${response.stop_reason}`);
  const block = response.content.find((c) => c.type === 'text');
  return JSON.parse(block.text);
}

export function createClient() {
  return process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
}
