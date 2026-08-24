import { describe, it, expect, afterAll } from "vitest";
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openProject } from "../src/project.js";
import { buildPrompt } from "../src/prompt/build.js";
import { readLineFile } from "../src/doc/linefile.js";
import { splitBlocks, findAnnotations, type BlockKind } from "../src/doc/blocks.js";
import { readSetting } from "../src/tools/read.js";
import { revise } from "../src/tools/write.js";

/**
 * The showcase fixture exists to exercise the whole feature surface at once, so these
 * tests assert the features are actually PRESENT in it. The generic case suite in
 * cases.test.ts would still pass if the fixture quietly lost its fence, its skeleton
 * or its second line-ending style — and then a regression in those paths would have
 * nothing testing it.
 */
const CASE = resolve(import.meta.dirname, "cases", "showcase");

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function copy() {
  const dir = mkdtempSync(join(tmpdir(), "coauthor-showcase-"));
  dirs.push(dir);
  for (const e of readdirSync(CASE, { withFileTypes: true })) {
    if (e.isFile()) writeFileSync(join(dir, e.name), readFileSync(join(CASE, e.name)));
  }
  return openProject(dir);
}

const blocks = () => splitBlocks(readLineFile(join(CASE, "main.md")));

describe("showcase covers every block kind", () => {
  const ALL: BlockKind[] = ["heading", "paragraph", "list", "separator", "fence", "skeleton"];

  it.each(ALL)("contains a %s block", (kind) => {
    expect(blocks().some((b) => b.kind === kind)).toBe(true);
  });

  it("gives one ordinal to a paragraph that spans several lines", () => {
    const multi = blocks().filter((b) => b.kind === "paragraph" && b.text.includes("\n"));
    expect(multi.length).toBeGreaterThan(0);
    // Consecutive ordinals: a continuation line must not consume one.
    const ns = blocks().map((b) => b.n);
    expect(ns).toEqual(ns.map((_, i) => i + 1));
  });

  it("keeps a fence whole, including its blank-looking interior", () => {
    const fence = blocks().find((b) => b.kind === "fence")!;
    expect(fence.text.startsWith("```")).toBe(true);
    expect(fence.text.trimEnd().endsWith("```")).toBe(true);
  });

  it("gives each list item its own ordinal", () => {
    expect(blocks().filter((b) => b.kind === "list").length).toBeGreaterThanOrEqual(3);
  });
});

