import { z } from "zod";
import { readLineFile, writeLineFile, spliceLines, type LineFile } from "../doc/linefile.js";
import { splitBlocks, type Block } from "../doc/blocks.js";
import { assertExpect, blockAt, renumber } from "../doc/number.js";
import { appendEdit } from "../log/editlog.js";
import { defineTool, type ToolContext } from "./index.js";

const EXPECT_DESC =
  "Copy at least 4 characters from the start of the targeted block exactly as it appears " +
  "in the draft. If the ordinal no longer matches, the write is rejected instead of editing " +
  "the wrong location.";

/** Strip any `NNN│` prefix the model echoed back, and normalize line breaks. */
function cleanIncoming(text: string): string[] {
  const stripped = text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.replace(/^\s*\d+\s*│/, "").replace(/^\s*│/, ""));
  while (stripped.length && !stripped[0].trim()) stripped.shift();
  while (stripped.length && !stripped[stripped.length - 1].trim()) stripped.pop();
  return stripped;
}

/**
 * Turn the model's text into lines, with blank lines between the paragraphs it
 * separated by blank lines, so replacing one block with several works naturally.
 */
function bodyLines(text: string): string[] {
  const lines = cleanIncoming(text);
  const out: string[] = [];
  let prevBlank = false;
  for (const l of lines) {
    const blank = !l.trim();
    if (blank && prevBlank) continue;
    out.push(blank ? "" : l);
    prevBlank = blank;
  }
  return out;
}

interface Applied {
  before: Block[];
  after: Block[];
  file: LineFile;
}

function apply(ctx: ToolContext, mutate: (f: LineFile, blocks: Block[]) => LineFile): Applied {
  const file = readLineFile(ctx.project.draftPath);
  const before = splitBlocks(file);
  const mutated = mutate(file, before);
  const written = writeLineFile(mutated);
  return { before, after: splitBlocks(written), file: written };
}

function report(
  ctx: ToolContext,
  tool: string,
  where: string,
  beforeText: string,
  afterText: string,
  a: Applied,
  anchor: number,
): string {
  const diff = appendEdit(
    ctx.project.logPath,
    { tool, where, before: beforeText, after: afterText },
    ctx.project.draftName,
  );
  ctx.onEdit?.(`${tool} · ${where}\n${diff}`);
  const r = renumber(a.before, a.after, anchor);
  const shift =
    r.delta === 0
      ? "The total block count is unchanged; later ordinals stay the same."
      : `Block count ${a.before.length} → ${r.totalBlocks} (${r.delta > 0 ? "+" : ""}${r.delta}); ` +
        `ordinals after block ${anchor} have shifted.`;
  return `Wrote ${ctx.project.draftName}. ${shift}\n\nCurrent ordinals around the edit:\n\n${r.context}`;
}

export const revise = defineTool({
  name: "revise",
  description:
    "Replace blocks from `from` through `to`, inclusive. Pass an empty `text` to delete them. " +
    "For a `---` annotation, set `from` to the annotated block and `to` to the note block " +
    "so the target, separator, and note are replaced together and the annotation disappears.",
  schema: z.object({
    from: z.number().int().min(1).describe("Starting block ordinal, inclusive"),
    to: z.number().int().min(1).describe("Ending block ordinal, inclusive"),
    expect: z.string().describe(EXPECT_DESC),
    text: z.string().describe("Replacement text without NNN│ ordinal prefixes; separate paragraphs with blank lines."),
  }),
  run: ({ from, to, expect, text }, ctx) => {
    if (to < from) throw new Error(`to (${to}) cannot be less than from (${from}).`);
    const a = apply(ctx, (file, blocks) => {
      assertExpect(blocks, from, expect);
      const first = blockAt(blocks, from);
      const last = blockAt(blocks, to);
      const body = bodyLines(text);
      // An empty body would leave the surrounding blank lines adjacent; drop the
      // trailing blank line with the deleted range so no double gap remains.
      let hi = last.to;
      if (!body.length && hi + 1 < file.lines.length && !file.lines[hi + 1].trim()) hi += 1;
      return spliceLines(file, first.from, hi, body);
    });
    const beforeText = a.before
      .filter((b) => b.n >= from && b.n <= to)
      .map((b) => b.text)
      .join("\n\n");
    return report(ctx, "revise", `${from}-${to}`, beforeText, cleanIncoming(text).join("\n"), a, from);
  },
});

export const insert = defineTool({
  name: "insert",
  description: "Insert new paragraphs after block `after`.",
  schema: z.object({
    after: z.number().int().min(1).describe("Block ordinal after which to insert"),
    expect: z.string().describe(EXPECT_DESC),
    text: z
      .string()
      .describe("Text to insert without NNN│ ordinal prefixes; separate paragraphs with blank lines."),
  }),
  run: ({ after, expect, text }, ctx) => {
    const body = bodyLines(text);
    if (!body.length) throw new Error("text is empty; there is nothing to insert.");
    const a = apply(ctx, (file, blocks) => {
      const anchor = assertExpect(blocks, after, expect);
      return spliceLines(file, anchor.to, anchor.to, [
        file.lines[anchor.to],
        "",
        ...body,
      ]);
    });
    return report(ctx, "insert", `after ${after}`, "", cleanIncoming(text).join("\n"), a, after);
  },
});

export const append = defineTool({
  name: "append",
  description:
    "Append text to the end of the draft. Include an `##` heading in `text` when starting a new chapter.",
  schema: z.object({
    text: z
      .string()
      .describe("Text to append without NNN│ ordinal prefixes; separate paragraphs with blank lines."),
  }),
  run: ({ text }, ctx) => {
    const body = bodyLines(text);
    if (!body.length) throw new Error("text is empty; there is nothing to append.");
    const a = apply(ctx, (file) => {
      const lastIdx = file.lines.length - 1;
      const tail = file.lines[lastIdx];
      // A file ending in a newline has an empty final line carrying the empty
      // terminator. The body must go BEFORE that remainder, or it inherits the
      // empty terminator and the file silently loses its trailing newline.
      const replacement = tail.trim()
        ? [tail, "", ...body]
        : ["", ...body, ""];
      return spliceLines(file, lastIdx, lastIdx, replacement);
    });
    const anchor = a.before.length ? a.before[a.before.length - 1].n : 1;
    return report(ctx, "append", "end", "", cleanIncoming(text).join("\n"), a, anchor);
  },
});
