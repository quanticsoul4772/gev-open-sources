/**
 * Fail (exit 1) when any JSON file under the given paths holds a credential:
 * a URL with a key in a parameter, path, fragment or userinfo, or a value in
 * a known token format. Runs after the cycle and before commit and publish.
 * Findings name file and JSON path only, never the value.
 * Usage: node src/scan-secrets.js <dir|file>...
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { scanJson } from './util/secrets.js';

function* jsonFiles(target) {
  if (!fs.existsSync(target)) return;
  if (fs.statSync(target).isFile()) {
    if (target.endsWith('.json')) yield target;
    return;
  }
  for (const name of fs.readdirSync(target)) yield* jsonFiles(path.join(target, name));
}

export function scanPaths(targets) {
  const findings = [];
  for (const target of targets)
    for (const file of jsonFiles(target))
      for (const f of scanJson(JSON.parse(fs.readFileSync(file, 'utf8')))) findings.push({ file, ...f });
  return findings;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const targets = process.argv.slice(2);
  if (!targets.length) throw new Error('usage: node src/scan-secrets.js <dir|file>...');
  const findings = scanPaths(targets);
  for (const f of findings) console.error(`secret: ${f.file} ${f.path}: ${f.reason}`);
  console.log(`scan-secrets: ${findings.length} finding(s) in ${targets.join(', ')}`);
  if (findings.length) process.exit(1);
}
