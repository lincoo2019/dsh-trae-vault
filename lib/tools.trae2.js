/**
 * Agent-facing tools for the conversation vault and Trae skill catalog.
 *
 * Every operation is implemented once on {@link SessionVault} and exposed here,
 * so the model and any future UI action share one code path and one set of
 * failure messages.
 *
 * @module @local/dsh-trae-session-vault/tools
 */
import { join } from 'node:path';
import { convertShare, fetchShare } from './share.trae2.js';

/** Text-only tool output. */
const text = (value) => [{ type: 'text', text: typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n` }];

/**
 * Compile an author property map into JSON Schema `properties` plus the
 * containing object's `required` name list.
 *
 * `required` is an array of property names on the *object* node in JSON Schema
 * — the opposite of the per-property `required: true` form the author DSL uses.
 *
 * @param {Record<string, object>} properties - property name to DSL node.
 * @returns {{ properties: Record<string, object>, required: string[] }} the compiled pair.
 */
function propertyMap(properties) {
  const required = [];
  const emitted = {};
  for (const [key, node] of Object.entries(properties)) {
    const { required: isRequired, ...rest } = node ?? {};
    if (isRequired === true) required.push(key);
    emitted[key] = rest;
  }
  return { properties: emitted, required };
}

/**
 * Build an `output.schema` object node in the enforced JSON Schema subset.
 *
 * `output.schema` is validated by `assertSupportedJsonSchema`. This helper
 * takes the author DSL shape (so both halves of a tool read the same way) and
 * emits the JSON Schema shape.
 *
 * @param {Record<string, object>} properties - property name to DSL node.
 * @returns {object} a JSON Schema object node.
 */
function objectSchema(properties) {
  const { properties: emitted, required } = propertyMap(properties);
  return {
    type: 'object',
    additionalProperties: false,
    ...(required.length === 0 ? {} : { required }),
    properties: emitted,
  };
}

/**
 * Build a tool's model-facing `parameters` schema.
 *
 * The registry forwards `definition.parameters` to the provider verbatim —
 * only `defineTool` compiles the author DSL — so a raw definition like these
 * must already hold JSON Schema. A parameter map left in DSL form reaches the
 * provider with no root `type`, and every run fails with
 * `Invalid schema for function '<name>': schema must be a JSON Schema of
 * 'type: "object"', got 'type: null'`.
 *
 * The root stays open (no `additionalProperties`), matching the schema
 * `parameterSchemaSpecToJsonSchema` compiles for the Harness's own tools.
 *
 * @param {Record<string, object>} properties - property name to DSL node.
 * @returns {object} a JSON Schema object node.
 */
function parameterSchema(properties) {
  const { properties: emitted, required } = propertyMap(properties);
  return {
    type: 'object',
    ...(required.length === 0 ? {} : { required }),
    properties: emitted,
  };
}

/**
 * Build the tool definitions this plugin registers.
 * @param {object} options - wiring.
 * @param {object} options.ctx - plugin context.
 * @param {object} options.vault - proxy routing calls to the active project's archive.
 * @param {(exec?: object) => object} options.vaultForCall - resolves and returns the calling project's archive.
 * @param {(projectRoot: string) => object} options.selectVault - resolves the archive that owns an explicit project root.
 * @param {() => string} options.skillsReport - renders the Trae skill catalog as text.
 * @param {object} options.shareConfig - how shared Trae conversations are fetched and imported.
 * @returns {Array<object>} tool definitions ready for `ctx.tools.register`.
 */
export function createTools({ ctx, vault, vaultForCall, selectVault, skillsReport, workspacesReport, shareConfig = {} }) {
  /**
   * The session a tool call belongs to.
   * @param {object} exec - the tool run context.
   * @returns {object | undefined} the live session, when the caller is an agent.
   */
  const sessionOf = (exec) => exec?.agent?.session ?? (exec?.agent === undefined ? undefined : ctx.sessions.get(exec.agent.id));

  return [
    {
      name: 'conversation_list',
      description: [
        'List the conversations archived in this project folder, plus any stored Harness sessions for this project that are not archived yet.',
        'Use it to find a session id before calling conversation_read, or to check what has already been saved.',
        '`conversation.sync_from_disk` imports the unarchived ones.',
      ].join(' '),
      parameters: parameterSchema({
        limit: {
          type: 'integer',
          description: 'Maximum archived conversations to list, newest first. Defaults to 20.',
        },
      }),
      output: {
        schema: objectSchema({
          project: { type: 'string', required: true },
          archiveDirectory: { type: 'string', required: true },
          archivedTotal: { type: 'integer', required: true },
          archived: {
            type: 'array',
            required: true,
            items: objectSchema({
              id: { type: 'string', required: true },
              title: { type: 'string', required: true },
              messageCount: { type: 'integer', required: true },
              humanMessageCount: { type: 'integer', required: true },
              endedAt: { type: 'string' },
            }),
          },
          unarchivedStoredSessions: {
            type: 'array',
            required: true,
            items: objectSchema({ id: { type: 'string', required: true } }),
          },
        }),
        render: (_args, value) => {
          const lines = [
            `Archived conversations for ${value.project}: ${value.archivedTotal} in ${value.archiveDirectory}`,
          ];
          for (const entry of value.archived) {
            lines.push(`- ${entry.id}  ${entry.title}  (${entry.messageCount} messages, ${entry.humanMessageCount} from you)`);
          }
          if (value.unarchivedStoredSessions.length > 0) {
            lines.push(`Stored but not archived yet: ${value.unarchivedStoredSessions.map((entry) => entry.id).join(', ')}`);
          }
          return text(lines.join('\n'));
        },
      },
      async execute(args, exec) {
        const limit = Number.isInteger(args?.limit) && args.limit > 0 ? args.limit : 20;
        const vault = vaultForCall(exec);
        const index = await vault.readIndex();
        const ordered = [...index.conversations].sort(
          (left, right) => (right.endedAt ?? right.updatedAt ?? 0) - (left.endedAt ?? left.updatedAt ?? 0),
        );
        const discovered = await vault.listDurableSessions();
        const archived = new Set(index.conversations.map((entry) => entry.id));
        const archivedIds = new Set(ordered.map((entry) => entry.id));
        const current = sessionOf(exec);
        return {
          project: vault.projectRoot,
          archiveDirectory: vault.directory,
          archivedTotal: ordered.length,
          archived: ordered
            .filter((entry) => limit > 0)
            .slice(0, limit)
            .map((entry) => ({
              id: entry.id,
              title: entry.title ?? '(untitled conversation)',
              messageCount: entry.messageCount ?? 0,
              humanMessageCount: entry.humanMessageCount ?? 0,
              ...(typeof entry.endedAt === 'number' ? { endedAt: new Date(entry.endedAt).toISOString() } : {}),
            })),
          unarchivedStoredSessions: discovered
            .filter((entry) => !archived.has(entry.id) && entry.id !== current?.id)
            .map((entry) => ({ id: entry.id })),
          ...(archivedIds.size === 0 && current !== undefined
            ? { note: `This conversation (${current.id}) is archived automatically as it progresses.` }
            : {}),
        };
      },
      presentCall: (args) => ({ card: 'generic', title: 'List archived conversations', kind: 'other', rawInput: args }),
    },

    {
      name: 'conversation_read',
      description: [
        'Read one archived project conversation and return its transcript.',
        'Returns exactly what the archive holds: your messages, assistant replies, tool calls, and clamped tool results.',
        'Accepts a full session id or any unique suffix of one.',
      ].join(' '),
      parameters: parameterSchema({
        session_id: {
          type: 'string',
          required: true,
          description: 'Session id, archive directory name, or a unique suffix such as "b0b7045".',
        },
        format: {
          type: 'string',
          enum: ['markdown', 'json', 'jsonl'],
          description: 'Transcript form. `markdown` is the readable transcript (default), `json` the structured conversation, `jsonl` the line-per-message record.',
        },
        max_messages: {
          type: 'integer',
          description: 'Return only the first N messages of the transcript. Omit for all of them.',
        },
      }),
      output: {
        schema: objectSchema({
          sessionId: { type: 'string', required: true },
          title: { type: 'string', required: true },
          format: { type: 'string', required: true },
          returnedMessages: { type: 'integer', required: true },
          totalMessages: { type: 'integer', required: true },
          transcript: { type: 'string', required: true },
        }),
        render: (_args, value) => text(
          `${value.title} (${value.sessionId})\n`
          + `${value.returnedMessages} of ${value.totalMessages} messages, ${value.format}\n\n`
          + value.transcript,
        ),
      },
      async execute(args, exec) {
        const sessionId = typeof args?.session_id === 'string' ? args.session_id.trim() : '';
        if (sessionId.length === 0) throw new Error('conversation_read requires a session_id');
        const format = ['markdown', 'json', 'jsonl'].includes(args?.format) ? args.format : 'markdown';
        const vault = vaultForCall(exec);
        const read = await vault.read(sessionId, format);
        if ('error' in read) throw new Error(read.error);
        const max = Number.isInteger(args?.max_messages) && args.max_messages > 0 ? args.max_messages : undefined;
        const messages = read.conversation.messages;
        let transcript = read.text;
        if (max !== undefined && max < messages.length) {
          const trimmed = { ...read.conversation, messages: messages.slice(0, max) };
          transcript = format === 'markdown'
            ? renderTrimmed(trimmed)
            : format === 'jsonl'
              ? toJsonlText(trimmed)
              : `${JSON.stringify(trimmed, null, 2)}\n`;
        }
        return {
          sessionId: read.conversation.session.id,
          title: read.conversation.session.title,
          format,
          returnedMessages: max === undefined ? messages.length : Math.min(max, messages.length),
          totalMessages: messages.length,
          transcript,
        };
      },
      presentCall: (args) => ({ card: 'generic', title: `Read conversation ${args?.session_id ?? ''}`, kind: 'read', rawInput: args }),
    },

    {
      name: 'conversation_export',
      description: [
        'Save DeepSeek Harness conversations into this project folder as a normalized JSONL archive plus a Markdown transcript.',
        'With no session_id it archives the conversation you are in right now.',
        'Pass session_id to archive a different live session, or all: true to archive every live session recorded for this project.',
        'The archive lands in the project-local vault directory reported by conversation_list.',
      ].join(' '),
      parameters: parameterSchema({
        session_id: {
          type: 'string',
          description: 'A live session id to archive. Defaults to the current conversation.',
        },
        all: {
          type: 'boolean',
          description: 'Archive every live session whose working directory is this project.',
        },
      }),
      output: {
        schema: objectSchema({
          archiveDirectory: { type: 'string', required: true },
          exported: {
            type: 'array',
            required: true,
            items: objectSchema({
              sessionId: { type: 'string', required: true },
              title: { type: 'string', required: true },
              messages: { type: 'integer', required: true },
              markdown: { type: 'string', required: true },
              jsonl: { type: 'string', required: true },
            }),
          },
          skipped: {
            type: 'array',
            required: true,
            items: objectSchema({
              sessionId: { type: 'string' },
              reason: { type: 'string', required: true },
            }),
          },
        }),
        render: (_args, value) => {
          const lines = [`Archived into ${value.archiveDirectory}`];
          for (const entry of value.exported) {
            lines.push(`- ${entry.sessionId}  ${entry.title}  (${entry.messages} messages) -> ${entry.markdown}`);
          }
          for (const entry of value.skipped) {
            lines.push(`- skipped ${entry.sessionId ?? '(no session)'}: ${entry.reason}`);
          }
          if (value.exported.length === 0 && value.skipped.length === 0) lines.push('Nothing to archive.');
          return text(lines.join('\n'));
        },
      },
      async execute(args, exec) {
        // Resolve the archive from the session being archived, not from the
        // caller: archiving another project's session must land in that project's
        // folder, and publishing it afterwards must then find it there.
        const ownerVault = (session) => (typeof session.header?.cwd === 'string' && session.header.cwd.length > 0
          ? selectVault(session.header.cwd)
          : vaultForCall(exec));
        const vault = vaultForCall(exec);
        const exported = [];
        const skipped = [];
        const record = async (session) => {
          const target = ownerVault(session);
          const written = await target.write({ header: session.header, events: session.snapshotEvents() });
          exported.push({
            sessionId: written.conversation.session.id,
            title: written.conversation.session.title,
            messages: written.conversation.session.messageCount,
            markdown: join(target.sessionDir(session.id), 'conversation.md'),
            jsonl: join(target.sessionDir(session.id), 'conversation.jsonl'),
          });
        };

        if (args?.all === true) {
          for (const session of ctx.sessions.list()) {
            const cwd = session.header?.cwd;
            if (typeof cwd !== 'string' || cwd.toLowerCase() !== vault.projectRoot.toLowerCase()) {
              skipped.push({ sessionId: session.id, reason: `working directory is ${cwd ?? 'unset'}, not this project` });
              continue;
            }
            await record(session);
          }
        } else if (typeof args?.session_id === 'string' && args.session_id.trim().length > 0) {
          const wanted = args.session_id.trim();
          const match = ctx.sessions.list().find((session) => session.id === wanted || session.id.endsWith(wanted));
          if (match === undefined) {
            skipped.push({ sessionId: wanted, reason: 'no live session matches; use conversation_sync_from_disk for a stored session' });
          } else {
            await record(match);
          }
        } else {
          const current = sessionOf(exec);
          if (current === undefined) skipped.push({ reason: 'this call has no owning session; pass session_id or all: true' });
          else await record(current);
        }
        return { archiveDirectory: vault.directory, exported, skipped };
      },
      presentCall: (args) => ({ card: 'generic', title: 'Export conversation to the project vault', kind: 'other', rawInput: args }),
    },

    {
      name: 'conversation_sync_from_disk',
      description: [
        'Import Harness conversations that are already stored on disk for this project but are not in the project archive yet.',
        'Use it after upgrading, or to pull in conversations recorded by another Harness window or the desktop app for the same folder.',
        'Stored logs live under the Harness session root and are read through the multi-frame zstd codec.',
      ].join(' '),
      parameters: parameterSchema({
        session_ids: {
          type: 'array',
          description: 'Import only these session ids (a unique suffix is accepted). Omit to import every unarchived stored session for this project.',
          items: { type: 'string' },
        },
        force: {
          type: 'boolean',
          description: 'Re-import conversations that are already archived, replacing their archive copy.',
        },
      }),
      output: {
        schema: objectSchema({
          archiveDirectory: { type: 'string', required: true },
          storedSessionsRoot: { type: 'string', required: true },
          imported: {
            type: 'array',
            required: true,
            items: objectSchema({
              sessionId: { type: 'string', required: true },
              title: { type: 'string', required: true },
              messages: { type: 'integer', required: true },
              markdown: { type: 'string', required: true },
            }),
          },
          skipped: {
            type: 'array',
            required: true,
            items: objectSchema({ sessionId: { type: 'string' }, reason: { type: 'string', required: true } }),
          },
          failed: {
            type: 'array',
            required: true,
            items: objectSchema({ sessionId: { type: 'string' }, error: { type: 'string', required: true } }),
          },
        }),
        render: (_args, value) => {
          const lines = [`Imported into ${value.archiveDirectory} from ${value.storedSessionsRoot}`];
          for (const entry of value.imported) {
            lines.push(`- ${entry.sessionId}  ${entry.title}  (${entry.messages} messages) -> ${entry.markdown}`);
          }
          for (const entry of value.skipped) lines.push(`- skipped ${entry.sessionId ?? '(unknown)'}: ${entry.reason}`);
          for (const entry of value.failed) lines.push(`- failed ${entry.sessionId ?? '(unknown)'}: ${entry.error}`);
          if (value.imported.length === 0 && value.skipped.length === 0 && value.failed.length === 0) {
            lines.push('No stored sessions found for this project.');
          }
          return text(lines.join('\n'));
        },
      },
      async execute(args, exec) {
        const vault = vaultForCall(exec);
        const result = await vault.importFromDisk({ ids: args?.session_ids, force: args?.force === true });
        return {
          archiveDirectory: vault.directory,
          storedSessionsRoot: vault.sessionsRoot,
          imported: result.imported.map((entry) => ({
            sessionId: entry.id,
            title: entry.title,
            messages: entry.messages,
            markdown: entry.directory,
          })),
          skipped: result.skipped.map((entry) => ({ sessionId: entry.id, reason: entry.reason })),
          failed: result.failed.map((entry) => ({ sessionId: entry.id, error: entry.error })),
        };
      },
      presentCall: (args) => ({ card: 'generic', title: 'Import stored conversations', kind: 'other', rawInput: args }),
    },

    {
      name: 'trae_skill_list',
      description: [
        'List the Trae skills this Harness can currently invoke from your .trae/skills folders, with the file each one came from.',
        'Use it to confirm which SKILL.md definitions are visible before invoking one with the skill tool.',
      ].join(' '),
      parameters: parameterSchema({}),
      output: {
        schema: objectSchema({
          count: { type: 'integer', required: true },
          skills: {
            type: 'array',
            required: true,
            items: objectSchema({
              name: { type: 'string', required: true },
              description: { type: 'string', required: true },
              source: { type: 'string', required: true },
              path: { type: 'string', required: true },
              modelInvocable: { type: 'boolean', required: true },
            }),
          },
          report: { type: 'string', required: true },
        }),
        render: (_args, value) => text(value.report),
      },
      async execute(args, exec) {
        const vault = vaultForCall(exec);
        const skills = await ctx.skills.list({ cwd: vault.projectRoot });
        const trae = skills.filter((skill) => skill.provider === 'trae');
        return {
          count: trae.length,
          skills: trae.map((skill) => ({
            name: skill.name,
            description: skill.description,
            source: skill.source,
            path: skill.path ?? '',
            modelInvocable: skill.invocation?.modelInvocable !== false,
          })),
          report: skillsReport(trae),
        };
      },
      presentCall: () => ({ card: 'generic', title: 'List Trae skills', kind: 'other' }),
    },

    {
      name: 'conversation_publish',
      description: [
        'Materialize archived conversations as real DeepSeek Harness sessions, so the workspace sidebar lists them and they can be opened and resumed like any other conversation.',
        'Each archived conversation is written into the Harness session store under a new session id whose cwd is this project; the original session log is never modified.',
        'Already-published conversations are skipped, so this is safe to call repeatedly.',
        'Use this for conversations that live only in a project folder, for example one copied in from another machine.',
      ].join(' '),
      parameters: parameterSchema({
        session_ids: {
          type: 'array',
          description: 'Publish only these archived session ids (a unique suffix is accepted). Omit to publish every archived conversation of this project.',
          items: { type: 'string' },
        },
        force: {
          type: 'boolean',
          description: 'Publish again even when the archive records a previous publication, superseding an unreadable stored session with a corrected copy.',
        },
        cwd: {
          type: 'string',
          description: 'Project folder whose archive to publish, defaulting to the calling session\'s own project. Use it for a workspace whose .dsh was added after startup, which the activation scan has not seen yet.',
        },
      }),
      output: {
        schema: objectSchema({
          project: { type: 'string', required: true },
          archiveDirectory: { type: 'string', required: true },
          published: {
            type: 'array',
            required: true,
            items: objectSchema({
              sessionId: { type: 'string', required: true },
              publishedAs: { type: 'string', required: true },
              title: { type: 'string', required: true },
              events: { type: 'integer', required: true },
            }),
          },
          skipped: {
            type: 'array',
            required: true,
            items: objectSchema({
              sessionId: { type: 'string' },
              reason: { type: 'string', required: true },
              importedAs: { type: 'string' },
            }),
          },
          failed: {
            type: 'array',
            required: true,
            items: objectSchema({ sessionId: { type: 'string' }, error: { type: 'string', required: true } }),
          },
        }),
        render: (_args, value) => {
          const lines = [`Published into the Harness session store from ${value.archiveDirectory}`];
          for (const entry of value.published) {
            lines.push(`- ${entry.sessionId} -> ${entry.publishedAs}  "${entry.title}" (${entry.events} events)`);
          }
          for (const entry of value.skipped) lines.push(`- skipped ${entry.sessionId ?? '(unknown)'}: ${entry.reason}`);
          for (const entry of value.failed) lines.push(`- failed ${entry.sessionId ?? '(unknown)'}: ${entry.error}`);
          if (value.published.length === 0 && value.failed.length === 0) lines.push('Nothing new to publish.');
          return text(lines.join('\n'));
        },
      },
      async execute(args, exec) {
        // An explicit `cwd` selects that folder's archive, which is how a
        // workspace registered after startup gets published without a restart.
        const vault = typeof args?.cwd === 'string' && args.cwd.length > 0
          ? selectVault(args.cwd)
          : vaultForCall(exec);
        const result = await vault.importToDsh({ ids: args?.session_ids, force: args?.force === true });
        return {
          project: vault.projectRoot,
          archiveDirectory: vault.directory,
          published: result.imported.map((entry) => ({
            sessionId: entry.sessionId,
            publishedAs: entry.importedAs,
            title: entry.title,
            events: entry.events,
          })),
          skipped: result.skipped.map((entry) => ({
            sessionId: entry.sessionId,
            reason: entry.reason,
            ...(entry.importedAs === undefined ? {} : { importedAs: entry.importedAs }),
          })),
          failed: result.failed.map((entry) => ({ sessionId: entry.sessionId, error: entry.error })),
        };
      },
      presentCall: (args) => ({ card: 'generic', title: 'Publish archived conversations as Harness sessions', kind: 'other', rawInput: args }),
    },

    {
      name: 'conversation_workspaces',
      description: [
        'Report which sessions the durable workspace registry currently attributes to each workspace.',
        'Use it to diagnose why a published conversation does or does not appear under a workspace in the sidebar.',
      ].join(' '),
      parameters: parameterSchema({}),
      output: {
        schema: objectSchema({
          report: { type: 'string', required: true },
        }),
        render: (_args, value) => text(value.report),
      },
      async execute() {
        const report = workspacesReport === undefined
          ? 'no workspace registry reporter is wired'
          : await workspacesReport();
        return { report };
      },
      presentCall: () => ({ card: 'generic', title: 'Show workspace attribution', kind: 'other' }),
    },

    {
      name: 'conversation_import_share',
      description: [
        'Download a shared Trae conversation (a https://share.traecontent.cn/share/<id> link) and import it into this project as a DeepSeek Harness session.',
        'The share is converted into the Harness session format, archived under this project\'s .dsh/conversations folder, and — unless publish is false — written into the session store so it appears in the sidebar and can be resumed.',
        'The imported conversation is a copy: the share is read-only and the original is never modified. Re-importing the same link is idempotent.',
        'Importing is read-only with respect to the share, but it is a network request; omit publish to download and archive without creating a session.',
      ].join(' '),
      parameters: parameterSchema({
        url: {
          type: 'string',
          required: true,
          description: 'The Trae share link (https://share.traecontent.cn/share/<id>) or the bare share id, optionally with ?enter_from=... appended.',
        },
        publish: {
          type: 'boolean',
          description: 'Materialize the imported conversation as a real Harness session. Defaults to true; pass false to archive it only.',
        },
        force: {
          type: 'boolean',
          description: 'Publish again even when this archive already recorded a publication, superseding an unreadable stored session with a corrected copy.',
        },
        cwd: {
          type: 'string',
          description: 'Project folder that should receive the conversation, defaulting to the calling session\'s own project.',
        },
      }),
      output: {
        schema: objectSchema({
          project: { type: 'string', required: true },
          archiveDirectory: { type: 'string', required: true },
          shareId: { type: 'string', required: true },
          sourceUrl: { type: 'string', required: true },
          title: { type: 'string', required: true },
          sessionId: { type: 'string', required: true },
          turns: { type: 'integer', required: true },
          humanMessages: { type: 'integer', required: true },
          toolCalls: { type: 'integer', required: true },
          events: { type: 'integer', required: true },
          files: { type: 'array', required: true, items: { type: 'string' } },
          published: { type: 'boolean', required: true },
          publishedAs: { type: 'string' },
          notes: { type: 'array', required: true, items: { type: 'string' } },
        }),
        render: (_args, value) => {
          const lines = [
            `Imported Trae share ${value.shareId} into ${value.project}`,
            `- title: ${value.title}`,
            `- archived as: ${value.sessionId} (${value.turns} turns, ${value.humanMessages} from you, ${value.toolCalls} tool calls, ${value.events} events)`,
            `- transcript: ${value.archiveDirectory}`,
            value.published
              ? `- published as Harness session ${value.publishedAs}`
              : '- not published; use conversation_publish to create the session',
          ];
          lines.push(...value.notes.map((note) => `- ${note}`));
          return text(lines.join('\n'));
        },
      },
      async execute(args, exec) {
        const url = typeof args?.url === 'string' ? args.url.trim() : '';
        if (url.length === 0) {
          throw new Error('conversation_import_share needs the share url (or the bare share id)');
        }
        if (shareConfig.enabled === false) {
          throw new Error('share import is disabled by this profile (set share.enabled to true in the plugin row config)');
        }
        // An explicit `cwd` selects that folder's archive; otherwise the calling
        // session's own project owns the import.
        const vault = typeof args?.cwd === 'string' && args.cwd.length > 0
          ? selectVault(args.cwd)
          : vaultForCall(exec);

        const share = await fetchShare(url, {
          apiBase: shareConfig.apiBase,
          timeoutMs: shareConfig.timeoutMs,
          headers: shareConfig.headers,
        });
        const conversion = convertShare(share, {
          cwd: vault.projectRoot,
          maxToolResultChars: shareConfig.maxToolResultChars,
          agentPreset: shareConfig.agentPreset,
        });
        const written = await vault.adopt({
          header: conversion.header,
          events: conversion.events,
          conversation: conversion.conversation,
        });

        const notes = [...conversion.warnings];
        let published = false;
        let publishedAs;
        if (args?.publish !== false && shareConfig.autoPublish) {
          const result = await vault.importToDsh({ ids: [conversion.header.id], force: args?.force === true });
          for (const entry of result.imported) {
            published = true;
            publishedAs = entry.importedAs;
          }
          for (const entry of result.skipped) {
            // Already present is the ordinary idempotent outcome, not a failure.
            published = true;
            publishedAs = entry.importedAs;
            notes.push(`already present in the session store as ${entry.importedAs ?? '(unknown)'}`);
          }
          for (const entry of result.failed) {
            notes.push(`could not publish the imported conversation: ${entry.error}`);
          }
        }

        return {
          project: vault.projectRoot,
          archiveDirectory: vault.directory,
          shareId: conversion.stats.shareId,
          sourceUrl: conversion.conversation.session.sourceUrl,
          title: conversion.conversation.session.title,
          sessionId: conversion.header.id,
          turns: conversion.stats.turns,
          humanMessages: conversion.stats.humanMessages,
          toolCalls: conversion.stats.toolCalls,
          events: conversion.stats.events,
          files: written.files,
          published,
          ...(publishedAs === undefined ? {} : { publishedAs }),
          notes,
        };
      },
      presentCall: (args) => ({ card: 'generic', title: 'Import a shared Trae conversation', kind: 'other', rawInput: args }),
    },
  ];
}

/** Markdown rendering of a full conversation, used when replying directly. */
function renderTrimmed(conversation) {
  const lines = [`# ${conversation.session.title}`, ''];
  for (const message of conversation.messages) {
    if (message.role === 'user') lines.push('## You');
    else if (message.role === 'assistant') lines.push('## Assistant');
    else lines.push(`### Tool result · \`${message.name ?? 'tool'}\`${message.isError ? ' (error)' : ''}`);
    lines.push('');
    if (message.text?.length > 0) lines.push(message.text, '');
    for (const call of message.toolCalls ?? []) {
      lines.push(`**Tool call** \`${call.name}\``, '');
    }
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/** JSONL rendering of a full conversation, used when replying directly. */
function toJsonlText(conversation) {
  const lines = [JSON.stringify({
    type: 'conversation',
    archiveVersion: conversation.archiveVersion ?? 1,
    ...conversation.session,
  })];
  for (const message of conversation.messages) lines.push(JSON.stringify(message));
  return `${lines.join('\n')}\n`;
}

export { text };
