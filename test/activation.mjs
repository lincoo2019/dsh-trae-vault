/**
 * Activation smoke test: loads index.js, runs apply() against a mock context,
 * and exercises the registered provider and tools for real.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

/**
 * The package under test, as a module URL.
 *
 * DSH loads a bundle by absolute path, so this test does too. It works both from
 * a standalone clone (where the package is this file's parent) and from a
 * development checkout that keeps the package in a sibling directory — the shape
 * the plugin was built in, and the shape that made `process.cwd()` the wrong
 * anchor.
 */
const packageDir = existsSync(join(process.cwd(), 'index.js'))
  ? process.cwd()
  : join(process.cwd(), '.dsh-plugin-dev', 'dsh-trae-session-vault');
if (!existsSync(join(packageDir, 'index.js'))) {
  throw new Error(`cannot find the package: run this from the directory that contains it (tried ${packageDir})`);
}
const root = pathToFileURL(packageDir).href;

/**
 * Capture the plugin's polling timer so it can be driven by hand.
 *
 * The plugin polls the workspace registry to notice an archive that appears
 * after startup. Waiting five real seconds per assertion would make this suite
 * slow and flaky, so the interval callback is recorded and invoked directly.
 */
const pollCallbacks = [];
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (fn, ms) => {
  pollCallbacks.push(fn);
  return realSetInterval(() => {}, ms);
};

const plugin = await import(`${root}/index.js`);
const { SessionVault, firstStructuralViolation } = await import(`${root}/lib/vault.trae2.js`);
const { createFakeSessionPersistence } = await import('./fake-persistence.mjs');

const project = await mkdtemp(join(tmpdir(), 'activate-project-'));
const sessionsRoot = await mkdtemp(join(tmpdir(), 'activate-sessions-'));
const lines = [];
const logged = (...args) => { const line = args.join(' '); lines.push(line); if (process.env.TRACE) console.log('    [plugin]', line); };

// A realistic Trae skills tree, matching the workspace's own layout.
await mkdir(join(project, '.trae', 'skills', 'comfyui-image-gen'), { recursive: true });
await writeFile(join(project, '.trae', 'skills', 'comfyui-image-gen', 'SKILL.md'),
  '---\nname: "comfyui-image-gen"\ndescription: "Generate images through ComfyUI workflows."\n---\n\n# ComfyUI\n\nRun the workflow.\n');
await mkdir(join(project, '.trae', 'skills', 'group', 'nested-one'), { recursive: true });
await writeFile(join(project, '.trae', 'skills', 'group', 'nested-one', 'SKILL.md'),
  '---\nname: nested-one\ndescription: "Nested Trae bundle."\n---\nbody\n');

/** Registered skill providers. */
const providers = new Map();
/** Registered tools. */
const tools = new Map();
/** Registered event listeners. */
const listeners = new Map();
const disposers = [];

/**
 * Assert a schema uses only the subset `@deepseek-ai/dsh-tools` enforces.
 *
 * Mirrors `assertSupportedJsonSchema`: a closed keyword set, `required` only as
 * an array of names on an object node, and no `required` on scalars. Without
 * this the mock accepts schemas the real registry rejects 鈥?which is how a
 * per-property `required` in `output.schema` reached the Host.
 *
 * @param {unknown} schema - the candidate schema.
 * @param {string} [path] - diagnostic path.
 */
function assertSupportedSchema(schema, path = 'schema') {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new TypeError(`${path} must be a schema object`);
  }
  const allowed = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'description', 'title']);
  for (const key of Object.keys(schema)) {
    if (!allowed.has(key)) throw new TypeError(`${path}.${key} is not a supported keyword`);
  }
  if (Object.hasOwn(schema, 'required')) {
    if (schema.type !== 'object') throw new TypeError(`${path}.required is not supported on type "${schema.type}"`);
    if (!Array.isArray(schema.required) || schema.required.some((entry) => typeof entry !== 'string')) {
      throw new TypeError(`${path}.required must be an array of property names`);
    }
    for (const entry of schema.required) {
      if (!Object.hasOwn(schema.properties ?? {}, entry)) throw new TypeError(`${path}.required names "${entry}" which is not in properties`);
    }
  }
  for (const [key, node] of Object.entries(schema.properties ?? {})) {
    assertSupportedSchema(node, `${path}.properties.${key}`);
  }
  if (Object.hasOwn(schema, 'items')) assertSupportedSchema(schema.items, `${path}.items`);
  if (Object.hasOwn(schema, 'oneOf')) {
    if (!Array.isArray(schema.oneOf) || schema.oneOf.length < 2) throw new TypeError(`${path}.oneOf must list at least two schemas`);
    schema.oneOf.forEach((node, index) => assertSupportedSchema(node, `${path}.oneOf[${index}]`));
  }
}

const skills = {
  registerProvider(create) {
    const control = { signal: new AbortController().signal, invalidate: () => logged('invalidate') };
    const provider = create(control);
    providers.set(provider.name, provider);
    return () => providers.delete(provider.name);
  },
  register: () => () => {},
  async list(options) {
    const out = [];
    for (const provider of providers.values()) out.push(...await provider.list(options));
    return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  },
  async snapshot(options) {
    return { skills: await this.list(options), complete: true };
  },
  async get(name, options) {
    const candidate = (await this.list(options)).find((s) => s.name === name);
    return candidate === undefined ? undefined : providers.get(candidate.provider).get(candidate, options);
  },
};

/**
 * Build a structurally valid session log for a set of messages.
 *
 * Surface events must sit inside an open turn and step, so a hand-written
 * fixture that is just a list of messages is not a session — the loader rejects
 * it with "does not match an open turn and step". Building the boundaries here
 * keeps every fixture honest instead of encoding an impossible log.
 *
 * @param {object} options - fixture inputs.
 * @param {number} options.turn - the turn number.
 * @param {number} options.step - the step number.
 * @param {Array<object>} options.messages - `user/message`, `assistant/message`, or `tool/result` payloads.
 * @param {string} [options.title] - an optional leading `session/title`.
 * @param {number} [options.startTime] - timestamp of the first event.
 * @returns {Array<object>} a valid event list with contiguous sequence numbers.
 */
function sessionLog({ turn, step, messages, title, startTime = 1 }) {
  const events = [];
  const emit = (event) => events.push({ seq: events.length, ...event });
  let clock = startTime;
  const tick = () => { clock += 1; return clock; };
  if (title !== undefined) emit({ type: 'session/title', time: tick(), data: { title } });
  emit({ type: 'turn/start', time: tick(), data: { turn } });
  emit({ type: 'step/start', time: tick(), data: { turn, step } });
  for (const message of messages) {
    // user/message carries no turn/step in the real format; the others do.
    const carriesPosition = message.type !== 'user/message' && message.type !== 'system/message';
    emit({
      type: message.type,
      time: tick(),
      surfaceOp: 'append',
      data: carriesPosition ? { turn, step, ...message.data } : { ...message.data },
    });
  }
  emit({ type: 'step/end', time: tick(), data: { turn, step } });
  emit({ type: 'turn/end', time: tick(), data: { turn, reason: { kind: 'completed' } } });
  return events;
}

const session = {
  id: 'session-live-1',
  header: { id: 'session-live-1', cwd: project, createdAt: 1, isSeeded: false, version: 4 },
  snapshotEvents: () => sessionLog({
    turn: 1,
    step: 1,
    title: 'Live conversation',
    messages: [
      { type: 'user/message', data: { role: 'user', id: 'u1', content: [{ type: 'text', text: 'hello there' }], source: { kind: 'user' } } },
      { type: 'assistant/message', data: { message: { role: 'assistant', id: 'm', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: 'hi back' }] }, stream: [] } },
    ],
  }),
};

/** Stands in for DSH's session store; nothing here touches the real one. */
const fakePersistence = createFakeSessionPersistence();

/** Records membership grants, which are what move a session out of "Ungrouped". */
const attachments = [];

/**
 * Runs inside `attachSession`, before the session is actually a member.
 *
 * Membership is registered by the attach itself, so the registry change it fires
 * is observed while the session is still *not* listed — which is precisely the
 * window a concurrent scan can slip through. A test that needs to stand in that
 * window installs a hook here.
 * @type {(() => Promise<void> | void) | undefined}
 */
let beforeAttach;

