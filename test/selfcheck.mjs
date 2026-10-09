/**
 * Standalone checks for the trae-session-vault plugin modules.
 * Run with the DSH runtime's node: `node test/selfcheck.mjs`
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** @returns {Promise<boolean>} whether a path exists. */
const exists = async (path) => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

const pluginRoot = pathToFileURL(join(new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), '..')).href;

const { decodeZstdFrames, hasZstd } = await import(`${pluginRoot}/lib/zstd.trae2.js`);
const skills = await import(`${pluginRoot}/lib/skills.trae2.js`);
const vault = await import(`${pluginRoot}/lib/vault.trae2.js`);
const { firstStructuralViolation } = vault;

/** The vault expects resolved vault settings, matching the plugin's own wrapper. */
const vaultConfig = (overrides = {}) => ({
  directory: '.dsh/conversations',
  includeRuntimeContext: false,
  maxToolResultChars: 2000,
  readGlobalSessions: true,
  ...overrides,
});

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

// ---------------------------------------------------------------- zstd
await check('zstd: codec is present in this runtime', () => {
  assert.equal(hasZstd(), true);
});

await check('zstd: decodes a multi-frame log and reports a truncated tail', async () => {
  const zlib = await import('node:zlib');
  const frames = ['{"type":"session","id":"a"}\n', '{"type":"turn/start","seq":1}\n', '{"type":"turn/end","seq":2}\n']
    .map((line) => zlib.zstdCompressSync(Buffer.from(line)));
  const complete = Buffer.concat(frames);
  const decoded = decodeZstdFrames(complete);
  assert.equal(decoded.frames, 3);
  assert.equal(decoded.skippedBytes, 0);
  assert.match(decoded.text, /"type":"turn\/end"/);

  const partial = Buffer.concat([...frames, Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x04, 0x00])]);
  const tail = decodeZstdFrames(partial);
  assert.equal(tail.frames, 3, 'complete frames must still decode');
  assert.ok(tail.skippedBytes > 0, 'the partial frame must be reported');
  assert.match(tail.text, /turn\/start/);
});

