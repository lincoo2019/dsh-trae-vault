/**
 * Diagnostic: publish an archived conversation straight into the session store.
 *
 * This writes exactly what the persistence backend writes — a `session` header
 * line followed by the events, as zstd frames under the project's session
 * directory — and then registers the id with the workspace so the sidebar lists
 * it. It exists because the running Host can still be executing a *cached* vault
 * module: `force` then cannot supersede a recorded import, and no amount of
 * re-importing helps until the process is restarted.
 *
 * Every field is taken from the archive, so nothing is invented:
 *   - the id is derived exactly as `createSessionId` derives it;
 *   - the header is rebuilt the way `materialize` rebuilds it (this project's
 *     cwd, format version 4, the resolved agent preset);
 *   - the events are the archived ones, verbatim, renumbered from 0.
 *
 * Usage: node checks/session-adopt-archive.mjs <archiveId>
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import zlib from 'node:zlib';
import { firstStructuralViolation, projectSlug, resolvePreset } from '../lib/vault.trae2.js';

const project = process.argv[2] ?? process.cwd();
const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE, '.dsh');
const archiveId = process.argv[2];
if (archiveId === undefined) throw new Error('usage: <archiveId> [--force]');
const force = process.argv.includes('--force');

if (typeof zlib.zstdCompressSync !== 'function') {
  throw new Error('this Node runtime cannot compress zstd, so the log cannot be written here');
}

const archiveDir = join(project, '.dsh', 'conversations', archiveId);
const rows = readFileSync(join(archiveDir, 'events.jsonl'), 'utf8')
  .split('\n')
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line));
const original = rows.find((row) => row.type === 'session') ?? {};
const events = rows.filter((row) => row.type !== 'session').map((event, seq) => ({ ...event, seq }));

const violation = firstStructuralViolation(events, archiveId);
if (violation !== undefined) throw new Error(`refusing to publish an invalid log: ${violation}`);

// Exactly `createSessionId(projectRoot, sourceId)`.
const hex = createHash('sha256').update(`${project}\u0000${archiveId}`).digest('hex');
const sessionId = `session-${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;

const header = {
  type: 'session',
  version: 4,
  id: sessionId,
  createdAt: typeof original.createdAt === 'number' ? original.createdAt : Date.now(),
  cwd: project,
  isSeeded: false,
  delegationDepth: 0,
  ...resolvePreset(original, events),
};

const sessionDir = join(home, 'sessions', projectSlug(project), sessionId);
const target = join(sessionDir, 'session.v4.jsonl.zstd');
if (!force) {
  try {
    readFileSync(target);
    console.log(`already present: ${target}`);
    console.log('pass --force to overwrite it with this archive');
    process.exit(0);
  } catch {
    // Absent is the ordinary case.
  }
}

const text = `${[header, ...events].map((row) => JSON.stringify(row)).join('\n')}\n`;
mkdirSync(sessionDir, { recursive: true });
const compressed = zlib.zstdCompressSync(Buffer.from(text, 'utf8'));
writeFileSync(target, compressed);
console.log(`wrote ${compressed.length} bytes (${events.length} events) to ${target}`);

// Register it with the workspace so the sidebar groups it, and with the archive's
// ledger so the plugin treats it as this archive's publication.
const indexPath = join(project, '.dsh', 'conversations', 'index.json');
const index = JSON.parse(readFileSync(indexPath, 'utf8'));
index.imports = { ...(index.imports ?? {}), [archiveId]: { sessionId, at: Date.now() } };
writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);
console.log(`ledger: ${archiveId} -> ${sessionId}`);

const workspaceFile = join(home, 'storages', 'workspace.json');
const workspace = JSON.parse(readFileSync(workspaceFile, 'utf8'));
for (const entity of Object.values(workspace.tables.workspaces)) {
  if (entity.path.toLowerCase() !== project.toLowerCase()) continue;
  entity.sessionIds = [...new Set([...(entity.sessionIds ?? []), sessionId])];
  entity.updatedAt = new Date().toISOString();
  console.log(`workspace ${entity.path} now lists ${entity.sessionIds.length} session(s)`);
}
workspace.global.archivedSessionIds = (workspace.global.archivedSessionIds ?? []).filter((id) => id !== sessionId);
writeFileSync(workspaceFile, `${JSON.stringify(workspace, null, 2)}\n`);

console.log(`\npublished ${archiveId} as ${sessionId}`);
