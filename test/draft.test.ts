import { describe, it, expect, afterAll } from "vitest";
import { writeFileSync, mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  openProject,
  validateDraftName,
  DEFAULT_DRAFT_FILE,
  AGENT_FILE,
} from "../src/project.js";
import { buildPrompt } from "../src/prompt/build.js";
import { splitBlocks } from "../src/doc/blocks.js";
import { readLineFile } from "../src/doc/linefile.js";
import { revise, append } from "../src/tools/write.js";
import { readSetting } from "../src/tools/read.js";

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A project whose draft is named something other than main.md. */
function projectWith(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "coauthor-draft-"));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text, "utf8");
  return dir;
}

const AGENT = "写一篇短篇小说。\n";
const DRAFT = "第一段。\n\n第二段。\n";

describe("validateDraftName", () => {
  it("accepts a plain file name", () => {
    expect(validateDraftName("chapter-3.md")).toBe("chapter-3.md");
  });

  it("trims surrounding whitespace", () => {
    expect(validateDraftName("  draft.md  ")).toBe("draft.md");
  });

  it("rejects an empty name", () => {
    expect(() => validateDraftName("   ")).toThrow(/needs a file name/);
  });

  /**
   * The write tools take no path argument so that one validated name is the whole of
   * their reach. A relative path would quietly widen that to anywhere on disk.
   */
  it.each(["../notes.md", "sub/draft.md", "..\\notes.md", "/etc/passwd"])(
    "rejects %s, which is a path and not a name",
    (bad) => {
      expect(() => validateDraftName(bad)).toThrow(/not a path|file name/);
    },
  );

  it("refuses to make AGENT.md the draft, since the write tools would edit the prompt", () => {
    expect(() => validateDraftName(AGENT_FILE)).toThrow(/prompt/);
  });
});

describe("openProject with a custom draft", () => {
  it("defaults to main.md", () => {
    const dir = projectWith({ [AGENT_FILE]: AGENT, "main.md": DRAFT });
    expect(openProject(dir).draftName).toBe(DEFAULT_DRAFT_FILE);
  });

  it("uses the given name", () => {
    const dir = projectWith({ [AGENT_FILE]: AGENT, "chapter-3.md": DRAFT });
    const p = openProject(dir, "chapter-3.md");
    expect(p.draftName).toBe("chapter-3.md");
    expect(p.draftPath).toBe(join(resolve(dir), "chapter-3.md"));
  });

  it("mentions --draft when the default is missing, since that is usually the fix", () => {
    const dir = projectWith({ [AGENT_FILE]: AGENT, "chapter-3.md": DRAFT });
    expect(() => openProject(dir)).toThrow(/--draft/);
  });

  it("uses a distinct edit log for each draft name", () => {
    const dir = projectWith({
      [AGENT_FILE]: AGENT,
      "main.md": DRAFT,
      "chapter-3.md": DRAFT,
    });
    expect(openProject(dir).logPath).toBe(join(resolve(dir), ".coauthor", "main.md.edit-log.md"));
    expect(openProject(dir, "chapter-3.md").logPath).toBe(
      join(resolve(dir), ".coauthor", "chapter-3.md.edit-log.md"),
    );
  });

  it("creates a missing custom draft as an empty file", () => {
    const dir = projectWith({ [AGENT_FILE]: AGENT, "main.md": DRAFT });
    const project = openProject(dir, "new-draft.md");
    expect(project.draftName).toBe("new-draft.md");
    expect(readFileSync(project.draftPath, "utf8")).toBe("");
  });

  it("rejects a path before touching the filesystem", () => {
    const dir = projectWith({ [AGENT_FILE]: AGENT, "main.md": DRAFT });
    expect(() => openProject(dir, "../escape.md")).toThrow(/not a path/);
  });
});

