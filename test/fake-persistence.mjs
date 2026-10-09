import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * An in-memory `ctx.sessionPersistence` double.
 *
 * The import path writes into DSH's real session store, so a test must never
 * touch it. This double implements the documented contract surface the vault
 * uses — `create` returning an owned write handle, `append`, `flush`, `close`,
 * plus `list`/`stat` — and applies the same validation the session loader
 * applies, so a malformed event fails here instead of in a user's sidebar.
 *
 * With `options.onDisk` it also materializes real directories, which lets a test
 * exercise the paths that replacement and cleanup operate on.
 *
 * @param {object} [options] - double behaviour.
 * @param {(header: object) => void} [options.onValidateHeader] - extra header checks.
 * @param {(events: readonly object[]) => void} [options.onValidateEvents] - extra event checks.
 * @param {{ root: string, slug: string }} [options.onDisk] - when set, materialize a real
 *   session directory under `root/<slug>/<id>/session.v4.jsonl` so paths can be exercised.
 * @returns {object} the persistence service double, with its stored sessions exposed for assertions.
 */
export function createFakeSessionPersistence(options = {}) {
  /** sessionId -> { header, events } */
  const stored = new Map();
  const created = [];
  const flushed = [];
  const closed = [];
  let idCounter = 0;

  /**
   * Create the physical artifact a real backend would materialize.
   *
   * Only one file is needed: the replacement path moves a whole directory, so it
   * cares that the artifact exists at a path, not that its bytes are zstd.
   *
   * @param {string} id - the session identity.
   * @param {object} header - the stored header.
   * @param {readonly object[]} events - the session's events.
   */
  const materializeOnDisk = (id, header, events) => {
    const { root, slug } = options.onDisk;
    const dir = join(root, slug, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'session.v4.jsonl'), `${[header, ...events].map((e) => JSON.stringify(e)).join('\n')}\n`);
  };

  /**
   * Reject the shapes the real loader rejects, so a test cannot pass on data a
   * real DSH session could not open.
   * @param {object} header - the session header.
   */
  const assertHeader = (header) => {
    if (typeof header !== 'object' || header === null) throw new TypeError('header must be an object');
    if (typeof header.id !== 'string' || header.id.length === 0) throw new TypeError('header needs an id');
    if (typeof header.version !== 'number') throw new TypeError('header needs a numeric version');
    if (typeof header.isSeeded !== 'boolean') throw new TypeError('header needs isSeeded');
    if (header.cwd !== undefined && (typeof header.cwd !== 'string' || !/^([A-Za-z]:[\\/]|\/)/.test(header.cwd))) {
      throw new TypeError(`header cwd must be an absolute path, got ${JSON.stringify(header.cwd)}`);
    }
    options.onValidateHeader?.(header);
  };

  /**
   * Assert that a whole event list is a structurally valid stored log.
   *
   * Validating the accumulated log (rather than each `append` call separately)
   * matches how persistence reads it back, and makes the check independent of how
   * an owner batches its appends.
   *
   * @param {readonly object[]} all - every event in order.
   * @param {number} from - index of the first newly appended event.
   */
  const assertLog = (all, from) => {
    // A log containing a compaction rewrite cannot be judged by a forward-only
    // state machine: `compaction/prune` replaces tool results at their historical
    // turn/step coordinates, so the sequence revisits earlier turns. The real
    // loader accepts that, so this double must not reject it either.
    const rewritten = all.some((event) => event?.type === 'compaction/prune');
    let openTurn = null;
    let openStep = null;
    all.forEach((event, index) => {
      const seq = index;
      if (typeof event?.type !== 'string' || event.type.length === 0) throw new TypeError(`event ${seq} needs a type`);
      if (event.seq !== seq) throw new TypeError(`event ${seq} must carry seq ${seq}, got ${JSON.stringify(event.seq)}`);
      if (typeof event.time !== 'number') throw new TypeError(`event ${seq} needs a numeric time`);
      if (typeof event.data !== 'object' || event.data === null) throw new TypeError(`event ${seq} needs a data object`);

      const { type, data } = event;
      if (type === 'turn/start') {
        if (!Number.isSafeInteger(data.turn)) throw new TypeError(`event ${seq} turn/start needs an integer turn`);
        openTurn = data.turn;
        openStep = null;
      } else if (type === 'turn/end') {
        if (data.turn !== openTurn) throw new TypeError(`event ${seq} turn/end does not match the open turn`);
        openTurn = null;
        openStep = null;
      } else if (type === 'step/start') {
        if (data.turn !== openTurn) throw new TypeError(`event ${seq} step/start is outside its turn`);
        openStep = data.step;
      } else if (type === 'step/end') {
        if (data.turn !== openTurn || data.step !== openStep) throw new TypeError(`event ${seq} step/end does not match the open step`);
        openStep = null;
      } else if (!rewritten && ['user/message', 'assistant/message', 'tool/result', 'system/message', 'developer/message'].includes(type)) {
        // The open turn and step are tracked by position: a real `user/message`
        // and `system/message` carry neither field, while `assistant/message`,
        // `tool/result` and `developer/message` must agree with what is open.
        if (openTurn === null || openStep === null) {
          throw new TypeError(`${type} does not match an open turn and step (event ${seq})`);
        }
        if (type !== 'user/message' && type !== 'system/message' && (data.turn !== openTurn || data.step !== openStep)) {
          throw new TypeError(`${type} does not match an open turn and step (event ${seq})`);
        }
      }

      if (type === 'assistant/message' || type === 'assistant/attempt') {
        if (!Array.isArray(data.stream)) throw new TypeError(`event ${seq} (${type}) must embed a stream array`);
        if (!Number.isSafeInteger(data.turn) || !Number.isSafeInteger(data.step)) {
          throw new TypeError(`event ${seq} (${type}) needs integer turn and step`);
        }
      }
      if (event.ignorable !== undefined && event.ignorable !== true) throw new TypeError(`event ${seq} has an invalid ignorable marker`);
    });
    if (from !== undefined) options.onValidateEvents?.(all.slice(from));
  };

  const handleFor = (id) => ({
    id,
    get header() {
      return stored.get(id)?.header;
    },
    inheritedEventCount: 0,
    access: 'write',
    async append(events) {
      const entry = stored.get(id);
      if (entry === undefined) throw new Error(`session ${id} is not stored`);
      if (!Array.isArray(events)) throw new TypeError('append needs an array of events');
      const from = entry.events.length;
      const combined = [...entry.events, ...events];
      assertLog(combined, from);
      entry.events.push(...events);
      if (options.onDisk !== undefined) materializeOnDisk(id, entry.header, entry.events);
    },
    async flush() {
      flushed.push(id);
    },
    async close() {
      closed.push(id);
    },
  });

  return {
    identity: Symbol('fake-sessionPersistence'),
    /** Everything the double stored, for assertions. */
    sessions: stored,
    created,
    flushed,
    closed,
    async create(header) {
      assertHeader(header);
      const id = header.id ?? `session-fake-${idCounter++}`;
      if (stored.has(id)) {
        const error = new Error(`session ${id} already exists`);
        error.name = 'SessionAlreadyExistsError';
        throw error;
      }
      // Store the header as given, with the storage id winning last: the caller
      // addresses the session by `id`, and a real backend stamps that same id.
      stored.set(id, { header: { ...header, id }, events: [] });
      created.push(id);
      return handleFor(id);
    },
    async open(id, access) {
      if (!stored.has(id)) {
        const error = new Error(`session ${id} not found`);
        error.name = 'SessionPersistenceNotFoundError';
        throw error;
      }
      if (access === 'write') return handleFor(id);
      return {
        id,
        get header() {
          return stored.get(id).header;
        },
        inheritedEventCount: 0,
        access: 'read',
        async read() {
          return { eventState: 'shared-frozen', events: [...stored.get(id).events] };
        },
        async append() {
          throw new Error('read handle cannot append');
        },
        async flush() {},
        async close() {},
      };
    },
    async stat(id) {
      const entry = stored.get(id);
      return entry === undefined ? undefined : { header: entry.header, revision: `${entry.events.length}` };
    },
    async list() {
      return [...stored.values()].map((entry) => ({ header: entry.header, revision: `${entry.events.length}` }));
    },
    async flushAll() {
      for (const id of stored.keys()) flushed.push(id);
    },
    /**
     * Forget a session, standing in for the absence a real backend reports once
     * its artifact is removed from disk. Test-only: the seam has no delete.
     * @param {string} id - the identity to forget.
     */
    forget(id) {
      return stored.delete(id);
    },
  };
}
