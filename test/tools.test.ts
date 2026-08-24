import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openProject } from "../src/project.js";
import { readDraft, readSetting } from "../src/tools/read.js";
import { revise, insert, append } from "../src/tools/write.js";
import type { ToolContext } from "../src/tools/index.js";

// Source the pristine manuscript, never the fixture: the fixture is mutated by
// end-to-end runs, and tests must not depend on its current state. Only read here;
// every write goes to a fresh temp copy.
const SRC = "C:/Users/kllam/documents/wechat-articles/s3";
const dirs: string[] = [];

function freshProject() {
  const dir = mkdtempSync(join(tmpdir(), "coauthor-t-"));
  dirs.push(dir);
  for (const f of ["main.md", "setting-notes.md"]) {
    writeFileSync(join(dir, f), readFileSync(join(SRC, f)));
  }
  writeFileSync(
    join(dir, "AGENT.md"),
    `你是一个优秀的科幻小说写作助手。

#[设定文档](setting-notes.md)
`,
    "utf8",
  );
  return openProject(dir);
}

afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

let ctx: ToolContext;
beforeEach(() => {
  ctx = { project: freshProject() };
});

const draft = () => readFileSync(ctx.project.draftPath, "utf8");
const bytes = () => readFileSync(ctx.project.draftPath);

describe("read_draft", () => {
  it("returns a numbered slice and the total", () => {
    const out = readDraft.run({ from: 86, to: 88 }, ctx);
    expect(out).toContain("正文共 105 段");
    expect(out).toMatch(/86│/);
    expect(out).toContain("---");
    expect(out).toContain("太罗嗦了");
  });

  it("returns everything when unbounded", () => {
    expect(readDraft.run({}, ctx).split("\n").length).toBeGreaterThan(100);
  });
});

describe("read_setting", () => {
  it("scopes to one heading and stops at the next same-level one", () => {
    const out = readSetting.run({ file: "setting-notes.md", heading: "回像、近像与远像" }, ctx);
    expect(out).toContain("对跖共轭像");
    expect(out).not.toContain("## 3. 内部布局");
  });

  it("lists available headings when the heading is unknown", () => {
    const out = readSetting.run({ file: "setting-notes.md", heading: "不存在的标题" }, ctx);
    expect(out).toContain("现有标题");
    expect(out).toContain("## 1. 球宇");
  });

  it("refuses to escape the project directory", () => {
    expect(() => readSetting.run({ file: "../secret.md", heading: "x" }, ctx)).toThrow();
  });

  it("redirects the draft to read_draft", () => {
    expect(readSetting.run({ file: "main.md", heading: "1" }, ctx)).toContain("read_draft");
  });
});

describe("revise — the annotation close-out", () => {
  const NEW = "“这就要说到回像了。”千岚笑了，伸出一根手指，先点向头顶：“北天这三个是本体。”";

  it("clears target, separator and note in one call", () => {
    const out = revise.run(
      { from: 86, to: 88, expect: "“这就要说到回像了", text: NEW },
      ctx,
    );
    const text = draft();
    expect(text).not.toContain("\n---");
    expect(text).not.toContain("太罗嗦了");
    expect(text).toContain("北天这三个是本体");
    expect(out).toContain("已写入 main.md");
    expect(text.split(/\r?\n/).filter((l) => l.trim() === "---")).toHaveLength(0);
  });

  it("leaves surrounding paragraphs byte-identical", () => {
    const before = draft();
    revise.run({ from: 86, to: 88, expect: "“这就要说到回像了", text: NEW }, ctx);
    const after = draft();
    // Everything up to the target and after the note must be untouched.
    const head = before.slice(0, before.indexOf("“这就要说到回像了"));
    expect(after.startsWith(head)).toBe(true);
    const tailMark = "“听糊涂了吧？”";
    expect(after.slice(after.indexOf(tailMark))).toBe(before.slice(before.indexOf(tailMark)));
  });

  it("preserves CRLF line endings", () => {
    revise.run({ from: 86, to: 88, expect: "“这就要说到回像了", text: NEW }, ctx);
    const b = bytes().toString("utf8");
    expect((b.match(/\r\n/g) || []).length).toBeGreaterThan(180);
    expect((b.match(/(?<!\r)\n/g) || []).length).toBe(0);
  });

  it("writes a diff to the edit log", () => {
    revise.run({ from: 86, to: 88, expect: "“这就要说到回像了", text: NEW }, ctx);
    expect(existsSync(ctx.project.logPath)).toBe(true);
    const log = readFileSync(ctx.project.logPath, "utf8");
    expect(log).toContain("· revise · 86-88");
    expect(log).toContain("```diff");
    expect(log).toContain("-太罗嗦了");
  });

  it("reports the shift and the new numbering", () => {
    const out = revise.run({ from: 86, to: 88, expect: "“这就要说到回像了", text: NEW }, ctx);
    expect(out).toContain("105 → 103");
    expect(out).toMatch(/86│/);
  });

  it("strips a NNN│ prefix the model echoed back", () => {
    revise.run({ from: 86, to: 88, expect: "“这就要说到回像了", text: ` 86│${NEW}` }, ctx);
    expect(draft()).not.toContain("│");
    expect(draft()).toContain("北天这三个是本体");
  });

  it("deletes when text is empty", () => {
    revise.run({ from: 86, to: 88, expect: "“这就要说到回像了", text: "" }, ctx);
    const text = draft();
    expect(text).not.toContain("这就要说到回像了");
    expect(text).not.toContain("太罗嗦了");
    expect(text).not.toMatch(/\r\n\r\n\r\n/);
  });
});

