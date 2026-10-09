/**
 * Diagnostic: register a hand-built archive in the vault's index.
 *
 * `importToDsh` iterates the index, so an archive directory placed on disk by
 * hand is invisible to it until the index names it. Rebuilding the transcript and
 * calling the vault's own `write` would do that, but it would also re-derive the
 * log — and the point here is to keep a log that has already been corrected. So
 * this performs the index merge `updateIndex` performs, from the archive's own
 * recorded metadata.
 *
 * Usage: node checks/share-index-archive.mjs <archiveId>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const project = process.argv[2] ?? process.cwd();
const root = join(project, '.dsh', 'conversations');
const archiveId = process.argv[2];
if (archiveId === undefined) throw new Error('usage: <archiveId>');
const indexPath = join(root, 'index.json');

const index = JSON.parse(readFileSync(indexPath, 'utf8'));
const directory = join(root, archiveId);
const rows = readFileSync(join(directory, 'events.jsonl'), 'utf8')
  .split('\n')
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line));
const header = rows.find((row) => row.type === 'session');
const events = rows.filter((row) => row.type !== 'session');
const times = events.map((event) => event.time).filter((time) => Number.isFinite(time));
const humans = events.filter((event) => event.type === 'user/message').length;
const surfaces = events.filter((event) => event.type === 'user/message' || event.type === 'assistant/message').length;
const title = events.find((event) => event.type === 'session/title')?.data?.title ?? '(untitled conversation)';

const entry = {
  id: archiveId,
  title,
  createdAt: header.createdAt,
  startedAt: times.length > 0 ? Math.min(...times) : header.createdAt,
  endedAt: times.length > 0 ? Math.max(...times) : header.createdAt,
  messageCount: surfaces,
  humanMessageCount: humans,
  directory: archiveId,
  updatedAt: Date.now(),
};
// Preserve the import ledger: it is what stops an already-published conversation
// being published twice.
const others = (index.conversations ?? []).filter((candidate) => candidate.id !== archiveId);
others.push(entry);
others.sort((left, right) => (right.endedAt ?? right.updatedAt ?? 0) - (left.endedAt ?? left.updatedAt ?? 0));
const next = {
  ...index,
  updatedAt: Date.now(),
  conversations: others,
  imports: index.imports ?? {},
};
writeFileSync(indexPath, `${JSON.stringify(next, null, 2)}\n`);
console.log(`indexed ${archiveId}: "${title}", ${surfaces} messages, ${humans} from you`);
console.log(`conversations in index: ${others.length}`);
