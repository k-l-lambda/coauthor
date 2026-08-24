# coauthor

A creative-writing agent harness. The agent gets a closed set of document-aware
tools instead of generic file access, so it spends its attention on prose rather
than on line offsets and marker bookkeeping.

## Usage

```sh
npm install && npm run build

coauthor check path/to/project        # validate the project, no model call
coauthor dev-prompt path/to/project   # print the assembled system prompt
coauthor path/to/project              # start the REPL
```

During development use `npm run dev -- <args>` in place of `coauthor`.

A writing project is a directory containing:

- `main.md` — the draft. Fixed by convention, so write tools take no filename.
- `AGENT.md` — the task in plain language; doubles as the system prompt.

## Configuration

Put a `.env.local` beside `AGENT.md`, or in the directory you run coauthor from. Copy
`.env.example` to start.

| Variable | Default | Purpose |
|---|---|---|
| `COAUTHOR_AUTH_TOKEN` | — | Credential. Checked before `COAUTHOR_API_KEY`. |
| `COAUTHOR_API_KEY` | — | Alternative credential name. |
| `COAUTHOR_BASE_URL` | `https://api.anthropic.com` | An Anthropic-compatible proxy. |
| `COAUTHOR_MODEL` | `claude-sonnet-4-6` | Any model the base URL serves. |
| `COAUTHOR_MAX_TOKENS` | `8192` | Response cap per model call. |
| `COAUTHOR_EFFORT` | `off` | Extended-thinking strength: `off`, `low`, `medium`, or `high`. |

**Only `COAUTHOR_*` is read.** An `ANTHROPIC_*` variable in the shell is ignored, so a
proxy or model exported for some other tool cannot redirect this project. `baseURL` is
always passed to the SDK explicitly for the same reason — given `undefined` the SDK
reads `ANTHROPIC_BASE_URL` itself. `check` lists any it finds:

```
!   ignored           ANTHROPIC_BASE_URL, ANTHROPIC_MODEL — coauthor reads COAUTHOR_* only
```

### Where it looks

Two locations, most specific first:

1. `<project>/.env.local` — the project's own model and proxy
2. `<cwd>/.env.local` — a fallback, so one credential can serve every project
3. the shell environment

The project file wins, because a project that pins a model must not be redirected by
where the command happened to be typed. The working-directory file exists so a token
need not be copied into every writing project, which is both tedious and multiplies the
number of files holding a live secret. Keeping only the credential in the cwd file and
letting each project pin its own model is the arrangement with the fewest copies.

When you run coauthor from inside a project the two paths are the same file, and it is
reported once. `check` labels each file by scope and says which variables lost:

```
ok  .env.local        1 variable project · test/cases/collapse/.env.local
ok  .env.local        3 variables cwd · .env.local — COAUTHOR_MODEL overridden by a higher-priority file
```

If nothing supplies a credential, the error names every path that was searched, since
"set it in `.env.local`" is unhelpful when the file exists one directory away:

```
--  credential        missing. Set COAUTHOR_AUTH_TOKEN in ../proj/.env.local or .env.local
```

Both files **override variables already set in the shell**, unlike Node's own
`process.loadEnvFile`. A shell exporting `COAUTHOR_MODEL` for another project would
otherwise silently defeat this project's choice, and the failure would look like
coauthor ignoring its configuration. `check` prints each value's source:

```
ok  model             deepseek/deepseek-v4-pro (.env.local, overrode environment)
ok  base url          https://apiproxy.paigod.work (.env.local)
ok  credential        RDb1I3********Lxmk via COAUTHOR_AUTH_TOKEN (.env.local)
```

It also flags a variable coauthor does not read, which catches typos:

```
!   .env.local        COAUTHOR_MODLE is not a variable coauthor reads
```

`.env.local` is gitignored; `.env.example` is not, so keep real tokens out of it.

## AGENT.md

Write it as prose. Reference a setting document with `#[label](path)` and its full
text is inlined into the system prompt, so the agent sees the whole thing at once:

```markdown
你是一个优秀的科幻小说写作助手。

#[设定文档](setting-notes.md)

保持正文中的文字风格，以蒲松龄式古灵精怪为特色。
```

A missing include target is a startup error, never a silent omission.

## How the agent addresses the draft

The full draft is injected into the system prompt with an ordinal on every
paragraph (headings included):

```
 86│“这就要说到鬼像了。”顾文笑了…
 87│---
 88│太罗嗦了。顾文应该说前面这三个是本体…
```

Writes locate by ordinal. `NNN│` is a harness-added marker, not manuscript content,
and is stripped if a model echoes it back.

**Annotations.** A lone `---` line means the paragraph above it is under review and
the paragraph below is the note. Closing it out is one call — `revise(86, 88, …)` —
which replaces target, separator and note in a single splice, so the marker
disappears without a second step. `[[……]]` paragraphs are suggestive scaffolding,
replaced the same way.

**`expect`.** Write tools require the opening characters of the block being
targeted, copied from the draft. A stale or wrong ordinal is refused with an error
instead of writing to the wrong place.

## Tools

| Tool | Purpose |
|---|---|
| `read_draft(from?, to?)` | Re-read numbered paragraphs; ordinals shift after each write |
| `read_setting(file, heading)` | Heading-scoped read of a setting document (read-only) |
| `revise(from, to, expect, text)` | Replace paragraphs; empty `text` deletes |
| `insert(after, expect, text)` | Insert after a paragraph |
| `append(text)` | Append at the end |

No shell, no generic file access, no writes outside `main.md`.

## Sessions and the edit log

Every turn is a fresh session — nothing accumulates. The system prompt is rebuilt
from disk each time, so it always reflects the current files and the previous turn's
writes are simply visible in the next one.

There are no write confirmations. Each mutation appends a unified diff to
`.coauthor/edit-log.md`; `/log` in the REPL shows recent entries. Review happens
after the fact rather than interrupting the writing.

## Notes

- Byte fidelity is structural: a file is a line array plus per-line terminators, and
  every mutation splices both. Line endings are detected per file (`main.md` may be
  CRLF while `setting-notes.md` is LF), a BOM is preserved but never added, and
  writes are atomic with a stale-file check.
- Markdown is split by a line-based splitter, not an AST. A lone `---` is always an
  annotation separator, never a setext heading underline — a markdown round-trip
  would otherwise rewrite the prose above it into a heading.
- Character counts are codepoints, not bytes or UTF-16 units.
