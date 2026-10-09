/**
 * Trae skill discovery for DeepSeek Harness.
 *
 * Trae stores skills as `<root>/<name>/SKILL.md` inside a project's `.trae/skills`
 * folder, and Trae skill bundles often nest their real definition deeper (for
 * example `.trae/skills/<group>/<name>/SKILL.md`). Harness's own filesystem
 * provider scans exactly one level below a root, so this module performs its own
 * recursive walk, parses the YAML frontmatter Trae writes, and exposes the result
 * through the `ctx.skills` provider registry.
 *
 * Catalog discovery reads frontmatter only; bodies load on demand, so editing a
 * `SKILL.md` body takes effect on the next invocation with no cache invalidation.
 *
 * @module @local/dsh-trae-session-vault/skills
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { watch } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** Directories that never contain an authored skill definition. */
const SKIP_DIRECTORIES = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv', '.idea', '.vscode']);
/** Provider ranks: lower wins inside one registry layer. */
export const TRAE_PROJECT_RANK = 150;
export const TRAE_CUSTOM_RANK = 250;
export const TRAE_HOME_RANK = 450;
/** Kebab-case skill name, matching the Harness registry's own grammar. */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Whether a name satisfies the Harness skill-name grammar.
 * @param {string} name - candidate name.
 * @returns {boolean} true when the registry will accept it.
 */
export function isSkillName(name) {
  return SKILL_NAME.test(name);
}

/**
 * @param {string} path - absolute path.
 * @returns {Promise<boolean>} true when `path` is an existing directory.
 */
