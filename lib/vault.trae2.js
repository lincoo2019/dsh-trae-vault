/**
 * Project-local conversation vault for DeepSeek Harness.
 *
 * Every Harness session is already durable on disk, but it lives under
 * `$DSH_HOME/sessions` as a multi-frame zstd JSONL keyed by a mangled project
 * path, which is impractical to read beside the code it describes. This module
 * copies each conversation into the project folder itself, as a normalized JSONL
 * plus a human-readable Markdown transcript, and can also read conversations
 * back out.
 *
 * Two independent sources feed it:
 *   - the live `ctx.sessions` instance, used for automatic export while a
 *     conversation runs;
 *   - the durable logs under `$DSH_HOME/sessions`, used to import older or
 *     not-currently-open conversations.
 *
 * @module @local/dsh-trae-session-vault/vault
 */
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { decodeZstdFrames, hasZstd } from './zstd.trae2.js';

/**
 * Version of the normalized archive layout written by this module, independent
 * of the DSH session format generation {@link SESSION_FORMAT_VERSION} declares.
 */
export const ARCHIVE_VERSION = 1;

/**
 * DSH session format generation for logs this module creates.
 *
 * Declared as a literal rather than imported from `dsh-session`: the Host
 * supplies that package at runtime, a linked bundle cannot resolve it, and a
 * bare import here would make the whole module unloadable.
 */
export const SESSION_FORMAT_VERSION = 4;

/**
 * Mint an identity for an imported session.
 *
 * The id is derived from the owning project and the archived session, so
 * re-importing the same conversation yields the same identity and cannot
 * accumulate duplicates — even if the archive's import ledger is lost. The
 * original log is never touched, because an imported session is always a new
 * file under a new id.
 *
 * @param {string} projectRoot - the owning project.
 * @param {string} sourceId - the archived session id.
 * @returns {string} a `session-<uuid>` identity.
 */
