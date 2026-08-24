# Test cases

Each directory is a complete writing project. `cases.test.ts` discovers them
automatically and runs the same four checks against every one: byte-identical
round-trip, prompt assembly, annotation close-out, and line-ending preservation
through a write. Adding a directory is enough — no registration.

A case needs `AGENT.md` and `main.md`. Anything else it contains is a setting
document, either inlined into the prompt via `#[label](path)` or left for
`read_setting`.

| Case | Draft | Covers |
|---|---|---|
| `collapse` | CRLF | Minimal shape: one note annotation, no include, no heading. |
| `showcase` | LF | The whole feature surface. See below. |

## `showcase`

Deliberately covers every path at once, so a regression has something to fail
against. `showcase.test.ts` asserts these features are *present* — the generic
suite would still pass if the fixture quietly lost its fence or its skeleton, and
then nothing would be testing those.

- **All six block kinds**: heading, paragraph, list, separator, fence, skeleton.
- **Multi-line paragraphs** — one ordinal each, continuation lines aligned under it
  with no number of their own.
- **Both annotation kinds**: a `---` note (spanning target + separator + note) and a
  `[[…]]` skeleton (one ordinal).
- **Both separator shapes.** Block 11 has a blank line above it; block 18 does not,
  which is the CommonMark setext-underline trap — an AST round-trip would re-emit
  that paragraph as `## 调查组三个月后才来…` and corrupt the manuscript. This is why
  the splitter is line-based.
- **Mixed line endings in one directory**: `main.md` is LF, `world.md` is CRLF.
  Detection is per file, so writing the draft must leave the include untouched. The
  real s3 corpus has this mix in the opposite direction.
- **Include expansion**: `world.md` is inlined in full by `AGENT.md`.
- **`read_setting`**: `glossary.md` is deliberately *not* included, so the tool has
  real work to do. Its nested headings exercise depth-scoped extraction.

## Line endings

`.gitattributes` marks `test/cases/**` as `-text`. Line endings here are the thing
under test, so git must not normalize them — a CRLF fixture rewritten to LF on
commit would silently stop testing CRLF and come back wrong in a fresh clone. A test
compares each fixture against its committed bytes to guard that exemption.

## Running the harness against a case

Safe — but it edits the fixture in place and leaves a gitignored `.coauthor/`
edit log behind. Restore with `git checkout test/cases/<name>/main.md` afterwards,
or the committed-bytes test will fail.
