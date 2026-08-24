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
    "Read a numbered excerpt of the draft. Ordinals can shift after each write; use this " +
    "tool to get current ordinals before editing another location. Without arguments, return the full draft.",
  schema: z.object({
    from: z.number().int().min(1).optional().describe("First block ordinal, inclusive"),
    to: z.number().int().min(1).optional().describe("Last block ordinal, inclusive"),
  }),
  run: ({ from, to }, ctx) => {
    const blocks = splitBlocks(readLineFile(ctx.project.draftPath));
    const last = blocks.length ? blocks[blocks.length - 1].n : 0;
    const lo = from ?? 1;
    const hi = to ?? last;
    const slice = blocks.filter((b) => b.n >= lo && b.n <= hi);
    if (!slice.length) return `The draft has ${last} blocks; range ${lo}–${hi} is empty.`;
    return `The draft has ${last} blocks. Blocks ${lo}–${Math.min(hi, last)}:\n\n${renderNumbered(slice)}`;
  },
});

export const readSetting = defineTool({
  name: "read_setting",
  description:
    "Read a section of a setting document by heading. Do not use this for a setting document " +
    "already fully included in the system prompt. Setting documents are read-only.",
  schema: z.object({
    file: z.string().describe("Setting document filename relative to the project, e.g. setting-notes.md"),
    heading: z
      .string()
      .describe("Heading text or prefix. Read until the next heading at the same or higher level."),
  }),
  run: ({ file, heading }, ctx) => {
    if (isAbsolute(file) || file.includes("..")) {
      throw new Error(`file must be a relative path inside the project: ${file}`);
    }
    const abs = resolve(ctx.project.root, file);
    if (!abs.startsWith(resolve(ctx.project.root))) {
      throw new Error(`file must be inside the project directory: ${file}`);
    }
    if (file === ctx.project.draftName) return "Use read_draft to read the draft.";
    if (!existsSync(abs)) throw new Error(`The project has no ${file}`);

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
      return `${file} has no heading “${heading}”. Available headings:\n  ${available}`;
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
