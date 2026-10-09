/**
 * Diagnostic: rewrite a Trae-share archive with the corrected converter.
 *
 * The archive on disk was written by a converter whose `session/title` cited
 * `turn/start` instead of the human message, which makes the published session
 * unopenable: the loader rejects the whole log. This re-fetches the share,
 * converts it with the current code, and writes the archive through the vault's
 * own `adopt` — so the transcript, the markdown, and the index stay one
 * conversation — then reports whether the loader rule now passes.
 *
 * The session store is NOT touched: publishing is the plugin's job, and its
 * `force` path is what re-announces the corrected copy to the sidebar.
 *
 * Usage: node checks/share-repair-archive.mjs [shareUrl] [projectRoot]
 */
import { join } from 'node:path';
import { convertShare, fetchShare } from '../lib/share.trae2.js';
import { SessionVault, firstStructuralViolation, readArchivedEvents } from '../lib/vault.trae2.js';

const url = process.argv[2] ?? 'https://share.traecontent.cn/share/H4TT51C..LW19X?enter_from=pc';
const project = process.argv[3] ?? process.cwd();

const share = await fetchShare(url, { timeoutMs: 60000 });
console.log(`fetched share ${share.shareId}: "${share.title}" (${share.messages.length} rows)`);

const conversion = convertShare(share, { cwd: project, maxToolResultChars: 2000, agentPreset: 'standard' });
const title = conversion.events.find((event) => event.type === 'session/title');
const cited = conversion.events[title.data.messageSeqs[0]];
console.log(`title cites seq ${title.data.messageSeqs[0]} -> ${cited?.type} (source kind ${JSON.stringify(cited?.data?.source?.kind)})`);

const violationBefore = firstStructuralViolation(conversion.events, conversion.header.id);
if (violationBefore !== undefined) throw new Error(`the converter still produces an invalid log: ${violationBefore}`);

const vault = new SessionVault({
  ctx: {
    logger: { warn: (...args) => console.log('[warn]', ...args), info: () => {} },
    sessions: { list: () => [], get: () => undefined },
    get: () => undefined,
  },
  config: { directory: '.dsh/conversations', includeRuntimeContext: false, maxToolResultChars: 2000 },
  projectRoot: project,
  sessionsRoot: join(project, '.dsh', 'sessions-scratch'),
});

const written = await vault.adopt({
  header: conversion.header,
  events: conversion.events,
  conversation: conversion.conversation,
});
console.log(`wrote ${written.files.length} file(s) under ${written.directory}`);

const archived = await readArchivedEvents(written.directory);
if ('error' in archived) throw new Error(archived.error);
const violationAfter = firstStructuralViolation(archived.events, conversion.header.id);
console.log(`archived log violation: ${violationAfter ?? 'NONE'}`);
console.log(`archived events: ${archived.events.length} (converted ${conversion.events.length})`);
const archivedTitle = archived.events.find((event) => event.type === 'session/title');
console.log(`archived title cites: ${JSON.stringify(archivedTitle.data.messageSeqs)} -> ${archived.events[archivedTitle.data.messageSeqs[0]]?.type}`);
if (violationAfter !== undefined) {
  console.error('\nREPAIR FAILED: the archive still violates the loader rule');
  process.exitCode = 1;
} else {
  console.log('\nREPAIR OK: the archive now satisfies the loader rule; republish it with force to fix the stored session.');
}