describe("expect guards against misaligned writes", () => {
  it("refuses a wrong ordinal and leaves the file untouched", () => {
    const before = bytes();
    expect(() => revise.run({ from: 40, to: 40, expect: "“这就要说到回像了", text: "x" }, ctx)).toThrow(
      /stale or wrong/,
    );
    expect(bytes().equals(before)).toBe(true);
  });

  it("refuses an expect shorter than the guard minimum", () => {
    const before = bytes();
    expect(() => revise.run({ from: 86, to: 88, expect: "“这", text: "x" }, ctx)).toThrow(/at least/);
    expect(bytes().equals(before)).toBe(true);
  });

  it("refuses an out-of-range ordinal", () => {
    expect(() => revise.run({ from: 9999, to: 9999, expect: "abcd", text: "x" }, ctx)).toThrow(
      /blocks 1\.\./,
    );
  });

  it("refuses to==from inverted", () => {
    expect(() => revise.run({ from: 88, to: 86, expect: "太罗嗦了", text: "x" }, ctx)).toThrow(
      /不能小于/,
    );
  });
});

describe("insert", () => {
  it("adds a paragraph after the anchor without disturbing it", () => {
    insert.run({ after: 86, expect: "“这就要说到回像了", text: "插入的新段落。" }, ctx);
    const blocks = readDraft.run({ from: 86, to: 88 }, ctx);
    expect(blocks).toMatch(/86│“这就要说到回像了/);
    expect(blocks).toMatch(/87│插入的新段落。/);
    expect(blocks).toMatch(/88│---/);
  });

  it("rejects empty text", () => {
    expect(() => insert.run({ after: 86, expect: "“这就要说到回像了", text: "  " }, ctx)).toThrow(
      /没有可插入/,
    );
  });
});

describe("append", () => {
  it("adds a new section at the end and keeps a single trailing newline", () => {
    append.run({ text: "## 3.新章\n\n新章的第一段。" }, ctx);
    const text = draft();
    expect(text).toContain("## 3.新章");
    expect(text.endsWith("\r\n")).toBe(true);
    expect(text).not.toMatch(/\r\n\r\n\r\n$/);
    const out = readDraft.run({}, ctx);
    expect(out).toContain("正文共 107 段");
  });

  it("rejects empty text", () => {
    expect(() => append.run({ text: "\n\n" }, ctx)).toThrow(/没有可追加/);
  });
});

describe("sequential writes in one turn", () => {
  it("later high-to-low edits stay valid", () => {
    revise.run({ from: 86, to: 88, expect: "“这就要说到回像了", text: "改后的段落甲。" }, ctx);
    // Editing an earlier ordinal is unaffected by a later-position edit.
    revise.run({ from: 40, to: 40, expect: readDraft.run({ from: 40, to: 40 }, ctx).match(/40│(.{6})/)![1], text: "改后的段落乙。" }, ctx);
    const text = draft();
    expect(text).toContain("改后的段落甲。");
    expect(text).toContain("改后的段落乙。");
  });
});
