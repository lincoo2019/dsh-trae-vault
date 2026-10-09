/**
 * Import a Trae share link as a DeepSeek Harness conversation.
 *
 * A Trae **share** (`https://share.traecontent.cn/share/<share-id>`) is a public,
 * read-only transcript of one Trae SOLO conversation, served as JSON by
 * `/api/remote/v1/share/<share-id>` (metadata) and
 * `/api/remote/v1/share/<share-id>/messages` (the turns). Its shape has nothing
 * in common with a Harness session, so this module is the seam between them:
 *
 *   share JSON  ->  contiguous DSH events  ->  SessionVault.adopt()
 *
 * Two deliberate choices:
 *
 *  - **Events are the source of truth.** The archive's `conversation.jsonl` is
 *    derived from the events with the vault's own `normalizeConversation`, not
 *    built in parallel, so the readable transcript and the importable log can
 *    never disagree.
 *  - **Tool results are not invented.** A share strips the payload of most tool
 *    results, so what the share does keep — a `finish` summary, a grep result, a
 *    file diff — is preserved and everything else is recorded as an explicit
 *    placeholder rather than as an empty success.
 *
 * @module @local/dsh-trae-session-vault/share
 */
import { createHash } from 'node:crypto';
import { normalizeConversation, resolvePreset } from './vault.trae2.js';

/** Where share links live, used both to recognise one and to cite it. */
export const SHARE_ORIGIN = 'https://share.traecontent.cn';

/** Default API root; every path below is appended to it. */
export const DEFAULT_SHARE_API_BASE = 'https://share.traecontent.cn';

/** Model identity recorded on every imported assistant message. */
const SHARE_SOURCE = { kind: 'model', provider: 'trae', model: 'trae-solo' };

/** The tool Trae calls to hand the user its final answer. */
const FINISH_TOOL = 'finish';

/** The API name for one share's metadata. */
const SESSION_API = '/api/remote/v1/share';

/**
 * Extract the share id from a share URL, a bare id, or a pasted path.
 *
 * Accepts every form a user is likely to paste: the full URL with a query
 * string, the URL without a scheme, `/share/<id>`, or just `<id>`.
 *
 * @param {unknown} input - the URL or id.
 * @returns {string | undefined} the bare share id, or undefined when nothing usable is present.
 */
