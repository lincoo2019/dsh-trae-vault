/**
 * Trae skills and a project-local conversation vault for DeepSeek Harness.
 *
 * Two capabilities, one bundle:
 *
 *  1. **Trae skill invocation** 鈥?registers a `trae` provider on `ctx.skills`
 *     that discovers `SKILL.md` bundles under the project's `.trae/skills`
 *     folder (recursively, including the nested layout Trae uses), an optional
 *     user-level `~/.trae/skills`, and any configured extra directories. The
 *     Harness `skill` tool then loads and invokes them like native skills.
 *
 *  2. **Conversation vault** 鈥?archives each conversation into the project
 *     folder itself as a normalized JSONL record plus a readable Markdown
 *     transcript, keeps an index, and reads them back on demand. It also imports
 *     conversations that exist only in the Harness session store, so a project
 *     folder carries its own history.
 *
 * @module @local/dsh-trae-session-vault
 */
import { homedir } from 'node:os';
import { appendFileSync, existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
// The Harness module loader caches a module job per resolved URL, so within one
// Host process a replaced bundle keeps executing the generation it first
// imported — including inside a linked package whose files changed on disk.
//
// That cache is per URL, and it applies just as much to these relative imports
// as it does to the generation itself. A bare `./lib/vault.trae2.js` resolves to
// one URL for the life of the process, so raising REVISION used to reload the
// generation and then re-wire it to the *previous* lib modules: the file on disk
// and every test agreed while the running plugin kept answering from the old
// code. Measured, not theoretical — it is why `force: true` still reported
// "already present" after the replace path had been fixed.
//
// The revision is therefore stamped onto every lib specifier. A static import
// cannot interpolate a binding, so the token is a literal: whenever REVISION is
// raised, the three specifiers below must be restamped to match. The entry
// cannot be imported here to check that — it awaits this module, and a static
// import in that direction is a cycle whose top-level await never settles — so
// `test/activation.mjs` asserts the two agree instead of the load path doing it.
import { TraeSkillProvider } from './lib/skills.trae2.js?v=35';
import { SessionVault } from './lib/vault.trae2.js?v=35';
import { createTools } from './lib/tools.trae2.js?v=35';

/**
 * In-flight publish chain per project root, so two sweeps never race.
 *
 * Declared before every function that reads it. Activation calls the publish
 * path synchronously, so a module-level binding declared further down the file
 * is in its temporal dead zone at exactly that moment — which threw
 * `Cannot access 'publishChains' before initialization` and took down the whole
 * vault, leaving every session published by the fallback path alone.
 */
const publishChains = new Map();

export const name = 'trae-session-vault';
/**
 * Services this plugin needs; activation waits until all of them exist.
 *
 * Declare every context property this module reads. cordis resolves a property
 * only for a service the fiber declared, so an undeclared one cannot be read at
 * all — a throw for `ctx.<name>`, and `undefined` from `ctx.get('<name>')`.
 * That silently disabled the workspace scan once, because `ctx.get` returned
 * `undefined` and the scan treated it as "this profile has no registry".
 *
 * `sessionPersistence` materializes an archived conversation as a real stored
 * session; `workspaceRegistry` enumerates the project folders to scan for
 * archives that belong to a workspace with no open session.
 */
export const inject = ['skills', 'tools', 'sessions', 'sessionPersistence', 'workspaceRegistry'];

/**
 * @param {unknown} error - a thrown value.
 * @returns {string} a message including the stack, for diagnostics.
 */
function describeError(error) {
  if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/**
 * A Standard Schema node, so this plugin needs no schema package of its own.
 *
 * `cordis` reads exactly one thing from a plugin's `Config` 鈥? * `Config['~standard'].validate(config)` 鈥?so implementing that interface is
 * enough to get the row's config validated and defaulted. Depending on
 * `@deepseek-ai/schemastery` instead would make this bundle's bare import depend
 * on how the Host resolves packages for a linked profile bundle, and would
 * silently pick up any same-named package on the resolution path.
 *
 * @param {object} spec - `{ type, properties?, fallback? }`.
 * @returns {object} a callable schema node exposing `~standard`.
 */
function schemaNode(spec) {
  const node = (value, options = {}) => node.resolve(value, options);
  Object.assign(node, spec);
  node.resolve = (value, options = {}) => {
    const fallback = options.fallback ?? spec.fallback;
    if (value === undefined || value === null) return fallback;
    if (spec.type === 'object') {
      const source = typeof value === 'object' && !Array.isArray(value) ? value : {};
      const out = {};
      for (const [key, child] of Object.entries(spec.properties)) {
        const resolved = child.resolve(source[key]);
        if (resolved !== undefined) out[key] = resolved;
      }
      return out;
    }
    // Accept only the declared type; anything else takes the default, so a
    // mistyped row field degrades to the documented behaviour instead of
    // reaching `apply` as an unexpected value.
    if (typeof value !== spec.type) return fallback;
    if (spec.type === 'number' && !Number.isFinite(value)) return fallback;
    return value;
  };
  Object.defineProperty(node, '~standard', {
    value: {
      version: 1,
      vendor: 'dsh-trae-vault',
      validate: (value) => {
        try {
          return { value: node.resolve(value) };
        } catch (error) {
          return { issues: [{ message: describeError(error) }] };
        }
      },
    },
  });
  return node;
}

/**
 * Build a schema node for a scalar or array field.
 * @param {object} spec - `{ type, fallback }`.
 * @returns {(fallback?: unknown) => object} a builder whose optional argument overrides the default.
 */
const schemaBuilder = (spec) => (fallback = spec.fallback) => schemaNode({ ...spec, fallback });
const objectOf = (properties) => schemaNode({ type: 'object', properties, fallback: {} });

/**
 * A free-form string map, for a section whose keys are chosen by the user.
 *
 * `objectOf` resolves an allowlist: it keeps only the named properties, so it
 * cannot carry something like extra HTTP headers whose names are not known in
 * advance. `schemaDefault` collapses a property-less object node to `{}`, so
 * this does not need — and must not have — an entry in that walk.
 *
 * @returns {object} a schema node whose resolved value is a shallow string map.
 */
function recordOf() {
  const node = schemaNode({ type: 'object', properties: {}, fallback: {} });
  node.resolve = (value) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
    const out = {};
    for (const [key, entry] of Object.entries(value)) if (typeof entry === 'string') out[key] = entry;
    return out;
  };
  return node;
}

const stringOf = schemaBuilder({ type: 'string', fallback: '' });
const booleanOf = schemaBuilder({ type: 'boolean', fallback: false });
const numberOf = schemaBuilder({ type: 'number', fallback: 0 });
const arrayOf = (items) => {
  const node = schemaNode({ type: 'object', properties: {}, fallback: [] });
  node.items = items;
  const resolve = node.resolve;
  node.resolve = (value, options = {}) => {
    if (Array.isArray(value)) return value;
    return resolve(value, options);
  };
  return node;
};

/** Deployment configuration, overridable from `cordis.patch.yml`. */
export const Config = objectOf({
  enabled: booleanOf(true),
  debugLog: stringOf(''),
  skills: objectOf({
    enabled: booleanOf(true),
    providerName: stringOf('trae'),
    customDirs: arrayOf(stringOf),
    scanUserHome: booleanOf(true),
    watch: booleanOf(true),
    recursiveWatch: booleanOf(true),
    watchDebounceMs: numberOf(250),
    maxDepth: numberOf(6),
  }),
  vault: objectOf({
    enabled: booleanOf(true),
    directory: stringOf('.dsh/conversations'),
    autoExport: booleanOf(true),
    includeRuntimeContext: booleanOf(false),
    maxToolResultChars: numberOf(2000),
    readGlobalSessions: booleanOf(true),
    sessionsRoot: stringOf(''),
    // Materialize archived conversations as real DSH sessions so the sidebar
    // lists them and they can be resumed. Writes into DSH's session store.
    autoImport: booleanOf(false),
  }),
  share: objectOf({
    // Import a conversation shared from Trae (a share.traecontent.cn link) into
    // this project as a real DSH session. This is the only capability in the
    // bundle that reaches the network.
    enabled: booleanOf(true),
    // The API origin. Overridable so an enterprise or mirror deployment can be
    // pointed at without a code change; `apiBase` is both the API host and the
    // host share links are built from for citation.
    apiBase: stringOf('https://share.traecontent.cn'),
    timeoutMs: numberOf(30000),
    // Publish an imported conversation to the session store as part of the
    // import, so it appears in the sidebar in one step. A share that is imported
    // while this is off is still archived and can be published later with
    // `conversation_publish`.
    autoPublish: booleanOf(true),
    // The agent preset an imported conversation runs under. Continuing a session
    // needs its preset projection, and a share records none.
    agentPreset: stringOf('standard'),
    maxToolResultChars: numberOf(2000),
    // Extra request headers, for a deployment that needs a cookie or token to
    // reach a share it is allowed to read.
    headers: recordOf(),
  }),
});

/** The schema's own defaults, so validation and the fallback path cannot drift. */
function schemaDefault(section) {
  const out = {};
  for (const [key, node] of Object.entries(section.properties)) {
    // A property-less object node is a free-form map (see `recordOf`), not a
    // nested section: descending would produce `{}` and then spread nothing.
    if (node.type === 'object' && node.properties !== undefined && Object.keys(node.properties).length > 0) {
      out[key] = schemaDefault(node);
      continue;
    }
    out[key] = node.fallback !== null && typeof node.fallback === 'object' && !Array.isArray(node.fallback)
      ? { ...node.fallback }
      : node.fallback;
  }
  return out;
}

/**
 * The resolved defaults `apply` falls back to when the Host hands it a raw row
 * config. Derived from {@link Config} so the two can never disagree.
 */
export const DEFAULT_OPTIONS = schemaDefault(Config);

/**
 * @param {object} section - a raw or validated config section.
 * @param {object} defaults - that section's defaults.
 * @returns {object} the section with every default filled in.
 */
function withDefaults(section, defaults) {
  const source = section !== null && typeof section === 'object' ? section : {};
  const merged = { ...defaults };
  for (const [key, fallback] of Object.entries(defaults)) {
    const value = source[key];
    if (value === undefined) continue;
    if (fallback !== null && typeof fallback === 'object' && !Array.isArray(fallback)) {
      // An empty default means the field is a free-form map: the caller's own
      // keys are the content, so a recursive merge would always erase them.
      merged[key] = Object.keys(fallback).length === 0
        ? (value !== null && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {})
        : withDefaults(value, fallback);
      continue;
    }
    if (typeof value === typeof fallback || Array.isArray(fallback)) merged[key] = value;
  }
  return merged;
}

/**
 * Normalize the row config into the shape `apply` reads.
 * @param {unknown} config - the Host-supplied config.
 * @returns {object} the resolved options.
 */
function resolveOptions(config) {
  return withDefaults(config, DEFAULT_OPTIONS);
}

/**
 * @param {object} config - the resolved vault options.
 * @returns {string} the absolute Harness session root.
 */
function resolveSessionsRoot(config) {
  if (typeof config.sessionsRoot === 'string' && config.sessionsRoot.length > 0) {
    return isAbsolute(config.sessionsRoot) ? config.sessionsRoot : resolve(config.sessionsRoot);
  }
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'sessions');
}