describe("the custom name reaches everything that names the draft", () => {
  const setup = () => {
    const dir = projectWith({
      [AGENT_FILE]: AGENT,
      "chapter-3.md": DRAFT,
      "main.md": "这是一个同名的旧稿，不应被改动。\n",
    });
    return { dir, project: openProject(dir, "chapter-3.md") };
  };

  it("names it in the prompt", () => {
    const { project } = setup();
    expect(buildPrompt(project).system).toContain("chapter-3.md");
    expect(buildPrompt(project).system).not.toContain("/main.md");
  });

  it("writes to it, leaving a same-directory main.md alone", () => {
    const { dir, project } = setup();
    const before = readFileSync(join(dir, "main.md"));
    const first = splitBlocks(readLineFile(project.draftPath))[0]!;
    revise.run(
      { from: first.n, to: first.n, expect: "第一段。", text: "改写后的第一段。" },
      { project },
    );
    expect(readFileSync(project.draftPath, "utf8")).toContain("改写后的第一段。");
    expect(readFileSync(join(dir, "main.md")).equals(before)).toBe(true);
  });

  it("names it in the tool's return value", () => {
    const { project } = setup();
    const out = append.run({ text: "追加的一段。" }, { project }) as string;
    expect(out).toContain("chapter-3.md");
    expect(out).not.toContain("main.md");
  });

  it("names it in the edit log diff header", () => {
    const { project } = setup();
    append.run({ text: "追加的一段。" }, { project });
    const log = readFileSync(project.logPath, "utf8");
    expect(log).toContain("chapter-3.md");
    expect(log).not.toContain("+++ main.md");
  });

  /**
   * read_setting refuses the draft, to keep one file from being reachable through both
   * a read tool and the write tools. That guard has to follow the renamed draft — and
   * must NOT keep pointing at main.md, which here is an ordinary readable document.
   */
  it("refuses read_setting on the renamed draft", () => {
    const { project } = setup();
    const out = readSetting.run({ file: "chapter-3.md", heading: "x" }, { project }) as string;
    expect(out).toContain("read_draft");
  });

  it("still allows read_setting on a file merely named main.md", () => {
    const { project } = setup();
    const out = readSetting.run({ file: "main.md", heading: "x" }, { project }) as string;
    expect(out).not.toContain("read_draft");
  });
});

describe("the --draft CLI option", () => {
  const cli = resolve(import.meta.dirname, "..", "dist", "index.js");
  const run = (args: string[], cwd: string) =>
    execFileSync(process.execPath, [cli, ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, COAUTHOR_AUTH_TOKEN: "", COAUTHOR_API_KEY: "" },
    });

  it.runIf(existsSync(cli))("check reports the custom draft", () => {
    const dir = projectWith({ [AGENT_FILE]: AGENT, "chapter-3.md": DRAFT });
    const out = run(["check", dir, "--draft", "chapter-3.md"], dir);
    expect(out).toContain("chapter-3.md");
    expect(out).toContain("(--draft)");
  });

  it.runIf(existsSync(cli))("check creates a missing custom draft", () => {
    const dir = projectWith({ [AGENT_FILE]: AGENT, "main.md": DRAFT });
    const out = run(["check", dir, "--draft", "new-draft.md"], dir);
    expect(out).toContain("new-draft.md");
    expect(readFileSync(join(dir, "new-draft.md"), "utf8")).toBe("");
  });

  it.runIf(existsSync(cli))("dev-prompt honours the short form -d", () => {
    const dir = projectWith({ [AGENT_FILE]: AGENT, "chapter-3.md": DRAFT });
    const out = run(["dev-prompt", dir, "-d", "chapter-3.md"], dir);
    expect(out).toContain("chapter-3.md");
  });

  it.runIf(existsSync(cli))("sys prints the assembled prompt for the current directory", () => {
    const dir = projectWith({ [AGENT_FILE]: AGENT, "main.md": DRAFT });
    const out = run(["sys"], dir);
    expect(out).toContain("# Writing requirements");
    expect(out).toContain("# Current draft");
    expect(out).toContain("第一段。");
    expect(out).toMatch(/\[system prompt: \d+ codepoints\]/);
  });

  it.runIf(existsSync(cli))("sys honours an explicit directory and custom draft", () => {
    const cwd = projectWith({ [AGENT_FILE]: AGENT, "main.md": DRAFT });
    const dir = projectWith({ [AGENT_FILE]: AGENT, "chapter-3.md": "自定义正文。\n" });
    const out = run(["sys", dir, "--draft", "chapter-3.md"], cwd);
    expect(out).toContain("chapter-3.md");
    expect(out).toContain("自定义正文。");
    expect(out).not.toContain("第一段。");
  });

  it.runIf(existsSync(cli))("fails with a clear message for a path", () => {
    const dir = projectWith({ [AGENT_FILE]: AGENT, "main.md": DRAFT });
    expect(() => run(["check", dir, "--draft", "../x.md"], dir)).toThrow(/not a path/);
  });
});
