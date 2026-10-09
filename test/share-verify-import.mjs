/**
 * Diagnostic: verify an imported share session end to end on disk.
 *
 * Checks the three facts that decide whether the conversation opens and resumes:
 * the archive holds the transcript and its verbatim events, the stored session
 * holds exactly those events, and the log announces the agent preset a resume
 * needs.
 *
 * Usage: node checks/share-verify-import.mjs <archiveId> <storedSessionId>
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeZstdFrames } from '../lib/zstd.trae2.js';
import { firstStructuralViolation, projectSlug, readArchivedEvents } from '../lib/vault.trae2.js';

const archiveId = process.argv[2];
if (archiveId === undefined) throw new Error('usage: <archiveId> [--force]');
const sessionId = process.argv[3] ?? 'session-8c8624bb-ba51-4c84-aee0-e063c64356e6';
const project = process.argv[2] ?? process.cwd();
const archiveDir = join(project, '.dsh', 'conversations', archiveId);
const storedFile = join(
  process.env.DSH_HOME ?? join(process.env.USERPROFILE, '.dsh'),
  'sessions',
  projectSlug(project),
  sessionId,
  'session.v4.jsonl.zstd',
);

const archived = await readArchivedEvents(archiveDir);
if ('error' in archived) throw new Error(archived.error);
const stored = decodeZstdFrames(readFileSync(storedFile)).text
  .split('\n')
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line));
const header = stored.find((row) => row.type === 'session');
const events = stored.filter((row) => row.type !== 'session');

const results = [];
const check = (label, fn) => {
  try {
    fn();
    results.push(`PASS  ${label}`);
  } catch (error) {
    results.push(`FAIL  ${label}\n      ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
};
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

check('the archive holds a transcript and verbatim events', () => {
  assert(archived.events.length > 0, 'events.jsonl must be present');
  assert(archived.reconstructed === undefined, 'the verbatim record must be the import source');
  const markdown = readFileSync(join(archiveDir, 'conversation.md'), 'utf8');
  assert(markdown.startsWith('# Fix ATS Secure Connection Error'), `unexpected title: ${markdown.slice(0, 60)}`);
  assert(markdown.includes('Imported from: https://share.traecontent.cn/share/H4TT51C..LW19X'), 'provenance must be recorded');
});

check('the archived log satisfies the structural contract', () => {
  const violation = firstStructuralViolation(archived.events, archiveId);
  assert(violation === undefined, String(violation));
});

check('the stored session holds the archive events, renumbered from 0', () => {
  assert(header !== undefined, 'the stored log needs a header');
  assert(header.id === sessionId, `header id ${header.id} must be the session id`);
  assert(header.cwd === project, `cwd ${header.cwd} must be the importing project`);
  assert(header.version === 4, `version ${header.version}`);
  assert(header.isSeeded === false, 'an import is not a seed');
  assert(events.length === archived.events.length, `${events.length} stored vs ${archived.events.length} archived`);
  assert(events.every((event, index) => event.seq === index), 'seq must be contiguous from 0');
  const violation = firstStructuralViolation(events, sessionId);
  assert(violation === undefined, String(violation));
});

check('the session announces the preset a resume needs', () => {
  assert(header.agentPreset === 'standard', `header agentPreset is ${header.agentPreset}`);
  const named = Date.parse('2026-01-01');
  assert(typeof named === 'number');
  const timeline = events.map((event) => event.time);
  assert(timeline.every((time, index) => index === 0 || time >= timeline[index - 1]), 'event times must not go backwards');
});

check('the conversation is complete and in order', () => {
  const users = events.filter((event) => event.type === 'user/message');
  const titles = events.filter((event) => event.type === 'session/title');
  assert(users.length === 10, `${users.length} human messages`);
  assert(titles.length === 1, 'exactly one title');
  assert(users[0].data.content[0].text === 'iOS上UI显示不全', 'the first question must survive');
  const turns = events.filter((event) => event.type === 'turn/start').map((event) => event.data.turn);
  assert(JSON.stringify(turns) === JSON.stringify([...Array(10)].map((_, index) => index + 1)), `turns: ${turns.join(',')}`);
});

console.log(results.join('\n'));
console.log(`\n${results.filter((row) => row.startsWith('PASS')).length}/${results.length} import checks passed`);
console.log(`archive: ${archiveDir}`);
console.log(`stored:  ${storedFile}`);