describe("showcase covers both annotation kinds", () => {
  it("has a note annotation spanning target, separator and instruction", () => {
    const note = findAnnotations(blocks()).find((a) => a.kind === "note")!;
    expect(note).toBeDefined();
    expect(note.to - note.from).toBe(2);
    expect(note.target).toBe(note.from);
  });

  it("has a skeleton annotation occupying a single ordinal", () => {
    const skel = findAnnotations(blocks()).find((a) => a.kind === "skeleton")!;
    expect(skel).toBeDefined();
    expect(skel.from).toBe(skel.to);
  });

  /**
   * The trap the line-based splitter exists for. A `---` directly under a prose line
   * with no blank between is a CommonMark setext underline, which makes the whole
   * paragraph an <h2>; an AST round-trip would re-emit it as `## …` and corrupt the
   * manuscript. One annotation in this fixture has that exact shape.
   */
  it("includes a separator with no blank line above it", () => {
    const lines = readFileSync(join(CASE, "main.md"), "utf8").split("\n");
    const tight = lines.filter((l, i) => l.trim() === "---" && i > 0 && lines[i - 1].trim() !== "");
    expect(tight.length).toBeGreaterThan(0);
  });

  it("treats that separator as its own block, not a heading underline", () => {
    const bs = blocks();
    const sep = bs.find((b) => b.kind === "separator" && b.from > 0 && bs[b.n - 2]?.to === b.from - 1);
    expect(sep).toBeDefined();
    // The paragraph above it stays a paragraph, and keeps its text.
    const above = bs[sep!.n - 2]!;
    expect(above.kind).toBe("paragraph");
    expect(above.text).not.toMatch(/^#/);
  });

  it("closes out a note in one revise, removing separator and instruction together", () => {
    const project = copy();
    const note = findAnnotations(splitBlocks(readLineFile(project.draftPath))).find(
      (a) => a.kind === "note",
    )!;
    const target = splitBlocks(readLineFile(project.draftPath)).find((b) => b.n === note.from)!;
    revise.run(
      {
        from: note.from,
        to: note.to,
        expect: Array.from(target.text.trim()).slice(0, 8).join(""),
        text: "改写后的段落。",
      },
      { project },
    );
    const after = readFileSync(project.draftPath, "utf8");
    expect(after).not.toContain(note.instruction.trim());
    expect(after).toContain("改写后的段落。");
  });
});

/**
 * Line endings are detected per file, not per project. The real s3 corpus has a CRLF
 * draft beside an LF setting document, so a project-wide setting would corrupt one of
 * them; this fixture reproduces that mix in the opposite direction.
 */
describe("showcase mixes line endings across files", () => {
  const eols = (name: string) => {
    const s = readFileSync(join(CASE, name), "utf8");
    return { crlf: (s.match(/\r\n/g) || []).length, lf: (s.match(/(?<!\r)\n/g) || []).length };
  };

  it("has an LF draft", () => {
    const e = eols("main.md");
    expect(e.crlf).toBe(0);
    expect(e.lf).toBeGreaterThan(0);
  });

  it("has a CRLF setting document in the same directory", () => {
    const e = eols("world.md");
    expect(e.lf).toBe(0);
    expect(e.crlf).toBeGreaterThan(0);
  });

  it("leaves the CRLF include untouched when the LF draft is written", () => {
    const project = copy();
    const before = readFileSync(join(project.root, "world.md"));
    const first = splitBlocks(readLineFile(project.draftPath)).find(
      (b) => b.kind === "paragraph",
    )!;
    revise.run(
      {
        from: first.n,
        to: first.n,
        expect: Array.from(first.text.trim()).slice(0, 8).join(""),
        text: "改写后的段落。",
      },
      { project },
    );
    expect(readFileSync(join(project.root, "world.md")).equals(before)).toBe(true);
    expect(readFileSync(project.draftPath, "utf8")).not.toContain("\r\n");
  });
});

describe("showcase exercises includes and read_setting together", () => {
  it("inlines the included setting document in full", () => {
    const ctx = buildPrompt(copy());
    expect(ctx.includes.map((i) => i.path)).toEqual(["world.md"]);
    // Full text, not a summary: a heading from the middle of the file must be there.
    expect(ctx.system).toContain("## 文体要求");
    expect(ctx.system).toContain("<!-- 观测站设定 — world.md -->");
  });

  /** An unincluded document is what read_setting is for; with everything inlined the
   * tool would have nothing to do and its heading scoping would go untested. */
  it("leaves a second document out of the prompt", () => {
    const ctx = buildPrompt(copy());
    expect(ctx.includes.some((i) => i.path === "glossary.md")).toBe(false);
    expect(ctx.system).not.toContain("滚筒式纸带记录仪");
  });

  it("reads one section of it, scoped by heading depth", () => {
    const out = readSetting.run(
      { file: "glossary.md", heading: "主记录仪" },
      { project: copy() },
    ) as string;
    expect(out).toContain("滚筒式纸带记录仪");
    // Stops before the next same-level heading.
    expect(out).not.toContain("归一化为 1.000");
  });

  it("takes nested subsections when given the parent heading", () => {
    const out = readSetting.run({ file: "glossary.md", heading: "规程" }, { project: copy() }) as string;
    expect(out).toContain("双签");
    expect(out).toContain("原始带");
    expect(out).not.toContain("滚筒式");
  });

  it("lists the available headings when one is not found", () => {
    const out = readSetting.run(
      { file: "glossary.md", heading: "不存在的标题" },
      { project: copy() },
    ) as string;
    expect(out).toContain("Available headings");
    expect(out).toContain("主记录仪");
  });

  it("refuses to read the draft as a setting document", () => {
    const out = readSetting.run({ file: "main.md", heading: "观测站" }, { project: copy() }) as string;
    expect(out).toContain("read_draft");
  });

  it("refuses a path outside the project", () => {
    expect(() =>
      readSetting.run({ file: "../collapse/main.md", heading: "x" }, { project: copy() }),
    ).toThrow();
  });
});