/**
 * Where activation checkpoints are appended when `debugLog` is not configured.
 *
 * A throw during plugin activation is contained by the Harness and reported only
 * on the Host console, which the Desktop build does not expose; leaving a trace
 * by default keeps such a failure diagnosable instead of silent.
 */
const defaultDebugLog = join(
  process.env.DSH_HOME ?? join(homedir(), '.dsh'),
  'trae-session-vault.activation.log',
);

/**
 * Activate the plugin.
 * @param {object} ctx - the plugin context.
 * @param {unknown} rawConfig - the row config, validated or raw.
 */
export function apply(ctx, rawConfig) {
  const config = resolveOptions(rawConfig);
  if (config.enabled === false) {
    ctx.logger.info('trae-session-vault: disabled by configuration');
    return;
  }

  /** The project root most recently observed; the default for tool calls. */
  let activeProjectRoot = resolve(process.cwd());
  /** Archive owners keyed by lowercased project root. */
  const vaults = new Map();
  /** The most recent Trae catalog, rendered for the `trae_skill_list` tool. */
  let lastCatalog = [];
  /**
   * Vault settings with schemastery's field defaults materialized, so the vault
   * module can read a plain object rather than proxy through a schema.
   */
  const vaultConfig = {
    directory: typeof config.vault.directory === 'string' && config.vault.directory.length > 0
      ? config.vault.directory
      : '.dsh/conversations',
    autoExport: config.vault.autoExport !== false,
    autoImport: config.vault.autoImport === true,
    includeRuntimeContext: config.vault.includeRuntimeContext === true,
    maxToolResultChars: Number.isInteger(config.vault.maxToolResultChars) ? config.vault.maxToolResultChars : 2000,
    readGlobalSessions: config.vault.readGlobalSessions !== false,
  };
  const sessionsRoot = resolveSessionsRoot(config.vault);

  /**
   * Share-import settings, with every field defaulted the same way.
   *
   * A share records no agent preset, so one is supplied here: continuing an
   * imported session needs its `agentPreset` projection, and a session that
   * opens without one cannot be resumed.
   */
  const shareConfig = {
    enabled: config.share.enabled !== false,
    apiBase: typeof config.share.apiBase === 'string' && config.share.apiBase.length > 0
      ? config.share.apiBase
      : 'https://share.traecontent.cn',
    timeoutMs: Number.isInteger(config.share.timeoutMs) && config.share.timeoutMs > 0 ? config.share.timeoutMs : 30000,
    autoPublish: config.share.autoPublish !== false,
    agentPreset: typeof config.share.agentPreset === 'string' && config.share.agentPreset.length > 0
      ? config.share.agentPreset
      : 'standard',
    maxToolResultChars: Number.isInteger(config.share.maxToolResultChars) ? config.share.maxToolResultChars : 2000,
    headers: config.share.headers !== null && typeof config.share.headers === 'object' ? { ...config.share.headers } : {},
  };

  /**
   * Archive owner for one project root, created on first use.
   * @param {string} projectRoot - absolute project directory.
   * @returns {SessionVault} the archive.
   */
  const vaultFor = (projectRoot) => {
    const root = resolve(projectRoot);
    const key = root.toLowerCase();
    let vault = vaults.get(key);
    if (vault === undefined) {
      vault = new SessionVault({
        ctx,
        config: vaultConfig,
        projectRoot: root,
        sessionsRoot,
        // Membership is granted by the workspace entity, and only this context
        // declares the registry, so both operations are handed to the vault.
        attachSession: (sessionId, owner) => attachToWorkspace(sessionId, owner),
        workspaceMember: (sessionId, owner) => isWorkspaceMember(sessionId, owner),
        publishSession: (sessionId, events, meta) => publishThroughStore(sessionId, events, meta),
      });
      vaults.set(key, vault);
    }
    return vault;
  };

  /**
   * Publish one session as a durable log without claiming its live identity.
   *
   * The log is written through persistence only — deliberately NOT through
   * `ctx.sessions.create()`.
   *
   * Creating the session in the store looks attractive because it announces the
   * session to live clients, but it also occupies the session id in the live
   * Session store, and that breaks the client's own resume path:
   *
   * - Opening an imported conversation calls `createOrAdopt`, which adopts a
   *   durable session by constructing an Agent for it.
   * - The Agent factory reaches `SessionStore.prepare`, whose first check is
   *   `if (this.store.has(sessionId)) throw new Error('session "…" already exists')`.
   * - The id is in the store because this publish put it there, so the
   *   conversation lists, loads its history, and then fails to resume — for every
   *   imported session.
   *
   * `sessionQuery.listSessions()` reads persisted headers, so a durable log is
   * enough for the session to be listed; leaving the id free is what lets the
   * client adopt it.
   *
   * @param {string} sessionId - a free session identity.
   * @param {object[]} events - the session's complete event log.
   * @param {object} meta - the header fields to store.
   * @returns {Promise<void>} resolves once the log is durable.
   */
  const publishThroughStore = async (sessionId, events, meta) => {
    const persistence = ctx.get?.('sessionPersistence');
    const header = {
      version: 4,
      id: sessionId,
      createdAt: meta.createdAt,
      cwd: meta.cwd,
      isSeeded: meta.isSeeded ?? false,
      ...(meta.agentPreset === undefined ? {} : { agentPreset: meta.agentPreset }),
    };
    if (persistence === undefined) {
      // Without a backend there is nothing to write, and announcing a session
      // nothing can open is the failure this function exists to avoid.
      throw new Error(`cannot publish session ${sessionId}: this profile has no sessionPersistence service`);
    }
    const handle = await persistence.create(header);
    try {
      await handle.append(events);
      await handle.flush();
    } finally {
      await handle.close();
    }
    trace(`wrote durable session ${sessionId} (${events.length} events); its id stays free for the client to adopt`);
  };

  /**
   * Grant one session membership of the workspace owning a project folder.
   *
   * A session written straight into persistence is not a workspace member, so it
   * appears under "Ungrouped"; `workspace.attachSession` is what puts it in the
   * folder's group.
   *
   * @param {string} sessionId - the published session identity.
   * @param {string} projectRoot - the project folder that owns it.
   * @returns {Promise<boolean>} true when the workspace accepted it.
   */
  const attachToWorkspace = async (sessionId, projectRoot) => {    const registry = ctx.workspaceRegistry;
    if (registry === undefined || typeof registry.list !== 'function') {
      trace('workspaceRegistry is unavailable; published sessions stay ungrouped');
      return false;
    }
    const wanted = resolve(projectRoot).toLowerCase();
    let workspace;
    try {
      workspace = registry.list().find((candidate) => String(candidate?.path ?? '').toLowerCase() === wanted);
    } catch (error) {
      trace('could not read the workspace registry', error);
      return false;
    }
    if (workspace === undefined || typeof workspace.attachSession !== 'function') {
      trace(`no workspace owns ${projectRoot}; ${sessionId} stays ungrouped`);
      return false;
    }
    try {
      await workspace.attachSession(sessionId);
      trace(`attached ${sessionId} to workspace ${workspace.path}`);
      return true;
    } catch (error) {
      trace(`could not attach ${sessionId} to ${workspace.path}`, error);
      return false;
    }
  };

  /**
   * Whether a session already belongs to the workspace owning a project folder.
   *
   * An archive folder can be copied into a second project, and its ledger comes
   * with it. Membership — not the ledger — decides whether that conversation is
   * already present in the workspace the user is looking at.
   *
   * @param {string} sessionId - the session a previous publish recorded.
   * @param {string} projectRoot - the project folder that should own it.
   * @returns {Promise<boolean>} true when the workspace lists it.
   */
  const isWorkspaceMember = async (sessionId, projectRoot) => {
    const registry = ctx.workspaceRegistry;
    if (registry === undefined || typeof registry.list !== 'function') return true;
    const wanted = resolve(projectRoot).toLowerCase();
    try {
      const workspace = registry.list().find((candidate) => String(candidate?.path ?? '').toLowerCase() === wanted);
      if (workspace === undefined) return false;
      const member = [...workspace.sessionIds].some((id) => String(id) === sessionId);
      if (!member) trace(`${sessionId} is not a member of ${workspace.path}; publishing a copy there`);
      return member;
    } catch (error) {
      trace('could not check workspace membership', error);
      return true;
    }
  };

  /**
   * The project root a session belongs to, which is always that session's own
   * `cwd`.
   *
   * Never route an archive through a shared "current project" variable: with
   * several sessions open, whichever one was observed last would capture the
   * others, and every session's transcript would be written into that one
   * folder. That is exactly how this session's archive once landed in an
   * unrelated workspace.
   *
   * @param {object} session - a live session.
   * @returns {string | undefined} the absolute project root, or undefined when the session records no cwd.
   */
  const rootOfSession = (session) => {
    const cwd = session?.header?.cwd;
    return typeof cwd === 'string' && cwd.length > 0 ? resolve(cwd) : undefined;
  };

  /**
   * The archive for a tool call's project, falling back to the last observed one.
   * @param {object} [exec] - the tool run context.
   * @returns {SessionVault} the archive.
   */
  const vaultForCall = (exec) => {
    const root = rootOfSession(exec?.agent?.session);
    if (root !== undefined) activeProjectRoot = root;
    return vaultFor(activeProjectRoot);
  };

  /** Routes every property to the archive of the active project. */
  const dynamicVault = new Proxy({}, {
    get(_target, property) {
      const vault = vaultFor(activeProjectRoot);
      const value = vault[property];
      return typeof value === 'function' ? value.bind(vault) : value;
    },
  });

  /**
   * Render a Trae catalog as plain text.
   * @param {Array<object>} [skills] - catalog to render; defaults to the last scan.
   * @returns {string} a human-readable report.
   */
  const skillsReport = (skills) => {
    const catalog = skills ?? lastCatalog;
    if (catalog.length === 0) {
      return [
        `No Trae skills were found for ${activeProjectRoot}.`,
        `Expected SKILL.md bundles under ${join(activeProjectRoot, '.trae', 'skills')} (or the same path in a parent folder).`,
      ].join('\n');
    }
    const lines = [`Trae skills visible for ${activeProjectRoot}:`, ''];
    for (const skill of catalog) {
      lines.push(`- ${skill.name}${skill.invocation?.modelInvocable === false ? ' (model invocation disabled)' : ''}`);
      lines.push(`  ${skill.description}`);
      if (skill.path !== undefined) lines.push(`  file: ${skill.path}`);
    }
    return lines.join('\n');
  };

  // `ctx.inject` runs its callback synchronously once every named service
  // exists, so only declarations above this point are initialized; anything the
  // callback touches must already be defined or it throws into the child fiber,
  // which leaves this plugin's own fiber `active` with nothing registered.
  /**
   * Append an activation diagnostic to `debugLog` when tracing is enabled.
   *
   * A throw inside this plugin's injected child fiber is contained by the
   * Harness and only reaches the Host console, which the Desktop build does not
   * expose. This opt-in trace keeps such a failure observable; it is written
   * with `node:fs` rather than `ctx.fs` so it cannot be blocked by the file
   * sandbox.
   *
   * @param {string} message - what happened.
   * @param {unknown} [error] - an optional error to record.
   */
  const trace = (message, error) => {
    const target = config.debugLog.length > 0 ? config.debugLog : defaultDebugLog;
    const line = `${new Date().toISOString()}  ${message}${error === undefined ? '' : ` :: ${describeError(error)}`}\n`;
    try {
      appendFileSync(target, line, 'utf8');
    } catch {
      // Diagnostics must never break activation.
    }
    try {
      ctx.logger.info(`trae-session-vault: ${message}`);
    } catch {
      // A logger that rejects the write is not worth failing activation over.
    }
  };
  trace('apply entered (generation 35)');

  // This module's own `inject` already guarantees these services exist before
  // `apply` runs, so registration is direct. Wrapping it in a second
  // `ctx.inject` would add a layer whose failure mode is silent: a throw inside
  // the injected child fiber is contained by the Harness, leaving this plugin's
  // own fiber `active` with nothing registered.
  //
  // Each capability gets its own try/catch for the same reason: when both shared
  // one scope, a throw late in the vault half discarded the already-successful
  // tool and skill registrations, so one bug took the whole plugin down.
  const register = (label, run) => {
    try {
      run();
      trace(`${label} done`);
    } catch (error) {
      ctx.logger.error(`trae-session-vault: ${label} failed: ${describeError(error)}`);
      trace(`${label} failed`, error);
    }
  };

  register('registerSkills', () => {
    if (config.skills.enabled) registerSkills(ctx);
  });
  register('registerVault', () => {
    if (config.vault.enabled) registerVault(ctx);
  });
  trace('apply finished');

  /**
   * Register the Trae skill provider and seed the diagnostic catalog.
   * @param {object} serviceCtx - the context that owns the services.
   */
  function registerSkills(serviceCtx) {
    let provider;
    const providerName = config.skills.providerName;
    const removeProvider = serviceCtx.skills.registerProvider((control) => {
      provider = new TraeSkillProvider({
        ctx: serviceCtx,
        name: providerName,
        invalidate: () => control.invalidate(),
        config: {
          customDirs: (config.skills.customDirs ?? []).map((dir) => (isAbsolute(dir) ? dir : resolve(dir))),
          scanUserHome: config.skills.scanUserHome,
          home: homedir(),
          watch: config.skills.watch,
          recursiveWatch: config.skills.recursiveWatch,
          watchDebounceMs: config.skills.watchDebounceMs,
          maxDepth: config.skills.maxDepth,
        },
      });
      return provider;
    });
    serviceCtx.effect(() => async () => {
      provider?.dispose();
      await removeProvider();
    }, 'trae-session-vault: trae skill provider');

    serviceCtx.skills.list({ cwd: activeProjectRoot }).then((skills) => {
      lastCatalog = skills.filter((skill) => skill.provider === providerName);
      serviceCtx.logger.info(
        `trae-session-vault: ${lastCatalog.length} Trae skill(s) visible for ${activeProjectRoot}`,
      );
    }).catch((error) => {
      serviceCtx.logger.warn(`trae-session-vault: initial skill scan failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  /**
   * Register the vault's tools and the automatic export hook.
   * @param {object} serviceCtx - the context that owns the services.
   */
  function registerVault(serviceCtx) {
    /** Set once the plugin is torn down, so a pending retry stops touching services. */
    let disposed = false;
    /** Retry timers still outstanding, cleared on teardown. */
    const pendingTimers = new Set();
    const definitions = createTools({
      ctx: serviceCtx,
      vault: dynamicVault,
      vaultForCall,
      // Route to the archive that owns an explicit project root, so archiving a
      // session from another project lands in that project's folder.
      selectVault: (projectRoot) => {
        activeProjectRoot = resolve(projectRoot);
        return vaultFor(activeProjectRoot);
      },
      skillsReport,
      shareConfig,
      // Diagnostic: report what the durable workspace registry currently
      // attributes to each workspace. `list()` filters by its canonical-cwd
      // header index, so this shows whether a published session is attached yet.
      workspacesReport: () => {
        const registry = serviceCtx.workspaceRegistry;
        if (registry === undefined) return 'no workspaceRegistry service';
        try {
          const lines = [];
          for (const workspace of registry.list()) {
            lines.push(`${workspace.path}  title=${workspace.title}  sessions=[${[...workspace.sessionIds].join(', ')}]`);
          }
          return lines.join('\n');
        } catch (error) {
          return `could not list workspaces: ${error instanceof Error ? error.message : String(error)}`;
        }
      },
    });
    const registered = [];
    for (const definition of definitions) {
      serviceCtx.tools.register(definition);
      registered.push(definition.name);
      trace(`registered tool ${definition.name}`);
    }
    trace(`registerVault done: registered ${registered.length} of ${definitions.length} tools`);
    if (!shareConfig.enabled) {
      trace('share import is disabled by configuration; conversation_import_share will refuse');
    }

    // Export and publish are independent switches. A profile may want to publish
    // archives only, so the export half must not gate the publish half.
    if (!vaultConfig.autoExport && !vaultConfig.autoImport) return;

    /**
     * Archive one live session, then — when enabled — publish its archive back
     * out as a real DSH session so the sidebar can list and resume it.
     *
     * Failures are contained per session: one unimportable conversation must not
     * stop the rest, and it must never disturb the live session that triggered it.
     *
     * @param {object} vault - the archive owning this session.
     * @param {object} session - the live session.
     */
    const syncSession = (vault, session) => {
      vault.exportLive(session)
        .then(() => {
          if (!vaultConfig.autoImport) return undefined;
          return vault.importToDsh();
        })
        .then((result) => {
          if (result === undefined) return;
          for (const entry of result.imported) {
            trace(`imported ${entry.sessionId} as DSH session ${entry.importedAs}`);
          }
          for (const entry of result.failed) {
            ctx.logger.warn(`trae-session-vault: could not import ${entry.sessionId ?? '(unknown)'}: ${entry.error}`);
            trace(`import failed for ${entry.sessionId ?? '(unknown)'}`, entry.error);
          }
        })
        .catch((error) => {
          ctx.logger.warn(`trae-session-vault: materializing sessions failed: ${describeError(error)}`);
          trace('materialize failed', error);
        });
    };

    if (vaultConfig.autoExport) {
      serviceCtx.on('session/event', (session, event) => {
        // `session/title` arrives early and gives the archive its title;
        // `turn/end` is the durable boundary of one exchange.
        if (event?.type !== 'turn/end' && event?.type !== 'session/title') return;
        // Resolve the vault from THIS session's own cwd. Sharing one mutable
        // "current project" here would file every session's transcript under
        // whichever project was seen last.
        const root = rootOfSession(session);
        if (root === undefined) return;
        activeProjectRoot = root;
        syncSession(vaultFor(root), session);
      });

      // Archive every already-open session once at activation, each into its own
      // project folder, so resuming Harness does not wait for the next turn.
      //
      // This reads `ctx.sessions` only. `ctx.agents` was once read here without
      // being declared in `inject`, which threw after the tools were registered
      // and discarded the whole activation result.
      for (const session of serviceCtx.sessions.list()) {
        const root = rootOfSession(session);
        if (root === undefined) continue;
        activeProjectRoot = root;
        syncSession(vaultFor(root), session);
      }
    }

    // Publish archives that belong to projects with no open session.
    //
    // A project someone already opened once has its archive on disk but no live
    // session, so the loop above never sees it and nothing would ever be
    // published. The workspace registry is the bounded, authoritative list of
    // real project folders, so it is the right thing to scan — better than
    // walking the filesystem, which would be unbounded.
    if (vaultConfig.autoImport) materializeRegisteredWorkspaces(serviceCtx);

    if (vaultConfig.autoImport) {
      // The plugin is startup-loaded, so it is already running before a workspace
      // is created or before its `.dsh` folder is copied in. Neither of those
      // filesystem facts announces itself, and a registry change that happened
      // before this listener existed can never be observed — so waiting for an
      // event alone leaves conversations invisible with no retry. Instead, watch
      // for newly *appeared* archives: the registry still bounds the search, so
      // each sweep only stats known project folders.
      //
      // The poll is a gap-closer, not a fixture: it stops for good once every
      // registered workspace is accounted for, and the interval is deliberately
      // coarse because publishing is only ever needed once per archive.
      const baseline = new Set();
      let sweeps = 0;
      let idlePolls = 0;

      /**
       * Record which workspaces already have an archive directory.
       *
       * The activation scan has just published everything it found, so those are
       * settled. The test is the directory's presence — matching `pollOnce` — and
       * not `index.json`: an archive copied in from elsewhere may hold session
       * folders without an index, and the two must agree on what is settled.
       *
       * @param {object[]} workspaces - the registry's workspace entities.
       * @returns {Set<string>} their lowercased paths.
       */
      const noteArchived = (workspaces) => {
        for (const workspace of workspaces) {
          const path = workspace?.path;
          if (typeof path !== 'string' || path.length === 0) continue;
          if (existsSync(join(path, vaultConfig.directory))) baseline.add(path.toLowerCase());
        }
        return new Set([...workspaces].map((workspace) => String(workspace?.path ?? '').toLowerCase()));
      };

      const rescan = (why) => {
        sweeps += 1;
        trace(`rescanning for archives to publish (${why})`);
        try {
          materializeRegisteredWorkspaces(serviceCtx);
        } catch (error) {
          trace('rescan failed', error);
        }
      };

      /**
       * One poll: publish archives that appeared since the last sweep.
       *
       * @returns {boolean} true when every registered workspace is accounted for,
       *   so the watch may go quiet.
       */
      const pollOnce = () => {
        const registry = serviceCtx.workspaceRegistry;
        if (registry === undefined || typeof registry.list !== 'function') return false;
        let workspaces;
        try {
          workspaces = registry.list();
        } catch {
          return false;
        }
        const known = new Set([...workspaces].map((workspace) => String(workspace?.path ?? '').toLowerCase()));
        // A workspace that vanished changes what "complete" means.
        for (const key of [...baseline]) if (!known.has(key)) baseline.delete(key);
        let fresh = false;
        let waiting = 0;
        for (const workspace of workspaces) {
          const path = workspace?.path;
          if (typeof path !== 'string' || path.length === 0) continue;
          const key = path.toLowerCase();
          if (baseline.has(key)) continue;
          if (!existsSync(join(path, vaultConfig.directory))) {
            // A workspace created without an archive yet is still *pending*, not
            // settled. Treating it as quiet is what let the watch give up before
            // the `.dsh` folder arrived, so the conversations only appeared after
            // a restart.
            waiting += 1;
            continue;
          }
          fresh = true;
          baseline.add(key);
        }
        if (fresh) rescan('an archive appeared in a registered workspace');
        else if (sweeps === 0) rescan('confirming registered workspaces');
        return !fresh && waiting === 0;
      };

      // Establish the opening baseline from what the activation scan just did.
      try {
        noteArchived(serviceCtx.workspaceRegistry?.list?.() ?? []);
      } catch {
        // An unreadable registry leaves the poll to discover everything.
      }

      const interval = setInterval(() => {
        if (disposed) return;
        // Only a genuinely settled picture ends the watch: every registered
        // workspace either has an archive or is still waiting for one. While any
        // workspace is pending the poll keeps a coarse watch running, because the
        // moment the archive appears is not announced by anything.
        if (pollOnce()) {
          idlePolls += 1;
          if (idlePolls >= 8) {
            trace(`stopped watching for new archives after ${sweeps} sweep(s)`);
            clearInterval(interval);
          }
        } else {
          idlePolls = 0;
        }
      }, 5_000);
      if (typeof interval.unref === 'function') interval.unref();
      pendingTimers.add(interval);

      serviceCtx.on('domain/changed', (change) => {
        if (change?.domain !== 'workspace') return;
        rescan('workspace registry changed');
      });
      serviceCtx.on('session/created', () => {
        rescan('a session was created');
      });

      // Teardown must stop the poll, or a later sweep would touch services the
      // plugin no longer owns.
      serviceCtx.effect(() => () => {
        disposed = true;
        for (const timer of pendingTimers) clearInterval(timer);
        pendingTimers.clear();
      });
    }
  }

  /**
   * Publish the archive of every registered workspace that has one.
   *
   * Best-effort by design: an unreadable or absent registry leaves the rest of
   * the plugin unaffected, and each project's failure is contained.
   *
   * @param {object} serviceCtx - the context owning the services.
   */
  function materializeRegisteredWorkspaces(serviceCtx) {
    // Read through the declared property, not `ctx.get`. An undeclared service
    // reads as `undefined` from `get`, which once made this guard report "no
    // registry" and skip the scan without a trace — indistinguishable from a
    // scan that found nothing.
    const registry = serviceCtx.workspaceRegistry;
    if (registry === undefined || typeof registry.list !== 'function') {
      trace('workspaceRegistry is unavailable; skipped publishing pre-existing archives');
      return;
    }
    let workspaces;
    try {
      workspaces = registry.list();
    } catch (error) {
      trace('could not list workspaces', error);
      return;
    }
    const paths = [...workspaces].map((workspace) => workspace?.path).filter((path) => typeof path === 'string' && path.length > 0);
    trace(`scanning ${paths.length} workspace(s) for archives to publish`);
    publishWorkspaces(paths.map((path) => ({ path })));
  }


  /**
   * Publish one project's archive, serialized against its own earlier publishes.
   *
   * Without this, overlapping triggers each ran `importToDsh` concurrently: both
   * saw the derived id as free (or unreadable) and both created a session, which
   * is how one workspace ended up with the same conversation twice, one second
   * apart. Chaining means the second pass observes the first pass's result and
   * skips it.
   *
   * @param {string} root - the absolute project root.
   * @returns {Promise<object>} the publish result.
   */
  function queuedPublish(root) {
    const key = root.toLowerCase();
    const previous = publishChains.get(key) ?? Promise.resolve();
    // Swallow an earlier failure so one bad sweep cannot block the next.
    const next = previous.catch(() => {}).then(() => vaultFor(root).importToDsh());
    publishChains.set(key, next);
    // Release the slot so a long-idle project does not hold a chain forever.
    next.catch(() => {}).finally(() => {
      if (publishChains.get(key) === next) publishChains.delete(key);
    });
    return next;
  }

  /**
   * Publish one archive per workspace path.
   *
   * Split from the registry lookup so the behaviour a profile actually depends on
   * — archives belonging to projects with no open session still get published —
   * is testable without composing a registry.
   *
   * @param {Iterable<object>} workspaces - entities exposing an absolute `path`.
   */
  function publishWorkspaces(workspaces) {
    const seen = new Set();
    for (const workspace of workspaces) {
      const path = workspace?.path;
      if (typeof path !== 'string' || path.length === 0) continue;
      const root = resolve(path);
      // One sweep may list a path twice, and consecutive sweeps overlap anyway.
      if (seen.has(root.toLowerCase())) continue;
      seen.add(root.toLowerCase());
      activeProjectRoot = root;
      // Reuse the per-project vault the same way a live session would, so the
      // published session's cwd is that workspace and the sidebar files it there.
      queuedPublish(root)
        .then((result) => {
          for (const entry of result.imported) {
            trace(`published ${entry.sessionId} of ${path} as DSH session ${entry.importedAs}${entry.reconstructed === true ? ' (rebuilt from the transcript)' : ''}`);
          }
          for (const entry of result.skipped) {
            trace(`already published ${entry.sessionId} of ${path} as ${entry.importedAs ?? '(unknown)'}`);
          }
          for (const entry of result.failed) {
            trace(`publish failed for ${path}/${entry.sessionId ?? '(unknown)'}`, entry.error);
          }
        })
        .catch((error) => {
          trace(`publish threw for ${path}`, error);
        });
    }
  }
}