// ---------------------------------------------------------------- skills
await check('skills: parses Trae frontmatter', () => {
  const parsed = skills.parseFrontmatter('---\nname: "my-skill"\ndescription: "does things"\n---\n\n# Body\n\ntext\n');
  assert.equal(parsed.data.name, 'my-skill');
  assert.equal(parsed.data.description, 'does things');
  assert.match(parsed.body, /# Body/);
  assert.equal(skills.parseFrontmatter('# no frontmatter'), undefined);
});

await check('skills: strict boolean grammar', () => {
  assert.equal(skills.booleanField('yes'), true);
  assert.equal(skills.booleanField('Off'), false);
  assert.throws(() => skills.booleanField('maybe'));
});

await check('skills: recursive discovery across nested and flat bundles', async () => {
  const root = await mkdtemp(join(tmpdir(), 'trae-skills-'));
  try {
    await mkdir(join(root, 'flat-skill'), { recursive: true });
    await writeFile(join(root, 'flat-skill', 'SKILL.md'), '---\nname: flat-skill\ndescription: a flat bundle\n---\nbody one\n');
    await mkdir(join(root, 'group', 'nested-skill'), { recursive: true });
    await writeFile(join(root, 'group', 'nested-skill', 'SKILL.md'), '---\nname: nested-skill\ndescription: a nested bundle\nwhen-to-use: when nested\n---\nbody two\n');
    await mkdir(join(root, 'group', '.git'), { recursive: true });
    await writeFile(join(root, 'group', '.git', 'SKILL.md'), '---\nname: ignored-skill\ndescription: must not appear\n---\n');
    await mkdir(join(root, 'broken'), { recursive: true });
    await writeFile(join(root, 'broken', 'SKILL.md'), 'no frontmatter here');
    await mkdir(join(root, 'Bad_Name'), { recursive: true });
    await writeFile(join(root, 'Bad_Name', 'SKILL.md'), '---\nname: Bad_Name\ndescription: bad name\n---\n');

    const files = await skills.collectSkillFiles(root, 6);
    assert.equal(files.length, 4, `expected 4 SKILL.md files, found ${files.length}`);

    const found = [];
    for (const file of files.sort()) {
      const loaded = await skills.readSkillFile(file, 'trae-project');
      if ('skipped' in loaded) {
        found.push(`skipped:${loaded.skipped.split(':')[0]}`);
        continue;
      }
      assert.equal(loaded.definition.invocation.modelInvocable, true);
      found.push(loaded.definition.name);
      assert.ok(loaded.definition.content.length > 0, `${loaded.definition.name} must have a body`);
      if (loaded.definition.name === 'nested-skill') assert.equal(loaded.definition.whenToUse, 'when nested');
    }
    assert.deepEqual(found.sort(), [
      'flat-skill',
      'nested-skill',
      'skipped:invalid skill name "Bad_Name"',
      'skipped:missing YAML frontmatter',
    ].sort());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await check('skills: walks up to find a project .trae/skills folder', async () => {
  const root = await mkdtemp(join(tmpdir(), 'trae-project-'));
  try {
    await mkdir(join(root, '.trae', 'skills'), { recursive: true });
    await mkdir(join(root, 'src', 'deep', 'inside'), { recursive: true });
    const found = await skills.findProjectSkillsDir(join(root, 'src', 'deep', 'inside'));
    assert.equal(found, join(root, '.trae', 'skills'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- vault
await check('vault: reproduces the persistence project slug', () => {
  assert.equal(vault.projectSlug('F:\\QwenTTS_Fn2'), '--F-QwenTTS_Fn2--');
  assert.equal(vault.projectSlug('C:\\Users\\linco\\Documents\\deepseek-harness-default-workspace'),
    '--C-Users-linco-Documents-deepseek-harness-default-workspace--');
  assert.equal(vault.projectSlug('/home/u/my project'), '--home-u-my~0020project--');
});
await check('vault: normalizes a conversation and drops injected context', () => {
  const events = [
    { type: 'turn/start', seq: 1, time: 1000, data: { turn: 1 } },
    { type: 'user/message', seq: 2, time: 1001, data: { role: 'user', content: [{ type: 'text', text: 'real question' }], source: { kind: 'user' }, id: 'm1' } },
    { type: 'user/message', seq: 3, time: 1002, data: { role: 'user', content: [{ type: 'text', text: 'runtime snapshot' }], source: { kind: 'runtime-context' }, id: 'm2' } },
    { type: 'assistant/message', seq: 4, time: 1003, data: { turn: 1, step: 1, message: { role: 'assistant', id: 'm3', source: { kind: 'model' }, content: [
      { type: 'reasoning', text: 'thinking' },
      { type: 'text', text: 'the answer' },
      { type: 'tool-call', id: 'c1', name: 'read', arguments: '{"file_path":"a.txt"}' },
    ] }, usage: { inputTokens: 5, outputTokens: 6 } } },
    { type: 'tool/result', seq: 5, time: 1004, data: { turn: 1, step: 1, message: { role: 'tool', source: { kind: 'tool', callId: 'c1' }, toolCallId: 'c1', isError: false, id: 'm4', content: [{ type: 'text', text: 'file body' }] } } },
    { type: 'session/title', seq: 6, time: 1005, data: { title: 'A titled conversation', messageSeqs: [2] } },
    { type: 'turn/end', seq: 7, time: 1006, data: { turn: 1, reason: { kind: 'completed' } } },
  ];
  const conversation = vault.normalizeConversation({ id: 's1', cwd: 'F:\\proj' }, events);
  assert.equal(conversation.session.title, 'A titled conversation');
  assert.equal(conversation.session.messageCount, 3);
  assert.equal(conversation.session.humanMessageCount, 1);
  assert.equal(conversation.messages[0].text, 'real question');
  assert.equal(conversation.messages[1].text, 'the answer');
  assert.equal(conversation.messages[1].toolCalls[0].name, 'read');
  assert.deepEqual(conversation.messages[1].toolCalls[0].arguments, { file_path: 'a.txt' });
  assert.equal(conversation.messages[2].name, 'read', 'tool result inherits the name from tool/call');
  assert.equal(conversation.messages[2].isError, false);
  assert.ok(!conversation.messages.some((m) => m.text === 'runtime snapshot'), 'injected context must be dropped');

  const kept = vault.normalizeConversation({ id: 's1' }, events, { includeRuntimeContext: true });
  assert.ok(kept.messages.some((m) => m.text === 'runtime snapshot'));
});

await check('vault: clamps oversized tool results', () => {
  const events = [{ type: 'tool/result', seq: 1, time: 1, data: { turn: 1, step: 1, message: { role: 'tool', source: { kind: 'tool', callId: 'c' }, toolCallId: 'c', id: 'm', content: [{ type: 'text', text: 'x'.repeat(100) }] } } }];
  const conversation = vault.normalizeConversation({ id: 's' }, events, { maxToolResultChars: 10 });
  assert.equal(conversation.messages[0].truncated, true);
  assert.match(conversation.messages[0].text, /90 more characters elided/);
});

await check('vault: renders Markdown without leaking reasoning blocks', () => {
  const conversation = vault.normalizeConversation({ id: 's', title: 'T' }, [
    { type: 'user/message', seq: 1, time: 1, data: { role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } } },
    { type: 'assistant/message', seq: 2, time: 2, data: { turn: 1, step: 1, message: { role: 'assistant', id: 'm', source: { kind: 'model' }, content: [{ type: 'reasoning', text: 'SECRET-REASONING' }, { type: 'text', text: 'hello' }] } } },
  ]);
  const markdown = vault.renderMarkdown(conversation);
  assert.match(markdown, /## You/);
  assert.match(markdown, /hello/);
  assert.ok(!markdown.includes('SECRET-REASONING'), 'reasoning blocks must not reach the transcript');
});

await check('vault: writes, indexes, and reads back an archive', async () => {
  const project = await mkdtemp(join(tmpdir(), 'trae-project-'));
  const sessionsRoot = await mkdtemp(join(tmpdir(), 'trae-sessions-'));
  try {
    const store = new vault.SessionVault({
      ctx: { logger: { warn() {}, info() {} }, sessions: { list: () => [] } },
      config: vaultConfig(),
      projectRoot: project,
      sessionsRoot,
    });
    const written = await store.write({
      header: { id: 'session-abc-123', cwd: project, createdAt: 5 },
      events: [
        { type: 'session/title', seq: 1, time: 10, data: { title: 'Archived chat' } },
        { type: 'user/message', seq: 2, time: 11, data: { role: 'user', content: [{ type: 'text', text: 'question' }], source: { kind: 'user' } } },
        { type: 'assistant/message', seq: 3, time: 12, data: { turn: 1, step: 1, message: { role: 'assistant', id: 'm', source: { kind: 'model' }, content: [{ type: 'text', text: 'answer' }] } } },
      ],
    });
    assert.equal(written.conversation.session.title, 'Archived chat');
    assert.equal(written.index.conversations.length, 1);

    const markdown = await readFile(join(store.sessionDir('session-abc-123'), 'conversation.md'), 'utf8');
    assert.match(markdown, /Archived chat/);
    assert.match(markdown, /answer/);

    const readBack = await store.read('abc-123', 'markdown');
    assert.ok(!('error' in readBack), `suffix lookup failed: ${readBack.error ?? ''}`);
    assert.equal(readBack.conversation.session.messageCount, 2);

    const jsonl = await store.read('session-abc-123', 'jsonl');
    const lines = jsonl.text.trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(lines[0].type, 'conversation');
    assert.equal(lines.length, 3);
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(sessionsRoot, { recursive: true, force: true });
  }
});

await check('vault: refuses to archive another project\'s session', async () => {
  const owner = await mkdtemp(join(tmpdir(), 'trae-owner-'));
  const stranger = await mkdtemp(join(tmpdir(), 'trae-stranger-'));
  const sessionsRoot = await mkdtemp(join(tmpdir(), 'trae-refuse-sessions-'));
  const warnings = [];
  try {
    const store = new vault.SessionVault({
      ctx: { logger: { warn: (message) => warnings.push(String(message)), info() {} }, sessions: { list: () => [] } },
      config: vaultConfig(),
      projectRoot: owner,
      sessionsRoot,
    });
    const foreign = {
      id: 'session-stranger-1',
      // The session belongs to a different project, so this vault must not take it.
      header: { id: 'session-stranger-1', cwd: stranger, createdAt: 1, isSeeded: false, version: 4 },
      snapshotEvents: () => [{ type: 'session/title', seq: 1, time: 2, data: { title: 'Elsewhere' } }],
    };
    const result = await store.exportLive(foreign);
    assert.equal(result.ok, false, 'a foreign session must not be archived');
    assert.equal(result.skipped, 'cwd does not belong to this vault');
    assert.ok(warnings.some((w) => w.includes('refusing to archive')), `expected a warning, got ${JSON.stringify(warnings)}`);

    // Nothing was written into this project's archive.
    const index = await store.readIndex();
    assert.equal(index.conversations.length, 0, `archive must stay empty, found ${JSON.stringify(index.conversations)}`);
    assert.equal(await exists(store.sessionDir('session-stranger-1')), false, 'no directory may be created for the foreign session');
    // The same session is accepted by the vault that actually owns it.
    const owning = new vault.SessionVault({
      ctx: { logger: { warn() {}, info() {} }, sessions: { list: () => [] } },
      config: vaultConfig(),
      projectRoot: stranger,
      sessionsRoot,
    });
    const accepted = await owning.exportLive(foreign);
    assert.equal(accepted.ok, true, 'the owning vault must accept it');
    assert.equal((await owning.readIndex()).conversations.length, 1);
  } finally {
    await rm(owner, { recursive: true, force: true });
    await rm(stranger, { recursive: true, force: true });
    await rm(sessionsRoot, { recursive: true, force: true });
  }
});

await check('vault: imports a durable multi-frame zstd session from disk', async () => {
  const zlib = await import('node:zlib');
  const project = await mkdtemp(join(tmpdir(), 'trae-import-project-'));
  const sessionsRoot = await mkdtemp(join(tmpdir(), 'trae-import-sessions-'));
  try {
    const sessionId = 'session-durable-1';
    const dir = join(sessionsRoot, vault.projectSlug(project), sessionId);
    await mkdir(dir, { recursive: true });
    const headerLine = JSON.stringify({ type: 'session', version: 4, id: sessionId, createdAt: 1, cwd: project, isSeeded: false });
    const bodyLines = [
      JSON.stringify({ type: 'session/title', seq: 1, time: 2, data: { title: 'From disk' } }),
      JSON.stringify({ type: 'user/message', seq: 2, time: 3, data: { role: 'user', content: [{ type: 'text', text: 'stored question' }], source: { kind: 'user' } } }),
      JSON.stringify({ type: 'assistant/message', seq: 3, time: 4, data: { turn: 1, step: 1, message: { role: 'assistant', id: 'm', source: { kind: 'model' }, content: [{ type: 'text', text: 'stored answer' }] } } }),
    ];
    // One frame per durable write, exactly as persistence appends them.
    const frames = [headerLine, ...bodyLines].map((line) => zlib.zstdCompressSync(Buffer.from(`${line}\n`)));
    await writeFile(join(dir, 'session.v4.jsonl.zstd'), Buffer.concat(frames));

    const store = new vault.SessionVault({
      ctx: { logger: { warn() {}, info() {} }, sessions: { list: () => [] } },
      config: vaultConfig(),
      projectRoot: project,
      sessionsRoot,
    });

    const discovered = await store.listDurableSessions();
    assert.equal(discovered.length, 1, `expected one discovered session, got ${JSON.stringify(discovered)}`);
    assert.equal(discovered[0].archived, false);

    const imported = await store.importFromDisk();
    assert.equal(imported.imported.length, 1, `import failed: ${JSON.stringify(imported.failed)}`);
    assert.equal(imported.imported[0].title, 'From disk');
    assert.equal(imported.imported[0].messages, 2);

    const readBack = await store.read(sessionId, 'markdown');
    assert.match(readBack.text, /stored answer/);

    const again = await store.importFromDisk();
    assert.equal(again.imported.length, 0);
    assert.equal(again.skipped.length, 1, 'a second import must skip the archived session');
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(sessionsRoot, { recursive: true, force: true });
  }
});

await check('vault: rebuilds a legacy archive that has no verbatim events', async () => {
  const project = await mkdtemp(join(tmpdir(), 'trae-legacy-'));
  const sessionsRoot = await mkdtemp(join(tmpdir(), 'trae-legacy-sessions-'));
  try {
    const { createFakeSessionPersistence } = await import('./fake-persistence.mjs');
    const fake = createFakeSessionPersistence();
    const store = new vault.SessionVault({
      ctx: { logger: { warn() {}, info() {} }, sessions: { list: () => [], get: () => undefined }, get: (n) => (n === 'sessionPersistence' ? fake : undefined) },
      config: vaultConfig(),
      projectRoot: project,
      sessionsRoot,
    });

    // Write a normal archive, then delete the verbatim record so it looks like
    // one written before `events.jsonl` existed.
    const written = await store.write({
      header: { id: 'session-legacy-1', cwd: 'F:\\elsewhere', createdAt: 1, isSeeded: false, version: 4 },
      events: [
        { type: 'session/title', seq: 4, time: 9, data: { title: 'Legacy' } },
        { type: 'user/message', seq: 5, time: 10, data: { role: 'user', content: [{ type: 'text', text: 'legacy question' }], source: { kind: 'user' }, surfaceOp: 'append' } },
        { type: 'assistant/message', seq: 6, time: 11, data: { turn: 1, step: 1, stream: [{ type: 'chunk' }], message: { role: 'assistant', id: 'm', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: 'legacy answer' }] }, surfaceOp: 'append' } },
        { type: 'tool/call', seq: 7, time: 12, data: { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{"file_path":"a.txt"}' } },
        { type: 'tool/result', seq: 8, time: 13, data: { turn: 1, step: 1, message: { role: 'tool', id: 't', source: { kind: 'tool', callId: 'c1' }, toolCallId: 'c1', isError: false, content: [{ type: 'text', text: 'file body' }] }, surfaceOp: 'append' } },
      ],
    });
    const dir = store.sessionDir('session-legacy-1');
    assert.ok(written.files.some((f) => f.endsWith('events.jsonl')));
    await rm(join(dir, 'events.jsonl'), { force: true });

    const read = await vault.readArchivedEvents(dir);
    assert.ok(!('error' in read), `rebuild failed: ${read.error ?? ''}`);
    assert.equal(read.reconstructed, true, 'the caller must be told this is not verbatim');
    assert.deepEqual(read.events.map((e) => e.seq), read.events.map((_, i) => i), 'seq must be contiguous from 0');

    // Every message must sit inside an open turn and step; the loader rejects the
    // whole stored log otherwise with "does not match an open turn and step".
    const kinds = read.events.map((e) => e.type);
    // The preset comes first, before any turn: an agent activation reads that
    // projection to compose the resumed session, and without it the conversation
    // opens but cannot be continued.
    assert.equal(kinds[0], 'agent-preset/selected', `the log must announce its agent preset first, got ${kinds[0]}`);
    assert.equal(read.events[0].data.agentPreset, 'standard', 'a rebuild with no declared preset uses the shipped default');
    assert.equal(kinds[1], 'turn/start', `the log must open a turn next, got ${kinds[1]}`);
    assert.equal(kinds[2], 'step/start', `a message needs an open step, got ${kinds[2]}`);
    assert.deepEqual(kinds.slice(-2), ['step/end', 'turn/end'], 'the log must close what it opened');
    let openStep = null;
    let openTurn = null;
    for (const event of read.events) {
      if (event.type === 'turn/start') openTurn = event.data.turn;
      if (event.type === 'step/start') openStep = event.data.step;
      if (event.type === 'step/end') openStep = null;
      if (['user/message', 'assistant/message', 'tool/result'].includes(event.type)) {
        // A real `user/message` carries no position; the others must agree.
        if (event.data.step !== undefined) {
          assert.equal(event.data.step, openStep, `${event.type} at seq ${event.seq} is outside its step`);
          assert.equal(event.data.turn, openTurn, `${event.type} at seq ${event.seq} is outside its turn`);
        }
      }
    }
    for (const event of read.events) {
      if (event.type === 'step/end' || event.type === 'turn/end') continue;
      assert.ok(event.seq === read.events.indexOf(event), 'seq must equal position');
    }

    const assistant = read.events.find((e) => e.type === 'assistant/message');
    assert.ok(assistant !== undefined, 'the assistant turn must survive');
    assert.ok(Array.isArray(assistant.data.stream), 'the loader requires a stream array on assistant/message');
    assert.deepEqual(assistant.data.message.content.map((c) => c.type), ['text', 'tool-call']);
    assert.equal(read.events.find((e) => e.type === 'tool/result').data.message.toolCallId, 'c1');

    // The reconstructed events must satisfy the same validation a real load does.
    const published = await store.importToDsh({ force: true });
    assert.deepEqual(published.failed, [], `publish failed: ${JSON.stringify(published.failed)}`);
    assert.equal(published.imported.length, 1);
    assert.equal(published.imported[0].reconstructed, true);
    const stored = fake.sessions.get(published.imported[0].importedAs);
    assert.equal(stored.header.cwd, project, 'it must belong to the workspace owning the archive');
    assert.ok(stored.events.some((e) => e.type === 'turn/start'), 'the stored log needs turn boundaries');
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(sessionsRoot, { recursive: true, force: true });
  }
});

await check('vault: refuses to publish a log the loader would reject', async () => {
  const project = await mkdtemp(join(tmpdir(), 'trae-invalid-'));
  const sessionsRoot = await mkdtemp(join(tmpdir(), 'trae-invalid-sessions-'));
  try {
    // A message with no open turn or step is exactly what made a real session
    // unopenable, so publishing must refuse it up front.
    const violation = vault.firstStructuralViolation([
      { type: 'user/message', seq: 0, time: 1, data: { role: 'user', id: 'u', source: { kind: 'user' }, content: [] } },
    ]);
    assert.match(violation ?? '', /outside an open turn and step/);
    assert.equal(vault.firstStructuralViolation([]), undefined, 'an empty list has no violation');
    assert.equal(vault.firstStructuralViolation([
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } },
      { type: 'user/message', seq: 2, time: 3, data: { role: 'user', id: 'u', source: { kind: 'user' }, content: [] } },
    ]), undefined, 'a properly bounded message is sound');

    // A tool result whose call was never started is the defect that made a
    // published session unopenable with "not-started error requires an object".
    const assistant = (content) => ({
      type: 'assistant/message',
      time: 3,
      surfaceOp: 'append',
      data: { turn: 1, step: 1, stream: [], message: { role: 'assistant', id: 'a1', source: { kind: 'model' }, content } },
    });
    const callBlock = { type: 'tool-call', id: 'c1', name: 'pwsh', arguments: '{"command":"pwd"}' };
    const callEvent = (args) => ({ type: 'tool/call', time: 4, data: { turn: 1, step: 1, callId: 'c1', name: 'pwsh', arguments: args } });
    const resultEvent = () => ({
      type: 'tool/result',
      time: 5,
      surfaceOp: 'append',
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'tool',
          id: 't1',
          source: { kind: 'tool', callId: 'c1' },
          toolCallId: 'c1',
          isError: false,
          content: [{ type: 'text', text: 'ok' }],
        },
      },
    });
    const head = [
      { type: 'turn/start', time: 1, data: { turn: 1 } },
      { type: 'step/start', time: 2, data: { turn: 1, step: 1 } },
    ];
    const numbered = (list) => list.map((event, seq) => ({ ...event, seq }));
    assert.match(
      vault.firstStructuralViolation(numbered([...head, assistant([callBlock]), resultEvent()])) ?? '',
      /never started/,
      'a result whose call never started must be rejected',
    );
    assert.equal(
      vault.firstStructuralViolation(numbered([...head, assistant([callBlock]), callEvent('{"command":"pwd"}'), resultEvent()])),
      undefined,
      'a started call makes its result loadable',
    );
    assert.match(
      vault.firstStructuralViolation(numbered([...head, assistant([callBlock]), callEvent('{}'), resultEvent()])) ?? '',
      /does not match its advertised call/,
      'a call must restate the advertised arguments',
    );

    // A rebuilt conversation must name itself. The title lives in the archive's
    // metadata, not in its messages, so without an explicit `session/title` the
    // sidebar shows every imported conversation as untitled.
    const rebuilt = vault.buildEventsFromConversation({
      session: { id: 'session-titled', title: 'A named conversation', startedAt: 1 },
      messages: [
        { seq: 0, time: 2, role: 'user', turn: 1, step: 1, text: 'the first question' },
        { seq: 1, time: 3, role: 'assistant', turn: 1, step: 1, text: 'the answer' },
      ],
    });
    const titles = rebuilt.filter((event) => event.type === 'session/title');
    assert.equal(titles.length, 1, 'a rebuilt conversation must carry exactly one title');
    assert.equal(titles[0].data.title, 'A named conversation');
    // The loader requires `messageSeqs` to cite an EARLIER human message whenever
    // the source kind is not `user`.
    assert.equal(titles[0].data.source.kind, 'fallback');
    assert.equal(titles[0].data.messageSeqs.length, 1);
    const cited = rebuilt[titles[0].data.messageSeqs[0]];
    assert.ok(cited !== undefined && titles[0].data.messageSeqs[0] < titles[0].seq, 'the title must cite an earlier message');
    assert.equal(cited.type, 'user/message');
    assert.equal(cited.data.source.kind, 'user');
    // A title the archive already carries must not be duplicated.
    const alreadyTitled = vault.buildEventsFromConversation({
      session: { id: 'session-titled-2', title: 'Archive title' },
      messages: [
        { type: 'session/title', data: { title: 'Original title' } },
        { seq: 0, time: 2, role: 'user', turn: 1, step: 1, text: 'hi' },
      ],
    });
    assert.equal(alreadyTitled.filter((event) => event.type === 'session/title').length, 0, 'an existing title must be kept as-is');

    // A copied log's delivery markers must name the session that now holds them:
    // the loader rejects a marker naming another session with
    // "current-generation delivery marker names the wrong Session".
    const markers = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'session-log-deepseek/delivery-accepted', seq: 1, time: 2, data: { sessionId: 'session-source', sessionFormatVersion: 4, throughSeq: 0 } },
      { type: 'session-log-deepseek/delivery-accepted', seq: 2, time: 3, data: { sessionId: 'session-target', sessionFormatVersion: 4, throughSeq: 1 } },
    ];
    const repointed = vault.repointDeliveryMarkers(markers, 'session-target');
    assert.equal(repointed[1].data.sessionId, 'session-target', 'a foreign marker must be repointed');
    assert.equal(repointed[1].data.throughSeq, 0, 'its meaning must be preserved');
    assert.equal(repointed[2], markers[2], 'a marker already naming the session must be left alone');
    assert.equal(markers[1].data.sessionId, 'session-source', 'the archive must not be mutated');
    assert.equal(
      vault.repointDeliveryMarkers(repointed, 'session-target'),
      repointed,
      'a log needing no change must be returned unchanged',
    );

    const { createFakeSessionPersistence } = await import('./fake-persistence.mjs');

    // The same repair must happen on the write path, for a verbatim archive.
    const markerFake = createFakeSessionPersistence();
    const markerStore = new vault.SessionVault({
      ctx: { logger: { warn() {}, info() {} }, sessions: { list: () => [], get: () => undefined }, get: (n) => (n === 'sessionPersistence' ? markerFake : undefined) },
      config: vaultConfig(),
      projectRoot: project,
      sessionsRoot,
    });
    const repointedWrite = await markerStore.materialize(markerFake, {
      header: { id: 'session-old', cwd: project, createdAt: 1, isSeeded: false, version: 4 },
      events: markers.map((event, seq) => ({ ...event, seq })),
    }, 'session-new');
    const storedMarkers = markerFake.sessions.get(repointedWrite.sessionId).events
      .filter((event) => event.type === 'session-log-deepseek/delivery-accepted');
    assert.equal(storedMarkers.length, 2, 'the markers must survive the write');
    for (const marker of storedMarkers) {
      assert.equal(marker.data.sessionId, 'session-new', 'every stored marker must name its own session');
    }

    const fake = createFakeSessionPersistence();
    const store = new vault.SessionVault({
      ctx: { logger: { warn() {}, info() {} }, sessions: { list: () => [], get: () => undefined }, get: (n) => (n === 'sessionPersistence' ? fake : undefined) },
      config: vaultConfig(),
      projectRoot: project,
      sessionsRoot,
    });
    // The write path rejects such a log rather than storing it — but only for a
    // log this module rebuilt. A verbatim log is DSH's own bytes and may carry a
    // compaction rewrite that a forward-only walk reads as a violation, so it
    // must be passed through untouched.
    await assert.rejects(
      () => store.materialize(fake, {
        header: { id: 'x', cwd: project, createdAt: 1, isSeeded: false, version: 4 },
        events: [{ type: 'user/message', seq: 0, time: 1, data: { role: 'user', id: 'u', source: { kind: 'user' }, content: [] } }],
        reconstructed: true,
      }, 'session-invalid-1'),
      /refusing to publish an invalid session log/,
    );
    assert.equal(fake.sessions.size, 0, 'nothing may be written for an invalid log');

    // A verbatim log with a compaction rewrite passes through unharmed.
    const rewritten = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } },
      { type: 'tool/result', seq: 2, time: 3, data: { turn: 1, step: 1, message: { role: 'tool', id: 't', source: { kind: 'tool', callId: 'c' }, toolCallId: 'c', isError: false, content: [] } } },
      { type: 'compaction/prune', seq: 3, time: 4, data: {} },
      { type: 'tool/result', seq: 4, time: 5, data: { turn: 1, step: 1, message: { role: 'tool', id: 't', source: { kind: 'tool', callId: 'c' }, toolCallId: 'c', isError: false, content: [] } } },
    ];
    const written = await store.materialize(fake, {
      header: { id: 'session-verbatim-1', cwd: project, createdAt: 1, isSeeded: false, version: 4 },
      events: rewritten,
    }, 'session-verbatim-1');
    assert.equal(written.events, rewritten.length, 'a verbatim log must be stored as-is');
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(sessionsRoot, { recursive: true, force: true });
  }
});

