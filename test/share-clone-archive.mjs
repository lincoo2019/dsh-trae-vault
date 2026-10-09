/**
 * Diagnostic: build a second archive id for a repaired conversation.
 *
 * Needed because a session id that the store already holds cannot be
 * re-materialized without the `force` replacement path, and the running Host may
 * still be on a generation that predates it. A fresh archive id derives a fresh
 * session id, so publishing it goes down the ordinary create path and announces
 * itself to the sidebar.
 *
 * Usage: node checks/share-clone-archive.mjs <sourceArchiveId> <newArchiveId>
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { firstStructuralViolation } from '../lib/vault.trae2.js';

const project = process.argv[2] ?? process.cwd();
const root = join(project, '.dsh', 'conversations');
const sourceId = process.argv[2];
if (sourceId === undefined) throw new Error('usage: <sourceArchiveId> [newArchiveId]');
const newId = process.argv[3] ?? `${sourceId}-v2`;

const source = join(root, sourceId);
const target = join(root, newId);
if (!existsSync(source)) throw new Error(`no archive at ${source}`);
if (existsSync(target)) rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });

for (const name of ['events.jsonl', 'conversation.jsonl', 'conversation.md']) {
  if (!existsSync(join(source, name))) continue;
  const raw = readFileSync(join(source, name), 'utf8');
  // The archive id is the conversation's identity: it appears in the header, in
  // every generated message id, and in the transcript's metadata line.
  const rewritten = raw.replaceAll(`${sourceId}-u`, `${newId}-u`)
    .replaceAll(`${sourceId}-t`, `${newId}-t`)
    .replaceAll(JSON.stringify(sourceId), JSON.stringify(newId));
  writeFileSync(join(target, name), rewritten);
  console.log(`${name}: ${rewritten.length} bytes, id rewritten ${rewritten === raw ? 'NO' : 'yes'}`);
}

const rows = readFileSync(join(target, 'events.jsonl'), 'utf8')
  .split('\n')
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line));
const header = rows.find((row) => row.type === 'session');
const events = rows.filter((row) => row.type !== 'session');
const title = events.find((event) => event.type === 'session/title');
console.log(`header id:   ${header.id}`);
console.log(`events:      ${events.length}`);
console.log(`title cites: ${JSON.stringify(title?.data?.messageSeqs)} -> ${events[title?.data?.messageSeqs?.[0]]?.type}`);
console.log(`violation:   ${firstStructuralViolation(events, header.id) ?? 'NONE'}`);