async function directoryExists(path) {
  try {
    const info = await stat(path);
    return info.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Absolute `.trae/skills` folder for `cwd`, if one exists here or in an ancestor.
 * @param {string} cwd - the lookup working directory.
 * @returns {Promise<string | undefined>} the directory, or undefined when absent.
 */
export async function findProjectSkillsDir(cwd) {
  let current = resolve(cwd);
  for (;;) {
    const candidate = join(current, '.trae', 'skills');
    if (await directoryExists(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/**
 * Parse a leading `---` YAML frontmatter block.
 *
 * Only the flat `key: value` scalars Trae emits are interpreted. Values may be
 * single- or double-quoted.
 *
 * @param {string} raw - full file text.
 * @returns {{ data: Record<string, unknown>, body: string } | undefined} parsed parts, or undefined without frontmatter.
 */
export function parseFrontmatter(raw) {
  const text = raw.replace(/^\uFEFF/, '');
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (match === null) return undefined;
  const data = {};
  for (const line of match[1].split(/\r?\n/)) {
    const keyMatch = /^([A-Za-z0-9_.\-]+)[ \t]*:[ \t]?(.*)$/.exec(line);
    if (keyMatch === null) continue;
    let value = keyMatch[2].trim();
    if (value.length > 1) {
      const first = value[0];
      const last = value[value.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) value = value.slice(1, -1);
    }
    if (value.length === 0) continue;
    data[keyMatch[1]] = value;
  }
  return { data, body: text.slice(match[0].length) };
}

/**
 * Interpret the strict boolean grammar Harness uses for invocation frontmatter.
 * @param {unknown} value - raw frontmatter value.
 * @returns {boolean | undefined} the boolean, or undefined when the value is absent.
 * @throws {Error} when a present value is not a recognized boolean spelling.
 */
export function booleanField(value) {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['true', 'yes', 'on', '1'].includes(normalized)) return true;
  if (['false', 'no', 'off', '0'].includes(normalized)) return false;
  throw new Error(`must be a boolean, received ${JSON.stringify(value)}`);
}

/**
 * Read and validate one `SKILL.md`.
 * @param {string} filePath - absolute path to the definition.
 * @param {string} source - source label recorded on the catalog entry.
 * @returns {Promise<{ definition: object, locator: object } | { skipped: string }>} a loaded skill or a skip reason.
 */
export async function readSkillFile(filePath, source) {
  let raw;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    return { skipped: `unreadable: ${error instanceof Error ? error.message : String(error)}` };
  }
  const parsed = parseFrontmatter(raw);
  if (parsed === undefined) return { skipped: 'missing YAML frontmatter' };
  const name = typeof parsed.data.name === 'string' ? parsed.data.name : undefined;
  const description = typeof parsed.data.description === 'string' ? parsed.data.description : undefined;
  if (name === undefined) return { skipped: 'frontmatter requires name' };
  if (description === undefined) return { skipped: 'frontmatter requires description' };
  if (!isSkillName(name)) return { skipped: `invalid skill name ${JSON.stringify(name)}` };
  let modelInvocable = true;
  let userInvocable = true;
  try {
    modelInvocable = booleanField(parsed.data['disable-model-invocation']) !== true;
    userInvocable = booleanField(parsed.data['user-invocable']) !== false;
  } catch (error) {
    return { skipped: `invalid invocation frontmatter: ${error instanceof Error ? error.message : String(error)}` };
  }
  const whenToUse = typeof parsed.data.whenToUse === 'string' ? parsed.data.whenToUse
    : typeof parsed.data['when-to-use'] === 'string' ? parsed.data['when-to-use'] : undefined;
  return {
    definition: {
      name,
      description,
      ...(whenToUse === undefined ? {} : { whenToUse }),
      invocation: { modelInvocable, userInvocable },
      source,
      content: parsed.body.trim(),
    },
    locator: { path: filePath, directory: dirname(filePath) },
  };
}

/**
 * Recursively collect `SKILL.md` paths under `root`, without descending into
 * version-control or dependency directories.
 * @param {string} root - absolute skill root.
 * @param {number} maxDepth - remaining recursion budget.
 * @returns {Promise<string[]>} absolute SKILL.md paths.
 */
export async function collectSkillFiles(root, maxDepth) {
  if (maxDepth < 0) return [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      files.push(...await collectSkillFiles(full, maxDepth - 1));
      continue;
    }
    if (entry.isFile() && entry.name.toLowerCase() === 'skill.md') files.push(full);
  }
  return files;
}

/**
 * Whether a filesystem event name could affect the skill catalog.
 * @param {string} filename - the event's relative path.
 * @returns {boolean} true when the path may hold a definition.
 */
export function isPotentialSkillPath(filename) {
  const parts = filename.split(/[\\/]/).filter((part) => part.length > 0);
  if (parts.some((part) => SKIP_DIRECTORIES.has(part))) return false;
  return parts[parts.length - 1]?.toLowerCase() === 'skill.md';
}

/** The `ctx.skills` provider that surfaces Trae SKILL.md bundles. */
export class TraeSkillProvider {
  /**
   * @param {object} options - provider wiring.
   * @param {object} options.ctx - the plugin context, used for logging.
   * @param {string} options.name - provider name registered on the registry.
   * @param {() => void} options.invalidate - registry cache invalidator.
   * @param {object} options.config - resolved skills configuration.
   */
  constructor({ ctx, name, invalidate, config }) {
    this.ctx = ctx;
    this.name = name;
    this.invalidate = invalidate;
    this.config = config;
    this.watchers = new Map();
    this.warned = new Set();
    this.debounce = undefined;
  }

  /**
   * Discover Trae skills for one lookup working directory.
   * @param {{ cwd?: string, signal?: AbortSignal }} options - lookup options.
   * @returns {Promise<Array<object>>} catalog candidates with this provider's ranks.
   */
  async list(options) {
    const roots = await this.roots(options?.cwd);
    const candidates = [];
    const seen = new Set();
    for (const root of roots) {
      const files = await collectSkillFiles(root.path, this.config.maxDepth);
      for (const file of files.sort()) {
        const key = resolve(file).toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        const loaded = await readSkillFile(file, root.source);
        if ('skipped' in loaded) {
          this.warnOnce(file, loaded.skipped);
          continue;
        }
        candidates.push({
          name: loaded.definition.name,
          description: loaded.definition.description,
          ...(loaded.definition.whenToUse === undefined ? {} : { whenToUse: loaded.definition.whenToUse }),
          invocation: loaded.definition.invocation,
          source: root.source,
          provider: this.name,
          resourceBase: { kind: 'directory', path: loaded.locator.directory },
          path: loaded.locator.path,
          rank: root.rank,
          locator: loaded.locator,
        });
      }
    }
    if (this.config.watch) await this.watch(roots);
    return candidates;
  }

  /**
   * Load one skill body from the winning candidate's locator.
   * @param {object} candidate - a candidate returned by {@link list}.
   * @returns {Promise<object | undefined>} the full skill, or undefined if the file vanished.
   */
  async get(candidate) {
    const locator = candidate?.locator;
    if (locator === undefined || typeof locator.path !== 'string') return undefined;
    const loaded = await readSkillFile(locator.path, candidate.source);
    if ('skipped' in loaded) {
      this.warnOnce(locator.path, loaded.skipped);
      return undefined;
    }
    return {
      ...loaded.definition,
      provider: this.name,
      resourceBase: { kind: 'directory', path: locator.directory },
      path: locator.path,
    };
  }

  /**
   * Resolve the ordered Trae skill roots for one working directory.
   * @param {string | undefined} cwd - lookup working directory.
   * @returns {Promise<Array<{ path: string, source: string, rank: number }>>} roots in precedence order.
   */
  async roots(cwd) {
    const roots = [];
    if (typeof cwd === 'string' && cwd.length > 0) {
      const projectDir = await findProjectSkillsDir(cwd);
      if (projectDir !== undefined) roots.push({ path: projectDir, source: 'trae-project', rank: TRAE_PROJECT_RANK });
    }
    for (const dir of this.config.customDirs) {
      roots.push({ path: dir, source: 'trae-custom', rank: TRAE_CUSTOM_RANK });
    }
    if (this.config.scanUserHome) {
      const homeDir = join(this.config.home, '.trae', 'skills');
      if (await directoryExists(homeDir)) roots.push({ path: homeDir, source: 'trae-user', rank: TRAE_HOME_RANK });
    }
    return roots;
  }

  /**
   * Attach one watcher per existing root so an edited or added SKILL.md reaches
   * the next catalog read. Only the root set changes rebuild watchers.
   * @param {Array<{ path: string }>} roots - the roots discovered for this lookup.
   * @returns {Promise<void>} resolves once watchers match the root set.
   */
  async watch(roots) {
    const desired = new Set(roots.map((root) => root.path));
    for (const [path, handle] of this.watchers) {
      if (desired.has(path)) continue;
      handle.close();
      this.watchers.delete(path);
    }
    for (const path of desired) {
      if (this.watchers.has(path)) continue;
      const handle = this.watchRoot(path);
      if (handle !== undefined) this.watchers.set(path, handle);
    }
  }

  /**
   * Observe one root and invalidate the catalog when a definition may have changed.
   * @param {string} path - root directory to observe.
   * @returns {{ close: () => void } | undefined} the watcher handle, or undefined when watching is unsupported.
   */
  watchRoot(path) {
    const onChange = (_eventType, filename) => {
      if (typeof filename === 'string' && filename.length > 0 && !isPotentialSkillPath(filename)) return;
      if (this.debounce !== undefined) clearTimeout(this.debounce);
      // Coalesce a burst of writes (an editor saving several files, a checkout)
      // into a single registry invalidation.
      this.debounce = setTimeout(() => {
        this.debounce = undefined;
        this.warned.clear();
        this.invalidate();
      }, this.config.watchDebounceMs);
      this.debounce.unref?.();
    };
    try {
      // `recursive` is honored on Windows and macOS, where nested Trae skill
      // bundles are common; elsewhere the top level still covers the usual
      // `.trae/skills/<name>/SKILL.md` layout.
      return watch(path, { recursive: this.config.recursiveWatch }, onChange);
    } catch {
      try {
        return watch(path, onChange);
      } catch (error) {
        this.ctx.logger.warn(`trae skills: cannot watch ${path}: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
      }
    }
  }

  /**
   * Log one skip reason once per path, so a rejected skill cannot flood the log.
   * @param {string} path - the definition path.
   * @param {string} reason - the skip reason.
   */
  warnOnce(path, reason) {
    const key = `${path} ${reason}`;
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.ctx.logger.warn(`trae skills: ${path} ignored: ${reason}`);
  }

  /** Close every watcher. */
  dispose() {
    if (this.debounce !== undefined) clearTimeout(this.debounce);
    this.debounce = undefined;
    for (const handle of this.watchers.values()) handle.close();
    this.watchers.clear();
  }
}
