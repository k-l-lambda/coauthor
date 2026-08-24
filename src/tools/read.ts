import { z } from "zod";
import { existsSync, readFileSync } from "node:fs";
import { join, isAbsolute, resolve } from "node:path";
import { readLineFile } from "../doc/linefile.js";
import { splitBlocks } from "../doc/blocks.js";
import { renderNumbered } from "../doc/number.js";
import { defineTool } from "./index.js";


export const readDraft = defineTool({
  name: "read_draft",
  description:
    "重新读取带序号的正文片段。每次写入后序号会移位，继续改别处前先用它取最新序号。" +
    "不带参数则返回全文。",
  schema: z.object({
    from: z.number().int().min(1).optional().describe("起始自然段序号（含）"),
    to: z.number().int().min(1).optional().describe("结束自然段序号（含）"),
  }),
  run: ({ from, to }, ctx) => {
    const blocks = splitBlocks(readLineFile(ctx.project.draftPath));
    const last = blocks.length ? blocks[blocks.length - 1].n : 0;
    const lo = from ?? 1;
    const hi = to ?? last;
    const slice = blocks.filter((b) => b.n >= lo && b.n <= hi);
    if (!slice.length) return `正文共 ${last} 段，没有第 ${lo}–${hi} 段。`;
    return `正文共 ${last} 段。第 ${lo}–${Math.min(hi, last)} 段：\n\n${renderNumbered(slice)}`;
  },
});

export const readSetting = defineTool({
  name: "read_setting",
  description:
    "按标题读设定文档中的某一节。已在提示词中完整给出的设定文档不必再读此工具。" +
    "设定文档是只读的。",
  schema: z.object({
    file: z.string().describe("设定文档文件名，相对项目目录，例如 setting-notes.md"),
    heading: z
      .string()
      .describe("标题文本或其前缀，例如 “2. 全局几何” 或 “回像、近像与远像”。取该标题下直到同级或更高级标题之前的内容。"),
  }),
  run: ({ file, heading }, ctx) => {
    if (isAbsolute(file) || file.includes("..")) {
      throw new Error(`file 必须是项目目录内的相对路径，收到 ${file}`);
    }
    const abs = resolve(ctx.project.root, file);
    if (!abs.startsWith(resolve(ctx.project.root))) {
      throw new Error(`file 必须在项目目录内，收到 ${file}`);
    }
    if (file === ctx.project.draftName) return `正文请用 read_draft 读取。`;
    if (!existsSync(abs)) throw new Error(`项目目录下没有 ${file}`);

    const blocks = splitBlocks(readLineFile(abs));
    const want = heading.trim().toLowerCase();
    const idx = blocks.findIndex((b) => {
      if (b.kind !== "heading") return false;
      const t = b.text.replace(/^#+\s*/, "").trim().toLowerCase();
      return t === want || t.startsWith(want) || t.includes(want);
    });
    if (idx < 0) {
      const available = blocks
        .filter((b) => b.kind === "heading")
        .map((b) => b.text.trim())
        .join("\n  ");
      return `${file} 里没找到标题 “${heading}”。现有标题：\n  ${available}`;
    }

    const depth = blocks[idx].depth ?? 1;
    const out = [blocks[idx]];
    for (let k = idx + 1; k < blocks.length; k++) {
      const b = blocks[k];
      if (b.kind === "heading" && (b.depth ?? 1) <= depth) break;
      out.push(b);
    }
    return `${file} · ${blocks[idx].text.trim()}\n\n${out.slice(1).map((b) => b.text).join("\n\n")}`;
  },
});