/**
 * One durable workspace entity per registered path.
 *
 * `sessionIds` is mutated in place and the same objects come back on every
 * `list()` call, because membership is what the vault consults before deciding
 * whether a conversation still needs publishing. A registry that recreated its
 * entities each call would report every session as a non-member and republish
 * forever.
 */
const workspaceEntities = new Map();
const workspaceEntity = (path) => {
  const key = path.toLowerCase();
  let entity = workspaceEntities.get(key);
  if (entity === undefined) {
    entity = {
      path,
      title: path,
      sessionIds: [],
      async attachSession(sessionId) {
        await beforeAttach?.();
        if (!entity.sessionIds.includes(sessionId)) entity.sessionIds.push(sessionId);
        attachments.push({ path, sessionId });
      },
    };
    workspaceEntities.set(key, entity);
  }
  return entity;
};

/**
 * The store's own publication path.
 *
 * Publishing through the store rather than straight to persistence is what makes
 * a new session visible to a running client, so the mock must implement it —
 * otherwise the plugin's only wired route would silently fall back.
 */
const storeCreations = [];
const createdSessions = new Map();
const sessionsService = {
  list: () => [session, ...createdSessions.values()],
  // The real store returns any live session by id, including one it just
  // created. Answering only the fixture made every publish look like it had no
  // durability listener.
  get: (id) => (id === session.id ? session : createdSessions.get(id)),
  /**
   * Mirror `SessionStore.create`: build a session, announce it, then persist it.
   * @param {string} id - the session identity.
   * @param {object} options - seed events and creation metadata.
   * @returns {object} the created session.
   */
  create(id, options) {
    if (createdSessions.has(id)) throw new Error(`session "${id}" already exists`);
    const created = {
      id,
      header: { version: 4, id, ...(options?.meta ?? {}) },
      seed: options?.seed ?? [],
      seq: (options?.seed ?? []).length,
      appended: [],
    };
    createdSessions.set(id, created);
    storeCreations.push(id);
    return created;
  },
  async flush(created) {
    // The real store's flush reports whether any durability listener
    // participated, and a session nobody wrote is not durable. `true` mirrors a
    // participating listener.
    if (created === undefined) return false;
    // The seed is routed to the persistence listeners; here that is the double,
    // so the assertions see the same durable result.
    const handle = await fakePersistence.create({ ...created.header, id: created.id });
    try {
      // `create` seeds an empty log; append the seed and any later appends.
      await handle.append([...(created.seed ?? []), ...(created.appended ?? [])]);
      await handle.flush();
    } finally {
      await handle.close();
    }
    return true;
  },
};

const ctx = {
  logger: { info: logged, warn: logged, error: logged, debug: logged },
  skills,
  sessions: sessionsService,
  tools: {
    register(definition) {
      // Mirror `dsh-tools`' own registration guard. Without this the mock would
      // accept a tool the real registry rejects, which is exactly how a missing
      // `output.render` once shipped as "13/13 passing".
      const output = definition.output;
      if (output === undefined || typeof output !== 'object' || typeof output.render !== 'function') {
        throw new TypeError(`tool "${definition.name}" must declare output { schema, render, presentationMeta? }`);
      }
      if (output.schema === undefined || typeof output.schema !== 'object') {
        throw new TypeError(`tool "${definition.name}" must declare output.schema`);
      }
      assertSupportedSchema(output.schema, `tool "${definition.name}" output.schema`);
      if (typeof definition.parameters !== 'object' || definition.parameters === null) {
        throw new TypeError(`tool "${definition.name}" must declare parameters`);
      }
      // The provider requires an object root, and the registry forwards
      // `parameters` verbatim. Without this guard an author-DSL parameter map
      // passes every check here and then fails the whole run with
      // `Invalid schema for function "<name>": ... got 'type: null'`.
      if (definition.parameters.type !== 'object') {
        throw new TypeError(`tool "${definition.name}" parameters must be an object-rooted JSON Schema`);
      }
      assertSupportedSchema(definition.parameters, `tool "${definition.name}" parameters`);
      if (typeof definition.execute !== 'function') {
        throw new TypeError(`tool "${definition.name}" must declare execute`);
      }
      tools.set(definition.name, definition);
      return () => tools.delete(definition.name);
    },
  },
  agents: { currentInitiator: () => ({ session }) },
  // Import writes into DSH's real session store, so the double stands in for it.
  sessionPersistence: fakePersistence,
  // Bounded list of real project folders; the activation scan is driven by this.
  // The same entity objects come back each call, so an attachment is visible to
  // the next membership check.
  workspaceRegistry: {
    list: () => [project, archivedOnly, foreignHost].map((path) => workspaceEntity(path)),
  },
  effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d); return () => {}; },
  on(name, listener) { listeners.set(name, listener); return () => listeners.delete(name); },
  inject(_services, callback) { callback(this); return () => {}; },
  get(name) { return this[name]; },
};

const config = {
  enabled: true,
  skills: { enabled: true, providerName: 'trae', customDirs: [], scanUserHome: false, watch: true, recursiveWatch: false, watchDebounceMs: 50, maxDepth: 6 },
  vault: { enabled: true, directory: '.dsh/conversations', autoExport: true, autoImport: true, includeRuntimeContext: false, maxToolResultChars: 2000, readGlobalSessions: true, sessionsRoot },
};

const results = [];

/**
 * Wait until publishing settles.
 *
 * Publication is asynchronous and serialized per project, so an assertion that
 * reads the durable result must let the chain drain first. Waiting on the count
 * to stop changing is the honest check: it assumes nothing about how many
 * publishes were needed, only that none is still running.
 *
 * @param {number} [quietMs] - how long the count must stay unchanged.
 */