export function createSessionId(projectRoot, sourceId) {
  if (typeof sourceId !== 'string' || sourceId.length === 0) return `session-${randomUUID()}`;
  const hex = createHash('sha256').update(`${resolve(projectRoot)}\u0000${sourceId}`).digest('hex');
  return `session-${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
/** Session log format generations this reader understands, newest first. */
const SESSION_LOG_NAMES = ['session.v4.jsonl.zstd', 'session.v3.jsonl.zstd', 'session.v2.jsonl.zstd', 'session.jsonl.zstd', 'session.v4.jsonl', 'session.jsonl'];
/** Message roles retained in a transcript. */
const TRANSCRIPT_ROLES = new Set(['user', 'assistant', 'tool']);

/**
 * Mangle an absolute project path into the directory name Harness persistence
 * uses under its session root. This mirrors the persistence codec exactly so the
 * reader finds an existing project's logs.
 * @param {string} cwd - absolute project path.
 * @returns {string} the project directory name.
 */
export function projectSlug(cwd) {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path');
  let readable = '';
  let separatorRun = false;
  for (let index = 0; index < cwd.length; index++) {
    const code = cwd.charCodeAt(index);
    const char = String.fromCharCode(code);
    if (char === '/' || char === '\\' || char === ':') {
      if (!separatorRun) readable += '-';
      separatorRun = true;
    } else if (char !== '~' && /^[A-Za-z0-9._-]$/.test(char)) {
      readable += char;
      separatorRun = false;
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`;
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`;
}

/**
 * Whether a user message is real human input rather than an injected harness
 * snapshot. `source.kind === 'user'` marks authored input; runtime context and
 * approval notices are recorded with their own kinds.
 * @param {object} data - the `user/message` payload.
 * @returns {boolean} true when the human typed it.
 */
export function isHumanMessage(data) {
  const kind = data?.source?.kind;
  return kind === 'user' || kind === 'user-command' || kind === undefined;
}

/**
 * Concatenate the text of one content block list, keeping named parts.
 * @param {Array<object>} content - message content blocks.
 * @returns {string} joined plain text.
 */
function contentText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

/**
 * Normalize one session log — a header plus ordered events — into the archived
 * conversation shape. Pure and synchronous so it can be unit-tested directly.
 *
 * @param {object} header - `{ id, cwd, createdAt, agentPreset, ... }`.
 * @param {Array<object>} events - raw session events in sequence order.
 * @param {object} [options] - normalization options.
 * @param {boolean} [options.includeRuntimeContext] - keep injected runtime-context user messages.
 * @param {number} [options.maxToolResultChars] - clamp per tool result.
 * @returns {object} the normalized conversation.
 */
export function normalizeConversation(header, events, options = {}) {
  const includeRuntimeContext = options.includeRuntimeContext === true;
  const maxToolResultChars = Number.isInteger(options.maxToolResultChars) ? options.maxToolResultChars : 2000;
  const toolNames = new Map();
  const messages = [];
  let title;
  let turn = 0;
  let step = 0;
  let humanCount = 0;
  let firstTime;
  let lastTime;

  for (const event of events) {
    if (event === null || typeof event !== 'object') continue;
    const { type, data } = event;
    if (typeof event.time === 'number') {
      if (firstTime === undefined) firstTime = event.time;
      lastTime = event.time;
    }
    switch (type) {
      case 'session/title':
        if (typeof data?.title === 'string' && data.title.length > 0) title = data.title;
        break;
      case 'turn/start':
        if (typeof data?.turn === 'number') turn = data.turn;
        break;
      case 'step/start':
        if (typeof data?.turn === 'number') turn = data.turn;
        if (typeof data?.step === 'number') step = data.step;
        break;
      case 'user/message': {
        if (!includeRuntimeContext && !isHumanMessage(data)) continue;
        const text = contentText(data?.content);
        if (text.length === 0) continue;
        if (isHumanMessage(data)) humanCount += 1;
        messages.push({
          seq: event.seq,
          time: event.time,
          role: 'user',
          turn: typeof data?.turn === 'number' ? data.turn : turn,
          kind: data?.source?.kind ?? 'user',
          text,
        });
        break;
      }
      case 'assistant/message': {
        const content = data?.message?.content;
        const text = contentText(content);
        const calls = Array.isArray(content)
          ? content.filter((block) => block?.type === 'tool-call').map((block) => ({
            id: block.id,
            name: block.name,
            arguments: parseArguments(block.arguments),
          }))
          : [];
        // Record the names here as well: a tool call is announced inside the
        // assistant message, and only echo-confirmed by a separate `tool/call`.
        for (const call of calls) {
          if (typeof call.id === 'string' && typeof call.name === 'string') toolNames.set(call.id, call.name);
        }
        if (text.length === 0 && calls.length === 0) break;
        messages.push({
          seq: event.seq,
          time: event.time,
          role: 'assistant',
          turn: typeof data?.turn === 'number' ? data.turn : turn,
          step: typeof data?.step === 'number' ? data.step : step,
          text,
          ...(calls.length === 0 ? {} : { toolCalls: calls }),
          ...(data?.usage === undefined ? {} : { usage: data.usage }),
        });
        break;
      }
      case 'tool/call':
        if (typeof data?.callId === 'string' && typeof data?.name === 'string') toolNames.set(data.callId, data.name);
        break;
      case 'tool/result': {
        const message = data?.message;
        if (message === undefined) break;
        const raw = contentText(message.content);
        const truncated = raw.length > maxToolResultChars;
        // The call id is recorded both on the message and on the event payload,
        // depending on the log generation.
        const callId = message.toolCallId ?? data?.toolCallId;
        messages.push({
          seq: event.seq,
          time: event.time,
          role: 'tool',
          turn: typeof data?.turn === 'number' ? data.turn : turn,
          step: typeof data?.step === 'number' ? data.step : step,
          name: data?.name ?? toolNames.get(callId) ?? 'tool',
          callId,
          isError: message.isError === true,
          text: truncated ? `${raw.slice(0, maxToolResultChars)}\n— [${raw.length - maxToolResultChars} more characters elided]` : raw,
          ...(truncated ? { truncated: true } : {}),
        });
        break;
      }
      default:
        break;
    }
  }

  return {
    archiveVersion: ARCHIVE_VERSION,
    session: {
      id: header?.id,
      cwd: header?.cwd,
      title: title ?? '(untitled conversation)',
      createdAt: header?.createdAt,
      agentPreset: header?.agentPreset,
      ...(firstTime === undefined ? {} : { startedAt: firstTime }),
      ...(lastTime === undefined ? {} : { endedAt: lastTime }),
      messageCount: messages.length,
      humanMessageCount: humanCount,
      eventCount: events.length,
    },
    messages,
  };
}

/**
 * Parse a tool-call argument string into JSON when possible.
 * @param {unknown} raw - the recorded arguments.
 * @returns {unknown} parsed arguments, or the raw string.
 */
function parseArguments(raw) {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * Parse raw JSONL session-log text into a header and its events. A tolerant
 * reader: a partially written trailing line is dropped rather than failing the
 * whole conversation.
 * @param {string} text - decoded JSONL.
 * @returns {{ header: object, events: Array<object>, badLines: number }} parsed log.
 */
export function parseSessionLog(text) {
  let header = {};
  const events = [];
  let badLines = 0;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      badLines += 1;
      continue;
    }
    if (parsed?.type === 'session') {
      header = parsed;
      continue;
    }
    if (typeof parsed?.type === 'string' && typeof parsed?.seq === 'number') events.push(parsed);
  }
  return { header, events, badLines };
}

/** Render one conversation as Markdown. */
export function renderMarkdown(conversation) {
  const info = conversation.session;
  const lines = [];
  lines.push(`# ${info.title}`);
  lines.push('');
  lines.push(`- Session: \`${info.id}\``);
  if (info.cwd !== undefined) lines.push(`- Project: \`${info.cwd}\``);
  // Provenance for a conversation that was imported rather than recorded here.
  if (typeof info.sourceUrl === 'string' && info.sourceUrl.length > 0) {
    lines.push(`- Imported from: ${info.sourceUrl}${typeof info.sharedBy === 'string' && info.sharedBy.length > 0 ? ` (shared by ${info.sharedBy})` : ''}`);
  }
  if (info.createdAt !== undefined) lines.push(`- Created: ${formatTime(info.createdAt)}`);
  if (info.sharedAt !== undefined) lines.push(`- Shared: ${formatTime(info.sharedAt)}`);
  if (info.startedAt !== undefined) lines.push(`- First event: ${formatTime(info.startedAt)}`);
  if (info.endedAt !== undefined) lines.push(`- Last event: ${formatTime(info.endedAt)}`);
  lines.push(`- Messages: ${info.messageCount} (${info.humanMessageCount} from you)`);
  lines.push('');
  lines.push('---');
  lines.push('');
  for (const message of conversation.messages) {
    if (message.role === 'user') {
      lines.push(`## You${message.turn === undefined ? '' : ` · turn ${message.turn}`}`);
      lines.push('');
      lines.push(message.text);
      lines.push('');
    } else if (message.role === 'assistant') {
      lines.push(`## Assistant${message.turn === undefined ? '' : ` · turn ${message.turn}`}`);
      lines.push('');
      if (message.text.length > 0) {
        lines.push(message.text);
        lines.push('');
      }
      for (const call of message.toolCalls ?? []) {
        lines.push(`**Tool call** \`${call.name}\``);
        lines.push('');
        lines.push('```json');
        lines.push(stringify(call.arguments));
        lines.push('```');
        lines.push('');
      }
    } else {
      lines.push(`### Tool result · \`${message.name}\`${message.isError ? ' (error)' : ''}`);
      lines.push('');
      lines.push('```text');
      lines.push(message.text.length === 0 ? '(empty)' : message.text);
      lines.push('```');
      lines.push('');
    }
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/**
 * @param {unknown} value - any JSON value.
 * @returns {string} pretty JSON, falling back to a string form.
 */
function stringify(value) {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * @param {number | undefined} time - epoch milliseconds.
 * @returns {string} an ISO timestamp, or an empty string.
 */
export function formatTime(time) {
  if (typeof time !== 'number' || !Number.isFinite(time)) return '';
  return new Date(time).toISOString();
}

/**
 * Read one durable session log from the Harness session root, transparently
 * handling both the multi-frame zstd generations and plain JSONL.
 * @param {string} sessionDir - the session's directory.
 * @returns {Promise<{ header: object, events: Array<object>, file: string, frames?: object } | { error: string }>} the log or a failure reason.
 */
export async function readDurableSession(sessionDir) {
  let dir;
  try {
    dir = await stat(sessionDir);
  } catch {
    return { error: `no stored log directory at ${sessionDir}` };
  }
  if (!dir.isDirectory()) return { error: `${sessionDir} is not a directory` };
  let entries;
  try {
    entries = await readdir(sessionDir);
  } catch (error) {
    return { error: `cannot list ${sessionDir}: ${error instanceof Error ? error.message : String(error)}` };
  }
  const available = new Set(entries);
  const file = SESSION_LOG_NAMES.find((candidate) => available.has(candidate));
  if (file === undefined) {
    return { error: `no recognized session log in ${sessionDir} (found: ${entries.join(', ') || 'nothing'})` };
  }
  const full = join(sessionDir, file);
  let buffer;
  try {
    buffer = await readFile(full);
  } catch (error) {
    return { error: `cannot read ${full}: ${error instanceof Error ? error.message : String(error)}` };
  }

  let text;
  let frames;
  if (file.endsWith('.zstd')) {
    if (!hasZstd()) return { error: 'this Harness runtime has no zstd codec, so compressed session logs cannot be read' };
    const decoded = decodeZstdFrames(buffer);
    if (decoded.text.length === 0 && decoded.error !== undefined) return { error: decoded.error };
    text = decoded.text;
    frames = { frames: decoded.frames, failedFrames: decoded.failedFrames, skippedBytes: decoded.skippedBytes };
  } else {
    text = buffer.toString('utf8');
  }

  const parsed = parseSessionLog(text);
  if (parsed.header.id === undefined && parsed.events.length === 0) {
    return { error: `${full} contained no readable session events` };
  }
  return { ...parsed, file: full, ...(frames === undefined ? {} : { frames }) };
}

/**
 * Check that an event list is a structurally loadable stored log.
 *
 * Publishing writes into DSH's own session store, and a log the loader rejects
 * surfaces to the user as "stored log is corrupt" only when they try to open it.
 * Checking the same invariants here — contiguous sequence numbers, and every
 * message inside an open turn and step — turns that into a publish-time failure
 * instead of a broken conversation in the sidebar.
 *
 * @param {readonly object[]} events - the events to write.
 * @returns {string | undefined} the first violation, or undefined when sound.
 */
export function firstStructuralViolation(events, sessionId) {
  let turn = null;
  let step = null;
  // The loader's own step cursor: `turn/start` resets it to 1, and every
  // `step/start` must equal it exactly. A converter that numbers steps per phase
  // instead of per turn emits 1, 1, 2 … and the loader rejects the whole log with
  // "step/start does not match the open turn and next step" — which is precisely
  // how a converted share became unopenable while every other check passed.
  let nextStep = null;
  // Advertised tool calls, and which of them the log has marked as started.
  // A result for a call that never started is rejected by the loader unless it
  // carries an exact TOOL_NOT_STARTED repair payload, which a reconstruction
  // never has — so this is the difference between a loadable log and
  // "not-started error requires an object".
  const advertised = new Map();
  const started = new Set();
  for (const [index, event] of events.entries()) {
    if (event === null || typeof event !== 'object') return `event ${index} is not an object`;
    if (event.seq !== index) return `event ${index} carries seq ${JSON.stringify(event.seq)}`;
    if (typeof event.type !== 'string' || event.type.length === 0) return `event ${index} has no type`;
    if (typeof event.time !== 'number') return `event ${index} has a non-numeric time`;
    const data = event.data;
    if (data === null || typeof data !== 'object') return `event ${index} has no data object`;
    if (event.type === 'turn/start') {
      if (!Number.isSafeInteger(data.turn)) return `event ${index} turn/start needs an integer turn`;
      turn = data.turn;
      step = null;
      nextStep = 1;
      continue;
    }
    if (event.type === 'turn/end') {
      if (data.turn !== turn) return `event ${index} turn/end does not match the open turn`;
      turn = null;
      step = null;
      nextStep = null;
      continue;
    }
    if (event.type === 'step/start') {
      if (data.turn !== turn) return `event ${index} step/start is outside its turn`;
      if (step !== null) return `event ${index} step/start opens a step while step ${step} is open`;
      if (!Number.isSafeInteger(data.step) || data.step !== nextStep) {
        return `event ${index} step/start says step ${JSON.stringify(data.step)} where the loader expects ${nextStep}`;
      }
      step = data.step;
      nextStep = data.step + 1;
      continue;
    }
    if (event.type === 'step/end') {
      if (data.turn !== turn || data.step !== step) return `event ${index} step/end does not match the open step`;
      step = null;
      continue;
    }
    // Tool lifecycle is checked before the surface gate: `tool/call` is a
    // log-only event, so it would otherwise be skipped by the `continue` below.
    // A delivery marker must name the session holding it; the loader refuses a
    // foreign one outright, so catch it here when the caller knows the id.
    if (event.type === 'session-log-deepseek/delivery-accepted' && typeof sessionId === 'string') {
      const named = data.sessionId;
      if (data.sessionFormatVersion === 4 && typeof named === 'string' && named !== sessionId) {
        return `event ${index} (delivery-accepted) names session ${named} instead of ${sessionId}`;
      }
    }
    // A title may cite only distinct, earlier, human `user/message` events — the
    // loader's own rule, and the one a converter is most likely to get subtly
    // wrong: reading a sequence handle one statement too early captures
    // `turn/start` and fails the ENTIRE log with "session/title messageSeqs must
    // cite distinct earlier human user/message events", which is exactly how an
    // imported conversation became unopenable while looking perfectly sound.
    // This check runs here so the mistake costs a publish-time error the caller
    // can read, not a broken session in the sidebar.
    if (event.type === 'session/title' || event.type === 'session/title-llm-request') {
      const references = data.messageSeqs;
      if (!Array.isArray(references)) return `event ${index} (${event.type}) has no messageSeqs array`;
      const namedSource = data.source === null || typeof data.source !== 'object' ? undefined : data.source.kind;
      if (event.type === 'session/title' && (references.length === 0) !== (namedSource === 'user')) {
        return `event ${index} (session/title) messageSeqs must be empty exactly for a user title`;
      }
      const cited = new Set();
      for (const reference of references) {
        if (!Number.isSafeInteger(reference) || reference >= index) {
          return `event ${index} (${event.type}) cites seq ${JSON.stringify(reference)}, which is not an earlier event`;
        }
        if (cited.has(reference)) return `event ${index} (${event.type}) cites seq ${reference} twice`;
        cited.add(reference);
        const target = events[reference];
        if (target?.type !== 'user/message') {
          return `event ${index} (${event.type}) cites seq ${reference}, which is a ${target?.type ?? 'missing event'} rather than a human message`;
        }
        if (target.data?.source?.kind !== 'user') {
          return `event ${index} (${event.type}) cites seq ${reference}, whose source kind is ${JSON.stringify(target.data?.source?.kind)} rather than "user"`;
        }
      }
    }
    if (event.type === 'assistant/message') {
      for (const block of data.message?.content ?? []) {
        if (block?.type === 'tool-call') advertised.set(block.id, { name: block.name, arguments: block.arguments });
      }
    }
    if (event.type === 'tool/call') {
      const callId = data.callId;
      const known = advertised.get(callId);
      if (known === undefined) return `event ${index} (tool/call) ${callId} was never advertised by an assistant message`;
      if (known.name !== data.name || known.arguments !== data.arguments) {
        return `event ${index} (tool/call) ${callId} does not match its advertised call`;
      }
      started.add(callId);
      continue;
    }
    if (event.type === 'tool/result') {
      const callId = data.message?.toolCallId ?? data.toolCallId;
      if (!advertised.has(callId)) return `event ${index} (tool/result) ${callId} has no advertised tool call`;
      if (!started.has(callId)) {
        return `event ${index} (tool/result) ${callId} reports a call that never started, which the loader only accepts as an exact TOOL_NOT_STARTED repair`;
      }
      started.delete(callId);
    }
    const surface = event.type === 'user/message' || event.type === 'assistant/message'
      || event.type === 'tool/result' || event.type === 'system/message' || event.type === 'developer/message';
    if (!surface) continue;
    if (turn === null || step === null) return `event ${index} (${event.type}) is outside an open turn and step`;
    // A real `user/message` and `system/message` carry no position; the others must agree.
    if (event.type !== 'user/message' && event.type !== 'system/message'
      && (data.turn !== turn || data.step !== step)) {
      return `event ${index} (${event.type}) says turn=${data.turn} step=${data.step} while turn=${turn} step=${step} is open`;
    }
    if ((event.type === 'assistant/message' || event.type === 'assistant/attempt') && !Array.isArray(data.stream)) {
      return `event ${index} (${event.type}) is missing its provider stream array`;
    }
  }
  return undefined;
}

/**
 * Resolve the agent preset a published conversation runs under.
 *
 * Continuing a conversation needs its `agentPreset` projection, which the
 * registry seeds from the stored header's `agentPreset`. A verbatim archive may
 * omit that field while still carrying an `agent-preset/selected` event, and a
 * rebuilt log always emits one, so the event is read as a fallback. Keeping the
 * two in step matters: a header claiming one preset while the log selects another
 * is a contradiction the backend can act on.
 *
 * @param {object} header - the archive's recorded header.
 * @param {readonly object[]} events - the events about to be written.
 * @returns {{ agentPreset: string }} the field to merge into the stored header.
 */
export function resolvePreset(header, events) {
  if (typeof header?.agentPreset === 'string' && header.agentPreset.length > 0) {
    return { agentPreset: header.agentPreset };
  }
  const selected = [...events].reverse().find((event) => event?.type === 'agent-preset/selected');
  const named = selected?.data?.agentPreset;
  if (typeof named === 'string' && named.length > 0) return { agentPreset: named };
  return { agentPreset: 'standard' };
}

/**
 * Whether an error means "that session id is already taken".
 *
 * The store signals this by name (`SessionAlreadyExistsError`), by code, or by a
 * plain message depending on the backend, so all three are accepted: a missed
 * collision would surface as a failure the user cannot act on.
 *
 * @param {unknown} error - the caught error.
 * @returns {boolean} true when the id is taken.
 */
export function isAlreadyExists(error) {
  if (error === null || typeof error !== 'object') return false;
  const named = error.name === 'SessionAlreadyExistsError' || error.code === 'SESSION_ALREADY_EXISTS';
  if (named) return true;
  return /already exists/i.test(typeof error.message === 'string' ? error.message : '');
}

/**
 * Repoint a copied log's delivery markers at the session that now holds them.
 *
 * `session-log-deepseek/delivery-accepted` records which session the DeepSeek
 * log backend acknowledged, and the loader requires that marker to name its own
 * session:
 *
 * ```js
 * if (deliveryId !== artifact.header.id) throw new SessionFormatError(
 *   'current-generation delivery marker names the wrong Session');
 * ```
 *
 * A verbatim archive published under a new id still carries the *source*
 * session's markers, so it loads everywhere except here. Rewriting the id is the
 * honest repair: the marker's meaning — this session's events up to `throughSeq`
 * were delivered — is unchanged; only the identity it records is corrected.
 *
 * @param {readonly object[]} events - the archived events.
 * @param {string} sessionId - the id the events are being published under.
 * @returns {object[]} a copy with delivery markers repointed, or the input when
 *   nothing needed changing.
 */
export function repointDeliveryMarkers(events, sessionId) {  let changed = false;
  const repointed = events.map((event) => {
    if (event?.type !== 'session-log-deepseek/delivery-accepted') return event;
    const data = event.data;
    if (data === null || typeof data !== 'object' || data.sessionId === sessionId) return event;
    changed = true;
    return { ...event, data: { ...data, sessionId } };
  });
  return changed ? repointed : events;
}

/** The project-local conversation archive. */
export class SessionVault {
  /**
   * @param {object} options - vault wiring.
   * @param {object} options.ctx - plugin context, for logging.
   * @param {object} options.config - resolved vault configuration.
   * @param {string} options.projectRoot - absolute project root that receives the archive.
   * @param {string} options.sessionsRoot - absolute Harness session root (`$DSH_HOME/sessions`).
   * @param {(sessionId: string, projectRoot: string) => Promise<boolean>} [options.attachSession]
   *   grants a published session membership of the workspace owning `projectRoot`.
   *   Supplied by the plugin, because the workspace registry is declared there.
   * @param {(sessionId: string, projectRoot: string) => Promise<boolean>} [options.workspaceMember]
   *   reports whether a session already belongs to that workspace. Also supplied
   *   by the plugin, for the same reason.
   * @param {(sessionId: string, events: object[], meta: object) => Promise<void>} [options.publishSession]
   *   creates the session through the session store so it is announced to live
   *   clients. Supplied by the plugin, which owns the `sessions` service.
   */
  constructor({ ctx, config, projectRoot, sessionsRoot, attachSession, workspaceMember, publishSession }) {
    this.ctx = ctx;
    this.config = config;
    this.attachSession = attachSession;
    this.workspaceMember = workspaceMember;
    this.publishSession = publishSession;
    this.projectRoot = resolve(projectRoot);
    this.sessionsRoot = resolve(sessionsRoot);
    const directory = typeof config.directory === 'string' && config.directory.length > 0
      ? config.directory
      : '.dsh/conversations';
    this.root = isAbsolute(directory) ? resolve(directory) : resolve(this.projectRoot, directory);
    this.pending = new Map();
    /**
     * Tail of the serialized chain that writes `index.json`.
     *
     * `updateIndex` and `recordImport` are both read-modify-write cycles over
     * one file, and a publish pass runs them while a scan started by its own
     * registry change runs the same cycles. Interleaved, the second write is
     * built from the state the first one read, so the first one's row is gone —
     * and a ledger row that never lands is exactly what lets the next pass
     * publish the same conversation again under a `-2` id.
     * @type {Promise<unknown>}
     */
    this.indexChain = Promise.resolve();
  }

  /**
   * Run one index mutation after every earlier one has finished.
   *
   * The read must happen inside the chain too: reading before taking the lock
   * would reintroduce the lost update this exists to prevent.
   *
   * @param {() => Promise<unknown>} work - the read-modify-write to perform.
   * @returns {Promise<unknown>} the work's result.
   */
  queueIndexWrite(work) {
    const next = this.indexChain.catch(() => {}).then(work);
    this.indexChain = next.catch(() => {});
    return next;
  }

  /** @returns {string} the absolute archive directory inside the project. */
  get directory() {
    return this.root;
  }

  /**
   * Archive directory for one session.
   * @param {string} sessionId - the session id.
   * @returns {string} absolute path.
   */
  sessionDir(sessionId) {
    return join(this.root, sanitizeSegment(sessionId));
  }

  /** @returns {string} absolute path of the archive index. */
  get indexPath() {
    return join(this.root, 'index.json');
  }

  /**
   * Absolute path of a session's verbatim event record.
   * @param {string} sessionId - the session id.
   * @returns {string} path to `events.jsonl`.
   */
  eventsPath(sessionId) {
    return join(this.sessionDir(sessionId), 'events.jsonl');
  }

  /**
   * Normalize, write, and index one conversation.
   *
   * Two records are written: `conversation.jsonl`, the normalized transcript a
   * human reads, and `events.jsonl`, the verbatim session events. The second
   * exists because the normalized form is lossy — it drops the assistant
   * provider stream that `assistant/message` and `assistant/attempt` are
   * validated against (`assertAssistantSettlementShape`), so a session rebuilt
   * from the transcript alone could not be loaded. Keeping the original events
   * lets an archived conversation be re-materialized as a real DSH session
   * byte-for-byte rather than synthesized.
   *
   * @param {object} options - export inputs.
   * @param {object} options.header - session header (`id`, `cwd`, `createdAt`, ...).
   * @param {Array<object>} options.events - raw session events.
   * @param {boolean} [options.writeMarkdown] - also write `conversation.md`.
   * @param {boolean} [options.updateIndex] - refresh `index.json`.
   * @param {object} [options.conversation] - a transcript already derived from `events`.
   * @param {boolean} [options.verbatim] - declare that `events` came from a real DSH
   *   session or from an importer that mirrors the format exactly, so the result
   *   may be re-materialized without the repair a reconstruction needs.
   * @returns {Promise<{ conversation: object, files: string[], index?: object }>} export summary.
   */
  async write({ header, events, writeMarkdown = true, updateIndex = true, conversation, verbatim = false }) {
    const sessionId = header?.id;
    if (typeof sessionId !== 'string' || sessionId.length === 0) throw new Error('cannot archive a conversation without a session id');
    // A caller that already ran this normalizer over these very events passes the
    // result in: re-deriving it would produce the same object, and keeping one
    // derivation is what guarantees `conversation.jsonl` and `events.jsonl`
    // describe the same conversation.
    const normalized = conversation ?? normalizeConversation(header, events, {
      includeRuntimeContext: this.config.includeRuntimeContext,
      maxToolResultChars: this.config.maxToolResultChars,
    });
    const stamped = verbatim && normalized.verbatim !== true ? { ...normalized, verbatim: true } : normalized;
    const dir = this.sessionDir(sessionId);
    await mkdir(dir, { recursive: true });
    const files = [];
    const jsonlPath = join(dir, 'conversation.jsonl');
    await writeFile(jsonlPath, toJsonl(stamped), 'utf8');
    files.push(jsonlPath);
    const eventsFile = this.eventsPath(sessionId);
    await writeFile(eventsFile, toEventsJsonl(header, events), 'utf8');
    files.push(eventsFile);
    if (writeMarkdown) {
      const markdownPath = join(dir, 'conversation.md');
      await writeFile(markdownPath, renderMarkdown(stamped), 'utf8');
      files.push(markdownPath);
    }
    if (updateIndex) {
      const index = await this.updateIndex(stamped);
      return { conversation: stamped, files, index };
    }
    return { conversation: stamped, files };
  }

  /**
   * Adopt an already-converted conversation into this archive.
   *
   * A Trae share is not a Harness session, so it reaches the archive through a
   * converter that produces both halves itself: the verbatim events and the
   * transcript derived from them. `write` cannot be used for that, because it
   * derives the transcript from the events and a share's events are not a log
   * this module read from anywhere — and the transcript is where the share's
   * provenance is recorded. This is the one seam that takes both.
   *
   * The conversion is declared `verbatim`: `materialize` only runs its structural
   * walk over a *reconstruction*, and a converted share mirrors the format
   * exactly, so the check is not needed — but the flag also tells the next reader
   * that the log is sound rather than guessed at, which is what lets it be
   * re-imported without the repair pass.
   *
   * @param {object} options - the conversion to store.
   * @param {object} options.header - the session header (`id`, `cwd`, `createdAt`, ...).
   * @param {Array<object>} options.events - contiguous DSH events starting at seq 0.
   * @param {object} options.conversation - the transcript derived from those events.
   * @param {boolean} [options.writeMarkdown] - also write `conversation.md`.
   * @returns {Promise<{ conversation: object, files: string[], index?: object, directory: string }>} the write summary.
   */
  async adopt({ header, events, conversation, writeMarkdown = true }) {
    const result = await this.write({
      header,
      events,
      conversation,
      verbatim: true,
      writeMarkdown,
      updateIndex: true,
    });
    return { ...result, directory: this.sessionDir(header.id) };
  }

  /**
   * Merge one conversation's summary into the archive index.
   * @param {object} conversation - a normalized conversation.
   * @returns {Promise<object>} the written index.
   */
  async updateIndex(conversation) {
    // Serialized against every other index write; see `queueIndexWrite`.
    return this.queueIndexWrite(async () => {
      const index = await this.readIndex();
      const entry = {
        id: conversation.session.id,
        title: conversation.session.title,
        createdAt: conversation.session.createdAt,
        startedAt: conversation.session.startedAt,
        endedAt: conversation.session.endedAt,
        messageCount: conversation.session.messageCount,
        humanMessageCount: conversation.session.humanMessageCount,
        directory: sanitizeSegment(conversation.session.id),
        updatedAt: Date.now(),
      };
      const others = index.conversations.filter((candidate) => candidate.id !== entry.id);
      others.push(entry);
      others.sort((left, right) => (right.endedAt ?? right.updatedAt ?? 0) - (left.endedAt ?? left.updatedAt ?? 0));
      const next = {
        version: ARCHIVE_VERSION,
        project: this.projectRoot,
        updatedAt: Date.now(),
        conversations: others,
        // Preserve the import ledger: a routine re-export must not forget which
        // conversations were already materialized as DSH sessions.
        imports: index.imports,
      };
      await mkdir(this.root, { recursive: true });
      await writeFile(this.indexPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
      return next;
    });
  }

  /**
   * Read the archive index, tolerating a missing or unreadable file.
   * @returns {Promise<{ version: number, project: string, updatedAt: number, conversations: Array<object> }>} the index.
   */
  async readIndex() {
    try {
      const parsed = JSON.parse(await readFile(this.indexPath, 'utf8'));
      if (Array.isArray(parsed?.conversations)) {
        return {
          version: typeof parsed.version === 'number' ? parsed.version : ARCHIVE_VERSION,
          project: typeof parsed.project === 'string' ? parsed.project : this.projectRoot,
          updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
          conversations: parsed.conversations.filter((entry) => entry !== null && typeof entry?.id === 'string'),
          // `sourceId` (the archived conversation) to its materialized DSH session.
          imports: parsed.imports !== null && typeof parsed.imports === 'object' && !Array.isArray(parsed.imports)
            ? { ...parsed.imports }
            : {},
        };
      }
    } catch {
      // A missing or corrupt index is rebuilt from the session directories.
    }
    return {
      version: ARCHIVE_VERSION,
      project: this.projectRoot,
      updatedAt: 0,
      conversations: await this.discoverConversations(),
      imports: {},
    };
  }

  /**
   * List the conversations an archive directory holds, without an index.
   *
   * `readIndex` used to return an empty list whenever `index.json` was absent,
   * so an archive dropped into a project folder — the ordinary way a second
   * workspace receives conversations — was invisible: the plugin reported
   * nothing to publish. The directory contents are the authority, and either
   * record is enough to reconstruct a conversation.
   *
   * @returns {Promise<Array<object>>} index-style entries, newest first.
   */
  async discoverConversations() {
    let entries;
    try {
      entries = await readdir(this.root, { withFileTypes: true });
    } catch {
      return [];
    }
    const skipped = [];
    const discovered = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        if (entry.name !== 'index.json') skipped.push(`${entry.name} (not a session directory)`);
        continue;
      }
      const directory = join(this.root, entry.name);
      let names;
      try {
        names = await readdir(directory);
      } catch {
        skipped.push(`${entry.name} (unreadable)`);
        continue;
      }
      const verbatim = names.includes('events.jsonl');
      if (!verbatim && !names.includes('conversation.jsonl')) {
        skipped.push(`${entry.name} (holds ${names.join(', ') || 'nothing'})`);
        continue;
      }
      const record = await this.describeConversation(directory, entry.name, verbatim);
      if (record !== undefined) discovered.push(record);
      else skipped.push(`${entry.name} (unparseable)`);
    }
    // Discovery is silent by nature, which once made "an archive is present but
    // nothing was published" indistinguishable from "there is no archive".
    if (skipped.length > 0) {
      this.ctx.logger.info?.(`session vault: ${this.root} has no index; discovered ${discovered.length} conversation(s), skipped ${skipped.join('; ')}`);
    }
    discovered.sort((left, right) => (right.endedAt ?? right.updatedAt ?? 0) - (left.endedAt ?? left.updatedAt ?? 0));
    return discovered;
  }

  /**
   * Build one index entry from an archive directory.
   *
   * A verbatim `events.jsonl` carries the header and the real timestamps, so it
   * is preferred; a legacy `conversation.jsonl` supplies the rest.
   *
   * @param {string} directory - the conversation directory.
   * @param {string} name - the directory name, used as the id when the records disagree.
   * @param {boolean} verbatim - whether the directory holds `events.jsonl`.
   * @returns {Promise<object | undefined>} the entry, or undefined when unreadable.
   */
  async describeConversation(directory, name, verbatim) {
    let header;
    let messages = [];
    if (verbatim) {
      try {
        const parsed = parseSessionLog(await readFile(join(directory, 'events.jsonl'), 'utf8'));
        header = parsed.header;
        messages = parsed.events.filter((event) => event.type === 'user/message' || event.type === 'assistant/message');
      } catch {
        return undefined;
      }
    } else {
      try {
        const parsed = await this.read(name, 'json');
        if ('error' in parsed) return undefined;
        header = parsed.conversation.session;
        messages = parsed.conversation.messages;
      } catch {
        return undefined;
      }
    }
    const id = typeof header?.id === 'string' && header.id.length > 0 ? header.id : name;
    const endedAt = typeof header?.endedAt === 'number' ? header.endedAt : undefined;
    return {
      id,
      title: typeof header?.title === 'string' ? header.title : '(untitled conversation)',
      createdAt: typeof header?.createdAt === 'number' ? header.createdAt : 0,
      startedAt: typeof header?.startedAt === 'number' ? header.startedAt : header?.createdAt,
      endedAt,
      messageCount: typeof header?.messageCount === 'number' ? header.messageCount : messages.length,
      humanMessageCount: typeof header?.humanMessageCount === 'number'
        ? header.humanMessageCount
        : messages.filter((message) => message.role === 'user' || message.type === 'user/message').length,
      directory: name,
      updatedAt: endedAt ?? (typeof header?.startedAt === 'number' ? header.startedAt : 0),
    };
  }

  /**
   * Read an archived conversation and return it in the requested form.
   * @param {string} sessionId - session id or archive directory name.
   * @param {'json' | 'jsonl' | 'markdown'} [format] - output form.
   * @returns {Promise<{ conversation: object, format: string, text: string, directory: string } | { error: string }>} the read result.
   */
  async read(sessionId, format = 'json') {
    const directory = await this.resolveArchiveDir(sessionId);
    if (directory === undefined) return { error: `no archived conversation matching "${sessionId}"` };
    let conversation;
    let raw;
    try {
      raw = await readFile(join(directory, 'conversation.jsonl'), 'utf8');
    } catch (error) {
      return { error: `cannot read the archived conversation in ${directory}: ${error instanceof Error ? error.message : String(error)}` };
    }
    try {
      conversation = parseConversationFile(raw);
    } catch (error) {
      return { error: `the archived conversation in ${directory} is unreadable: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (format === 'markdown') return { conversation, format, text: renderMarkdown(conversation), directory };
    if (format === 'jsonl') return { conversation, format, text: toJsonl(conversation), directory };
    return { conversation, format: 'json', text: `${JSON.stringify(conversation, null, 2)}\n`, directory };
  }

  /**
   * Regenerate `conversation.md` for every archived conversation that is missing
   * it, so a transcript written before Markdown existed can be upgraded.
   * @returns {Promise<number>} how many transcripts were rewritten.
   */
  async rebuildMarkdown() {
    const index = await this.readIndex();
    let written = 0;
    for (const entry of index.conversations) {
      const directory = join(this.root, entry.directory);
      const read = await this.read(entry.id, 'json');
      if ('error' in read) {
        this.ctx.logger.warn(`session vault: cannot rebuild ${entry.id}: ${read.error}`);
        continue;
      }
      await writeFile(join(directory, 'conversation.md'), renderMarkdown(read.conversation), 'utf8');
      written += 1;
    }
    return written;
  }

  /**
   * Resolve a user-supplied id to an archive directory.
   * @param {string} sessionId - full id, directory name, or unique suffix.
   * @returns {Promise<string | undefined>} the absolute directory.
   */
  async resolveArchiveDir(sessionId) {
    const direct = this.sessionDir(sessionId);
    if (await isDirectory(direct)) return direct;
    const index = await this.readIndex();
    const match = index.conversations.find((entry) => entry.id === sessionId
      || entry.directory === sessionId
      || entry.id?.endsWith(sessionId));
    if (match !== undefined) {
      const resolved = join(this.root, match.directory);
      if (await isDirectory(resolved)) return resolved;
    }
    let entries;
    try {
      entries = await readdir(this.root, { withFileTypes: true });
    } catch {
      return undefined;
    }
    const candidate = entries.find((entry) => entry.isDirectory() && entry.name.includes(sessionId));
    return candidate === undefined ? undefined : join(this.root, candidate.name);
  }

  /**
   * Materialize archived conversations as real DSH sessions.
   *
   * Each imported conversation becomes a new stored session with a fresh id and
   * the archive's own `cwd`, written through `ctx.sessionPersistence` so the
   * backend owns the encoding (checksummed zstd frames), the header frame, and
   * the durability barrier. `workspaceRegistry` then associates it with the
   * workspace whose canonical path is that `cwd`, which is what makes it appear
   * in the sidebar and open as a resumable conversation.
   *
   * The events are the archive's verbatim originals, not a reconstruction: the
   * loader validates an `assistant/message` against fields the normalized
   * transcript does not keep, so synthesizing them would produce a session that
   * fails to open.
   *
   * @param {object} [options] - import selection.
   * @param {string[]} [options.ids] - archive session ids to import; omit for every archived conversation.
   * @param {boolean} [options.force] - re-import conversations that were already imported.
   * @returns {Promise<{ imported: Array<object>, skipped: Array<object>, failed: Array<object> }>} the outcome per conversation.
   */
  async workspaceSessionIds() {
    const registry = this.ctx.workspaceRegistry;
    if (registry === undefined || typeof registry.list !== 'function') return new Set();
    try {
      const wanted = this.projectRoot.toLowerCase();
      const workspace = registry.list().find((candidate) => String(candidate?.path ?? '').toLowerCase() === wanted);
      if (workspace === undefined) return new Set();
      return new Set([...workspace.sessionIds].map((id) => String(id)));
    } catch {
      return new Set();
    }
  }

  /**
   * Whether a session id is one this archive published.
   *
   * `recordImport` journals every publication in `.dsh/conversations/index.json`,
   * so the archive itself knows which sessions it produced. That journal is the
   * reliable marker for "this is a copy of an archived conversation", and it is
   * what lets the import side stay permissive: a genuine conversation that merely
   * shares an id with some stored session is never suppressed.
   *
   * @param {string} sessionId - the candidate.
   * @returns {Promise<boolean>} true when this vault published it.
   */
  async isPublishedImport(sessionId) {
    try {
      const index = await this.readIndex();
      for (const record of Object.values(index.imports ?? {})) {
        if (record !== null && typeof record === 'object' && record.sessionId === sessionId) return true;
      }
    } catch {
      // An unreadable journal leaves the session archivable, which is the safe side.
    }
    return false;
  }

  /**
   * Publish the archive of every archived conversation.
   *
   * @param {object} [options] - import selection.
   * @param {string[]} [options.ids] - archive session ids to import; omit for every archived conversation.
   * @param {boolean} [options.force] - re-import conversations that were already imported.
   * @returns {Promise<{ imported: Array<object>, skipped: Array<object>, failed: Array<object> }>} the outcome per conversation.
   */
  async importToDsh({ ids, force = false } = {}) {
    const persistence = this.ctx.get?.('sessionPersistence');
    if (persistence === undefined) {
      return {
        imported: [],
        skipped: [],
        failed: [{ sessionId: undefined, error: 'no sessionPersistence service in this profile, so sessions cannot be materialized' }],
      };
    }
    const wanted = Array.isArray(ids) && ids.length > 0 ? new Set(ids) : undefined;
    const index = await this.readIndex();
    // The ledger records `{ sessionId }` for each archived conversation, keyed by
    // the recorded object rather than by the archive id. Mapping `entry.sourceId`
    // here yielded `undefined` for every row, so the ledger never matched and the
    // membership check below could not run.
    const already = new Map(Object.entries(index.imports ?? {}));
    const imported = [];
    const skipped = [];
    const failed = [];

    // The conversations this workspace has already published.
    //
    // Deliberately NOT "any session stored for this project": a workspace may
    // legitimately hold several conversations, and suppressing one because some
    // stored session shares its id threw away genuine conversations — the whole
    // point of a workspace that carries an archive. The comparison is between the
    // recorded *published session* and the workspace's members, because the
    // conversation's own id is never a member: publication gives it a derived id.
    //
    // The duplicate chain is additionally cut where it starts, by refusing to
    // auto-export a published session (see `exportLive`), so a fresh copy never
    // enters the archive to be re-published.
    const members = await this.workspaceSessionIds();
    const alreadyPublished = new Set();
    for (const [sourceId, record] of Object.entries(index.imports ?? {})) {
      const publishedId = record !== null && typeof record === 'object' ? record.sessionId : undefined;
      if (publishedId !== undefined && members.has(String(publishedId))) alreadyPublished.add(sourceId);
    }

    for (const entry of index.conversations) {
      if (wanted !== undefined && !wanted.has(entry.id) && ![...wanted].some((id) => entry.id.endsWith(id))) continue;
      // `force` must be allowed past this gate, or it cannot do the one thing it
      // is asked for. A conversation that is already a workspace member returns
      // early below with on-disk state that is correct and *unannounced*: the
      // published session was, for instance, written while this plugin was still
      // inactive, so no `session/created` ever reached a client and the
      // conversation stays invisible in the sidebar while the store holds a
      // perfectly good log. Superseding is what re-announces it — the corrected
      // copy is materialized through the session store, which is the surface
      // clients watch.
      if (alreadyPublished.has(entry.id) && force !== true) {
        skipped.push({
          sessionId: entry.id,
          reason: 'this conversation is already published in this workspace',
          importedAs: index.imports[entry.id]?.sessionId,
        });
        continue;
      }
      await this.publishArchivedEntry(persistence, entry, {
        already,
        alreadyPublished,
        force,
        imported,
        skipped,
        failed,
      });
    }
    return { imported, skipped, failed };
  }

  /**
   * Publish one archived conversation, and record what happened.
   *
   * Split out of {@link SessionVault#importToDsh} so one conversation's publish EM1
   * several `await` points, including the registry change that membership fires EM1
   * reads as a unit rather than as a loop body.
   *
   * @param {object} persistence - the `ctx.sessionPersistence` service.
   * @param {object} entry - the archive index entry.
   * @param {object} context - the running pass's accumulators and lookups.
   * @returns {Promise<void>} resolves when this conversation is settled.
   */
  async publishArchivedEntry(persistence, entry, context) {
    const { already, alreadyPublished, force, imported, skipped, failed } = context;
    const previous = already.get(entry.id);
    // The ledger alone is not proof that this conversation is already in THIS
    // workspace. An archive folder can be copied into another project carrying
    // its ledger, and then the recorded session lives in the original
    // workspace — publishing must still happen here, or the new workspace shows
    // nothing. Membership is the reliable signal, and it also decides which id
    // to publish under, so it is resolved once.
    const settled = previous !== undefined && !force ? await this.isWorkspaceMember(previous.sessionId) : false;
    if (settled) {
      skipped.push({ sessionId: entry.id, reason: `already imported as ${previous.sessionId}`, importedAs: previous.sessionId });
      return;
    }
    const directory = join(this.root, entry.directory);
    const archived = await readArchivedEvents(directory);
    if ('error' in archived) {
      failed.push({ sessionId: entry.id, error: archived.error });
      return;
    }
    // Occupied by this workspace: keep the derived id so the existing session is
    // reused. Occupied by another workspace: publish the copy under a free id,
    // leaving the other workspace's session untouched.
    //
    // The choice is made from artifact *existence* only. A readability probe
    // used to decide it, and that was wrong twice over: reading a large log
    // fails often enough to matter (a 7220-event session read back as
    // unreadable), and every false negative minted another copy — one
    // workspace accumulated four. Existence is what the store enforces, so a
    // collision is reported by the store itself rather than predicted here.
    const derived = createSessionId(this.projectRoot, entry.id);
    const collides = await this.storedSessionExists(persistence, derived);
    // A recorded id that no longer exists is a stale row: its artifact was
    // removed, or lost with a restored `.dsh` folder. A row naming a missing
    // session is worse than no row — the next pass reads it as "published
    // somewhere else" — so it is pointed back at the derived id before any id is
    // chosen. This does not by itself stop a copy being published when the derived
    // artifact is also unreadable: that state is indistinguishable from an archive
    // copied in from another project, and the copied-archive reading has to win,
    // as the comment above explains.
    const recorded = typeof previous?.sessionId === 'string' ? previous.sessionId : undefined;
    if (recorded !== undefined && !await this.storedSessionExists(persistence, recorded)) {
      await this.recordImport(entry.id, derived);
    }
    const sessionId = collides && settled === false
      ? await this.pickSessionId(entry.id)
      : derived;
    if (await this.storedSessionExists(persistence, sessionId)) {
      if (force === true) {
        // `force` means "give me a correct copy". Persistence has no
        // content-delete and refuses to re-create an id whose artifact exists,
        // so the existing session is superseded rather than rewritten; see
        // `replaceStoredSession`.
        try {
          const replaced = await this.replaceStoredSession(persistence, archived, sessionId, entry.id);
          // The ledger is written BEFORE membership is granted. Granting it
          // fires the registry change a scan reacts to, and that scan must
          // already see this conversation as published — see `publishArchivedEntry`.
          await this.recordImport(entry.id, replaced.sessionId);
          await this.attachToWorkspace(replaced.sessionId);
          await this.dropRepairCopies(sessionId);
          imported.push({
            sessionId: entry.id,
            importedAs: replaced.sessionId,
            events: replaced.events,
            title: entry.title,
            replaced: sessionId,
            ...(archived.reconstructed === true ? { reconstructed: true } : {}),
          });
        } catch (error) {
          failed.push({ sessionId: entry.id, error: `could not supersede the stored session ${sessionId}: ${error instanceof Error ? error.message : String(error)}` });
        }
        return;
      }
      // A session that exists but was never attached (published by an older
      // version) still needs membership, or it stays under "Ungrouped".
      await this.recordImport(entry.id, sessionId);
      await this.attachToWorkspace(sessionId);
      skipped.push({
        sessionId: entry.id,
        reason: `already present as ${sessionId}`,
        importedAs: sessionId,
      });
      return;
    }
    try {
      const result = await this.materialize(persistence, archived, sessionId, { entry });
      // The ledger first, membership second — and the order is the fix, not a
      // style choice. `attachToWorkspace` is what fires the registry change the
      // activation scan listens for. Writing the ledger afterwards left a
      // window in which the archive was on disk, the session was in the store,
      // and *nothing* recorded the pair as published: the scan therefore saw a
      // fresh conversation and materialized a second copy under the next free
      // id. A live trace shows the two writes 87 ms apart.
      //
      // The reversed order is self-correcting if it is interrupted. A ledger
      // row whose session never got attached is re-published from the row
      // itself, because `isWorkspaceMember` reports false and the stored
      // session is reused rather than recreated.
      await this.attachToWorkspace(result.sessionId);
      await this.recordImport(entry.id, result.sessionId);
      imported.push({
        sessionId: entry.id,
        importedAs: result.sessionId,
        events: result.events,
        title: entry.title,
        // An archive with no verbatim record is rebuilt from its transcript,
        // which is valid but not byte-faithful.
        ...(archived.reconstructed === true ? { reconstructed: true } : {}),
        // Where the conversation was originally recorded, when that differs
        // from the workspace it now appears in.
        ...(result.origin === undefined ? {} : { origin: result.origin }),
      });
    } catch (error) {
      // A collision on the announced id is the store's own verdict, and it is
      // authoritative in a way a pre-flight probe is not: the client publishes
      // `session/created` only when `create` succeeded, so a failure here means
      // the id really is taken. Retry under the next free id instead of
      // reporting a failure the user cannot act on.
      if (isAlreadyExists(error)) {
        try {
          const nextId = await this.pickSessionId(entry.id, { skipDerived: true });
          const retried = await this.materialize(persistence, archived, nextId, { entry });
          await this.recordImport(entry.id, retried.sessionId);
          await this.attachToWorkspace(retried.sessionId);
          imported.push({
            sessionId: entry.id,
            importedAs: retried.sessionId,
            events: retried.events,
            title: entry.title,
            ...(archived.reconstructed === true ? { reconstructed: true } : {}),
            ...(retried.origin === undefined ? {} : { origin: retried.origin }),
          });
        } catch (retryError) {
          failed.push({ sessionId: entry.id, error: retryError instanceof Error ? retryError.message : String(retryError) });
        }
        return;
      }
      failed.push({ sessionId: entry.id, error: error instanceof Error ? error.message : String(error) });
    }
  }

  /**
   * Replace a corrupt stored session's log with a correct one under the same id.
   *
   * Persistence exposes no content delete: a handle can only append, and its
   * write-open only discards a *torn tail*. A log whose events are structurally
   * wrong therefore cannot be repaired through the API, and leaving it in place
   * means the conversation stays unopenable while occupying the id a correct
   * copy would need.
   *
   * The replacement is staged so it cannot leave the session half-written: a
   * correct log is first materialized under a temporary id in the same project
   * directory, and only then moved over the target. If anything fails before the
   * move, the original artifact is untouched. `force` is the caller's explicit
   * consent to discard the corrupt contents; they are already unreadable.
   *
   * @param {object} persistence - the `ctx.sessionPersistence` service.
   * @param {{ header: object, events: Array<object> }} archived - the correct events.
   * @param {string} sessionId - the id to keep.
   * @returns {Promise<{ events: number }>} what was written.
   */
  async replaceStoredSession(persistence, archived, sessionId, sourceId) {
    // The corrected log is published under a fresh id rather than over the
    // corrupt one. Two measured constraints rule out an in-place replacement
    // through this seam: a handle can only append (there is no content delete,
    // and a write-open discards only a torn *tail*), and `create` refuses any id
    // whose artifact still exists — so the corrupt session's id cannot be
    // re-created while its log is on disk, and rewriting that file by hand would
    // mean reproducing the backend's framed encoding, which this module never
    // guesses.
    //
    // The unusable session is therefore left for the user to archive in the
    // sidebar, with a correct, workspace-attached copy published beside it under
    // an ordinary numbered id — the same scheme a copied archive uses, so a
    // workshop does not accumulate `-repair`/`-corrected` variants of one name.
    const replacementId = await this.pickSessionId(sourceId ?? sessionId, { skipDerived: true });
    const written = await this.materialize(persistence, archived, replacementId);
    await this.attachToWorkspace(replacementId);
    await this.recordImport(sourceId ?? sessionId, replacementId);
    return { sessionId: replacementId, events: written.events };
  }

  /**
   * Remove the `-repair` copies an earlier version of this plugin created.
   *
   * They were published beside a corrupt session to work around the missing
   * delete; once the id itself is correct they are duplicate rows.
   *
   * @param {string} sessionId - the id that now holds the correct log.
   * @returns {Promise<string[]>} the directory names removed.
   */
  async dropRepairCopies(sessionId) {
    const slug = projectSlug(this.projectRoot);
    const projectDir = join(this.sessionsRoot, slug);
    let entries;
    try {
      entries = await readdir(projectDir);
    } catch {
      return [];
    }
    const removed = [];
    for (const name of entries) {
      if (!name.startsWith(`${sessionId}-repair`)) continue;
      try {
        await rm(join(projectDir, name), { recursive: true, force: true });
        removed.push(name);
      } catch (error) {
        this.ctx.logger.warn(`session vault: could not remove the superseded repair copy ${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return removed;
  }

  /**
   * Give a published session to the workspace that owns this project folder.
   *
   * Writing a session into persistence does NOT make it a workspace member:
   * `WorkspaceView.sessionIds` supplies real-workspace membership, so a session
   * that only exists on disk shows up under "Ungrouped". Membership is granted
   * by the workspace entity itself, so this attaches the new identity to the
   * workspace whose path is this vault's project root.
   *
   * Best-effort: a missing or unreadable registry must not fail a publication.
   *
   * @param {string} sessionId - the published session identity.
   * @returns {Promise<boolean>} true when the workspace accepted it.
   */
  async attachToWorkspace(sessionId) {
    if (typeof this.attachSession === 'function') {
      try {
        return await this.attachSession(sessionId, this.projectRoot);
      } catch (error) {
        this.ctx.logger.warn(`session vault: could not attach ${sessionId} to ${this.projectRoot}: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      }
    }
    // Fallback for a context that declares the registry itself.
    const registry = this.ctx.workspaceRegistry;
    if (registry === undefined || typeof registry.list !== 'function') return false;
    const wanted = this.projectRoot.toLowerCase();
    let workspace;
    try {
      workspace = registry.list().find((candidate) => String(candidate?.path ?? '').toLowerCase() === wanted);
    } catch (error) {
      this.ctx.logger.warn(`session vault: could not read the workspace registry: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
    if (workspace === undefined || typeof workspace.attachSession !== 'function') return false;
    try {
      await workspace.attachSession(sessionId);
      return true;
    } catch (error) {
      this.ctx.logger.warn(`session vault: could not attach ${sessionId} to ${this.projectRoot}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  /**
   * Choose an id to publish an archived conversation under.
   *
   * Used when the derived id is occupied but the conversation is not a member of
   * this workspace — what happens once an archive folder is copied into a second
   * project, since the derived id then names the copy published in the first one.
   *
   * A derived id that reads back is kept even though it is occupied: it is a
   * healthy session, and reusing it is what keeps a repeated publish idempotent.
   * Only an id held by a log that cannot be read is stepped over, which is how a
   * corrupt session is left behind instead of resurfacing.
   *
   * @param {string} sourceId - the archived conversation id.
   * @param {object} [options] - selection overrides.
   * @param {boolean} [options.skipDerived] - start at the first numbered id, for a
   *   caller that has already judged the derived id unusable and wants a clean
   *   name rather than a `-corrected` variant of it.
   * @returns {Promise<string>} an id that is free or readable.
   */
  async pickSessionId(sourceId, { skipDerived = false } = {}) {
    const persistence = this.ctx.get?.('sessionPersistence');
    const derived = createSessionId(this.projectRoot, sourceId);
    if (persistence === undefined) return derived;
    for (let attempt = skipDerived ? 1 : 0; attempt < 40; attempt += 1) {
      const candidate = attempt === 0 ? derived : `${derived}-${attempt + 1}`;
      if (!await this.storedSessionExists(persistence, candidate)) return candidate;
      if (await this.storedSessionReadable(persistence, candidate)) return candidate;
    }
    return `${derived}-${Date.now()}`;
  }

  /**
   * Whether a session is a member of this vault's workspace.
   *
   * A recorded import is not evidence that the conversation belongs here: the
   * archive's ledger travels with the folder. Membership is what the sidebar
   * groups by, so it is the thing to check.
   *
   * @param {string} sessionId - the session a previous publish recorded.
   * @returns {Promise<boolean>} true when this workspace lists it.
   */
  async isWorkspaceMember(sessionId) {
    if (typeof this.workspaceMember === 'function') {
      try {
        return await this.workspaceMember(sessionId, this.projectRoot);
      } catch (error) {
        this.ctx.logger.warn(`session vault: could not check workspace membership of ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const registry = this.ctx.workspaceRegistry;
    if (registry === undefined || typeof registry.list !== 'function') {
      // Without the registry the recorded import is the only evidence available,
      // and republishing would create a duplicate on every activation.
      return true;
    }
    const wanted = this.projectRoot.toLowerCase();
    try {
      const workspace = registry.list().find((candidate) => String(candidate?.path ?? '').toLowerCase() === wanted);
      if (workspace === undefined) return false;
      return [...workspace.sessionIds].some((id) => String(id) === sessionId);
    } catch {
      return true;
    }
  }

  /**
   * Whether a stored session already exists.
   * @param {object} persistence - the `ctx.sessionPersistence` service.
   * @param {string} sessionId - the identity to probe.
   * @returns {Promise<boolean>} true when a stored session or a live session owns it.
   */
  async storedSessionExists(persistence, sessionId) {
    const live = this.ctx.get?.('sessions');
    if (live?.get?.(sessionId) !== undefined) return true;
    try {
      return (await persistence.stat(sessionId)) !== undefined;
    } catch {
      return false;
    }
  }

  /**
   * Write one archived conversation into the persistence backend.
   *
   * The header is rebuilt field by field rather than copied: a stored header
   * carries a format `version` that belongs to the generation that wrote it, and
   * `isSeeded` must be false for a session whose events are entirely its own.
   *
   * `cwd` becomes this vault's project root, not the archive's recorded `cwd`.
   * A project folder is expected to own the conversations under its own `.dsh`,
   * so dropping a conversation file there must surface it in *that* workspace's
   * sidebar. Trusting the archive's `cwd` would instead file it under whatever
   * project the file happened to be recorded in, and a conversation copied in
   * from another machine would appear in no workspace at all.
   *
   * @param {object} persistence - the `ctx.sessionPersistence` service.
   * @param {{ header: object, events: Array<object> }} archived - verbatim events and their original header.
   * @param {string} sessionId - the identity to store under, which the backend also
   *   derives the artifact path from.
   * @param {object} [options] - optional overrides.
   * @param {string} [options.logicalId] - the identity written into the header when it
   *   must differ from the storage id, as the replacement path requires: the backend
   *   would reject re-creating an id it still reports, so the corrected log is built
   *   under a staging id and then moved onto the real one.
   * @returns {Promise<{ sessionId: string, events: number, origin?: string }>} the new session identity.
   */
  async materialize(persistence, archived, sessionId, { logicalId } = {}) {
    const original = archived.header ?? {};
    // Validate only a log this module rebuilt. A verbatim log is the bytes DSH
    // itself wrote, and it may legitimately not satisfy a simple sequential walk:
    // `compaction/prune` rewrites tool results at their historical turn/step
    // coordinates, which a state machine that only moves forward reads as a
    // violation. Second-guessing the source store would refuse valid sessions.
    if (archived.reconstructed === true) {
      const violation = firstStructuralViolation(archived.events, sessionId);
      if (violation !== undefined) {
        throw new Error(`refusing to publish an invalid session log: ${violation}`);
      }
    }
    const recordedCwd = typeof original.cwd === 'string' && original.cwd.length > 0 ? original.cwd : undefined;
    // The preset the conversation runs under, resolved once so the stored header,
    // the `agent-preset/selected` event, and the store metadata all agree. A
    // verbatim archive may omit it from its header while still carrying the event,
    // and a rebuilt log always carries one; the store's own default is `standard`.
    const preset = resolvePreset(original, archived.events);
    const header = {
      version: SESSION_FORMAT_VERSION,
      // The header id must equal the id a reader requests, so it carries the
      // logical identity even when the artifact is staged under another one.
      id: logicalId ?? sessionId,
      createdAt: typeof original.createdAt === 'number' ? original.createdAt : Date.now(),
      cwd: this.projectRoot,
      isSeeded: false,
      ...preset,
    };
    // A copied log carries the source session's delivery markers, and the loader
    // rejects a marker that does not name the session holding it.
    const events = repointDeliveryMarkers(archived.events, sessionId);
    const outcome = {
      sessionId: header.id,
      events: events.length,
      // Reported so a conversation recorded elsewhere stays traceable to where it came from.
      ...(recordedCwd !== undefined && resolve(recordedCwd).toLowerCase() !== this.projectRoot.toLowerCase()
        ? { origin: recordedCwd }
        : {}),
    };
    // Prefer the session store. A log written straight to persistence exists on
    // disk but announces nothing, so a running client never learns of it and the
    // conversation stays invisible in the sidebar until a full reload — which is
    // exactly how a freshly published workspace looked empty. Creating a real
    // Session publishes it to the same surfaces the UI already watches, and the
    // store's own flush persists the identical header and events.
    if (typeof this.publishSession === 'function') {
      await this.publishSession(sessionId, events, {
        version: header.version,
        id: sessionId,
        createdAt: header.createdAt,
        cwd: header.cwd,
        isSeeded: header.isSeeded,
        ...(header.agentPreset === undefined ? {} : { agentPreset: header.agentPreset }),
      });
      return outcome;
    }
    const handle = await persistence.create({ ...header, id: sessionId });
    try {
      await handle.append(events);
      await handle.flush();
      return outcome;
    } finally {
      await handle.close();
    }
  }

  /**
   * Whether a stored session can be read back.
   *
   * `stat` reads only the header frame, so it reports a session as present even
   * when its event log is structurally invalid. This probes the body as well.
   *
   * Callers must treat a `false` here as "unknown", NOT as "corrupt": a read can
   * also fail for reasons that say nothing about the log's validity (a session
   * still held live by the query layer, a transient I/O fault). Concluding
   * "corrupt" from it once caused valid sessions to be republished on every
   * activation, each time colliding with its own earlier repair copy.
   *
   * @param {object} persistence - the `ctx.sessionPersistence` service.
   * @param {string} sessionId - the stored session to verify.
   * @returns {Promise<boolean>} true when the body reads back.
   */
  async storedSessionReadable(persistence, sessionId) {
    try {
      const handle = await persistence.open(sessionId, 'read');
      try {
        await handle.read();
        return true;
      } finally {
        await handle.close();
      }
    } catch (error) {
      this.ctx.logger.warn(`session vault: could not read stored session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  /**
   * Remember that one archived conversation was materialized as a DSH session,
   * so an automatic re-sync does not duplicate it.
   * @param {string} sourceId - the archived session id.
   * @param {string} sessionId - the new DSH session id.
   * @returns {Promise<void>} resolves once the index is durable.
   */
  async recordImport(sourceId, sessionId) {
    // Serialized against every other index write. A ledger row that loses this
    // race is indistinguishable from a conversation that was never published —
    // and the next pass then publishes it again, under a `-2` id.
    return this.queueIndexWrite(async () => {
      const index = await this.readIndex();
      index.imports[sourceId] = { sessionId, at: Date.now() };
      index.updatedAt = Date.now();
      await mkdir(this.root, { recursive: true });
      await writeFile(this.indexPath, `${JSON.stringify({
        version: index.version,
        project: index.project,
        updatedAt: index.updatedAt,
        conversations: index.conversations,
        imports: index.imports,
      }, null, 2)}\n`, 'utf8');
    });
  }

  /**
   * List durable logs for this project that are not yet archived.
   * @returns {Promise<Array<{ id: string, directory: string, file?: string, error?: string, archived: boolean }>>} discovered logs.
   */
  async listDurableSessions() {
    if (!this.config.readGlobalSessions) return [];
    const projectDir = join(this.sessionsRoot, projectSlug(this.projectRoot));
    let entries;
    try {
      entries = await readdir(projectDir, { withFileTypes: true });
    } catch {
      return [];
    }
    const index = await this.readIndex();
    const archived = new Set(index.conversations.map((entry) => entry.id));
    const results = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      results.push({
        id: entry.name,
        directory: join(projectDir, entry.name),
        archived: archived.has(entry.name),
      });
    }
    // Also surface logs whose stored `cwd` is this project but that were filed
    // under a different slug, which happens after the project is moved.
    for (const foreign of await this.listForeignSessions(archived)) results.push(foreign);
    results.sort((left, right) => left.id.localeCompare(right.id));
    return results;
  }

  /**
   * Find stored sessions from other slugs that recorded this project as `cwd`.
   * @param {Set<string>} archived - ids already present in the archive.
   * @returns {Promise<Array<object>>} matching logs.
   */
  async listForeignSessions(archived) {
    const results = [];
    let slugs;
    try {
      slugs = await readdir(this.sessionsRoot, { withFileTypes: true });
    } catch {
      return results;
    }
    const ownSlug = projectSlug(this.projectRoot);
    const wanted = resolve(this.projectRoot).toLowerCase();
    for (const slug of slugs) {
      if (!slug.isDirectory() || slug.name === ownSlug) continue;
      let sessions;
      try {
        sessions = await readdir(join(this.sessionsRoot, slug.name), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const session of sessions) {
        if (!session.isDirectory() || archived.has(session.name)) continue;
        const directory = join(this.sessionsRoot, slug.name, session.name);
        const header = await readSessionHeader(directory);
        if (header?.cwd === undefined || resolve(header.cwd).toLowerCase() !== wanted) continue;
        results.push({ id: session.name, directory, archived: false });
      }
    }
    return results;
  }

  /**
   * Import stored logs into the archive.
   * @param {object} [options] - import options.
   * @param {string[]} [options.ids] - import only these session ids; omit for every stored log of this project.
   * @param {boolean} [options.force] - re-import conversations already present.
   * @returns {Promise<{ imported: Array<object>, skipped: Array<object>, failed: Array<object> }>} import summary.
   */
  async importFromDisk({ ids, force = false } = {}) {
    const wanted = Array.isArray(ids) && ids.length > 0 ? new Set(ids) : undefined;
    const discovered = await this.listDurableSessions();
    const imported = [];
    const skipped = [];
    const failed = [];
    for (const entry of discovered) {
      if (wanted !== undefined && !wanted.has(entry.id) && ![...wanted].some((id) => entry.id.endsWith(id))) continue;
      if (entry.archived && !force) {
        skipped.push({ id: entry.id, reason: 'already archived' });
        continue;
      }
      const stored = await readDurableSession(entry.directory);
      if ('error' in stored) {
        failed.push({ id: entry.id, error: stored.error });
        continue;
      }
      const written = await this.write({ header: stored.header, events: stored.events });
      imported.push({
        id: entry.id,
        title: written.conversation.session.title,
        messages: written.conversation.session.messageCount,
        directory: join(this.sessionDir(entry.id), 'conversation.md'),
      });
    }
    return { imported, skipped, failed };
  }

  /**
   * Read one session's events from the live session registry.
   * @param {object} session - a live `Session`.
   * @returns {Array<object>} snapshot events.
   */
  eventsOf(session) {
    return session.snapshotEvents();
  }

  /**
   * Archive the currently running session, coalescing rapid repeat requests so a
   * burst of turns cannot queue redundant writes.
   *
   * Refuses a session whose own working directory is a different project: a
   * vault owns exactly one project root, and writing another project's
   * transcript here would scatter one conversation across unrelated folders.
   *
   * @param {object} session - the live session.
   * @returns {Promise<{ ok: boolean, error?: unknown, skipped?: string }>} the write summary.
   */
  async exportLive(session) {
    const id = session.id;
    const sessionCwd = session?.header?.cwd;
    if (typeof sessionCwd === 'string' && sessionCwd.length > 0
      && resolve(sessionCwd).toLowerCase() !== this.projectRoot.toLowerCase()) {
      this.ctx.logger.warn(
        `session vault: refusing to archive ${id} (cwd ${sessionCwd}) into ${this.projectRoot}`,
      );
      return { ok: false, skipped: 'cwd does not belong to this vault' };
    }
    const existing = this.pending.get(id);
    if (existing !== undefined) return existing;
    // Never archive a session this vault published from its own archive.
    //
    // Auto-export is what fed the duplicate chain: a published session was
    // written back into the archive as a *new* conversation, and the next sweep
    // published that copy under a derived id, exported it, and so on. Breaking
    // the loop here — at the point the copy would be created — is what keeps an
    // archive from growing, and it lets the import side stay permissive.
    if (await this.isPublishedImport(id)) {
      this.ctx.logger.info?.(`session vault: not archiving ${id} into ${this.projectRoot}; it is a session this vault published from that archive`);
      return { ok: false, skipped: 'this session was published from this archive' };
    }
    const work = (async () => {
      try {
        await this.write({
          header: session.header,
          events: this.eventsOf(session),
          writeMarkdown: true,
          updateIndex: true,
        });
        return { ok: true };
      } catch (error) {
        this.ctx.logger.warn(`session vault: could not archive ${id}: ${error instanceof Error ? error.message : String(error)}`);
        return { ok: false, error };
      } finally {
        this.pending.delete(id);
      }
    })();
    this.pending.set(id, work);
    return work;
  }

  /**
   * Archive every live session whose header records this project.
   * @returns {Promise<Array<object>>} one summary per archived session.
   */
  async exportAllLive() {
    const summaries = [];
    for (const session of this.ctx.sessions.list()) {
      if (session.header?.cwd === undefined) continue;
      if (resolve(session.header.cwd).toLowerCase() !== this.projectRoot.toLowerCase()) continue;
      await this.exportLive(session);
      summaries.push({ id: session.id, title: session.header.id });
    }
    return summaries;
  }
}

/**
 * Serialize a transcript as JSONL: one metadata line, then one line per message.
 * @param {object} conversation - the normalized conversation.
 * @returns {string} JSONL text.
 */
export function toJsonl(conversation) {
  const lines = [JSON.stringify({
    type: 'conversation',
    archiveVersion: conversation.archiveVersion ?? ARCHIVE_VERSION,
    ...conversation.session,
  })];
  for (const message of conversation.messages) lines.push(JSON.stringify(message));
  return `${lines.join('\n')}\n`;
}

/**
 * Serialize a session's verbatim events for the archive.
 *
 * Line 1 is the session header under a `type: 'session'` tag — the same shape
 * the persistence backend writes — and every later line is one unmodified
 * session event. This file is the import source: re-materializing a conversation
 * as a DSH session must reuse the original `data` payloads exactly, because the
 * loader validates shapes the normalized transcript does not retain.
 *
 * @param {object} header - the session header.
 * @param {Array<object>} events - raw session events.
 * @returns {string} JSONL text.
 */
export function toEventsJsonl(header, events) {
  const lines = [JSON.stringify({ type: 'session', ...header })];
  for (const event of events) lines.push(JSON.stringify(event));
  return `${lines.join('\n')}\n`;
}

/**
 * Renumber a borrowed event list so it is a standalone log.
 *
 * Persistence requires events contiguous from seq 0, and an archive preserved
 * the source log's original sequence numbers — a session whose surface was ever
 * replaced, or which was itself inherited, does not start at 0. Every reference
 * that points *within* the list is remapped too; a reference to an event outside
 * it is dropped rather than left dangling.
 *
 * @param {readonly object[]} events - the events as archived.
 * @returns {Array<object>} new event objects with contiguous `seq` values.
 */
export function renumberEvents(events) {
  /** old seq -> new seq, for references inside this list. */
  const remap = new Map();
  events.forEach((event, index) => {
    if (typeof event?.seq === 'number') remap.set(event.seq, index);
  });
  return events.map((event, index) => {
    const next = { ...event, seq: index };
    if (Array.isArray(event.sourceEventSeqs)) {
      const mapped = event.sourceEventSeqs
        .map((seq) => (typeof seq === 'number' ? remap.get(seq) : undefined))
        .filter((seq) => seq !== undefined);
      if (mapped.length === 0) delete next.sourceEventSeqs;
      else next.sourceEventSeqs = mapped;
    }
    return next;
  });
}

/**
 * Rebuild session events from a normalized transcript.
 *
 * Used only for an archive written before `events.jsonl` existed. The result is
 * a valid, loadable session, but not a byte-faithful one: the transcript is
 * lossy, so an assistant message is rebuilt with an empty provider `stream`
 * (which the loader requires to exist, and only the live UI replays) and tool
 * calls carry their parsed arguments rather than the original argument text.
 * Prefer re-exporting such a session to upgrade the archive.
 *
 * Every message must sit inside an **open** turn and step — the loader fails the
 * whole log with `assistant/message does not match an open turn and step` — so
 * messages are wrapped in the `turn/start`, `step/start`, `step/end` and
 * `turn/end` events that bound them, derived from the recorded `turn`/`step` and
 * emitted in non-decreasing order.
 *
 * @param {object} conversation - a parsed normalized conversation.
 * @returns {Array<object>} contiguous session events starting at seq 0.
 */
export function buildEventsFromConversation(conversation) {
  const events = [];
  const sessionId = conversation?.session?.id ?? 'imported';
  const messages = conversation?.messages ?? [];
  const defaultTime = conversation?.session?.startedAt ?? Date.now();
  /** The archived title, which the messages themselves do not carry. */
  const title = typeof conversation?.session?.title === 'string' ? conversation.session.title : undefined;
  /**
   * The agent preset the conversation runs under.
   *
   * Continuing a conversation needs its `agentPreset` projection. The registry
   * seeds that from `header.agentPreset ?? null` and updates it from an
   * `agent-preset/selected` event; a rebuild that carries neither leaves the
   * session openable but not continuable. `standard` is a shipped preset, and an
   * archive that names its own keeps it.
   */
  const agentPreset = typeof conversation?.session?.agentPreset === 'string' && conversation.session.agentPreset.length > 0
    ? conversation.session.agentPreset
    : 'standard';
  /** Kept unchanged when the archive already names the conversation. */
  const hasTitle = messages.some((message) => message?.type === 'session/title');
  /** The title event is emitted once, after the first human message it cites. */
  let titleEmitted = false;
  /** The currently open turn and step, or null. */
  let open = null;
  /** Tool-call ids announced so far, so a result is never left dangling. */
  const announcedCalls = new Map();

  /**
   * Append one event with the next sequence number.
   * @param {object} event - the event without `seq`.
   */
  const emit = (event) => {
    events.push({ seq: events.length, ...event });
  };

  /**
   * Close the open step and turn, if any.
   */
  const close = () => {
    if (open === null) return;
    const { turn, step, lastTime } = open;
    emit({ type: 'step/end', time: lastTime, data: { turn, step } });
    emit({ type: 'turn/end', time: lastTime, data: { turn, reason: { kind: 'completed' } } });
    open = null;
  };

  /**
   * Open or advance the turn and step a message belongs to.
   * @param {number} turn - the message's turn.
   * @param {number} step - the message's step.
   * @param {number} time - the message's timestamp.
   */
  const openAt = (turn, step, time) => {
    if (open === null || turn > open.turn) {
      close();
      emit({ type: 'turn/start', time, data: { turn } });
      emit({ type: 'step/start', time, data: { turn, step } });
      open = { turn, step, lastTime: time };
      return;
    }
    if (step > open.step) {
      emit({ type: 'step/end', time, data: { turn: open.turn, step: open.step } });
      emit({ type: 'step/start', time, data: { turn, step } });
      open.step = step;
    }
    open.lastTime = time;
  };

  // Announce the agent preset first, before any turn opens: the projection is
  // what an agent activation reads to compose the resumed session, and a log
  // without it opens but cannot be continued.
  emit({
    type: 'agent-preset/selected',
    time: defaultTime,
    data: { agentPreset },
  });

  for (const message of messages) {
    const time = typeof message.time === 'number' ? message.time : defaultTime;
    const turn = Number.isSafeInteger(message.turn) && message.turn >= 0 ? message.turn : 1;
    const step = Number.isSafeInteger(message.step) && message.step >= 0 ? message.step : 1;
    const id = `${sessionId}-e${events.length}`;
    const content = [];
    if (message.role === 'assistant') {
      if (typeof message.text === 'string' && message.text.length > 0) content.push({ type: 'text', text: message.text });
      for (const call of message.toolCalls ?? []) {
        content.push({
          type: 'tool-call',
          id: call.id ?? `${id}-c${content.length}`,
          name: String(call.name ?? 'tool'),
          arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? {}),
        });
      }
      if (content.length === 0) continue;
    }
    openAt(turn, step, time);
    if (message.role === 'user') {
      // A real `user/message` carries no `turn`/`step` — the open turn and step
      // are tracked by position, and the loader rejects extra posture that
      // contradicts the log. Emit exactly the fields the format defines.
      const seq = events.length;
      emit({
        type: 'user/message',
        time,
        surfaceOp: 'append',
        data: {
          role: 'user',
          id,
          source: { kind: 'user' },
          content: [{ type: 'text', text: String(message.text ?? '') }],
        },
      });
      // Name the conversation. Without a `session/title` the sidebar has nothing
      // to show and every imported conversation reads as an untitled row, because
      // the title lives in the archive's metadata, never in the messages.
      //
      // The loader requires `messageSeqs` to cite distinct *earlier* human
      // messages whenever the title's source is not `user`, so this waits for the
      // first user message and names it.
      if (!titleEmitted && !hasTitle && typeof title === 'string' && title.length > 0 && String(message.text ?? '').length > 0) {
        titleEmitted = true;
        emit({
          type: 'session/title',
          time,
          data: { title, messageSeqs: [seq], source: { kind: 'fallback' } },
        });
      }
      continue;
    }
    if (message.role === 'assistant') {
      emit({
        type: 'assistant/message',
        time,
        surfaceOp: 'append',
        data: {
          turn,
          step,
          message: {
            role: 'assistant',
            id,
            source: { kind: 'model', provider: 'reconstructed', model: 'reconstructed' },
            content,
          },
          // Required by `assertAssistantSettlementShape`; only the live UI replays it.
          stream: [],
          ...(message.usage === undefined ? {} : { usage: message.usage }),
        },
      });
      // Remember which call ids this turn announced, so a result whose call is
      // missing from the transcript can still be paired with one.
      for (const block of content) {
        if (block.type === 'tool-call') announcedCalls.set(block.id, { name: block.name, arguments: block.arguments ?? '{}', turn, step });
      }
      continue;
    }
    let callId = typeof message.callId === 'string' && message.callId.length > 0 ? message.callId : `${id}-c`;
    if (!announcedCalls.has(callId)) {
      // The transcript lost the announcement (it only keeps tool calls that the
      // assistant message recorded). A result with no call would be a dangling
      // tool result, so announce it on the assistant message of this turn, or
      // start one when the turn has none yet.
      const name = typeof message.name === 'string' && message.name.length > 0 ? message.name : 'tool';
      const host = [...events].reverse().find((event) => event.type === 'assistant/message' && event.data.turn === turn);
      if (host === undefined) {
        emit({
          type: 'assistant/message',
          time,
          surfaceOp: 'append',
          data: {
            turn,
            step,
            message: {
              role: 'assistant',
              id: `${id}-caller`,
              source: { kind: 'model', provider: 'reconstructed', model: 'reconstructed' },
              content: [{ type: 'tool-call', id: callId, name, arguments: '{}' }],
            },
            stream: [],
          },
        });
      } else {
        host.data.message.content.push({ type: 'tool-call', id: callId, name, arguments: '{}' });
      }
      announcedCalls.set(callId, { name, arguments: '{}', turn, step });
    }
    const announced = announcedCalls.get(callId);
    const toolName = typeof message.name === 'string' && message.name.length > 0
      ? message.name
      : (announced?.name ?? 'tool');
    // The transcript keeps tool *results* but not the `tool/call` that marks the
    // call as started, and the loader refuses a result for a call it never saw
    // start: it then demands an exact TOOL_NOT_STARTED repair payload
    // ("not-started error requires an object"). Emitting the call first keeps
    // every result matched to a started call.
    //
    // The call must restate the advertised name and arguments verbatim — every
    // one of the 1033 `tool/call` events in a real log matches its assistant
    // block exactly, and the loader treats the pair as one identity.
    emit({
      type: 'tool/call',
      time,
      data: {
        turn,
        step,
        callId,
        name: toolName,
        arguments: announced?.arguments ?? '{}',
      },
    });
    emit({
      type: 'tool/result',
      time,
      surfaceOp: 'append',
      data: {
        turn,
        step,
        message: {
          role: 'tool',
          id,
          source: { kind: 'tool', callId },
          toolCallId: callId,
          isError: message.isError === true,
          content: [{ type: 'text', text: String(message.text ?? '') }],
        },
      },
    });
  }
  close();
  return events;
}

/**
 * Read a session's archived events, preferring the verbatim record.
 *
 * `events.jsonl` is the faithful source. An archive written before it existed
 * has only the normalized transcript, so the events are rebuilt from it and the
 * caller is told the result is reconstructed rather than verbatim.
 *
 * @param {string} directory - the session's archive directory.
 * @returns {Promise<{ header: object, events: Array<object>, reconstructed?: true } | { error: string }>} the record.
 */
export async function readArchivedEvents(directory) {
  try {
    const raw = await readFile(join(directory, 'events.jsonl'), 'utf8');
    const parsed = parseSessionLog(raw);
    if (parsed.events.length > 0) return { header: parsed.header, events: renumberEvents(parsed.events) };
  } catch {
    // Fall through to the transcript below.
  }
  let conversationRaw;
  try {
    conversationRaw = await readFile(join(directory, 'conversation.jsonl'), 'utf8');
  } catch (error) {
    return { error: `no readable archive in ${directory}: ${error instanceof Error ? error.message : String(error)}` };
  }
  let conversation;
  try {
    conversation = parseConversationFile(conversationRaw);
  } catch (error) {
    return { error: `the archive in ${directory} is unreadable: ${error instanceof Error ? error.message : String(error)}` };
  }
  const events = buildEventsFromConversation(conversation);
  if (events.length === 0) return { error: `the archive in ${directory} held no reconstructable messages` };
  // The archive claims its events were not a guess — a converter that mirrors the
  // session format declares this. The claim is only good while `events.jsonl` is
  // actually present, which is the file that was just found missing, so the
  // rebuilt log stays marked as a reconstruction.
  const { verbatim: _claimed, ...session } = conversation.session ?? {};
  return { header: session, events, reconstructed: true };
}

/**
 * Rebuild a conversation from its archived JSONL record.
 *
 * Line 1 is the conversation metadata; every later line is one message. Unknown
 * message shapes are preserved as-is so a newer archive stays readable.
 *
 * @param {string} raw - the archive file's text.
 * @returns {object} the normalized conversation.
 * @throws {Error} when the file has no conversation header.
 */
export function parseConversationFile(raw) {
  let session;
  const messages = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const parsed = JSON.parse(trimmed);
    if (parsed?.type === 'conversation') {
      const { type: _type, ...rest } = parsed;
      session = rest;
      continue;
    }
    messages.push(parsed);
  }
  if (session === undefined) {
    throw new Error('missing the leading conversation metadata line');
  }
  return {
    archiveVersion: typeof session.archiveVersion === 'number' ? session.archiveVersion : ARCHIVE_VERSION,
    session: { ...session, messageCount: session.messageCount ?? messages.length },
    messages,
  };
}

/**
 * Read only a stored session's header line, which is enough to match a project.
 * @param {string} directory - the session directory.
 * @returns {Promise<object | undefined>} the header, or undefined.
 */
async function readSessionHeader(directory) {
  const read = await readDurableSession(directory);
  return 'error' in read ? undefined : read.header;
}

/**
 * @param {string} path - candidate directory.
 * @returns {Promise<boolean>} true when it is a directory.
 */
async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * @param {string} value - a session id.
 * @returns {string} a filesystem-safe single path segment.
 */
export function sanitizeSegment(value) {
  return String(value).replace(/[^A-Za-z0-9._-]/g, '_');
}
