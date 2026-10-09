/**
 * Diagnostic: run the structural contract check over every real stored session
 * log, to see whether the check can be trusted as a publish-time gate.
 *
 * A false positive here would refuse to publish a conversation DSH itself wrote,
 * which is worse than the bug the check exists to catch. Reports each log's
 * event count and the first violation, or NONE.
 *
 * Usage: node checks/share-check-real-logs.mjs [sessionRoot]
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { decodeZstdFrames } from '../lib/zstd.trae2.js';
import { firstStructuralViolation } from '../lib/vault.trae2.js';

const root = process.argv[2] ?? join(process.env.DSH_HOME ?? join(process.env.USERPROFILE, '.dsh'), 'sessions');
let checked = 0;
let clean = 0;
const violations = [];
const skipped = [];

for (const project of readdirSync(root)) {
  const projectDir = join(root, project);
  if (!statSync(projectDir).isDirectory()) continue;
  for (const id of readdirSync(projectDir)) {
    const dir = join(projectDir, id);
    if (!statSync(dir).isDirectory()) continue;
    const file = readdirSync(dir).find((name) => name.endsWith('.jsonl.zstd'));
    if (file === undefined) {
      skipped.push(`${id} (no zstd log)`);
      continue;
    }
    checked += 1;
    let events;
    try {
      const decoded = decodeZstdFrames(readFileSync(join(dir, file)));
      if (decoded.failedFrames > 0 || decoded.skippedBytes > 0) {
        skipped.push(`${id} (${decoded.failedFrames} bad frames, ${decoded.skippedBytes} bytes skipped)`);
        continue;
      }
      events = decoded.text.split('\n').filter((line) => line.trim().length > 0).map((line) => JSON.parse(line));
    } catch (error) {
      skipped.push(`${id} (unreadable: ${error instanceof Error ? error.message : String(error)})`);
      continue;
    }
    const header = events.find((row) => row.type === 'session');
    const body = events.filter((row) => row.type !== 'session');
    const violation = firstStructuralViolation(body, header?.id);
    if (violation === undefined) clean += 1;
    else violations.push(`${header?.id ?? id} (${body.length} events): ${violation}`);
  }
}

console.log(`checked ${checked} stored log(s): ${clean} clean, ${violations.length} flagged, ${skipped.length} skipped`);
for (const line of violations) console.log(`  FLAGGED  ${line}`);
for (const line of skipped) console.log(`  skipped  ${line}`);
