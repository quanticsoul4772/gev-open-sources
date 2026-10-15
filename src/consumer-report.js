/**
 * Report-only consumer check: what the app would see in the published
 * directory under the shared coverage limits (conformance/cases.json).
 * Lists published boxes over their class's limit, and wide entries that
 * carry no explicit class in entries/. Writes Markdown to
 * $GITHUB_STEP_SUMMARY (stdout otherwise) and never fails the run.
 * Usage: node src/consumer-report.js
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { plausibleBbox } from './harvest/catalogue.js';
import { DIST_DIR, readEntries } from './store.js';

/**
 * @param {object[]} published entries of the published directory
 * @param {Map<string, object>} entries entries/ by id (their explicit class)
 * @returns {{overLimit: object[], wideUnclassed: object[]}}
 */
export function consumerReport(published, entries) {
  const overLimit = [];
  const wideUnclassed = [];
  for (const e of published) {
    const bbox = e.coverage?.bbox;
    if (!bbox) continue;
    const cls = e.coverage.class ?? 'regional';
    if (!plausibleBbox(bbox, cls)) overLimit.push({ id: e.id, domain: e.domain, class: cls, bbox });
    if (entries.get(e.id)?.coverage?.class === undefined && !plausibleBbox(bbox) && cls === 'regional')
      wideUnclassed.push({ id: e.id, domain: e.domain, bbox });
  }
  return { overLimit, wideUnclassed };
}

const span = (b) => `${(b[2] - b[0]).toFixed(1)}° × ${(b[3] - b[1]).toFixed(1)}°`;

/** The report as Markdown. */
export function reportMarkdown({ overLimit, wideUnclassed }) {
  const lines = ['## Consumer check (report only)', ''];
  lines.push(`**Boxes over their class limit:** ${overLimit.length}`, '');
  if (overLimit.length) {
    lines.push('| Entry | Domain | Class | Span |', '|---|---|---|---|');
    for (const r of overLimit) lines.push(`| ${r.id} | ${r.domain} | ${r.class} | ${span(r.bbox)} |`);
    lines.push('');
  }
  lines.push(`**Wide entries without an explicit class:** ${wideUnclassed.length}`, '');
  if (wideUnclassed.length) {
    lines.push('| Entry | Domain | Span |', '|---|---|---|');
    for (const r of wideUnclassed) lines.push(`| ${r.id} | ${r.domain} | ${span(r.bbox)} |`);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const directory = JSON.parse(fs.readFileSync(path.join(DIST_DIR, 'v1', 'directory.json'), 'utf8'));
  const report = consumerReport(directory.entries, readEntries());
  const markdown = reportMarkdown(report);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
  else process.stdout.write(markdown);
  console.log(`consumer-report: ${report.overLimit.length} over their class limit, ${report.wideUnclassed.length} wide without a class`);
}
