import { z } from "zod";
import { readLineFile, writeLineFile, spliceLines, type LineFile } from "../doc/linefile.js";
import { splitBlocks, type Block } from "../doc/blocks.js";
import { assertExpect, blockAt, renumber } from "../doc/number.js";
import { appendEdit } from "../log/editlog.js";
import { defineTool, type ToolContext } from "./index.js";

const EXPECT_DESC =
  "被定位那个自然段开头的至少 4 个字符，从正文原文照抄。序号对不上时写入会被拒绝，不会改错地方。";

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
      ? "段落总数未变，后续序号不变。"
      : `段落总数 ${a.before.length} → ${r.totalBlocks}（${r.delta > 0 ? "+" : ""}${r.delta}），` +
        `第 ${anchor} 段之后的序号已移位。`;
  return `已写入 ${ctx.project.draftName}。${shift}\n\n改动后该处的最新序号：\n\n${r.context}`;
}

export const revise = defineTool({
  name: "revise",
  description:
    "用 text 替换第 from 到第 to 个自然段（含两端）。text 传空字符串即删除这些段落。" +
    "处理 `---` 附注时：from 取被批注段落的序号，to 取批注文字的序号，" +
    "这样目标段、`---`、批注文字会在同一次操作中一起被替换，标记自动消失。",
  schema: z.object({
    from: z.number().int().min(1).describe("起始自然段序号（含）"),
    to: z.number().int().min(1).describe("结束自然段序号（含）"),
    expect: z.string().describe(EXPECT_DESC),
    text: z.string().describe("改写后的正文，不要带 NNN│ 序号前缀。段落之间用空行分隔。"),
  }),
  run: ({ from, to, expect, text }, ctx) => {
    if (to < from) throw new Error(`to (${to}) 不能小于 from (${from})。`);
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
  description: "在第 after 个自然段之后插入新段落。",
  schema: z.object({
    after: z.number().int().min(1).describe("在这个序号的自然段之后插入"),
    expect: z.string().describe(EXPECT_DESC),
    text: z.string().describe("要插入的正文，不要带 NNN│ 序号前缀。段落之间用空行分隔。"),
  }),
  run: ({ after, expect, text }, ctx) => {
    const body = bodyLines(text);
    if (!body.length) throw new Error("text 为空，没有可插入的内容。");
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
  description: "追加到正文末尾。新增章节时把 ## 标题一并写在 text 里。",
  schema: z.object({
    text: z.string().describe("要追加的正文，不要带 NNN│ 序号前缀。段落之间用空行分隔。"),
  }),
  run: ({ text }, ctx) => {
    const body = bodyLines(text);
    if (!body.length) throw new Error("text 为空，没有可追加的内容。");
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
