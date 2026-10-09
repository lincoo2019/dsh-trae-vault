/**
 * Diagnostic: list stored sessions that DSH cannot open, and optionally remove
 * them from the store and the workspace registry.
 *
 * An unopenable session is worse than a missing one: the sidebar lists it, and
 * opening it reports a corrupt-log error. This finds them by the same contract
 * the loader enforces, then can retire them so only loadable conversations
 * remain.
 *
 * Usage:
 *   node checks/session-retire-broken.mjs                 # report only
 *   node checks/session-retire-broken.mjs --retire <id>…  # retire these ids
 */
import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeZstdFrames } from '../lib/zstd.trae2.js';
import { firstStructuralViolation, projectSlug } from '../lib/vault.trae2.js';

const project = process.argv[2] ?? process.cwd();
const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE, '.dsh');
const projectDir = join(home, 'sessions', projectSlug(project));
const workspaceFile = join(home, 'storages', 'workspace.json');

const retireIndex = process.argv.indexOf('--retire');
const toRetire = retireIndex === -1 ? [] : process.argv.slice(retireIndex + 1).filter((arg) => arg.length > 0);

/**
 * @param {string} id - the stored session id.
 * @returns {{ id: string, events: number, violation?: string, createdAt?: number }} its verdict.
 */
function inspect(id) {
  const dir = join(projectDir, id);
  try {
    if (!statSync(dir).isDirectory()) return { id, events: 0, violation: 'no artifact directory' };
    const file = readFileSync(join(dir, 'session.v4.jsonl.zstd'));
    const decoded = decodeZstdFrames(file);
    const rows = decoded.text.split('\n').filter((line) => line.trim().length > 0).map((line) => JSON.parse(line));
    const header = rows.find((row) => row.type === 'session');
    const events = rows.filter((row) => row.type !== 'session');
    const violation = firstStructuralViolation(events, header?.id ?? id);
    return { id, events: events.length, createdAt: header?.createdAt, ...(violation === undefined ? {} : { violation }) };
  } catch (error) {
    return { id, events: 0, violation: `unreadable: ${error instanceof Error ? error.message : String(error)}` };
  }
}

const workspace = JSON.parse(readFileSync(workspaceFile, 'utf8'));
const workspaceEntry = Object.values(workspace.tables.workspaces)
  .find((candidate) => candidate.path.toLowerCase() === project.toLowerCase());
const listed = workspaceEntry?.sessionIds ?? [];
console.log(`workspace ${workspaceEntry?.path ?? '(not registered)'} lists ${listed.length} session(s)`);

const verdicts = new Set([...listed]);
for (const id of toRetire) verdicts.add(id);
const rows = [...verdicts].map(inspect);
for (const row of rows) {
  console.log(`  ${row.violation === undefined ? 'OK      ' : 'BROKEN  '} ${row.id}  (${row.events} events)${row.violation === undefined ? '' : `\n            ${row.violation}`}`);
}

if (toRetire.length === 0) {
  console.log('\nreport only; pass --retire <id>… to remove the broken ones');
} else {
  for (const id of toRetire) {
    const dir = join(projectDir, id);
    if (statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
      rmSync(dir, { recursive: true, force: true });
      console.log(`removed artifact ${id}`);
    } else {
      console.log(`no artifact for ${id} (nothing to remove)`);
    }
  }
  writeFileSync(`${workspaceFile}.bak-retire`, readFileSync(workspaceFile));
  const drop = new Set(toRetire);
  for (const entity of Object.values(workspace.tables.workspaces)) {
    entity.sessionIds = (entity.sessionIds ?? []).filter((id) => !drop.has(id));
  }
  workspace.global.archivedSessionIds = (workspace.global.archivedSessionIds ?? []).filter((id) => !drop.has(id));
  writeFileSync(workspaceFile, `${JSON.stringify(workspace, null, 2)}\n`);
  console.log(`unregistered ${toRetire.length} id(s) from the workspace registry`);
  const after = Object.values(workspace.tables.workspaces)
    .find((candidate) => candidate.path.toLowerCase() === project.toLowerCase());
  console.log(`registry now lists: ${(after?.sessionIds ?? []).join(', ') || '(none)'}`);
}
