/**
 * Live verification: import the real share the user linked, through the same
 * code path the plugin's `conversation_import_share` tool uses.
 *
 * The share is fetched from the live API, converted, archived into a throwaway
 * project folder, and published through a persistence double that validates the
 * header and every event the way DSH's own loader does. Nothing outside the
 * temporary folder is written.
 *
 * Usage: node checks/share-import-live.mjs [shareUrl]
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { convertShare, fetchShare } from '../lib/share.trae2.js';
import { SessionVault, firstStructuralViolation, readArchivedEvents, renderMarkdown } from '../lib/vault.trae2.js';
import { createFakeSessionPersistence } from './fake-persistence.mjs';

const url = process.argv[2] ?? 'https://share.traecontent.cn/share/H4TT51C..LW19X?enter_from=pc';
const project = await mkdtemp(join(tmpdir(), 'share-live-'));
const sessionsRoot = await mkdtemp(join(tmpdir(), 'share-live-sessions-'));
const results = [];
const check = async (label, fn) => {
  try {
    await fn();
    results.push(`PASS  ${label}`);
  } catch (error) {
    results.push(`FAIL  ${label}\n      ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
};

try {
  const share = await fetchShare(url, { timeoutMs: 60000 });
  const conversion = convertShare(share, { cwd: project, maxToolResultChars: 2000, agentPreset: 'standard' });

  await check('the live share is fetched with its metadata and every turn', () => {
    assert.equal(share.shareId, 'H4TT51C..LW19X');
    assert.ok(share.title.length > 0, 'the share records a title');
    assert.ok(share.messages.length >= 2, `expected turns, got ${share.messages.length}`);
    assert.equal(typeof share.sharedAt, 'number');
    console.log(`      fetched ${share.messages.length} message(s): "${share.title}" by ${share.creatorName ?? '(anonymous)'}`);
    console.log(`      ${JSON.stringify(conversion.stats)}`);
    for (const warning of conversion.warnings) console.log(`      warning: ${warning}`);
  });

  await check('the converted log satisfies the session structure contract', () => {
    assert.equal(firstStructuralViolation(conversion.events, conversion.header.id), undefined);
    assert.equal(conversion.events[0].type, 'turn/start');
    assert.deepEqual(
      conversion.events.map((event) => event.seq),
      conversion.events.map((_, index) => index),
    );
    const contentTypes = new Set(
      conversion.events
        .filter((event) => event.type === 'assistant/message')
        .flatMap((event) => event.data.message.content.map((block) => block.type)),
    );
    console.log(`      content block types: ${[...contentTypes].join(', ')}`);
    assert.ok(contentTypes.has('reasoning'), 'Trae reasoning is preserved as a reasoning block');
    assert.ok(contentTypes.has('tool-call'));
  });

  const fake = createFakeSessionPersistence();
  const vault = new SessionVault({
    ctx: {
      logger: { warn: () => {}, info: () => {} },
      sessions: { list: () => [], get: () => undefined },
      get: (name) => (name === 'sessionPersistence' ? fake : undefined),
    },
    config: { directory: '.dsh/conversations', includeRuntimeContext: false, maxToolResultChars: 2000 },
    projectRoot: project,
    sessionsRoot,
    attachSession: async () => true,
    workspaceMember: async () => false,
  });

  let written;
  await check('the archive writes a transcript, its events, and Markdown', async () => {
    written = await vault.adopt({
      header: conversion.header,
      events: conversion.events,
      conversation: conversion.conversation,
    });
    assert.equal(written.files.length, 3);
    const markdown = await readFile(join(written.directory, 'conversation.md'), 'utf8');
    assert.match(markdown, /Imported from: https:\/\/share\.traecontent\.cn\/share\/H4TT51C\.\.LW19X/);
    console.log(`      archive: ${written.directory}`);
  });

  await check('the archive reads back with the same conversation', async () => {
    const read = await vault.read(conversion.header.id, 'json');
    assert.ok(!('error' in read), `read failed: ${read.error}`);
    assert.equal(read.conversation.messages.length, conversion.conversation.messages.length);
    const archived = await readArchivedEvents(written.directory);
    assert.equal(archived.reconstructed, undefined, 'the verbatim events are the import source');
    assert.equal(firstStructuralViolation(archived.events, conversion.header.id), undefined);
  });

  await check('the conversation publishes as a real, valid DSH session', async () => {
    const published = await vault.importToDsh();
    assert.deepEqual(published.failed, [], `publish failed: ${JSON.stringify(published.failed)}`);
    assert.equal(published.imported.length, 1);
    const stored = fake.sessions.get(published.imported[0].importedAs);
    assert.ok(stored !== undefined, 'the session must be in the store');
    assert.equal(stored.header.cwd, project);
    assert.equal(stored.header.version, 4);
    // The double applies the loader's own header and event validation on append.
    console.log(`      published ${published.imported[0].importedAs} with ${stored.events.length} events`);
  });

  await check('re-importing the same link is idempotent', async () => {
    const before = fake.sessions.size;
    await vault.adopt({
      header: conversion.header,
      events: conversion.events,
      conversation: conversion.conversation,
    });
    const again = await vault.importToDsh();
    assert.equal(again.imported.length, 0, 'a repeat import must not create another session');
    assert.equal(fake.sessions.size, before);
  });

  console.log(results.join('\n'));
  console.log(`\n${results.filter((row) => row.startsWith('PASS')).length}/${results.length} live checks passed`);
  if (process.env.SHOW_MARKDOWN) console.log(`\n${renderMarkdown(conversion.conversation).slice(0, 1500)}`);
} finally {
  await rm(project, { recursive: true, force: true });
  await rm(sessionsRoot, { recursive: true, force: true });
}