await check('vault: a session outside its workspace gets a copy under a fresh id', async () => {
  const project = await mkdtemp(join(tmpdir(), 'trae-unreadable-'));
  const sessionsRoot = await mkdtemp(join(tmpdir(), 'trae-unreadable-sessions-'));
  try {
    const { createFakeSessionPersistence } = await import('./fake-persistence.mjs');
    let reads = 0;
    const fake = createFakeSessionPersistence();
    // `open(..., 'read')` fails while `stat` still succeeds: the situation that
    // once looped, republishing a repair copy that then collided with itself.
    const originalOpen = fake.open.bind(fake);
    fake.open = async (id, access) => {
      if (access === 'read') {
        reads += 1;
        throw new Error('transient read failure');
      }
      return originalOpen(id, access);
    };
    // The workspace lists nothing, standing in for an archive whose ledger was
    // copied in from another project: the recorded session is not a member here,
    // so the conversation must still appear.
    const store = new vault.SessionVault({
      ctx: { logger: { warn() {}, info() {} }, sessions: { list: () => [], get: () => undefined }, get: (n) => (n === 'sessionPersistence' ? fake : undefined) },
      config: vaultConfig(),
      projectRoot: project,
      sessionsRoot,
      attachSession: async () => true,
      workspaceMember: async () => false,
    });
    await store.write({
      header: { id: 'session-unread-1', cwd: project, createdAt: 1, isSeeded: false, version: 4 },
      events: vault.buildEventsFromConversation({
        session: { id: 'session-unread-1' },
        messages: [{ seq: 0, time: 1, role: 'user', turn: 1, step: 1, text: 'hi' }],
      }),
    });
    const first = await store.importToDsh();
    assert.equal(first.imported.length, 1, 'the first publish must succeed');
    const firstId = first.imported[0].importedAs;

    // A non-member must be published again — but beside the existing session, not
    // over it, and under a different id so nothing is clobbered.
    const second = await store.importToDsh();
    assert.equal(second.failed.length, 0, `nothing may fail: ${JSON.stringify(second.failed)}`);
    assert.equal(second.imported.length, 1, 'a conversation outside this workspace must be published here');
    const secondId = second.imported[0].importedAs;
    assert.notEqual(secondId, firstId, 'the copy must use a fresh id, not reuse the occupied one');
    assert.equal(fake.sessions.size, 2, `the original must survive, found ${[...fake.sessions.keys()].join(', ')}`);

    // The workspace now lists that copy, so the ledger finally means "already
    // here" and nothing further is published. The check reads the published id
    // from the ledger, because a closure over a variable assigned below would
    // still be `undefined` when this runs.
    const published = new Set([secondId]);
    const memberStore = new vault.SessionVault({
      ctx: { logger: { warn() {}, info() {} }, sessions: { list: () => [], get: () => undefined }, get: (n) => (n === 'sessionPersistence' ? fake : undefined) },
      config: vaultConfig(),
      projectRoot: project,
      sessionsRoot,
      workspaceMember: async (id) => published.has(id),
    });
    const third = await memberStore.importToDsh();
    assert.equal(third.imported.length, 0, 'a member must not be published again');
    assert.equal(third.skipped.length, 1);
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(sessionsRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- share import
const share = await import(`${pluginRoot}/lib/share.trae2.js`);

/**
 * A stand-in for the share API's own JSON.
 *
 * Mirrors the shapes a real share returns: a `content` field holding a JSON
 * string of blocks for a question, and a `task` whose `content` holds the plan
 * items, each with a `tool_call_info` and its own timing.
 *
 * @param {object} [overrides] - share metadata overrides.
 * @returns {{ meta: object, pages: object[] }} the two endpoints' bodies.
 */
function fakeShare(overrides = {}) {
  const planItem = (id, name, params, extra = {}) => ({
    id,
    plan_item: {
      agent_display_name: 'SOLO',
      agent_id: 'solo_agent',
      reasoning_content: extra.reasoning ?? `thinking about ${name}`,
      thought: extra.thought ?? '',
      timing: {
        generated_at_ms: extra.at ?? 1000,
        tool_call_started_at_ms: extra.at ?? 1000,
        tool_call_finished_at_ms: (extra.at ?? 1000) + 500,
      },
      tool_call_info: {
        id: `${id}-call`,
        name,
        params,
        result: extra.result ?? { status: 'success' },
      },
    },
  });
  const items = [
    {
      share_session_id: 'ABCDEF..GHIJK',
      message_id: 'm1',
      role: 'user',
      message_type: 'general',
      status: 'completed',
      message_index: 1,
      created_at: '2026-01-02T03:04:05+08:00',
      content: JSON.stringify([{ type: 'text', text_content: 'fix the thing' }]),
    },
    {
      share_session_id: 'ABCDEF..GHIJK',
      message_id: 'm2',
      role: 'assistant',
      message_type: 'task',
      status: 'completed',
      message_index: 2,
      created_at: '2026-01-02T03:04:05+08:00',
      reply_to_message_id: 'm1',
      content: JSON.stringify({
        task_id: 't1',
        messages: [
          planItem('p1', 'Read', { file_path: '/tmp/a.swift' }, { at: 1000, reasoning: 'look first' }),
          planItem('p2', 'Grep', { pattern: 'frame' }, {
            at: 2000,
            result: { status: 'success', data: { results: [{ file_path: '/tmp/a.swift', content: 'one match' }] } },
          }),
          planItem('p3', 'finish', { summary: 'Fixed it by guarding the frame.' }, { at: 3000 }),
        ],
      }),
    },
    {
      share_session_id: 'ABCDEF..GHIJK',
      message_id: 'm3',
      role: 'user',
      message_type: 'general',
      status: 'completed',
      message_index: 3,
      created_at: '2026-01-02T03:10:00+08:00',
      content: JSON.stringify([
        { type: 'text', text_content: 'and the second thing' },
        { type: 'web_page', data: { url: 'https://example.test/doc' } },
      ]),
    },
    {
      share_session_id: 'ABCDEF..GHIJK',
      message_id: 'm4',
      role: 'assistant',
      message_type: 'task',
      status: 'completed',
      message_index: 4,
      created_at: '2026-01-02T03:10:00+08:00',
      content: JSON.stringify({
        task_id: 't2',
        messages: [planItem('p4', 'Edit', { file_path: '/tmp/b.swift' }, { at: 4000, reasoning: '', thought: 'Applying the fix.' })],
      }),
    },
  ];
  return {
    meta: {
      code: 0,
      data: {
        share_session_id: 'ABCDEF..GHIJK',
        title: 'Fix the thing',
        created_at: '2026-01-05T00:00:00+08:00',
        creator_name: 'someone',
        status: 'active',
        ...overrides,
      },
      message: 'success',
    },
    pages: [{ code: 0, data: { items, has_more: false }, message: 'success' }],
  };
}

/**
 * Build a `fetch` double that answers the two share API paths.
 * @param {{ meta: object, pages: object[] }} fixture - the canned responses.
 * @param {string[]} [seen] - collects the requested URLs.
 * @returns {typeof globalThis.fetch} the double.
 */
function fakeFetch(fixture, seen = []) {
  return async (url) => {
    seen.push(String(url));
    const path = new URL(String(url)).pathname;
    const body = path.endsWith('/messages')
      ? fixture.pages[0]
      : fixture.meta;
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      async json() {
        return body;
      },
    };
  };
}

await check('share: recognises every form of a share link', () => {
  const expected = 'H4TT51C..LW19X';
  for (const input of [
    'https://share.traecontent.cn/share/H4TT51C..LW19X?enter_from=pc',
    'share.traecontent.cn/share/H4TT51C..LW19X',
    '/share/H4TT51C..LW19X',
    'H4TT51C..LW19X',
  ]) {
    assert.equal(share.extractShareId(input), expected, `${input} must resolve to the share id`);
  }
  assert.equal(share.extractShareId('https://example.test/other'), 'other');
  assert.equal(share.extractShareId('   '), undefined);
  assert.equal(share.extractShareId(undefined), undefined);
});

await check('share: the archive id is stable and filesystem-safe', () => {
  const first = share.shareSessionId('H4TT51C..LW19X');
  assert.equal(first, share.shareSessionId('H4TT51C..LW19X'), 'the same share must map to the same id');
  assert.match(first, /^trae-share-[A-Za-z0-9_-]+$/);
  assert.ok(!first.includes('.'), 'a dot in the share id must not survive into a directory name');
  assert.notEqual(first, share.shareSessionId('OTHER..ID'));
  // A share id made only of punctuation still gets a stable, distinct identity.
  assert.match(share.shareSessionId('..'), /^trae-share-[0-9a-f]{12}$/);
});

await check('share: a mixed-offset conversation keeps its own order and times', () => {
  // Trae stamps a turn with the wall clock of whoever asked, so one share holds
  // several offsets. Decoding each at its own offset would interleave the turns.
  const items = [
    { role: 'user', created_at: '2026-01-02T03:00:00+08:00', content: JSON.stringify([{ type: 'text', text_content: 'east' }]) },
    { role: 'user', created_at: '2026-01-02T03:30:00Z', content: JSON.stringify([{ type: 'text', text_content: 'utc' }]) },
    { role: 'user', created_at: '2026-01-02T04:00:00+08:00', content: JSON.stringify([{ type: 'text', text_content: 'east again' }]) },
  ];
  const conversion = share.convertShare(
    { shareId: 'MIXED..OFFSET', messages: items, title: 'mixed' },
    { cwd: 'C:\\project' },
  );
  const times = conversion.events.map((event) => event.time);
  assert.ok(times.every((time, index) => index === 0 || time >= times[index - 1]), 'event times must never go backwards');
  assert.deepEqual(
    [...new Set(conversion.events.filter((event) => event.type === 'user/message').map((event) => event.data.content[0].text))],
    ['east', 'utc', 'east again'],
    'the questions must keep the order they were asked in',
  );
  const offsets = conversion.events.filter((event) => event.type === 'user/message').map((event) => event.time);
  assert.ok(offsets[1] < offsets[2], 'the UTC question precedes the later +08:00 one');
});

await check('share: converts a conversation into a loadable event log', () => {
  const { pages, meta } = fakeShare();
  const conversion = share.convertShare(
    {
      shareId: 'ABCDEF..GHIJK',
      origin: 'https://share.traecontent.cn',
      title: meta.data.title,
      sharedAt: Date.parse(meta.data.created_at),
      messages: pages[0].data.items,
    },
    { cwd: 'C:\\project', maxToolResultChars: 2000, agentPreset: 'standard' },
  );
  assert.deepEqual(conversion.events.map((event) => event.seq), conversion.events.map((_, index) => index));
  assert.equal(vault.firstStructuralViolation(conversion.events, conversion.header.id), undefined);
  assert.equal(conversion.header.agentPreset, 'standard', 'a session that cannot be resumed is not worth importing');
  assert.equal(conversion.stats.turns, 2);
  assert.equal(conversion.stats.humanMessages, 2);
  // `finish` is Trae's way of handing over the answer, so it becomes reply text
  // rather than a tool call the reader cannot follow — leaving two real calls
  // plus the read the first turn opened with.
  assert.equal(conversion.stats.toolCalls, 3);
  assert.equal(conversion.conversation.messages.filter((message) => message.role === 'assistant'
    && (message.toolCalls ?? []).some((call) => call.name === 'finish')).length, 0,
  'finish must not survive as a tool call');
  assert.ok(conversion.events.some((event) => event.type === 'session/title'));
  const title = conversion.events.find((event) => event.type === 'session/title');
  assert.equal(title.data.title, 'Fix the thing');
  assert.equal(title.data.messageSeqs.length, 1);
  assert.ok(title.data.messageSeqs[0] < title.seq, 'the title must cite an earlier message');
  // Every advertised call has a matching `tool/call` and a result.
  const advertised = conversion.events
    .filter((event) => event.type === 'assistant/message')
    .flatMap((event) => event.data.message.content.filter((block) => block.type === 'tool-call'))
    .map((block) => block.id);
  const started = conversion.events.filter((event) => event.type === 'tool/call').map((event) => event.data.callId);
  const results = conversion.events.filter((event) => event.type === 'tool/result').map((event) => event.data.message.toolCallId);
  assert.deepEqual(started, advertised);
  assert.deepEqual(results, advertised);
  // A share strips most tool output; the transcript must say so, not imply empty.
  assert.ok(conversion.warnings.some((line) => /no shared output/.test(line)));
  const omitted = conversion.events.find((event) => event.type === 'tool/result');
  assert.match(omitted.data.message.content[0].text, /does not include this call's output/);
  // The grep result the share did keep survives verbatim.
  const kept = conversion.events.filter((event) => event.type === 'tool/result')[1];
  assert.match(kept.data.message.content[0].text, /one match/);
  // The question keeps the trailing link its second block carried.
  const question = conversion.conversation.messages.find((message) => message.role === 'user' && /second thing/.test(message.text));
  assert.match(question.text, /https:\/\/example\.test\/doc/);
  assert.equal(conversion.conversation.session.sourceUrl, 'https://share.traecontent.cn/share/ABCDEF..GHIJK');
  assert.equal(typeof conversion.conversation.session.sharedAt, 'number', 'when the share was published is its own fact');
});

await check('share: steps are numbered by one counter per turn', () => {
  // The second defect this converter shipped: the question's step was hardcoded to
  // 1 and the assistant's items restarted at 1, so one turn emitted 1, 1, 2.
  // `turn/start` resets the loader's `nextStep` to 1 and every `step/start` must
  // equal it, so the whole log was rejected with "step/start does not match the
  // open turn and next step".
  const { pages, meta } = fakeShare();
  const conversion = share.convertShare(
    { shareId: 'ABCDEF..GHIJK', title: meta.data.title, messages: pages[0].data.items },
    { cwd: 'C:\\project' },
  );
  const byTurn = new Map();
  for (const event of conversion.events) {
    if (event.type !== 'step/start') continue;
    byTurn.set(event.data.turn, [...(byTurn.get(event.data.turn) ?? []), event.data.step]);
  }
  for (const [turn, numbers] of byTurn) {
    assert.deepEqual(numbers, numbers.map((_, index) => index + 1),
      `turn ${turn} numbered its steps ${numbers.join(', ')}`);
  }
  assert.deepEqual([...byTurn.keys()], [1, 2], 'one turn per question');
  assert.ok(byTurn.get(1).length > 1, 'the first turn holds the question and the reply');
  assert.equal(firstStructuralViolation(conversion.events, conversion.header.id), undefined);

  // The check must reject the shape that shipped — a step number that repeats.
  const repeated = conversion.events.map((event) => (event.type === 'step/start' && event.data.turn === 1 && event.data.step === 2
    ? { ...event, data: { ...event.data, step: 1 } }
    : event));
  assert.match(
    firstStructuralViolation(repeated, conversion.header.id) ?? '',
    /expects 2/,
    'a repeated step number must be refused',
  );
});

await check('share: the title cites the human message, and the log passes the loader rule', () => {
  // The defect that made an imported conversation unopenable in DSH: the title's
  // `messageSeqs` was read one statement too early, so it cited `turn/start`
  // (seq 0) instead of the human message (seq 2). The loader rejects the WHOLE
  // log for that — "session/title messageSeqs must cite distinct earlier human
  // user/message events" — and `firstStructuralViolation` now checks the same
  // rule, so this assertion is the guard that was missing.
  const { pages, meta } = fakeShare();
  const conversion = share.convertShare(
    { shareId: 'ABCDEF..GHIJK', title: meta.data.title, messages: pages[0].data.items },
    { cwd: 'C:\\project' },
  );
  const title = conversion.events.find((event) => event.type === 'session/title');
  assert.ok(title !== undefined, 'a converted share must carry a title');
  assert.equal(title.data.source.kind, 'fallback');
  assert.equal(title.data.messageSeqs.length, 1);
  const cited = conversion.events[title.data.messageSeqs[0]];
  assert.equal(cited?.type, 'user/message', `the title must cite a user message, got ${cited?.type}`);
  assert.equal(cited.data.source.kind, 'user');
  assert.ok(title.data.messageSeqs[0] < title.seq, 'the citation must be an earlier event');
  assert.equal(firstStructuralViolation(conversion.events, conversion.header.id), undefined,
    'the converted log must satisfy every rule the check enforces');

  // And the rule itself must reject the exact shape that shipped, so this cannot
  // regress silently: a title citing turn/start is a violation, not a warning.
  const broken = conversion.events.map((event) => (event.type === 'session/title'
    ? { ...event, data: { ...event.data, messageSeqs: [0] } }
    : event));
  assert.match(
    firstStructuralViolation(broken, conversion.header.id) ?? '',
    /cites seq 0.*rather than a human message/,
    'a title citing turn/start must be refused',
  );
  // A user-sourced title must carry no citations at all.
  const userSourced = conversion.events.map((event) => (event.type === 'session/title'
    ? { ...event, data: { ...event.data, source: { kind: 'user' } } }
    : event));
  assert.match(
    firstStructuralViolation(userSourced, conversion.header.id) ?? '',
    /empty exactly for a user title/,
  );
});

await check('share: the conversation begins with its first turn, not with the share', () => {  const { pages, meta } = fakeShare();
  const published = Date.parse(meta.data.created_at);
  const conversion = share.convertShare(
    { shareId: 'ABCDEF..GHIJK', title: meta.data.title, sharedAt: published, messages: pages[0].data.items },
    { cwd: 'C:\\project' },
  );
  const first = Date.parse('2026-01-02T03:04:05+08:00');
  const last = Date.parse('2026-01-02T03:10:00+08:00');
  assert.equal(conversion.header.createdAt, first, 'the header must record when the conversation happened');
  assert.equal(conversion.conversation.session.startedAt, first);
  assert.equal(conversion.conversation.session.endedAt >= last, true);
  assert.equal(conversion.conversation.session.sharedAt, published, 'when the share was published is its own fact');
  assert.notEqual(conversion.header.createdAt, published, 'the share was published after the conversation happened');
  assert.ok(conversion.events.every((event) => event.time >= first), 'nothing may predate the conversation');
});

await check('share: a conversation with no usable stamps still converts', () => {
  const conversion = share.convertShare(
    {
      shareId: 'NODATES..1',
      title: 'no dates',
      messages: [{ role: 'user', created_at: 'not a date', content: JSON.stringify([{ type: 'text', text_content: 'hello' }]) }],
    },
    { cwd: 'C:\\project', now: 1700000000000 },
  );
  assert.equal(conversion.header.createdAt, 1700000000000, 'the import time is the honest fallback');
  assert.equal(vault.firstStructuralViolation(conversion.events, conversion.header.id), undefined);
  assert.equal(conversion.stats.turns, 1);
});

await check('share: fetchShare follows pagination and refuses a broken continuation', async () => {
  const { meta, pages } = fakeShare();
  const seen = [];
  const first = await share.fetchShare('https://share.traecontent.cn/share/ABCDEF..GHIJK?enter_from=pc', {
    fetchImpl: fakeFetch({ meta, pages }, seen),
  });
  assert.equal(first.shareId, 'ABCDEF..GHIJK');
  assert.equal(first.messages.length, 4);
  assert.equal(first.title, 'Fix the thing');
  assert.equal(first.creatorName, 'someone');
  assert.equal(first.sharedAt, Date.parse('2026-01-05T00:00:00+08:00'));
  assert.equal(seen.length, 2, 'both endpoints must be read');
  assert.ok(seen[0].endsWith('/api/remote/v1/share/ABCDEF..GHIJK'));

  // Two pages, reached by the cursor the first response advertises.
  const paged = [];
  const second = await share.fetchShare('ABCDEF..GHIJK', {
    fetchImpl: async (url) => {
      paged.push(String(url));
      const body = String(url).includes('/messages')
        ? (String(url).includes('cursor=next-page')
          ? { code: 0, data: { items: pages[0].data.items.slice(2), has_more: false }, message: 'success' }
          : { code: 0, data: { items: pages[0].data.items.slice(0, 2), has_more: true, next_cursor: 'next-page' }, message: 'success' })
        : meta;
      return { ok: true, status: 200, statusText: 'OK', async json() { return body; } };
    },
  });
  assert.equal(second.messages.length, 4, 'every page must be collected');
  assert.equal(paged.filter((url) => url.includes('cursor=')).length, 1);

  await assert.rejects(
    () => share.fetchShare('ABCDEF..GHIJK', {
      fetchImpl: async (url) => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        async json() {
          return String(url).includes('/messages')
            ? { code: 0, data: { items: [], has_more: true }, message: 'success' }
            : meta;
        },
      }),
    }),
    /offers no cursor/,
  );
});

await check('share: the API refuses a private or withdrawn share with its own words', async () => {
  await assert.rejects(
    () => share.fetchShare('GONE..SHARE', {
      fetchImpl: async () => ({ ok: false, status: 404, statusText: 'Not Found', async json() { return {}; } }),
    }),
    /HTTP 404/,
  );
  await assert.rejects(
    () => share.fetchShare('DENIED..SHARE', {
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        async json() {
          return { code: 40301, message: 'share is not public', data: null };
        },
      }),
    }),
    /refused the request \(code 40301: share is not public\)/,
  );
  await assert.rejects(
    () => share.fetchShare('not a share at all///'),
    /is not a Trae share URL or share id/,
  );
});

