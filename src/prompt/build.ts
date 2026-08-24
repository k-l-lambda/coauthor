import { readLineFile } from "../doc/linefile.js";
import { splitBlocks, findAnnotations, type Block } from "../doc/blocks.js";
import { renderNumbered, stats } from "../doc/number.js";
import { expandAgentMd, type Include } from "./agentmd.js";
import { toPosix, type Project } from "../project.js";

const BASE = `You are a writing assistant that edits a draft directly through a dedicated set of tools.
You have no shell or generic file access; make every change through the five tools below.

## Addressing the draft

The "Current draft" section below contains the complete draft. Every block, including headings, has an
\`NNN│\` ordinal prefix. These prefixes are **external location markers added by the harness, not draft
content**. Never include an ordinal prefix or the \`│\` character in text you write back.

## Tools

- \`read_draft(from?, to?)\` — Read a numbered excerpt of the draft again. **Ordinals can shift after
  every write; obtain current ordinals before editing another location.**
- \`read_setting(file, heading)\` — Read one heading-scoped section of a setting document. Do not call
  it for a setting document already included in full in this prompt.
- \`revise(from, to, expect, text)\` — Replace blocks \`from\` through \`to\`, inclusive, with \`text\`.
  Pass an empty string as \`text\` to delete those blocks.
- \`insert(after, expect, text)\` — Insert new blocks after block \`after\`.
- \`append(text)\` — Append text to the end of the draft.

Write tools can modify only the draft. Setting documents are read-only.

## The expect parameter

\`revise\` and \`insert\` require \`expect\`: copy at least four characters from the start of the targeted
block exactly as they appear in the draft. If the ordinal is stale or wrong, the write is rejected instead
of editing the wrong location.

## Annotation protocol

A standalone \`---\` line marks an annotation: the block **above** it is the target and the block **below**
it is the note. Resolve one with a **single \`revise\` call**: set \`from\` to the target block's ordinal,
\`to\` to the note block's ordinal, and \`text\` to the rewritten draft text. This replaces the target,
separator, and note together, so the annotation disappears without a second deletion. A note may also
request changes to subsequent blocks; extend \`to\` when necessary.

A block in the form \`[[……]]\` is suggested scaffolding. Rewrite it according to its instruction rather
than copying it, and complete any ellipsis. Replace it with \`revise(N, N, expect, new_text)\`.

## Editing multiple locations in one turn

When editing several locations in one turn, work **from higher ordinals to lower ordinals** so earlier
ordinals remain valid. Alternatively, use the updated ordinal context returned by each write or call
\`read_draft\` again.`;

export interface PromptContext {
  system: string;
  blocks: Block[];
  includes: Include[];
  draftCodepoints: number;
  pendingAnnotations: number;
}

/**
 * Assemble the system prompt from three layers: this harness's tool contract, the
 * project's AGENT.md with its includes expanded, and the full numbered draft.
 *
 * Rebuilt from disk every turn. Because sessions do not accumulate, the prompt is
 * always the current state of the files — there is no cross-turn staleness, and
 * writes from the previous turn are simply visible in the next one.
 */
export function buildPrompt(project: Project): PromptContext {
  const { text: agentMd, includes } = expandAgentMd(project.agentPath, project.root);
  const draft = readLineFile(project.draftPath);
  const blocks = splitBlocks(draft);
  const s = stats(blocks);
  const pending = findAnnotations(blocks);

  const pendingNote = pending.length
    ? `\n\nThis turn has ${pending.length} pending marker${pending.length === 1 ? "" : "s"}: ` +
      pending
        .map((a) =>
          a.kind === "note"
            ? `blocks ${a.from}–${a.to} (\`---\` annotation)`
            : `block ${a.from} (scaffolding)`,
        )
        .join(", ") +
      "."
    : "";

  const system = [
    BASE,
    `# Writing requirements\n\n${agentMd.trim()}`,
    `# Current draft (${toPosix(project.root)}/${project.draftName}; ${s.blocks} blocks, ` +
      `${s.codepoints} codepoints)${pendingNote}\n\n${renderNumbered(blocks)}`,
  ].join("\n\n---\n\n");

  return {
    system,
    blocks,
    includes,
    draftCodepoints: s.codepoints,
    pendingAnnotations: pending.length,
  };
}
