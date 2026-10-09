# dsh-trae-vault

A [DeepSeek Harness](https://github.com/deepseek-ai) plugin bundle that bridges
Trae and DSH in both directions, and keeps every conversation inside the project
it belongs to.

Four capabilities for DeepSeek Harness in one bundle:

1. **Trae skill invocation** — a `trae` provider on `ctx.skills` that discovers
   `SKILL.md` bundles written for Trae, so the Harness `skill` tool can load and
   invoke them exactly like native skills.
2. **Project-local conversation vault** — archives every conversation into the
   project folder itself as a normalized JSONL record plus a readable Markdown
   transcript, and reads them back on demand.
3. **Publishing archives as real sessions** — materializes an archived
   conversation back into DSH's session store so the sidebar lists it and it can
   be resumed.
4. **Importing shared Trae conversations** — downloads a
   `https://share.traecontent.cn/share/<id>` link, converts it into the Harness
   session format, and files it in this project like any other session.

## Install

The bundle is a plain ES-module package with **no dependencies**, so it is
installed by path rather than from a registry. Clone it somewhere permanent:

```bash
git clone https://github.com/lincoo2019/dsh-trae-vault.git
```

Then, from the directory that holds the clone, install it into a DSH profile —
this registers the package as a profile bundle and writes the link into the
profile's `package.json`:

```bash
dsh plugin --profile <your-profile> add ./dsh-trae-vault
```

`plugin_manager`'s `install_bundle` action does the same thing from inside DSH,
and the profile's own patch layer (`$DSH_HOME/profiles/<profile>/cordis.patch.yml`)
is where you override the row's config:

```yaml
- id: trae-vault
  config:
    vault:
      autoImport: true      # publish archives back as real, resumable sessions
```

Two implementation details matter while installing, and both are measured
behaviour rather than caution:

- **The clone must stay where you installed it.** The profile stores an absolute
  `link:` to this folder. Move or delete the folder and DSH cannot resolve the
  bundle at all — it reports `cannot resolve profile bundle`, and the plugin
  silently never activates.
- **`cordis.patch.yml` must be present in the package.** It is the row's overlay;
  an install that cannot read it is rejected. It is already listed in
  `package.json`'s `files`, so a packaged install carries it.

After a code change, the generation file's `REVISION` must be raised for the new
code to load (see [Why the entry is a thin loader](#why-the-entry-is-a-thin-loader)).

## 1. Trae skills

### Where it looks

| Rank | Source | Path |
|---|---|---|
| 150 | `trae-project` | `<project>/.trae/skills` |
| 250 | `trae-custom` | each `skills.customDirs` entry |
| 450 | `trae-user` | `~/.trae/skills` |

The project root is found by walking up from the session's working directory, so
a session started in `src/deep/inside` still sees `<repo>/.trae/skills` (the
walk stops at the first ancestor containing `.trae/skills`, not `.git`).

Lower rank wins inside one registry layer. Harness's own `skill-filesystem`
provider uses ranks 100 and 200 for `<project>/.dsh/skills` and
`<project>/.agents/skills`, so a Trae skill outranks `.agents` but not `.dsh`.

### Why a bespoke provider

Harness's filesystem provider scans exactly one level below a root
(`<root>/<name>/SKILL.md`). Trae skill bundles are frequently grouped, for
example `.trae/skills/<group>/<name>/SKILL.md`, so this provider walks the tree
recursively (skipping `.git`, `node_modules`, `__pycache__`, and similar) and
uses the `name` field from the frontmatter as the skill name.

Catalog discovery reads frontmatter only. **Bodies load on demand**, so editing
a `SKILL.md` body takes effect on the next invocation with no cache
invalidation. Adding, renaming, or deleting a `SKILL.md` invalidates the
catalog through a watcher (debounced).

### Frontmatter

```yaml
---
name: my-skill                 # required, kebab-case
description: What it does      # required
when-to-use: Optional hint     # optional (also accepts `whenToUse`)
disable-model-invocation: true # optional; keeps it out of model catalogs
user-invocable: false          # optional; hides it from human commands
---
```

The invocation keys use the same strict boolean grammar as Harness
(`true/false`, `yes/no`, `on/off`, `1/0`, case-insensitive). A rejected spelling
drops the whole skill with a warning rather than silently permitting a surface.

## 2. Conversation vault

### Where it writes

```
<project>/.dsh/conversations/
├── index.json                         # every archived conversation for this project
└── <session-id>/
    ├── conversation.jsonl             # durable record: 1 metadata line + 1 line per message
    └── conversation.md                # readable transcript
```

Included per conversation: your messages, assistant replies (text and tool
calls), and tool results clamped to `maxToolResultChars`. Injected runtime
context is excluded by default; model reasoning blocks are never written.

### When it runs

- **Automatically** on `session/title` (to capture the title early) and on
  `turn/end` (the durable boundary of one exchange), plus once for every
  already-open session of the project when the plugin activates.
- **On demand** through the tools below.

### Reading durable logs

Harness persists sessions under `$DSH_HOME/sessions/<mangled-project-path>/`
as a **concatenation of independently compressed zstd frames** — one frame per
durable write. Node's `zstdDecompressSync` and `createZstdDecompress()` both
stop at the first frame boundary, so `lib/zstd.js` walks the frames itself using
the zstd frame-header layout and decompresses each one with Node's built-in
codec. A frame still being written is reported rather than thrown away, so a
live session never loses its already-durable frames.

The project directory name is reproduced exactly as the persistence codec
mangles it (`F:\QwenTTS_Fn2` → `--F-QwenTTS_Fn2--`), so discovery finds an
existing project's logs. Logs filed under a different slug but recording this
project as `cwd` are also found, which covers a moved or renamed project.

## 3. Publishing archives as real sessions

An archived conversation can be materialized back into DSH's session store, so
the workspace sidebar lists it and it opens and resumes like any other session.

**What it writes.** A new session through `ctx.sessionPersistence` — the backend
owns the encoding (checksummed zstd frames), the header frame, and the
`flush()` durability barrier. The original session log is never touched: an
imported session is always a new file under a new id.

**Whose cwd it gets.** The project root of the vault that owns the `.dsh`
folder, **not** the `cwd` recorded inside the archive. A project folder is
expected to own the conversations under its own `.dsh`, so dropping a
conversation file into `.dsh/conversations/` surfaces it in *that* workspace's
sidebar. Trusting the archive's own `cwd` would file it under whatever project
it was originally recorded in, and a conversation copied in from another machine
would appear in no workspace at all. When the two differ, the recorded path is
reported as `origin` so the conversation stays traceable.

**Faithful, not reconstructed.** Imports replay the archive's verbatim events
(`events.jsonl`). The normalized transcript cannot be used as the source: the
loader validates an `assistant/message` against fields the transcript does not
keep (`assertAssistantSettlementShape` requires `turn`, `step`, and a `stream`
array), so a session rebuilt from the transcript alone would fail to open.
Sequence numbers are renumbered to be contiguous from 0, with `sourceEventSeqs`
remapped to match.

**Idempotent.** The target id is derived from `sha256(projectRoot + sourceId)`,
so re-publishing the same conversation targets the same session and is skipped —
even if the archive's import ledger is lost.

**When it runs.** On activation, and after each automatic export at `turn/end`.
Two sources are scanned, because a project someone already used has its archive
on disk but may have no live session:

1. every open session, each into its own project folder;
2. every workspace in `ctx.workspaceRegistry` — the bounded, authoritative list
   of real project folders — so an archive belonging to a project with no open
   session is still published.

Exports and publishing are independent switches; `autoImport` works with
`autoExport` off.

## 4. Importing a shared Trae conversation

A Trae **share** link is a public, read-only transcript of one Trae SOLO
conversation. `conversation_import_share` turns one into a session of the
calling project:

```
share.traecontent.cn/api/remote/v1/share/<id>            metadata
share.traecontent.cn/api/remote/v1/share/<id>/messages   the turns
          |
          v
   convertShare()  →  contiguous DSH events  →  SessionVault.adopt()  →  sidebar
```

**Events are the source of truth.** The archive's `conversation.jsonl` is derived
from the converted events with the vault's own `normalizeConversation`, not built
in parallel, so the readable transcript and the importable log cannot disagree.
The conversion is checked against `firstStructuralViolation`, the same contract
the loader enforces: one turn per question, each assistant step inside an open
step and turn, every advertised tool call matched by a `tool/call` and a result,
a `session/title` that cites only distinct *earlier human* `user/message` events,
and step numbers that follow the loader's own cursor.

Two of those rules are not decoration — both were shipped bugs, and each one made
the conversation list in the sidebar and then refuse to open:

- **A title cites the question, not the turn.** `messageSeqs` is a sequence
  number, and reading the handle one statement too early captures `turn/start`
  instead. The loader rejects the **entire** log: `session/title messageSeqs must
  cite distinct earlier human user/message events`.
- **Steps are numbered by one cursor per turn.** `turn/start` resets the loader's
  `nextStep` to 1 and every `step/start` must equal it. Hardcoding the question's
  step to 1 and restarting the assistant's items at 1 emits `1, 1, 2` and fails
  with `step/start does not match the open turn and next step`.

`firstStructuralViolation` now checks both, so a converter that regresses fails
`test/selfcheck.mjs` instead of shipping a session nobody can read.
`checks/share-verify-import.mjs` re-checks them against a session already in the
store, and `checks/session-retire-broken.mjs` reports (or retires) stored sessions
this workspace lists but DSH cannot open — which is the symptom both bugs produced.

**Tool results are not invented.** A share strips the payload of most tool
results — 18 of the 38 calls in the share this was built against keep nothing
but a status. What the share does keep (a `finish` summary, a grep result, a file
diff) is preserved verbatim, and everything else is recorded as an explicit
`"(Trae's share does not include this call's output)"` rather than as an empty
success, which would read as "the tool returned nothing".

**`finish` becomes the reply.** Trae's agent hands over its answer by calling
`finish`; recording that as a tool call would leave the reader with a tool named
`finish` and no answer, so its `summary` is emitted as the assistant's text.

**Time is read at one offset.** Trae stamps a turn with the wall clock of whoever
asked, so one share mixes `+08:00` and `Z`. Reading each stamp at its own offset
interleaves the turns; the offset most of them agree on wins, and the
conversation's own bounds come from its turns — never from `meta.created_at`,
which is when the share was *published* and can be weeks later.

**Idempotent.** The archive id is `trae-share-<slugged share id>`, and the
published session id is derived from it, so re-importing the same link rewrites
the same archive and resolves to the same session.

```yaml
share:
  enabled: true
  apiBase: https://share.traecontent.cn   # API origin, and the host links are cited from
  timeoutMs: 30000
  autoPublish: true                       # archive + publish in one call
  agentPreset: standard                   # a share records none, and a session cannot resume without one
  maxToolResultChars: 2000
  headers: {}                             # extra request headers, when a deployment needs them
```

`publish: false` archives without creating a session; `conversation_publish`
publishes it later. This is the only capability in the bundle that reaches the
network, and the only one that reads anything outside the machine.

### The `-2` sessions, and what was actually fixed

Importing the linked share produced **two** stored sessions for one conversation —
`session-8c8624bb-…` and `session-8c8624bb-…-2` — and it happened twice, 87 ms
after the first write. It is worth separating what was fixed from what was not,
because only one of the two has a reproduction.

**Fixed and reproducible: `index.json` updates could lose each other.**
`updateIndex` and `recordImport` are both read-modify-write cycles over one file,
and a publish pass runs them while a scan started by that same publish runs the
same cycles. Interleaved, the second write is built from the state the first one
read, so the first publish's ledger row is gone. The regression
(`vault: concurrent index writes cannot lose each other`) fails without the fix,
showing one of two conversations missing from the index entirely. Both mutations
now go through `queueIndexWrite`, so every read happens inside the lock.

A second, narrower hardening: a ledger row naming a session that no longer exists
is pointed back at the derived id before any id is chosen
(`vault: a ledger naming a missing session is repaired, not left stale`). A row
naming a missing session is worse than no row, because it reads as "published
somewhere else".

**Not fixed: adopting a session that exists but cannot be read back.** This is the
part that actually mints the `-2` name, and it is reproduced exactly: publish a
conversation, delete the published session, clear its ledger row, and import the
same share again. `pickSessionId` keeps an occupied id only when it reads back —
the right instinct for a log of unknown provenance — so an unreadable artifact is
stepped over and a copy lands beside it, which is what the two ids and the 87 ms
in the trace are.

It is not fixed because the state is not decidable here. `materialize` stamps
`cwd: this.projectRoot` on every session it publishes, so a session this vault
published and then lost membership of, and a session an archive folder carried in
from another project, are identical in every field available: same derived id,
same `cwd`, same ledger row. Telling them apart broke
`a session outside its workspace gets a copy under a fresh id`, which is the case
that must win — silently reusing the other project's session shows a workspace a
conversation filed somewhere else. The distinguishing fact would have to be
recorded when the session is published, and nothing does that yet; that is the
change to make next.

## Agent tools

| Tool | Purpose |
|---|---|
| `conversation_list` | Archived conversations + stored-but-unarchived sessions |
| `conversation_read` | Transcript of one conversation (`markdown`, `json`, or `jsonl`) |
| `conversation_export` | Archive the current session, a named live session, or all of this project's live sessions |
| `conversation_sync_from_disk` | Import stored Harness sessions for this project into the archive |
| `conversation_publish` | Materialize archived conversations as real, resumable DSH sessions |
| `conversation_import_share` | Import a shared Trae conversation (a `share.traecontent.cn` link) as a session of this project |
| `conversation_workspaces` | Report which sessions the workspace registry attributes to each workspace |
| `trae_skill_list` | The Trae skills currently invocable, with source file |

`conversation_read` accepts a full session id or any unique suffix (for example
`b0b7045`).

## Configuration

Overridable in the profile's `cordis.patch.yml` under the `trae-vault` row:

```yaml
- id: trae-vault
  config:
    enabled: true
    debugLog: ''                      # '' uses $DSH_HOME/trae-session-vault.activation.log
    skills:
      enabled: true
      providerName: trae
      customDirs: []                  # extra SKILL.md roots, absolute or relative
      scanUserHome: true              # also scan ~/.trae/skills
      watch: true
      recursiveWatch: true
      watchDebounceMs: 250
      maxDepth: 6
    vault:
      enabled: true
      directory: .dsh/conversations   # relative to the project, or absolute
      autoExport: true                # archive conversations into the project
      autoImport: false               # publish archives back as real DSH sessions
      includeRuntimeContext: false
      maxToolResultChars: 2000
      readGlobalSessions: true
      sessionsRoot: ''                # defaults to $DSH_HOME/sessions
    share:
      enabled: true
      apiBase: https://share.traecontent.cn
      timeoutMs: 30000
      autoPublish: true
      agentPreset: standard
      maxToolResultChars: 2000
      headers: {}                     # free-form; survives validation as written
```

`debugLog` is written with `node:fs`, and an unwritable target is swallowed on
purpose — diagnostics must never break activation. The cost is that a stale path
silently buys you no trace at all.

## Layout

| File | Role |
|---|---|
| `index.js` | Stable entry: resolves `impl.r<REVISION>.js` and re-exports it |
| `impl.r<REVISION>.js` | The implementation: `apply`, `inject`, `Config`, wiring |
| `lib/skills.trae2.js` | Trae skill discovery, frontmatter parsing, root walking, watching |
| `lib/vault.trae2.js` | Session-log parsing, normalization, archive storage, publishing |
| `lib/zstd.trae2.js` | Multi-frame zstd reader |
| `lib/tools.trae2.js` | The eight agent tools |
| `lib/share.trae2.js` | Share-link parsing, API fetch, Trae→DSH conversion |

### Why the entry is a thin loader

The Harness module loader caches a module job per resolved URL, so a bundle
replaced on disk keeps executing the generation it first imported. Measured
behaviour: toggling the bundle (`plugin_manager` disable/enable) and reinstalling
the package originally **did not** re-import the entry — the process was still
running generation 8 after `REVISION` had been raised to 10.

`index.js` still resolves a versioned generation, so whichever generation is
actually in flight is identifiable: the trace's first line names it. **Bump
`REVISION` and edit `impl.r<REVISION>.js` together.**

That per-URL cache applies to the generation's *own* imports too, which is
subtler and was measured the hard way. A bare `./lib/vault.trae2.js` resolves to
one URL for the life of the process, so raising `REVISION` reloaded the
generation and then re-wired it to the **previous** lib modules: the file on
disk, the tests, and every check agreed while the running plugin kept answering
from the old code — `force: true` still reported "already present" after the
replace path had been fixed. The generation therefore stamps `?v=<REVISION>` onto
each lib specifier. A static specifier cannot interpolate, so the token is a
literal; `test/activation.mjs` asserts it equals `REVISION`, which turns a
forgotten restamp into a failing test instead of a stale plugin.

The bundle must also be *installed* from an existing path for DSH to resolve it
at all: a profile `link:` dependency pointing at a checkout that no longer exists
makes the bundle unresolvable, and the plugin silently never activates. Reinstall
with `plugin_manager install_bundle` (or `dsh plugin --profile <name> install`)
after moving the checkout. That install reports `restart-required`, and a live
Host does pick up a new generation and register the new tool set without one — so
check the tool list before restarting. A session published *before* the plugin
loaded exists in the store and is listed by the workspace registry, but the
sidebar only learns about it from the `session/created` announcement, so reload
the page (or call `conversation_publish` with `force: true`) to see it.

## Dependencies

None. `Config` implements the Standard Schema interface the Host reads
(`Config['~standard'].validate`), so the plugin needs no schema package. That
matters because a linked profile bundle's bare imports resolve through whatever
`node_modules` happens to sit above the checkout, which is a poor thing to
depend on.

## Tests

```
node test/selfcheck.mjs    # zstd, frontmatter, discovery, normalization, archive round-trip, share conversion
node test/activation.mjs   # apply() against a mock context: provider, tools, export, publish, share import
../checks/config-shapes.mjs   # the Config contract, tool schemas, registration guard
../checks/schema-shape.mjs    # emitted output.schema against the enforced subset
```

All run on the DSH runtime's Node and need no installed packages.
`test/fake-persistence.mjs` stands in for the session store — the tests never
write to a real one — while validating headers and events the way the loader
does (`assistant/message` must embed a `stream`, `seq` must be contiguous, `cwd`
must be absolute). Mocks mirror `dsh-tools`' own `register()` guard, because a
missing `output.render` and a non-object-rooted `parameters` each once passed
every test while failing in the Host.

`test/activation.mjs` loads the package the way DSH does, by path from
`process.cwd()`, so run it from the directory that *contains* this folder:

```
cd .. && node dsh-trae-vault/test/activation.mjs
```

`checks/config-shapes.mjs` and `checks/schema-shape.mjs` are the workspace-level
contract checks; they import the package by relative path, so they are only
available from a development checkout, not from a bare clone.

The share path can be exercised end to end against the live service:

```
node test/share-import-live.mjs [shareUrl]
```

fetches a real share, converts it, archives it into a throwaway project folder,
and publishes it through a persistence double that validates every event the way
the loader does. The remaining `test/share-*.mjs` and `test/session-*.mjs` scripts
are diagnostics, each taking its inputs as arguments: `share-convert-real.mjs` and
`share-timeline.mjs` report an event timeline for a saved messages payload,
`share-verify-import.mjs` checks a published session against the loader contract,
`session-retire-broken.mjs` lists (or retires) stored sessions DSH cannot open,
and `share-probe-msgseqs.mjs` prints the emit order a conversion actually
produces — which is how the two `session/title` and step-numbering bugs were
found.