await check('vault: adopts a converted share as an archive and publishes it', async () => {
  const project = await mkdtemp(join(tmpdir(), 'share-project-'));
  const sessionsRoot = await mkdtemp(join(tmpdir(), 'share-sessions-'));
  try {
    const { createFakeSessionPersistence } = await import('./fake-persistence.mjs');
    const { pages, meta } = fakeShare();
    const conversion = share.convertShare(
      {
        shareId: 'ABCDEF..GHIJK',
        origin: 'https://share.traecontent.cn',
        title: meta.data.title,
        creatorName: 'someone',
        sharedAt: Date.parse(meta.data.created_at),
        messages: pages[0].data.items,
      },
      { cwd: project },
    );
    const fake = createFakeSessionPersistence();
    const store = new vault.SessionVault({
      ctx: {
        logger: { warn() {}, info() {} },
        sessions: { list: () => [], get: () => undefined },
        get: (name) => (name === 'sessionPersistence' ? fake : undefined),
      },
      config: vaultConfig(),
      projectRoot: project,
      sessionsRoot,
      attachSession: async () => true,
      workspaceMember: async () => false,
    });
    const written = await store.adopt({
      header: conversion.header,
      events: conversion.events,
      conversation: conversion.conversation,
    });
    assert.equal(written.files.length, 3, 'transcript, verbatim events, and Markdown are written');

    // The transcript and the events must describe one conversation. The vault
    // derived the transcript from these very events, so reading it back has to
    // return the same messages.
    const read = await store.read(conversion.header.id, 'json');
    assert.ok(!('error' in read), `the archive must be readable: ${read.error}`);
    assert.equal(read.conversation.messages.length, conversion.conversation.messages.length);
    assert.equal(read.conversation.session.sourceUrl, conversion.conversation.session.sourceUrl);
    const markdown = await readFile(join(written.directory, 'conversation.md'), 'utf8');
    assert.match(markdown, /Imported from: https:\/\/share\.traecontent\.cn\/share\/ABCDEF\.\.GHIJK/);
    assert.match(markdown, /Fixed it by guarding the frame\./);
    assert.match(markdown, /does not include this call's output/);

    // The archive's own events are the import source, and they load verbatim.
    const published = await store.importToDsh();
    assert.equal(published.failed.length, 0, `publishing must succeed: ${JSON.stringify(published.failed)}`);
    assert.equal(published.imported.length, 1);
    assert.equal(published.imported[0].reconstructed, undefined, 'a converted share is not a reconstruction');
    const stored = fake.sessions.get(published.imported[0].importedAs);
    assert.equal(stored.header.cwd, project, 'an imported conversation belongs to the importing project');
    assert.equal(vault.firstStructuralViolation(stored.events, stored.header.id), undefined);
    assert.match(markdown, /- Created:/);

    // Re-importing the same link must not mint a second conversation.
    const again = await store.adopt({
      header: conversion.header,
      events: conversion.events,
      conversation: conversion.conversation,
    });
    assert.equal(again.files.length, 3);
    const reread = await store.read(conversion.header.id, 'json');
    assert.equal(reread.conversation.messages.length, conversion.conversation.messages.length);
    const republished = await store.importToDsh();
    assert.equal(republished.imported.length, 0, 'a second import must not create another session');
    assert.equal(fake.sessions.size, 1);
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(sessionsRoot, { recursive: true, force: true });
  }
});

await check('vault: a converted share is still rebuildable if its events are lost', async () => {
  // The `verbatim` claim is only good while `events.jsonl` is present. Deleting
  // it must leave a transcript that still reconstructs, not a lie.
  const project = await mkdtemp(join(tmpdir(), 'share-legacy-'));
  const sessionsRoot = await mkdtemp(join(tmpdir(), 'share-legacy-sessions-'));
  try {
    const { createFakeSessionPersistence } = await import('./fake-persistence.mjs');
    const { pages, meta } = fakeShare();
    const conversion = share.convertShare(
      { shareId: 'ABCDEF..GHIJK', origin: 'https://share.traecontent.cn', title: meta.data.title, messages: pages[0].data.items },
      { cwd: project },
    );
    const fake = createFakeSessionPersistence();
    const store = new vault.SessionVault({
      ctx: {
        logger: { warn() {}, info() {} },
        sessions: { list: () => [], get: () => undefined },
        get: (name) => (name === 'sessionPersistence' ? fake : undefined),
      },
      config: vaultConfig(),
      projectRoot: project,
      sessionsRoot,
      attachSession: async () => true,
      workspaceMember: async () => false,
    });
    const written = await store.adopt({
      header: conversion.header,
      events: conversion.events,
      conversation: conversion.conversation,
    });
    await rm(join(written.directory, 'events.jsonl'));
    const archived = await vault.readArchivedEvents(written.directory);
    assert.equal(archived.reconstructed, true, 'a transcript without its events is a reconstruction');
    assert.equal(archived.header.verbatim, undefined, 'the stale claim must not be believed');
    const published = await store.importToDsh();
    assert.equal(published.failed.length, 0, `a rebuilt log must publish: ${JSON.stringify(published.failed)}`);
    assert.equal(published.imported[0].reconstructed, true);
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(sessionsRoot, { recursive: true, force: true });
  }
});

await check('vault: concurrent index writes cannot lose each other', async () => {
  // The lost-ledger defect. `updateIndex` and `recordImport` are both
  // read-modify-write cycles over one `index.json`, and a publish pass runs them
  // while a scan started by that publish's own registry change runs the same
  // cycles. Interleaved, the second write is built from the state the first one
  // read — so the first publish's ledger row disappears, and the conversation
  // looks unpublished. The next pass then publishes it a second time, which is
  // how one conversation came to own both `<derived>` and `<derived>-2`.
  const project = await mkdtemp(join(tmpdir(), 'index-race-'));
  const sessionsRoot = await mkdtemp(join(tmpdir(), 'index-race-sessions-'));
  try {
    const store = new vault.SessionVault({
      ctx: { logger: { warn() {}, info() {} }, sessions: { list: () => [], get: () => undefined }, get: () => undefined },
      config: vaultConfig(),
      projectRoot: project,
      sessionsRoot,
    });
    const conversation = (id) => ({
      archiveVersion: vault.ARCHIVE_VERSION,
      session: { id, title: id, createdAt: 1, startedAt: 1, endedAt: 2, messageCount: 1, humanMessageCount: 1 },
      messages: [],
    });

    // Four archive writes and four ledger rows, all started before any finishes.
    await Promise.all([
      store.write({ header: { id: 'a1', cwd: project, createdAt: 1, isSeeded: false, version: 4 }, events: [], conversation: conversation('a1'), writeMarkdown: false }),
      store.write({ header: { id: 'a2', cwd: project, createdAt: 1, isSeeded: false, version: 4 }, events: [], conversation: conversation('a2'), writeMarkdown: false }),
      store.recordImport('a1', 'session-published-1'),
      store.recordImport('a2', 'session-published-2'),
    ]);

    const index = await store.readIndex();
    const archived = index.conversations.map((entry) => entry.id).sort();
    assert.deepEqual(archived, ['a1', 'a2'], `both conversations must survive the index: ${archived.join(', ')}`);
    assert.equal(index.imports.a1?.sessionId, 'session-published-1', 'the first ledger row must survive');
    assert.equal(index.imports.a2?.sessionId, 'session-published-2', 'and so must the second');

    // A ledger row is what stops the next pass from publishing again, so losing
    // one is not cosmetic: it is the difference between one session and two.
    const reread = await store.readIndex();
    assert.deepEqual(Object.keys(reread.imports).sort(), ['a1', 'a2']);
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(sessionsRoot, { recursive: true, force: true });
  }
});

await check('vault: a ledger naming a missing session is repaired, not left stale', async () => {
  // The live state, reproduced: the session this vault had published was removed
  // from the store (a deleted artifact, a restored `.dsh` folder, an interrupted
  // publish), leaving an `index.json` row that names a session which no longer
  // exists — while the conversation's own artifact is still there under the
  // derived id. A stale row is worse than no row, because it tells the next pass
  // this conversation is published somewhere else.
  //
  // The invariant asserted is the one that must hold after any publish pass:
  // **the ledger names a session that exists**. It is checkable directly rather
  // than inferred from a count.
  //
  // Deliberately NOT asserted: that the existing artifact is adopted instead of a
  // copy being published. That reading is indistinguishable from an archive copied
  // in from another project — `materialize` stamps `cwd: this.projectRoot` on every
  // session it publishes, so the two are identical in every field available here —
  // and the copied-archive reading is the one that must win. See
  // `publishArchivedEntry`.
  const project = await mkdtemp(join(tmpdir(), 'stale-ledger-'));
  const sessionsRoot = await mkdtemp(join(tmpdir(), 'stale-ledger-sessions-'));
  try {
    const { createFakeSessionPersistence } = await import('./fake-persistence.mjs');
    const fake = createFakeSessionPersistence();
    const store = new vault.SessionVault({
      ctx: {
        logger: { warn() {}, info() {} },
        sessions: { list: () => [], get: () => undefined },
        get: (name) => (name === 'sessionPersistence' ? fake : undefined),
      },
      config: vaultConfig(),
      projectRoot: project,
      sessionsRoot,
      attachSession: async () => true,
      workspaceMember: async () => false,
    });
    const archivedId = 'share-stale-1';
    await store.write({
      header: { id: archivedId, cwd: project, createdAt: 1, isSeeded: false, version: 4 },
      events: vault.buildEventsFromConversation({
        session: { id: archivedId },
        messages: [{ seq: 0, time: 1, role: 'user', turn: 1, step: 1, text: 'hello' }],
      }),
    });
    const first = await store.importToDsh();
    const derived = first.imported[0].importedAs;

    // A row naming a session that does not exist, while the derived artifact does.
    const phantom = `${derived}-phantom`;
    await store.recordImport(archivedId, phantom);
    assert.equal((await store.readIndex()).imports[archivedId]?.sessionId, phantom, 'the stale row must be in place');
    assert.equal(await fake.stat(phantom), undefined, 'the named session must not exist');
    assert.notEqual(await fake.stat(derived), undefined, 'the derived session must exist');

    await store.importToDsh();
    const settled = await store.readIndex();
    const named = settled.imports[archivedId]?.sessionId;
    assert.notEqual(named, phantom, 'the stale row must not survive a publish pass');
    assert.ok(named === undefined || await fake.stat(named) !== undefined,
      `the ledger must name a session that exists, or nothing at all; it names ${named}`);

    // And the archive settles: a further pass adds nothing.
    const before = fake.sessions.size;
    const again = await store.importToDsh();
    assert.deepEqual(again.failed, [], `nothing may fail: ${JSON.stringify(again.failed)}`);
    assert.equal(fake.sessions.size, before, 'a settled archive must stop creating sessions');
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(sessionsRoot, { recursive: true, force: true });
  }
});

console.log(results.join('\n'));
console.log(`\n${results.filter((r) => r.startsWith('PASS')).length}/${results.length} checks passed`);