export function extractShareId(input) {
  if (typeof input !== 'string') return undefined;
  const text = input.trim();
  if (text.length === 0) return undefined;
  let path = text;
  if (/^https?:\/\//i.test(text)) {
    try {
      path = new URL(text).pathname;
    } catch {
      return undefined;
    }
  }
  path = path.split(/[?#]/)[0];
  const match = /\/share\/([^/?#]+)/i.exec(path.startsWith('/') ? path : `/${path}`);
  const raw = match === null ? path.replace(/^\/+/, '') : match[1];
  const decoded = decodeURIComponent(raw).trim();
  if (decoded.length === 0 || decoded.includes('/')) return undefined;
  return decoded;
}

/**
 * Turn a share id into a session identity that is safe on every filesystem.
 *
 * Share ids are opaque and may contain dots — the observed one is
 * `H4TT51C..LW19X` — so the id is slugged rather than trusted. The result is
 * stable for a given share, which is what makes re-importing idempotent.
 *
 * @param {string} shareId - the bare share id.
 * @returns {string} a readable, stable archive id.
 */
export function shareSessionId(shareId) {
  const slug = String(shareId).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  // A share id made entirely of punctuation would slug to nothing; fall back to
  // a digest so the identity stays stable instead of collapsing to one bucket.
  const stable = slug.length > 0 ? slug : createHash('sha256').update(String(shareId)).digest('hex').slice(0, 12);
  return `trae-share-${stable}`;
}

/**
 * @param {object} share - `{ shareId, origin? }`.
 * @returns {string} the canonical link for a share, for citation.
 */
export function shareUrl(share) {
  return `${share?.origin ?? SHARE_ORIGIN}/share/${share?.shareId ?? ''}`;
}

/**
 * The UTC offset a share's timestamps are written in.
 *
 * Trae stamps a turn with the wall clock of whoever asked, so one share holds
 * `2026-09-07T19:33:03+08:00` and `2026-10-09T07:50:49+08:00` for two questions
 * asked in different places, and the machine this import runs on may be in a
 * third. Decoding each stamp at its own offset would interleave the turns, so
 * the offset most of them agree on wins and all messages are read at that
 * offset. The dominant one is the offset of one instant, and `Date.parse`
 * already accounts for it, so this only decides whose wall clock the log is
 * read against.
 *
 * @param {Array<object>} items - the share's message rows.
 * @returns {number | undefined} the offset in minutes, or undefined when nothing usable is present.
 */
function dominantOffsetMinutes(items) {
  const counts = new Map();
  const pattern = /(?:Z|([+-])(\d{2}):?(\d{2}))\s*$/;
  for (const item of items) {
    const raw = item?.created_at;
    if (typeof raw !== 'string') continue;
    const match = pattern.exec(raw.trim());
    if (match === null) continue;
    const minutes = match[1] === undefined
      ? 0
      : (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3]));
    counts.set(minutes, (counts.get(minutes) ?? 0) + 1);
  }
  let best;
  let bestCount = -1;
  for (const [minutes, count] of counts) {
    if (count > bestCount) {
      best = minutes;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Read one share timestamp at a chosen offset.
 *
 * The UTC instant a stamp records is not in question — its offset is. Reading
 * every stamp at the same offset is what keeps a share whose turns were asked
 * in different places in the order they happened.
 *
 * @param {unknown} value - the recorded timestamp.
 * @param {number} [offsetMinutes] - the offset to read it at; a `Z` stamp follows it too.
 * @returns {number | undefined} epoch milliseconds, or undefined when absent or invalid.
 */
export function parseShareTime(value, offsetMinutes) {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  let text = value.trim().replace(' ', 'T');
  // The offset a stamp carries is replaced, not merely added: the digits are the
  // wall clock, and the whole point is to read that clock at one offset.
  if (Number.isFinite(offsetMinutes)) {
    const sign = offsetMinutes < 0 ? '-' : '+';
    const magnitude = Math.abs(offsetMinutes);
    const suffix = `${sign}${String(Math.floor(magnitude / 60)).padStart(2, '0')}:${String(magnitude % 60).padStart(2, '0')}`;
    text = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text) ? text.replace(/(?:Z|[+-]\d{2}:?\d{2})$/i, suffix) : `${text}${suffix}`;
  } else if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)) {
    text = `${text}Z`;
  }
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * Parse a JSON-in-a-string field, tolerating both an object and a malformed body.
 * @param {unknown} text - the field.
 * @returns {unknown} the parsed value, or undefined.
 */
function parseJsonField(text) {
  if (typeof text !== 'string' || text.trim().length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Render one share content block as plain text.
 * @param {unknown} block - one entry of a user message's `content` array.
 * @returns {string} its text, or an empty string for a block with nothing to say.
 */
function contentBlockText(block) {
  if (block === null || typeof block !== 'object') return '';
  const record = /** @type {Record<string, unknown>} */ (block);
  if (typeof record.text_content === 'string') return record.text_content;
  if (typeof record.data === 'object' && record.data !== null) {
    const data = /** @type {Record<string, unknown>} */ (record.data);
    if (typeof data.content === 'string') return data.content;
    if (typeof data.url === 'string') return data.url;
  }
  if (typeof record.type === 'string' && record.type !== 'text') return `[${record.type}]`;
  return '';
}

/**
 * Render a user turn's content as the text a human typed.
 *
 * The `content` field is a JSON string holding an array of blocks
 * (`{ type: 'text', text_content }`, `{ type: 'web_page', data: { url } }`, …).
 * Older or partial shares only carry `query`, whose blocks nest their payload
 * under `data`, so it is the fallback rather than the primary source.
 *
 * @param {object} item - the share message row.
 * @returns {string} the question text.
 */
export function userMessageText(item) {
  for (const field of ['content', 'query']) {
    const blocks = parseJsonField(item?.[field]);
    if (!Array.isArray(blocks) || blocks.length === 0) continue;
    const parts = blocks.map(contentBlockText).filter((part) => part.length > 0);
    if (parts.length > 0) return parts.join('\n');
  }
  if (typeof item?.content === 'string' && item.content.length > 0 && parseJsonField(item.content) === undefined) {
    return item.content;
  }
  return '';
}

/**
 * The text recorded when a share kept no output for a tool call.
 *
 * Deliberately not an empty string: an empty tool result reads as "the tool ran
 * and returned nothing", which is a different claim from "the share dropped it".
 */
export const NO_SHARED_OUTPUT = "(Trae's share does not include this call's output)";

/**
 * Reduce a tool result to the text the transcript should carry.
 *
 * A share keeps only what Trae's UI displayed. The interesting payload lives
 * under `result.data`, but several tools return no `data` at all — the share
 * simply dropped it — so each case says what it is.
 *
 * @param {object} call - the `tool_call_info` entry.
 * @returns {{ text: string, omitted: boolean, isError: boolean }} the readable result and what it cost.
 */
export function toolResult(call) {
  const result = call?.result;
  const isError = result !== null && typeof result === 'object'
    && typeof result.status === 'string' && result.status !== 'success';
  if (result === null || typeof result !== 'object') {
    return { text: '(the share records no result for this call)', omitted: true, isError };
  }
  const status = typeof result.status === 'string' ? result.status : 'unknown';
  const data = result.data;
  if (data === null || data === undefined) {
    return {
      text: status === 'success'
        ? NO_SHARED_OUTPUT
        : `(the call ended with status "${status}" and no shared output)`,
      omitted: true,
      isError,
    };
  }
  const found = findResultText(data, status);
  return { text: found, omitted: false, isError };
}

/**
 * Pull the readable text out of a share tool result payload.
 * @param {unknown} data - the `result.data` payload.
 * @param {string} status - the recorded status, used when nothing else is present.
 * @returns {string} the text to record.
 */
function findResultText(data, status) {
  if (typeof data === 'string') return data;
  if (data === null || typeof data !== 'object') return `${status}: ${String(data)}`;
  const record = /** @type {Record<string, unknown>} */ (data);
  if (typeof record.summary === 'string') return record.summary;
  if (typeof record.content === 'string') return record.content;
  if (Array.isArray(record.results)) {
    const parts = record.results.map((entry) => {
      if (entry === null || typeof entry !== 'object') return String(entry);
      const item = /** @type {Record<string, unknown>} */ (entry);
      const name = typeof item.file_path === 'string' ? item.file_path : undefined;
      const body = typeof item.content === 'string' ? item.content : JSON.stringify(item);
      return name === undefined ? body : `${name}\n${body}`;
    });
    if (parts.length > 0) return parts.join('\n\n');
  }
  if (Array.isArray(record.changes)) {
    const parts = record.changes.map((entry) => {
      const item = /** @type {Record<string, any>} */ (entry);
      const path = item?.file_path ?? '(unknown file)';
      const action = item?.file_action ?? 'modified';
      const diff = item?.diff_info ?? {};
      return `${action} ${path} (+${diff.insert_line_count ?? 0}/-${diff.delete_line_count ?? 0})`;
    });
    if (parts.length > 0) return parts.join('\n');
  }
  const serialized = JSON.stringify(data);
  if (serialized === undefined) return `(the call returned a value that cannot be shown; status "${status}")`;
  return serialized.length > 20000 ? `${serialized.slice(0, 20000)}… (truncated)` : serialized;
}

/**
 * Reject a share API response that is not a share.
 * @param {unknown} body - the decoded response body.
 * @returns {string | undefined} the reason, or undefined when it looks usable.
 */
function shareResponseError(body) {
  if (body === null || typeof body !== 'object') return 'the share API did not return a JSON object';
  const record = /** @type {Record<string, unknown>} */ (body);
  if (record.code !== undefined && record.code !== 0) {
    const message = typeof record.message === 'string' && record.message.length > 0 ? record.message : 'no message';
    return `the share API refused the request (code ${String(record.code)}: ${message})`;
  }
  if (record.data === null || typeof record.data !== 'object') return 'the share API returned no data';
  return undefined;
}

/**
 * Fetch one share and everything it holds.
 *
 * The messages endpoint is followed to exhaustion: a long conversation comes
 * back in pages flagged by `has_more`, and a partial import that silently drops
 * its tail would be worse than a refusal, so a continuation that cannot be
 * followed is an error.
 *
 * @param {string} urlOrId - a share URL or share id.
 * @param {object} [options] - fetch options.
 * @param {string} [options.apiBase] - API origin; defaults to {@link DEFAULT_SHARE_API_BASE}.
 * @param {number} [options.timeoutMs] - per-request timeout.
 * @param {string} [options.headers] - extra request headers, for a deployment that needs them.
 * @param {typeof globalThis.fetch} [options.fetchImpl] - fetch implementation, for tests.
 * @returns {Promise<{ shareId: string, origin: string, url: string, title: string, sharedAt?: number, creatorName?: string, messages: object[], raw: object }>} the share.
 */
export async function fetchShare(urlOrId, options = {}) {
  const shareId = extractShareId(urlOrId);
  if (shareId === undefined) {
    throw new Error(`"${String(urlOrId)}" is not a Trae share URL or share id (expected something like https://share.traecontent.cn/share/<id>)`);
  }
  const apiBase = String(options.apiBase ?? DEFAULT_SHARE_API_BASE).replace(/\/+$/, '');
  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 30000;
  const extraHeaders = options.headers !== null && typeof options.headers === 'object' ? options.headers : {};
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('this runtime exposes no fetch, so a Trae share cannot be downloaded');
  }

  /**
   * GET one share API path.
   * @param {string} path - the API path.
   * @returns {Promise<unknown>} the decoded body.
   */
  const getJson = async (path) => {
    const controller = typeof AbortController === 'function' ? new AbortController() : undefined;
    const timer = controller === undefined ? undefined : setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(`${apiBase}${path}`, {
        method: 'GET',
        headers: { accept: 'application/json', ...extraHeaders },
        ...(controller === undefined ? {} : { signal: controller.signal }),
      });
    } catch (error) {
      const reason = error instanceof Error && error.name === 'AbortError'
        ? `timed out after ${timeoutMs}ms`
        : error instanceof Error ? error.message : String(error);
      throw new Error(`could not reach ${apiBase}${path}: ${reason}`);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    if (!response.ok) {
      throw new Error(`${apiBase}${path} answered HTTP ${response.status} ${response.statusText ?? ''}`.trim());
    }
    try {
      return await response.json();
    } catch {
      throw new Error(`${apiBase}${path} did not return JSON; the share is probably private or has been withdrawn`);
    }
  };

  const metaBody = await getJson(`${SESSION_API}/${encodeURIComponent(shareId)}`);
  const metaError = shareResponseError(metaBody);
  if (metaError !== undefined) throw new Error(`${shareId}: ${metaError}`);
  const meta = /** @type {Record<string, any>} */ (metaBody).data;

  const messages = [];
  let cursor;
  for (let page = 0; page < 100; page += 1) {
    const query = cursor === undefined ? '' : `?cursor=${encodeURIComponent(String(cursor))}`;
    const body = await getJson(`${SESSION_API}/${encodeURIComponent(shareId)}/messages${query}`);
    const error = shareResponseError(body);
    if (error !== undefined) throw new Error(`${shareId}: ${error}`);
    const data = /** @type {Record<string, any>} */ (body).data;
    const items = Array.isArray(data.items) ? data.items : [];
    messages.push(...items);
    if (data.has_more !== true) break;
    const next = data.next_cursor ?? data.cursor;
    if (next === undefined || String(next) === String(cursor)) {
      throw new Error(`${shareId}: the messages API reports more pages but offers no cursor to reach them`);
    }
    cursor = next;
    if (page === 99) throw new Error(`${shareId}: the messages API did not finish after 100 pages`);
  }

  // The share's own publication stamp, read at the messages' dominant offset so
  // it and the turns never disagree about how the clock reads. It is *not* the
  // conversation's creation: a share can be published long after the work it
  // records, so `convertShare` derives the conversation's own bounds from its
  // turns and keeps this under its own name.
  const sharedAt = parseShareTime(meta.created_at, dominantOffsetMinutes(messages));
  return {
    shareId,
    origin: apiBase,
    url: `${apiBase}/share/${shareId}`,
    title: typeof meta.title === 'string' && meta.title.length > 0 ? meta.title : undefined,
    ...(sharedAt === undefined ? {} : { sharedAt }),
    ...(typeof meta.creator_name === 'string' && meta.creator_name.length > 0 ? { creatorName: meta.creator_name } : {}),
    messages,
    raw: { ...meta, items: messages },
  };
}

/**
 * Derive a conversation title when the share records none.
 * @param {string} title - the share's own title.
 * @param {string} firstQuestion - the first human question.
 * @returns {string} a non-empty title.
 */
function conversationTitle(title, firstQuestion) {
  if (typeof title === 'string' && title.trim().length > 0) return title.trim();
  const line = firstQuestion.split('\n').map((part) => part.trim()).find((part) => part.length > 0);
  if (line === undefined) return 'Imported Trae share';
  return line.length > 120 ? `${line.slice(0, 117)}…` : line;
}

/**
 * Convert a fetched share into a DSH session header, events, and transcript.
 *
 * The event stream mirrors what a real Harness turn looks like: one turn per
 * human question, each assistant step opening with a `turn/start` + `step/start`
 * pair, the assistant message carrying `reasoning`/`text`/`tool-call` blocks,
 * then the matching `tool/call` and `tool/result`, and finally `step/end` and
 * `turn/end`. `firstStructuralViolation` is exactly this contract, so the result
 * of this function can be checked against it.
 *
 * The transcript is derived from the events with the vault's own normalizer, so
 * the two records an import writes cannot drift apart.
 *
 * @param {object} share - the value returned by {@link fetchShare}.
 * @param {object} options - conversion options.
 * @param {string} options.cwd - absolute project root the session belongs to.
 * @param {number} [options.now] - fallback timestamp, epoch milliseconds.
 * @param {number} [options.maxToolResultChars] - clamp per tool result.
 * @param {string} [options.agentPreset] - preset the imported session runs under.
 * @returns {{ header: object, events: object[], conversation: object, stats: object }} the conversion.
 */
export function convertShare(share, options) {
  if (share === null || typeof share !== 'object') throw new TypeError('convertShare needs a share object');
  const shareId = share.shareId;
  if (typeof shareId !== 'string' || shareId.length === 0) throw new TypeError('the share has no share id');
  const cwd = options?.cwd;
  if (typeof cwd !== 'string' || cwd.length === 0) throw new TypeError('convertShare needs the project root as `cwd`');
  const now = Number.isFinite(options?.now) ? options.now : Date.now();
  const maxToolResultChars = Number.isInteger(options?.maxToolResultChars) ? options.maxToolResultChars : 2000;

  const archiveId = shareSessionId(shareId);
  const items = Array.isArray(share.messages) ? share.messages : [];
  /** The offset every stamp is read at, so the turns keep their real order. */
  const offsetMinutes = dominantOffsetMinutes(items);
  const events = [];
  /** Internal messages, in the shape `buildEventsFromConversation` consumes. */
  const messages = [];

  /**
   * Append one DSH event with the next sequence number.
   * @param {string} type - the event type.
   * @param {number} time - epoch milliseconds.
   * @param {object} data - the event payload.
   * @param {object} [extra] - additional top-level event fields.
   */
  const emit = (type, time, data, extra) => {
    events.push({ seq: events.length, type, time, data, ...(extra ?? {}) });
  };

  // The conversation's own bounds come from its turns, never from the moment of
  // import and never from `sharedAt`: a share is a record of the past, and a
  // clock seeded with "now" clamps every earlier event onto one timestamp.
  const messageTimes = items
    .map((item) => parseShareTime(item?.created_at, offsetMinutes))
    .filter((time) => Number.isFinite(time));
  const startedAt = messageTimes.length > 0 ? Math.min(...messageTimes) : now;
  const endedAt = messageTimes.length > 0 ? Math.max(...messageTimes) : startedAt;
  let eventTime = startedAt;
  /**
   * Move the monotonic clock forward.
   *
   * Share turns carry second-resolution wall-clock times and plan items carry no
   * time of their own, so two events can land on the same millisecond and a
   * later one can never precede an earlier one. Events never move backwards;
   * they only ever advance.
   *
   * @param {number | undefined} candidate - the event's own timestamp, when known.
   * @returns {number} the timestamp to record.
   */
  const tick = (candidate) => {
    eventTime = Number.isFinite(candidate) && candidate > eventTime ? candidate : eventTime;
    return eventTime;
  };

  let turn = 0;
  let step = 0;
  let humanCount = 0;
  let toolCallCount = 0;
  let unanswered = 0;
  let omittedResults = 0;

  for (const item of items) {
    if (item === null || typeof item !== 'object') continue;

    if (item.role === 'user') {
      const text = userMessageText(item);
      if (text.length === 0) continue;
      turn += 1;
      step = 0;
      humanCount += 1;
      const at = tick(parseShareTime(item.created_at, offsetMinutes));
      messages.push({ role: 'user', text, turn, time: at });
      emit('turn/start', at, { turn });
      // Steps are numbered by ONE counter per turn and must be emitted in order:
      // `turn/start` resets the loader's `nextStep` to 1, and every `step/start`
      // must equal it exactly — "step/start does not match the open turn and next
      // step". Restarting the count at the assistant's first item, as this once
      // did, repeats step 1 and fails the whole log.
      step = 1;
      emit('step/start', at, { turn, step });
      // The seq of the human message, which is the only thing a title may cite.
      // It is read *after* the message is emitted, and reading it before — as
      // this once did — silently captured `turn/start` instead, because the
      // handle is the array's own length at the moment of the read. The loader
      // then rejected the whole log: "session/title messageSeqs must cite
      // distinct earlier human user/message events". `firstStructuralViolation`
      // now checks exactly that, so the mistake fails at publish time.
      const userSeq = events.length;
      emit('user/message', at, {
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
        role: 'user',
        id: `${archiveId}-u${turn}`,
      }, { surfaceOp: 'append' });
      emit('step/end', at, { turn, step });
      // The sidebar has nothing to show without a title, and the loader requires
      // `messageSeqs` to cite a distinct *earlier* human message.
      if (turn === 1) {
        emit('session/title', at, {
          title: conversationTitle(share.title, text),
          messageSeqs: [userSeq],
          source: { kind: 'fallback' },
        });
      }
      continue;
    }

    if (item.role !== 'assistant') continue;
    const body = parseJsonField(item.content);
    const planItems = Array.isArray(body?.messages) ? body.messages : [];
    if (planItems.length === 0) {
      // An assistant turn with no recorded work at all. It still belongs to the
      // open turn, so the log keeps a step rather than a dangling turn.
      if (turn === 0) {
        turn = 1;
        step = 1;
        emit('turn/start', tick(parseShareTime(item.created_at, offsetMinutes)), { turn });
      }
      unanswered += 1;
      step += 1;
      const at = tick(parseShareTime(item.created_at, offsetMinutes));
      emit('step/start', at, { turn, step });
      messages.push({ role: 'assistant', text: '(the share records no content for this reply)', turn, step, time: at });
      emit('assistant/message', at, {
        turn,
        step,
        message: {
          role: 'assistant',
          id: `${archiveId}-t${turn}s${step}`,
          source: { ...SHARE_SOURCE },
          content: [{ type: 'text', text: '(the share records no content for this reply)' }],
        },
        stream: [],
      }, { surfaceOp: 'append' });
      emit('step/end', at, { turn, step });
      continue;
    }

    if (turn === 0) {
      // Defensive: a share whose first row is an assistant message still needs a
      // turn before any step is legal.
      turn = 1;
      step = 1;
      emit('turn/start', tick(parseShareTime(item.created_at, offsetMinutes)), { turn });
    }

    for (const entry of planItems) {
      const planItem = entry?.plan_item;
      if (planItem === null || typeof planItem !== 'object') continue;
      step += 1;
      const call = planItem.tool_call_info ?? undefined;
      const timing = planItem.timing ?? {};
      const startedAt = Number.isFinite(timing.tool_call_started_at_ms)
        ? timing.tool_call_started_at_ms
        : Number.isFinite(timing.generated_at_ms) ? timing.generated_at_ms : undefined;
      const at = tick(startedAt ?? parseShareTime(item.created_at, offsetMinutes));
      emit('step/start', at, { turn, step });

      const reasoning = typeof planItem.reasoning_content === 'string' ? planItem.reasoning_content : '';
      const thought = typeof planItem.thought === 'string' ? planItem.thought : '';
      const finishSummary = call !== undefined && call.name === FINISH_TOOL && typeof call.params?.summary === 'string'
        ? call.params.summary
        : undefined;
      const text = finishSummary ?? (thought.trim().length > 0 ? thought : '');
      const callId = typeof call?.id === 'string' && call.id.length > 0 ? call.id : `${archiveId}-t${turn}s${step}-call`;
      // `finish` is how Trae's agent hands over its answer, so it is recorded as
      // the assistant's reply rather than as a tool the reader cannot follow.
      const advertise = call !== undefined && call.name !== FINISH_TOOL;
      const argumentsText = JSON.stringify(call?.params ?? {});

      const content = [];
      if (reasoning.trim().length > 0) content.push({ type: 'reasoning', text: reasoning });
      if (text.length > 0) content.push({ type: 'text', text });
      if (advertise) {
        content.push({ type: 'tool-call', id: callId, name: String(call.name), arguments: argumentsText });
      }

      const messageId = `${archiveId}-t${turn}s${step}`;
      messages.push({
        role: 'assistant',
        text,
        ...(reasoning.trim().length > 0 ? { reasoning } : {}),
        ...(advertise ? { toolCalls: [{ id: callId, name: String(call.name), arguments: argumentsText }] } : {}),
        turn,
        step,
        time: at,
      });
      emit('assistant/message', at, {
        turn,
        step,
        message: {
          role: 'assistant',
          id: messageId,
          source: { ...SHARE_SOURCE },
          content,
        },
        stream: [],
      }, { surfaceOp: 'append' });

      if (advertise) {
        toolCallCount += 1;
        // The call must restate the advertised name and arguments verbatim: the
        // loader treats the assistant block and the `tool/call` as one identity.
        emit('tool/call', at, {
          turn,
          step,
          callId,
          name: String(call.name),
          arguments: argumentsText,
        });
        const finishedAt = Number.isFinite(timing.tool_call_finished_at_ms)
          ? timing.tool_call_finished_at_ms
          : at;
        const resultAt = tick(finishedAt);
        const outcome = toolResult(call);
        if (outcome.omitted) omittedResults += 1;
        const raw = outcome.text;
        const truncated = raw.length > maxToolResultChars;
        const resultText = truncated
          ? `${raw.slice(0, maxToolResultChars)}\n… [${raw.length - maxToolResultChars} more characters elided]`
          : raw;
        messages.push({
          role: 'tool',
          name: String(call.name),
          callId,
          isError: outcome.isError,
          text: resultText,
          turn,
          step,
          time: resultAt,
        });
        const callSeq = events.length - 1;
        emit('tool/result', resultAt, {
          turn,
          step,
          message: {
            role: 'tool',
            id: `${messageId}-r`,
            source: { kind: 'tool', callId },
            toolCallId: callId,
            isError: outcome.isError,
            content: [{ type: 'text', text: resultText }],
          },
        }, { surfaceOp: 'append', sourceEventSeqs: [callSeq] });
      }

      emit('step/end', tick(at), { turn, step });
    }
    emit('turn/end', tick(eventTime), { turn, reason: { kind: 'completed' } });
  }

  const header = {
    version: 4,
    id: archiveId,
    // The conversation's own beginning, which is what the sidebar orders by.
    createdAt: startedAt,
    cwd,
    isSeeded: false,
    ...resolvePreset({ agentPreset: options?.agentPreset }, events),
  };

  // The transcript is produced by the very normalizer the vault uses on export,
  // so `conversation.jsonl` and `events.jsonl` describe one conversation.
  const conversation = normalizeConversation(header, events, { maxToolResultChars });
  conversation.session.sourceUrl = `${share.origin ?? SHARE_ORIGIN}/share/${shareId}`;
  conversation.session.startedAt = startedAt;
  conversation.session.endedAt = endedAt;
  // When the share was published — a different fact from when the conversation
  // happened, and one a reader of the transcript wants: a share can be
  // republished long after the work it records.
  const sharedAt = Number.isFinite(share.sharedAt) ? share.sharedAt : share.createdAt;
  if (Number.isFinite(sharedAt)) conversation.session.sharedAt = sharedAt;
  if (typeof share.creatorName === 'string') conversation.session.sharedBy = share.creatorName;
  // Recorded in the transcript's own header, so `renderMarkdown` shows where the
  // conversation came from. It is metadata about the archive, not a session
  // header field, and the header is fed to the persistence backend verbatim.
  conversation.sourceUrl = conversation.session.sourceUrl;

  /** What the caller should know about the conversion that is not an error. */
  const warnings = [];
  // A share is redacted: the payloads of most tool results are stripped, and what
  // remains is only what Trae's UI displayed. Saying so is the difference between
  // a faithful import and one that reads as a tool which returned nothing.
  if (omittedResults > 0) {
    warnings.push(`${omittedResults} tool result(s) had no shared output; each is marked in the transcript`);
  }
  if (unanswered > 0) {
    warnings.push(`${unanswered} assistant reply/replies carried no content in the share`);
  }
  if (humanCount === 0) {
    warnings.push('the share holds no user message, so the imported session has no question');
  }

  return {
    header,
    events,
    conversation,
    warnings,
    stats: {
      shareId,
      events: events.length,
      turns: turn,
      humanMessages: humanCount,
      toolCalls: toolCallCount,
      omittedToolResults: omittedResults,
      messages: conversation.messages.length,
      assistantMessagesWithoutSharedContent: unanswered,
    },
  };
}