const settle = async (quietMs = 120) => {
  const deadline = Date.now() + 5000;
  let last = -1;
  let stableSince = Date.now();
  while (Date.now() < deadline) {
    const size = fakePersistence.sessions.size;
    if (size !== last) {
      last = size;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= quietMs) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

/** Surface publish failures; a silent ones makes every later assertion a riddle. */
const explainFailures = () => {
  const noisy = logged.filter((line) => /publish failed|publish threw|import failed|could not/i.test(line));
  return noisy.length === 0 ? '' : `\n      publish log:\n        ${noisy.slice(-6).join('\n        ')}`;
};

const check = async (label, fn) => {
  try {
    await fn();
    results.push(`PASS  ${label}`);
  } catch (error) {
    results.push(`FAIL  ${label}\n      ${error instanceof Error ? error.stack : String(error)}`);
    process.exitCode = 1;
  }
};

/**
 * A second project that has an archive on disk but NO open session.
 *
 * This is the case that matters: activation used to publish only projects with a
 * live session, so an archived workspace showed nothing in the sidebar forever.
 * Its archive is written directly, exactly as an earlier run would have left it.
 */
const archivedOnly = await mkdtemp(join(tmpdir(), 'activate-archived-'));
{
  const store = new SessionVault({
    ctx: { logger: { warn() {}, info() {} }, sessions: { list: () => [] }, get: () => undefined },
    config: { ...config.vault, sessionsRoot },
    projectRoot: archivedOnly,
    sessionsRoot,
  });
  await store.write({
    header: { id: 'session-archived-9', cwd: archivedOnly, createdAt: 7, isSeeded: false, version: 4 },
    events: sessionLog({
      turn: 1,
      step: 1,
      title: 'Archived offline',
      messages: [
        { type: 'user/message', data: { role: 'user', id: 'u9', content: [{ type: 'text', text: 'offline question' }], source: { kind: 'user' } } },
      ],
    }),
  });
}

/**
 * A workspace holding a conversation file that was recorded in a DIFFERENT
 * project — the "drop a .dsh/ in here and see it in the sidebar" case. The
 * archive's own `cwd` names `project`, but the file lives under `foreignHost`,
 * and it must appear in the sidebar of the workspace that owns the file.
 */
const foreignHost = await mkdtemp(join(tmpdir(), 'activate-foreign-'));
{
  await mkdir(join(foreignHost, '.dsh', 'conversations'), { recursive: true });
  await writeFile(join(foreignHost, '.dsh', 'conversations', 'index.json'), `${JSON.stringify({
    version: 1,
    // Records a different project than the workspace that owns this file.
    project,
    updatedAt: 1,
    conversations: [{ id: 'session-imported-3', title: 'Carried over', directory: 'session-imported-3', messageCount: 2, humanMessageCount: 1 }],
    imports: {},
  }, null, 2)}\n`, 'utf8');
  const target = join(foreignHost, '.dsh', 'conversations', 'session-imported-3');
  await mkdir(target, { recursive: true });
  const events = [
    { type: 'session', version: 4, id: 'session-imported-3', cwd: project, createdAt: 21, isSeeded: false },
    ...sessionLog({
      turn: 1,
      step: 1,
      startTime: 21,
      title: 'Carried over',
      messages: [
        { type: 'user/message', data: { role: 'user', id: 'u3', content: [{ type: 'text', text: 'imported question' }], source: { kind: 'user' } } },
      ],
    }),
  ];
  await writeFile(join(target, 'events.jsonl'), `${events.map((e) => JSON.stringify(e)).join('\n')}\n`, 'utf8');
}

plugin.apply(ctx, config);
await new Promise((resolve) => setTimeout(resolve, 150)); // let the activation-time scans settle

await check('a conversation carried in from elsewhere appears in THIS workspace', async () => {
  await settle();
  const hex = createHash('sha256').update(`${foreignHost}\u0000session-imported-3`).digest('hex');
  const derived = `session-${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  const stored = fakePersistence.sessions.get(derived);
  assert.ok(stored !== undefined, `expected ${derived} to be published; stored: ${[...fakePersistence.sessions.keys()].join(', ')}`);
  // The decisive assertion: its cwd is the workspace that owns the file, not the
  // project the archive happens to record. Otherwise it would appear under the
  // wrong workspace, or in none.
  assert.equal(stored.header.cwd, foreignHost, 'the published session must belong to the workspace owning the file');
  assert.ok(stored.events.some((e) => e.type === 'user/message'), 'its events must be written');
});

await check('publishing writes a durable log and leaves the id free to adopt', async () => {
  await settle();
  // Publishing must produce a durable artifact, because that is what
  // `sessionQuery.listSessions()` lists and what the client opens.
  const published = [...fakePersistence.sessions.keys()];
  assert.ok(published.length > 0, 'something must have been published');

  // It must NOT occupy the id in the live Session store. Opening an imported
  // conversation adopts a durable session by constructing an Agent for it, and
  // the Agent factory reaches `SessionStore.prepare`, whose first check is
  // `if (this.store.has(sessionId)) throw ... 'already exists'`. A publish that
  // pre-registered the id made every imported conversation load its history and
  // then fail to resume.
  for (const id of published) {
    assert.equal(
      createdSessions.has(id),
      false,
      `${id} was pre-registered in the live store, which blocks the client from adopting it`,
    );
    assert.ok(
      fakePersistence.sessions.get(id).events.length > 0,
      `${id} must have a durable log`,
    );
  }
});

await check('a published session is attached to its workspace, not left ungrouped', async () => {
  await settle();
  // `WorkspaceView.sessionIds` supplies real-workspace membership, so a session
  // that is only written to persistence lands under "Ungrouped" until the
  // workspace itself accepts it.
  const published = [...fakePersistence.sessions.keys()];
  assert.ok(published.length > 0, 'the activation scan must have published something');
  for (const id of published) {
    const owner = attachments.find((entry) => entry.sessionId === id);
    assert.ok(owner !== undefined, `${id} was never attached to a workspace`);
  }
  // Each session must go to the workspace that owns its vault, not any other.
  const archivedAttach = attachments.find((entry) => entry.sessionId.startsWith('session-') && entry.path === archivedOnly);
  assert.ok(archivedAttach !== undefined, `no session was attached to ${archivedOnly}`);
});

await check('a workspace created after activation gets its archive published', async () => {
  // The activation scan runs once, so a folder registered later — the ordinary
  // "I just created a workspace and its conversations are missing" case — would
  // wait for a restart. The registry is a Cordis domain and announces changes,
  // so the scan must re-run then.
  const handler = listeners.get('domain/changed');
  assert.ok(handler !== undefined, 'the plugin must subscribe to domain/changed');

  const latecomer = join(tmpdir(), `trae-late-ws-${Date.now()}`);
  const archiveDir = join(latecomer, '.dsh', 'conversations', 'session-late-ws');
  await mkdir(archiveDir, { recursive: true });
  await writeFile(join(archiveDir, 'events.jsonl'), `${[
    { type: 'session', version: 4, id: 'session-late-ws', cwd: latecomer, createdAt: 31, isSeeded: false },
    ...sessionLog({
      turn: 1,
      step: 1,
      startTime: 31,
      title: 'Registered late',
      messages: [
        { type: 'user/message', data: { role: 'user', id: 'lw', content: [{ type: 'text', text: 'late workspace' }], source: { kind: 'user' } } },
      ],
    }),
  ].map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8');

  const before = fakePersistence.sessions.size;
  // Register it the way the registry does, then announce the change.
  workspaceEntity(latecomer);
  ctx.workspaceRegistry.list = () => [project, archivedOnly, foreignHost, latecomer].map((path) => workspaceEntity(path));
  handler({ domain: 'workspace' });
  // The publish is asynchronous; poll rather than race a fixed delay.
  const deadline = Date.now() + 2000;
  while (fakePersistence.sessions.size === before && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  assert.ok(fakePersistence.sessions.size > before, 'the late workspace archive must be published');
  const attached = attachments.some((entry) => entry.path === latecomer);
  assert.ok(attached, `the published session must be attached to ${latecomer}`);
  // An unrelated domain must not be treated as a workspace change.
  const settled = fakePersistence.sessions.size;
  handler({ domain: 'credentials' });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(fakePersistence.sessions.size, settled, 'only a workspace change may trigger a scan');
  await rm(latecomer, { recursive: true, force: true });
});

await check('an archive that appears after activation is picked up by the poll', async () => {
  // The failure this covers: the plugin is startup-loaded and already running
  // when a workspace is created or its `.dsh` folder is copied in. Neither fact
  // announces itself, and a registry change that already happened cannot be
  // observed, so an event-only design never notices — the conversations stay
  // invisible until a restart.
  assert.ok(pollCallbacks.length > 0, 'the plugin must poll for archives that appear late');

  const latecomer = join(tmpdir(), `trae-poll-ws-${Date.now()}`);
  await mkdir(latecomer, { recursive: true });
  // Register the workspace FIRST, with no archive: exactly the state the plugin
  // sees the moment a workspace is created.
  workspaceEntity(latecomer);
  ctx.workspaceRegistry.list = () => [project, archivedOnly, foreignHost, latecomer].map((path) => workspaceEntity(path));

  const before = fakePersistence.sessions.size;
  const poll = pollCallbacks[pollCallbacks.length - 1];
  poll();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(fakePersistence.sessions.size, before, 'a workspace with no archive publishes nothing');

  // Now the archive lands, with no registry change and no session created.
  const archiveDir = join(latecomer, '.dsh', 'conversations', 'session-poll-1');
  await mkdir(archiveDir, { recursive: true });
  await writeFile(join(archiveDir, 'events.jsonl'), `${[
    { type: 'session', version: 4, id: 'session-poll-1', cwd: latecomer, createdAt: 41, isSeeded: false },
    ...sessionLog({
      turn: 1,
      step: 1,
      startTime: 41,
      title: 'Arrived late',
      messages: [
        { type: 'user/message', data: { role: 'user', id: 'pl', content: [{ type: 'text', text: 'polled' }], source: { kind: 'user' } } },
      ],
    }),
  ].map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8');

  poll();
  const deadline = Date.now() + 2000;
  while (fakePersistence.sessions.size === before && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(fakePersistence.sessions.size > before, 'the archive must be published once it appears');
  assert.ok(attachments.some((entry) => entry.path === latecomer), `it must be attached to ${latecomer}`);
  await rm(latecomer, { recursive: true, force: true });
});

await check('a workspace with no archive yet keeps the watch alive', async () => {
  // The regression this locks down: a workspace is created BEFORE its `.dsh`
  // folder is copied in, so at that instant there is nothing to publish. Counting
  // that as "quiet" let the watch retire before the archive arrived, and the
  // conversations then only appeared after a restart — the exact complaint.
  const pending = join(tmpdir(), `trae-pending-ws-${Date.now()}`);
  await mkdir(pending, { recursive: true });
  workspaceEntity(pending);
  ctx.workspaceRegistry.list = () => [project, archivedOnly, foreignHost, pending].map((path) => workspaceEntity(path));

  const cleared = [];
  const realClear = globalThis.clearInterval;
  globalThis.clearInterval = (handle) => { cleared.push(handle); return realClear(handle); };
  try {
    const poll = pollCallbacks[pollCallbacks.length - 1];
    const before = fakePersistence.sessions.size;
    // Many polls while the archive is missing must never retire the watch.
    for (let i = 0; i < 12; i += 1) {
      poll();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(cleared.length, 0, 'the watch must not retire while a workspace has no archive yet');
    assert.equal(fakePersistence.sessions.size, before, 'nothing may be published before the archive exists');

    // The archive arrives with no registry change and no session created.
    const archiveDir = join(pending, '.dsh', 'conversations', 'session-pending-1');
    await mkdir(archiveDir, { recursive: true });
    await writeFile(join(archiveDir, 'events.jsonl'), `${[
      { type: 'session', version: 4, id: 'session-pending-1', cwd: pending, createdAt: 61, isSeeded: false },
      ...sessionLog({
        turn: 1,
        step: 1,
        startTime: 61,
        title: 'Arrived after the workspace',
        messages: [
          { type: 'user/message', data: { role: 'user', id: 'pd', content: [{ type: 'text', text: 'late archive' }], source: { kind: 'user' } } },
        ],
      }),
    ].map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8');

    poll();
    const deadline = Date.now() + 2000;
    while (fakePersistence.sessions.size === before && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(fakePersistence.sessions.size > before, 'the archive must be published as soon as it appears');
    await settle();

    // Only now, with every workspace accounted for, may a few quiet polls retire it.
    for (let i = 0; i < 12; i += 1) {
      poll();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(cleared.length > 0, 'a settled picture must eventually retire the watch');
  } finally {
    globalThis.clearInterval = realClear;
    await rm(pending, { recursive: true, force: true });
  }
});

await check('a published copy is never published again as a new conversation', async () => {
  await settle();
  // Auto-export writes a published session back into the same archive as a new
  // conversation, and every published copy gets a fresh id. Without a guard each
  // sweep published the previous copy, which is how one workspace accumulated
  // seven copies of a single conversation.
  const workspace = workspaceEntity(archivedOnly);
  const first = await tools.get('conversation_publish').execute({ cwd: archivedOnly }, { agent: { session } });
  assert.equal(first.failed.length, 0, `nothing may fail: ${JSON.stringify(first.failed)}`);

  // The copy that sweep produced is now a member of this workspace.
  for (const entry of first.published) workspace.sessionIds.push(entry.publishedAs);
  const afterFirst = fakePersistence.sessions.size;

  // Publishing again must recognise every remaining conversation as a copy of a
  // member and publish nothing new.
  const second = await tools.get('conversation_publish').execute({ cwd: archivedOnly }, { agent: { session } });
  assert.equal(second.published.length, 0, `a copy must not be published again: ${JSON.stringify(second.published)}`);
  assert.equal(fakePersistence.sessions.size, afterFirst, 'the archive must not grow the chain');
  assert.ok(second.skipped.every((entry) => entry.reason.length > 0), 'each skip must explain itself');
});

await check('overlapping sweeps cannot publish the same conversation twice', async () => {
  await settle();
  // Overlapping triggers (a domain change, a session creation, the poll) each ran
  // `importToDsh` concurrently. Both passes found the derived id free and both
  // created a session, which is how one workspace showed the same conversation
  // twice, about a second apart. Publishes are now chained per project, so the
  // second pass must observe the first one's result and skip.
  const before = fakePersistence.sessions.size;
  const repeats = await Promise.all([
    tools.get('conversation_publish').execute({ cwd: project }, { agent: { session } }),
    tools.get('conversation_publish').execute({ cwd: project }, { agent: { session } }),
    tools.get('conversation_publish').execute({ cwd: project }, { agent: { session } }),
  ]);
  const created = repeats.reduce((total, result) => total + result.published.length, 0);
  assert.equal(created, 0, `already-published conversations must not be created again: ${JSON.stringify(repeats.map((r) => r.published))}`);
  assert.equal(fakePersistence.sessions.size, before, 'no duplicate session may be written');

  // The same for a first publish: three concurrent passes yield one session.
  // The archive must be one nothing has published yet, or "created 0" would prove
  // idempotence rather than the absence of a race.
  const fresh = join(tmpdir(), `trae-race-ws-${Date.now()}`);
  const freshArchive = join(fresh, '.dsh', 'conversations', 'session-race-1');
  await mkdir(freshArchive, { recursive: true });
  await writeFile(join(freshArchive, 'events.jsonl'), `${[
    { type: 'session', version: 4, id: 'session-race-1', cwd: fresh, createdAt: 51, isSeeded: false },
    ...sessionLog({
      turn: 1,
      step: 1,
      startTime: 51,
      title: 'Racy',
      messages: [
        { type: 'user/message', data: { role: 'user', id: 'rc', content: [{ type: 'text', text: 'race' }], source: { kind: 'user' } } },
      ],
    }),
  ].map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8');

  const concurrent = await Promise.all([
    tools.get('conversation_publish').execute({ cwd: fresh }, { agent: { session } }),
    tools.get('conversation_publish').execute({ cwd: fresh }, { agent: { session } }),
    tools.get('conversation_publish').execute({ cwd: fresh }, { agent: { session } }),
  ]);
  const published = concurrent.reduce((total, result) => total + result.published.length, 0);
  assert.equal(published, 1, `three concurrent first publishes must create exactly one session, created ${published}`);
  const ids = [...fakePersistence.sessions.keys()].filter((id) => id.startsWith('session-') && id.length > 8);
  assert.equal(new Set(ids).size, ids.length, 'no session id may appear twice');
  await rm(fresh, { recursive: true, force: true });
});

await check('repeated sweeps never mint another copy of one conversation', async () => {
  await settle();
  // The duplicate came from a readability probe: reading a large log fails often
  // enough to matter (a 7220-event session read back as unreadable), and every
  // false negative picked the next id and published again. Identity is now
  // decided by artifact existence only, so many sweeps must change nothing.
  const before = fakePersistence.sessions.size;
  for (let sweep = 0; sweep < 6; sweep += 1) {
    const result = await tools.get('conversation_publish').execute({}, { agent: { session } });
    assert.equal(result.published.length, 0, `sweep ${sweep} created a session: ${JSON.stringify(result.published.map((e) => e.importedAs))}`);
  }
  assert.equal(fakePersistence.sessions.size, before, 'no sweep may add a copy');
  const ids = [...fakePersistence.sessions.keys()];
  assert.equal(new Set(ids).size, ids.length, 'a session id may not be stored twice');
});

await check('a workspace holding several conversations publishes all of them', async () => {
  await settle();
  // The guard against re-publishing copies must not suppress genuine
  // conversations. A workspace can legitimately carry several, and suppressing
  // one because some stored session shares its id would throw real conversations
  // away — the whole point of an archive-carrying workspace.
  const multi = join(tmpdir(), `trae-multi-ws-${Date.now()}`);
  const archiveRoot = join(multi, '.dsh', 'conversations');
  const ids = ['session-multi-1', 'session-multi-2', 'session-multi-3'];
  for (const [index, id] of ids.entries()) {
    const dir = join(archiveRoot, id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'events.jsonl'), `${[
      { type: 'session', version: 4, id, cwd: multi, createdAt: 71 + index, isSeeded: false },
      ...sessionLog({
        turn: 1,
        step: 1,
        startTime: 71 + index,
        title: `Conversation ${index + 1}`,
        messages: [
          { type: 'user/message', data: { role: 'user', id: `u${index}`, content: [{ type: 'text', text: `question ${index + 1}` }], source: { kind: 'user' } } },
        ],
      }),
    ].map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8');
  }
  workspaceEntity(multi);
  ctx.workspaceRegistry.list = () => [project, archivedOnly, foreignHost, multi].map((path) => workspaceEntity(path));

  const before = fakePersistence.sessions.size;
  const result = await tools.get('conversation_publish').execute({ cwd: multi }, { agent: { session } });
  assert.equal(result.failed.length, 0, `nothing may fail: ${JSON.stringify(result.failed)}`);
  assert.equal(result.published.length, 3, `every conversation must be published: ${JSON.stringify(result.published.map((e) => e.publishedAs))}`);
  assert.equal(fakePersistence.sessions.size, before + 3, 'three conversations, three sessions');
  for (const id of result.published.map((entry) => entry.publishedAs)) {
    assert.ok(attachments.some((entry) => entry.sessionId === id), `${id} must be attached to ${multi}`);
  }

  // Each published session is a copy; exporting it again must be refused, which is
  // what stops the archive from growing on every subsequent sweep.
  const multiVault = new SessionVault({
    ctx: { logger: { warn() {}, info() {} }, sessions: { list: () => [], get: () => undefined }, get: (n) => (n === 'sessionPersistence' ? fakePersistence : undefined) },
    config: config.vault,
    projectRoot: multi,
    sessionsRoot,
  });
  for (const entry of result.published) {
    const stored = fakePersistence.sessions.get(entry.publishedAs);
    const outcome = await multiVault.exportLive({
      id: entry.publishedAs,
      header: stored.header,
      snapshotEvents: () => stored.events,
    });
    assert.equal(outcome.ok, false, `${entry.importedAs} must not be re-archived as a new conversation`);
    assert.match(String(outcome.skipped), /published from this archive/);
  }
  // A genuine conversation in the same workspace is still archivable.
  const genuine = await multiVault.exportLive({
    id: 'session-genuine-1',
    header: { id: 'session-genuine-1', cwd: multi, createdAt: 99, isSeeded: false, version: 4 },
    snapshotEvents: () => sessionLog({
      turn: 1,
      step: 1,
      startTime: 99,
      title: 'Genuine',
      messages: [{ type: 'user/message', data: { role: 'user', id: 'g', content: [{ type: 'text', text: 'real' }], source: { kind: 'user' } } }],
    }),
  });
  assert.equal(genuine.ok, true, 'a genuine conversation must still be archived');
  await rm(multi, { recursive: true, force: true });
});

await check('apply registers exactly one trae provider and eight tools', () => {
  assert.deepEqual([...providers.keys()], ['trae']);
  assert.deepEqual([...tools.keys()].sort(), [
    'conversation_export', 'conversation_import_share', 'conversation_list',
    'conversation_publish', 'conversation_read', 'conversation_sync_from_disk',
    'conversation_workspaces', 'trae_skill_list',
  ]);
  assert.ok(listeners.has('session/event'), 'auto-export must subscribe to session/event');
});

await check('the generation file stamps its lib modules with the entry revision', async () => {
  // A static specifier cannot interpolate, so the lib URLs carry a literal token.
  // If that token drifts from REVISION, the Host reloads the generation and keeps
  // it wired to the *previous* lib modules: the files on disk and every other
  // check agree while the running plugin serves stale code. This is that failure,
  // caught here rather than in a user's sidebar.
  const revision = plugin.REVISION;
  assert.ok(Number.isSafeInteger(revision) && revision > 0, `entry REVISION is ${revision}`);
  const source = await readFile(join(packageDir, `impl.r${revision}.js`), 'utf8');
  const stamped = [...source.matchAll(/from '\.\/lib\/[A-Za-z0-9.]+\.js\?v=(\d+)'/g)].map((match) => Number(match[1]));
  assert.equal(stamped.length, 3, `expected three stamped lib imports, found ${stamped.length}`);
  assert.deepEqual([...new Set(stamped)], [revision],
    `impl.r${revision}.js imports its lib modules with ?v=${[...new Set(stamped)].join('/')}`);
  // And the module that actually executed is the one the entry claims.
  assert.match(
    lines.find((line) => line.includes('apply entered')) ?? '',
    new RegExp(`generation ${revision}\\b`),
    'the activation trace must name the generation the entry claims',
  );
});

await check('activation publishes a workspace that has no open session', async () => {
  // Nothing opened `archivedOnly` in this process; only the registry lists it.
  const sessionId = 'session-archived-9';
  const expected = createHash('sha256')
    .update(`${archivedOnly}\u0000${sessionId}`)
    .digest('hex');
  const derived = `session-${expected.slice(0, 8)}-${expected.slice(8, 12)}-4${expected.slice(13, 16)}-a${expected.slice(17, 20)}-${expected.slice(20, 32)}`;
  const stored = fakePersistence.sessions.get(derived);
  assert.ok(stored !== undefined, `expected ${derived} to be published; stored: ${[...fakePersistence.sessions.keys()].join(', ')}`);
  assert.equal(stored.header.cwd, archivedOnly, 'the published session must belong to the archived workspace');
  assert.ok(stored.events.length > 0, 'its events must be written');
  assert.deepEqual(stored.events.map((e) => e.seq), stored.events.map((_, i) => i), 'seq must be renumbered contiguously');
  assert.ok(stored.events.some((e) => e.type === 'session/title'), 'the title event must survive');
});

await check('provider discovers both Trae bundles and loads their bodies', async () => {
  const found = await skills.list({ cwd: project });
  assert.deepEqual(found.map((s) => s.name), ['comfyui-image-gen', 'nested-one']);
  assert.equal(found[0].provider, 'trae');
  assert.equal(found[0].source, 'trae-project');
  assert.equal(found[0].rank, 150);
  assert.equal(found[0].resourceBase.kind, 'directory');
  assert.ok(found[0].path.endsWith('SKILL.md'));
  const loaded = await skills.get('comfyui-image-gen', { cwd: project });
  assert.match(loaded.content, /Run the workflow/);
  assert.equal(loaded.provider, 'trae');
});

await check('trae_skill_list reports the ambient workspace catalog', async () => {
  // No tool call has run yet, so the active project is still the process cwd 閳?  // which is the real workspace, and its real .trae/skills tree.
  const result = await tools.get('trae_skill_list').execute({}, { agent: { session } });
  assert.ok(result.count >= 1, 'the real workspace must expose at least one Trae skill');
  assert.ok(result.report.includes('Trae skills visible for'), 'the report must name its project');
  for (const skill of result.skills) {
    assert.ok(skill.path.toLowerCase().includes(join('.trae', 'skills').toLowerCase()),
      `${skill.name} must resolve inside a .trae/skills folder, got ${skill.path}`);
    assert.equal(skill.source, 'trae-project');
  }
  // A tool call re-targets the plugin at the calling session's project.
  const scoped = await tools.get('conversation_list').execute({}, { agent: { session } });
  assert.equal(scoped.project, project, 'a tool call must adopt the calling session cwd');
  const after = await tools.get('trae_skill_list').execute({}, { agent: { session } });
  assert.deepEqual(after.skills.map((s) => s.name).sort(), ['comfyui-image-gen', 'nested-one'],
    'after re-targeting, only the temp project skills must be visible');
});

await check('auto-export archived the live session on activation', async () => {
  const markdown = await readFile(join(project, '.dsh', 'conversations', 'session-live-1', 'conversation.md'), 'utf8');
  assert.match(markdown, /Live conversation/);
  assert.match(markdown, /hi back/);
  const index = JSON.parse(await readFile(join(project, '.dsh', 'conversations', 'index.json'), 'utf8'));
  assert.equal(index.conversations.length, 1);
  assert.equal(index.conversations[0].title, 'Live conversation');
});

await check('conversation_list returns the archive and its location', async () => {
  const result = await tools.get('conversation_list').execute({}, { agent: { session } });
  assert.equal(result.archivedTotal, 1);
  assert.equal(result.archived[0].id, 'session-live-1');
  assert.equal(result.project, project);
  assert.ok(result.archiveDirectory.endsWith(join('.dsh', 'conversations')));
});

await check('conversation_read returns the transcript by id suffix', async () => {
  const result = await tools.get('conversation_read').execute({ session_id: 'live-1', format: 'markdown' }, { agent: { session } });
  assert.match(result.transcript, /hi back/);
  assert.equal(result.totalMessages, 2);
  assert.equal(result.returnedMessages, 2);
});

await check('conversation_read honours max_messages', async () => {
  const result = await tools.get('conversation_read').execute({ session_id: 'session-live-1', format: 'json', max_messages: 1 }, { agent: { session } });
  assert.equal(result.returnedMessages, 1);
  assert.equal(result.totalMessages, 2);
  assert.ok(!result.transcript.includes('hi back'));
});

await check('conversation_read fails loudly for an unknown id', async () => {
  await assert.rejects(
    () => tools.get('conversation_read').execute({ session_id: 'nope-nope' }, { agent: { session } }),
    /no archived conversation matching/,
  );
});

await check('conversation_export archives the calling session on demand', async () => {
  const result = await tools.get('conversation_export').execute({}, { agent: { session } });
  assert.equal(result.exported.length, 1);
  assert.equal(result.exported[0].sessionId, 'session-live-1');
  assert.ok(result.exported[0].markdown.endsWith('conversation.md'));
});

await check('conversation_export all:true archives every project session', async () => {
  const other = { ...session, id: 'session-live-2', header: { ...session.header, id: 'session-live-2' } };
  const foreign = { ...session, id: 'session-elsewhere', header: { ...session.header, id: 'session-elsewhere', cwd: tmpdir() } };
  const original = ctx.sessions.list;
  ctx.sessions.list = () => [session, other, foreign];
  try {
    const result = await tools.get('conversation_export').execute({ all: true }, { agent: { session } });
    assert.deepEqual(result.exported.map((e) => e.sessionId).sort(), ['session-live-1', 'session-live-2']);
    assert.equal(result.skipped.length, 1, 'the foreign-cwd session must be skipped');
    assert.match(result.skipped[0].reason, /not this project/);
  } finally {
    ctx.sessions.list = original;
  }
});

await check('conversation_sync_from_disk imports a durable stored session', async () => {
  const zlib = await import('node:zlib');
  const { projectSlug } = await import(`${root}/lib/vault.trae2.js`);
  const id = 'session-from-disk';
  const dir = join(sessionsRoot, projectSlug(project), id);
  await mkdir(dir, { recursive: true });
  const lines2 = [
    JSON.stringify({ type: 'session', version: 4, id, createdAt: 1, cwd: project, isSeeded: false }),
    ...sessionLog({
      turn: 1,
      step: 1,
      title: 'Older stored chat',
      messages: [
        { type: 'user/message', data: { role: 'user', id: 'ou', content: [{ type: 'text', text: 'old question' }], source: { kind: 'user' } } },
        { type: 'assistant/message', data: { message: { role: 'assistant', id: 'om', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: 'old answer' }] }, stream: [] } },
      ],
    }).map((event) => JSON.stringify(event)),
  ];
  await writeFile(join(dir, 'session.v4.jsonl.zstd'), Buffer.concat(lines2.map((l) => zlib.zstdCompressSync(Buffer.from(`${l}\n`)))));

  const result = await tools.get('conversation_sync_from_disk').execute({}, { agent: { session } });
  assert.equal(result.imported.length, 1, `import failed: ${JSON.stringify(result.failed)}`);
  assert.equal(result.imported[0].title, 'Older stored chat');
  assert.deepEqual(result.failed, []);

  const read = await tools.get('conversation_read').execute({ session_id: id, format: 'markdown' }, { agent: { session } });
  assert.match(read.transcript, /old answer/);
});

await check('session/event listener archives on turn/end', async () => {
  const listener = listeners.get('session/event');
  const late = {
    id: 'session-late',
    header: { id: 'session-late', cwd: project, createdAt: 1, isSeeded: false, version: 4 },
    snapshotEvents: () => sessionLog({
      turn: 1,
      step: 1,
      title: 'Late conversation',
      messages: [
        { type: 'user/message', data: { role: 'user', id: 'lu', content: [{ type: 'text', text: 'later question' }], source: { kind: 'user' } } },
      ],
    }),
  };
  listener(late, { type: 'turn/end', seq: 3, time: 9, data: { turn: 1, reason: { kind: 'completed' } } });
  listener(late, { type: 'step/start', seq: 4, time: 10, data: { turn: 2, step: 1 } });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const markdown = await readFile(join(project, '.dsh', 'conversations', 'session-late', 'conversation.md'), 'utf8');
  assert.match(markdown, /later question/);
  const index = JSON.parse(await readFile(join(project, '.dsh', 'conversations', 'index.json'), 'utf8'));
  assert.equal(index.conversations.length >= 3, true, `index must contain every archived session: ${index.conversations.map((c) => c.id).join(', ')}`);
});

await check('vault instances are per project, not global', () => {
  const a = new SessionVault({ ctx, config: config.vault, projectRoot: project, sessionsRoot });
  const b = new SessionVault({ ctx, config: config.vault, projectRoot: tmpdir(), sessionsRoot });
  assert.notEqual(a.directory, b.directory);
  assert.ok(a.directory.startsWith(project));
});

await check('conversation_publish materializes a fresh archive as a real DSH session', async () => {
  // Activation already published the existing archives, so archive a NEW session
  // and publish that: it exercises the tool's own path rather than a re-publish.
  const fresh = {
    id: 'session-fresh-7',
    header: { id: 'session-fresh-7', cwd: project, createdAt: 11, isSeeded: false, version: 4 },
    snapshotEvents: () => sessionLog({
      turn: 1,
      step: 1,
      startTime: 11,
      title: 'Fresh conversation',
      messages: [
        { type: 'user/message', data: { role: 'user', id: 'fu', content: [{ type: 'text', text: 'fresh question' }], source: { kind: 'user' } } },
        { type: 'assistant/message', data: { message: { role: 'assistant', id: 'fm', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: 'fresh answer' }] }, stream: [] } },
      ],
    }),
  };
  // A real call arrives from the session being archived, so exec carries it.
  await tools.get('conversation_export').execute({}, { agent: { session: fresh } });

  const before = fakePersistence.sessions.size;
  const result = await tools.get('conversation_publish').execute(
    { session_ids: ['session-fresh-7'] },
    { agent: { session } },
  );
  assert.deepEqual(result.failed, [], `publish failed: ${JSON.stringify(result.failed)}`);
  assert.equal(result.published.length, 1, `expected one publication, got ${JSON.stringify(result)}`);
  const published = result.published[0];
  assert.equal(published.sessionId, 'session-fresh-7');
  assert.match(published.publishedAs, /^session-[0-9a-f-]{36}$/, `unexpected id ${published.publishedAs}`);
  assert.notEqual(published.publishedAs, 'session-fresh-7', 'the original session id must not be reused');

  // The double validates headers/events exactly as the loader does, so this
  // asserts a session DSH could actually open.
  assert.equal(fakePersistence.sessions.size, before + 1);
  const stored = fakePersistence.sessions.get(published.publishedAs);
  assert.equal(stored.header.cwd, project, 'the imported session must belong to this project');
  assert.equal(stored.header.isSeeded, false);
  assert.equal(stored.header.version, 4);
  assert.ok(stored.events.length > 0, 'events must be written');
  assert.deepEqual(stored.events.map((e) => e.seq), stored.events.map((_, i) => i), 'seq must be contiguous from 0');
  assert.ok(stored.events.some((e) => e.type === 'assistant/message'), 'the assistant turn must survive');
  assert.ok(fakePersistence.flushed.includes(published.publishedAs), 'the session must be flushed durably');
  assert.ok(fakePersistence.closed.includes(published.publishedAs), 'the write handle must be released');
});

await check('conversation_publish is idempotent', async () => {
  // Publish everything that is still unpublished, then publish again: the second
  // pass must add nothing, whichever route skipped it.
  const first = await tools.get('conversation_publish').execute({}, { agent: { session } });
  const after = fakePersistence.sessions.size;
  const second = await tools.get('conversation_publish').execute({}, { agent: { session } });
  assert.equal(second.published.length, 0, `a second publish must not duplicate: ${JSON.stringify(second.published)}`);
  assert.ok(first.published.length + second.skipped.length > 0, 'every archive is either published or skipped');
  assert.equal(fakePersistence.sessions.size, after, 'no new session may be created by a repeat publish');
  assert.ok(second.skipped.every((entry) => entry.reason.length > 0));
});

await check('a published id is derived from the source, so it cannot drift', async () => {
  const original = await tools.get('conversation_publish').execute({ session_ids: ['session-live-1'] }, { agent: { session } });
  const record = original.published[0] ?? original.skipped[0];
  const id = record.publishedAs ?? record.importedAs;
  assert.ok(id !== undefined, `no id reported: ${JSON.stringify(original)}`);
  // The derived identity is a pure function of (project root, source id), so a
  // repeat publish must resolve to the same session rather than a new copy.
  const again = await tools.get('conversation_publish').execute({ session_ids: ['session-live-1'] }, { agent: { session } });
  const repeat = again.published[0] ?? again.skipped[0];
  assert.equal(repeat.publishedAs ?? repeat.importedAs, id, 'the derived id must be stable');
  assert.equal(again.published.length, 0, 'a repeat publish must not create another session');
});

await check('publishing without a persistence service fails cleanly', async () => {
  const bare = new SessionVault({
    ctx: { logger: { warn() {}, info() {} }, sessions: { list: () => [] }, get: () => undefined },
    config: config.vault,
    projectRoot: project,
    sessionsRoot,
  });
  const result = await bare.importToDsh();
  assert.equal(result.imported.length, 0);
  assert.match(result.failed[0].error, /no sessionPersistence service/);
});

await check('conversation_import_share downloads a share and creates a real session', async () => {
  // The tool reads the network through `globalThis.fetch`, so the double stands
  // in for the share API. Everything after the fetch is the real path: the
  // conversion, the archive write, and the publication through the session store.
  const items = [
    {
      share_session_id: 'ZZ11..YY22',
      message_id: 's1',
      role: 'user',
      message_type: 'general',
      status: 'completed',
      message_index: 1,
      created_at: '2026-02-03T10:00:00+08:00',
      content: JSON.stringify([{ type: 'text', text_content: 'why is the build red' }]),
    },
    {
      share_session_id: 'ZZ11..YY22',
      message_id: 's2',
      role: 'assistant',
      message_type: 'task',
      status: 'completed',
      message_index: 2,
      created_at: '2026-02-03T10:00:00+08:00',
      content: JSON.stringify({
        task_id: 'st1',
        messages: [
          {
            id: 'i1',
            plan_item: {
              reasoning_content: 'check the pipeline log',
              thought: '',
              timing: { generated_at_ms: 1000, tool_call_started_at_ms: 1000, tool_call_finished_at_ms: 1500 },
              tool_call_info: {
                id: 'i1-call',
                name: 'Grep',
                params: { pattern: 'error' },
                result: { status: 'success', data: { results: [{ file_path: 'ci.log', content: 'one error' }] } },
              },
            },
          },
          {
            id: 'i2',
            plan_item: {
              reasoning_content: '',
              thought: '',
              timing: { generated_at_ms: 2000, tool_call_started_at_ms: 2000, tool_call_finished_at_ms: 2400 },
              tool_call_info: {
                id: 'i2-call',
                name: 'finish',
                params: { summary: 'The build is red because of a flaky test.' },
                result: { status: 'success', data: { summary: 'done' } },
              },
            },
          },
        ],
      }),
    },
  ];
  const seen = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    const body = String(url).includes('/messages')
      ? { code: 0, data: { items, has_more: false }, message: 'success' }
      : {
        code: 0,
        data: {
          share_session_id: 'ZZ11..YY22',
          title: 'Red build',
          created_at: '2026-02-04T00:00:00+08:00',
          creator_name: 'someone',
          status: 'active',
        },
        message: 'success',
      };
    return { ok: true, status: 200, statusText: 'OK', async json() { return body; } };
  };
  let result;
  try {
    result = await tools.get('conversation_import_share').execute(
      { url: 'https://share.traecontent.cn/share/ZZ11..YY22?enter_from=pc' },
      { agent: { session } },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(seen.length, 2, 'both share endpoints must be requested');
  assert.equal(result.project, project, 'an import belongs to the calling project');
  assert.equal(result.shareId, 'ZZ11..YY22');
  assert.equal(result.sessionId, 'trae-share-ZZ11-YY22');
  assert.equal(result.title, 'Red build');
  assert.equal(result.turns, 1);
  assert.equal(result.humanMessages, 1);
  // `finish` becomes the reply, leaving the one real tool call.
  assert.equal(result.toolCalls, 1);
  assert.equal(result.published, true, `publish failed: ${JSON.stringify(result.notes)}`);
  assert.match(result.publishedAs, /^session-[0-9a-f-]{36}$/);
  assert.ok(result.notes.some((note) => /no shared output|shared output/.test(note)) === false,
    'this share kept its tool output, so nothing may be reported as stripped');

  // The double validates the log exactly as the loader does.
  const stored = fakePersistence.sessions.get(result.publishedAs);
  assert.ok(stored !== undefined, 'the imported conversation must be a stored session');
  assert.equal(stored.header.cwd, project);
  assert.equal(stored.header.version, 4);
  assert.deepEqual(stored.events.map((event) => event.seq), stored.events.map((_, index) => index));
  assert.ok(stored.events.some((event) => event.type === 'tool/result'), 'the tool result must survive');

  // The transcript is written where the workspace's other archives live.
  const markdown = await readFile(join(project, '.dsh', 'conversations', 'trae-share-ZZ11-YY22', 'conversation.md'), 'utf8');
  assert.match(markdown, /Imported from: https:\/\/share\.traecontent\.cn\/share\/ZZ11\.\.YY22/);
  assert.match(markdown, /The build is red because of a flaky test\./);
  assert.match(markdown, /one error/);

  // Importing the same link again must resolve to the same session, not a copy.
  const before = fakePersistence.sessions.size;
  const originalFetch2 = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const body = String(url).includes('/messages')
      ? { code: 0, data: { items, has_more: false }, message: 'success' }
      : {
        code: 0,
        data: { share_session_id: 'ZZ11..YY22', title: 'Red build', created_at: '2026-02-04T00:00:00+08:00', status: 'active' },
        message: 'success',
      };
    return { ok: true, status: 200, statusText: 'OK', async json() { return body; } };
  };
  let again;
  try {
    again = await tools.get('conversation_import_share').execute(
      { url: 'ZZ11..YY22' },
      { agent: { session } },
    );
  } finally {
    globalThis.fetch = originalFetch2;
  }
  assert.equal(again.sessionId, result.sessionId, 'the same share must map to the same archive id');
  assert.equal(again.publishedAs, result.publishedAs, 'the same share must map to the same session');
  assert.equal(fakePersistence.sessions.size, before, 'a repeat import must not create another session');
});

await check('force republishes a conversation that is already a workspace member', async () => {
  // The one thing `force` is asked for. A published session can be on disk and a
  // workspace member and still be invisible — it was written while the plugin was
  // inactive, so no `session/created` ever reached a client. The published set is
  // exactly what blocks a normal pass, so force has to be let past it and
  // supersede: the corrected copy goes through the session store, which is the
  // surface clients watch.
  const id = 'trae-share-ZZ11-YY22';
  const workspace = workspaceEntities.get(project.toLowerCase());
  const memberIds = new Set(workspace.sessionIds);
  assert.ok(memberIds.size > 0, 'the share import must have published something first');

  const plain = await tools.get('conversation_publish').execute({ session_ids: [id] }, { agent: { session } });
  assert.equal(plain.published.length, 0, 'without force an already-published conversation is skipped');
  assert.match(plain.skipped[0].reason, /already published in this workspace/);

  const sizeBefore = fakePersistence.sessions.size;
  const forced = await tools.get('conversation_publish').execute(
    { session_ids: [id], force: true },
    { agent: { session } },
  );
  assert.deepEqual(forced.failed, [], `force must not fail: ${JSON.stringify(forced.failed)}`);
  assert.equal(forced.published.length, 1, `force must republish, got ${JSON.stringify(forced)}`);
  assert.equal(forced.published[0].sessionId, id);
  // Superseding cannot rewrite an id the store still reports, so the corrected
  // copy takes the next free one — that is what makes it a fresh announcement.
  assert.notEqual(forced.published[0].publishedAs, undefined);
  assert.equal(fakePersistence.sessions.size >= sizeBefore, true);
  const stored = fakePersistence.sessions.get(forced.published[0].publishedAs);
  assert.ok(stored !== undefined, 'the superseding copy must be in the store');
  assert.equal(firstStructuralViolation(stored.events, stored.header.id), undefined);
});

await check('conversation_import_share refuses a bad link and can archive without publishing', async () => {
  await assert.rejects(
    () => tools.get('conversation_import_share').execute({ url: '   ' }, { agent: { session } }),
    /needs the share url/,
  );
  await assert.rejects(
    () => tools.get('conversation_import_share').execute({}, { agent: { session } }),
    /needs the share url/,
  );

  // A link the API rejects must surface the API's own words, not a generic fault.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    async json() { return { code: 40400, message: 'share not found', data: null }; },
  });
  try {
    await assert.rejects(
      () => tools.get('conversation_import_share').execute({ url: 'MISSING..SHARE' }, { agent: { session } }),
      /refused the request \(code 40400: share not found\)/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  // `publish: false` archives the conversation without touching the session store.
  const items = [
    {
      share_session_id: 'QQ33..RR44',
      message_id: 'q1',
      role: 'user',
      message_type: 'general',
      status: 'completed',
      message_index: 1,
      created_at: '2026-03-04T09:00:00+08:00',
      content: JSON.stringify([{ type: 'text', text_content: 'archive me only' }]),
    },
  ];
  const before = fakePersistence.sessions.size;
  const originalFetch2 = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const body = String(url).includes('/messages')
      ? { code: 0, data: { items, has_more: false }, message: 'success' }
      : { code: 0, data: { share_session_id: 'QQ33..RR44', title: 'Archive only', created_at: '2026-03-04T09:00:00+08:00', status: 'active' }, message: 'success' };
    return { ok: true, status: 200, statusText: 'OK', async json() { return body; } };
  };
  let archived;
  try {
    archived = await tools.get('conversation_import_share').execute(
      { url: 'QQ33..RR44', publish: false },
      { agent: { session } },
    );
  } finally {
    globalThis.fetch = originalFetch2;
  }
  assert.equal(archived.published, false);
  assert.equal(archived.publishedAs, undefined);
  assert.equal(fakePersistence.sessions.size, before, 'archiving alone must not create a session');

  // And the archived conversation is still publishable afterwards.
  const published = await tools.get('conversation_publish').execute(
    { session_ids: [archived.sessionId] },
    { agent: { session } },
  );
  assert.deepEqual(published.failed, []);
  assert.equal(published.published.length, 1);
  assert.equal(published.published[0].sessionId, archived.sessionId);
});

await check('two publishes of one conversation cannot mint a second copy', async () => {
  // The regression this locks down, captured in a live trace: publishing a
  // session grants it workspace membership, which fires the registry change the
  // activation scan reacts to. At that instant the archive is on disk and the
  // pass has not yet written its ledger, so the scan saw the conversation as
  // fresh and published a duplicate under `<derived>-2` — 87 ms after the first.
  //
  // Two concurrent passes reproduce the same window without needing the poll.
  const archivedId = 'trae-share-RACE-1';
  // Written through the vault, so the archive's index, transcript and verbatim
  // events are exactly what a real import leaves behind.
  const seed = new SessionVault({
    ctx: { logger: { warn() {}, info() {} }, sessions: { list: () => [] }, get: () => undefined },
    config: { ...config.vault, sessionsRoot },
    projectRoot: project,
    sessionsRoot,
  });
  await seed.write({
    header: { id: archivedId, cwd: project, createdAt: 51, isSeeded: false, version: 4 },
    events: sessionLog({
      turn: 1,
      step: 1,
      startTime: 51,
      title: 'Racing publish',
      messages: [
        { type: 'user/message', data: { role: 'user', id: 'race-u', content: [{ type: 'text', text: 'race' }], source: { kind: 'user' } } },
        { type: 'assistant/message', data: { message: { role: 'assistant', id: 'race-a', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: 'raced' }] }, stream: [] } },
      ],
    }),
  });

  const before = new Set(fakePersistence.sessions.keys());
  const publish = () => tools.get('conversation_publish').execute({ session_ids: [archivedId] }, { agent: { session } });
  const [first, second] = await Promise.all([publish(), publish()]);
  const created = [...fakePersistence.sessions.keys()].filter((id) => !before.has(id));
  const index = JSON.parse(await readFile(join(project, '.dsh', 'conversations', 'index.json'), 'utf8'));
  assert.ok(index.conversations.some((entry) => entry.id === archivedId),
    `the archive must be discoverable; index holds ${index.conversations.map((entry) => entry.id).join(', ')}`);
  assert.deepEqual(first.failed, [], `first pass failed: ${JSON.stringify(first.failed)}`);
  assert.deepEqual(second.failed, [], `second pass failed: ${JSON.stringify(second.failed)}`);
  assert.equal(created.length, 1, `one conversation must produce exactly one session, got ${created.join(', ')}`);

  const published = [...first.published, ...second.published].filter((entry) => entry.sessionId === archivedId);
  assert.equal(published.length, 1, `exactly one pass may publish it, got ${published.length}`);
  assert.match(published[0].publishedAs, /^session-[0-9a-f-]{36}$/, 'the first copy keeps the derived id, with no -2 suffix');

  // The pass that lost must report a reason, not a failure: the conversation is
  // published either way, and a user cannot act on "someone else did it".
  const refused = [...first.skipped, ...second.skipped].filter((entry) => entry.sessionId === archivedId);
  assert.equal(refused.length, 1, `the second pass must skip it, got ${JSON.stringify([...first.skipped, ...second.skipped])}`);
  assert.match(refused[0].reason, /already/);
  assert.deepEqual([...first.failed, ...second.failed], [], 'a lost race is not an error');
});

await check('a publish pass running during another cannot mint a second copy', async () => {
  // The live failure this locks down. Publishing grants membership, and granting
  // it is what wakes the activation scan; with the ledger written *after* the
  // attach, a scan starting in that window found an archive on disk, a session in
  // the store, and no record connecting them — so it published a duplicate under
  // `<derived>-2`. A real Host trace shows the two writes 87 ms apart.
  //
  // The window is opened here as it really is: membership not yet granted, the
  // ledger not yet written, and a second pass already under way.
  const archivedId = 'trae-share-MIDPUBLISH-1';
  const seed = new SessionVault({
    ctx: { logger: { warn() {}, info() {} }, sessions: { list: () => [] }, get: () => undefined },
    config: { ...config.vault, sessionsRoot },
    projectRoot: project,
    sessionsRoot,
  });
  await seed.write({
    header: { id: archivedId, cwd: project, createdAt: 61, isSeeded: false, version: 4 },
    events: sessionLog({
      turn: 1,
      step: 1,
      startTime: 61,
      title: 'Mid-publish scan',
      messages: [
        { type: 'user/message', data: { role: 'user', id: 'mid-u', content: [{ type: 'text', text: 'mid' }], source: { kind: 'user' } } },
      ],
    }),
  });

  const store = new SessionVault({
    ctx: {
      logger: { warn() {}, info() {} },
      sessions: { list: () => [], get: () => undefined },
      get: (name) => (name === 'sessionPersistence' ? fakePersistence : undefined),
      workspaceRegistry: ctx.workspaceRegistry,
    },
    config: { ...config.vault, sessionsRoot },
    projectRoot: project,
    sessionsRoot,
    attachSession: async (sessionId, owner) => {
      await workspaceEntity(owner).attachSession(sessionId);
      return true;
    },
    workspaceMember: async (sessionId, owner) => workspaceEntity(owner).sessionIds.includes(sessionId),
  });

  const before = new Set(fakePersistence.sessions.keys());
  /** Registry changes observed while the first pass was still in flight. */
  const windows = [];
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  beforeAttach = () => {
    windows.push(1);
    return held;
  };
  let first;
  let second;
  try {
    first = store.importToDsh({ ids: [archivedId] });
    // Let the first pass reach its registration window, then start the second
    // inside it: the same archive, a ledger it cannot see yet, membership not
    // yet granted.
    const deadline = Date.now() + 1000;
    while (windows.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 2));
    assert.ok(windows.length > 0, 'the first pass must have reached its registration window');
    second = store.importToDsh({ ids: [archivedId] });
    await new Promise((resolve) => setTimeout(resolve, 30));
    release();
    [first, second] = await Promise.all([first, second]);
  } finally {
    beforeAttach = undefined;
  }

  assert.deepEqual(first.failed, [], `first pass failed: ${JSON.stringify(first.failed)}`);
  assert.deepEqual(second.failed, [], `second pass failed: ${JSON.stringify(second.failed)}`);
  const created = [...fakePersistence.sessions.keys()].filter((id) => !before.has(id));
  assert.equal(created.length, 1, `one conversation must own exactly one session, got ${created.join(', ')}`);
  assert.equal(created[0], first.imported[0].importedAs, 'the first pass keeps the derived id');
  assert.ok(!created[0].endsWith('-2'), 'no copy may be filed under a -2 id');
  // The pass that lost must reuse the recorded publication rather than report a
  // failure the user cannot act on.
  assert.equal(second.imported.length, 0, `the second pass must not publish it: ${JSON.stringify(second.imported)}`);
  assert.ok(second.skipped.some((entry) => entry.sessionId === archivedId),
    `the second pass must account for it: ${JSON.stringify(second.skipped)}`);
});

console.log(results.join('\n'));
console.log(`\n${results.filter((r) => r.startsWith('PASS')).length}/${results.length} activation checks passed`);
if (lines.length > 0) console.log(`\nplugin log:\n  ${lines.join('\n  ')}`);

for (const dispose of disposers) { try { await dispose(); } catch {} }
await rm(project, { recursive: true, force: true });
await rm(sessionsRoot, { recursive: true, force: true });
