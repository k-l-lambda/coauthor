import { describe, it, expect, afterAll } from "vitest";
import { readFileSync, writeFileSync, readdirSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openProject } from "../src/project.js";
import { buildPrompt } from "../src/prompt/build.js";
import { readLineFile, serialize } from "../src/doc/linefile.js";
import { splitBlocks, findAnnotations } from "../src/doc/blocks.js";
import { revise } from "../src/tools/write.js";

const CASES = resolve(import.meta.dirname, "cases");
const cases = existsSync(CASES)
  ? readdirSync(CASES, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  : [];

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/**
 * Copy a case's files to a temp directory. Files only, non-recursively: running the
 * harness against a case leaves a gitignored `.coauthor/` behind, and treating that
 * as a file made the whole suite fail with EISDIR on any machine where coauthor had
 * actually been used — a failure that depended on developer history, not on code.
 */
function copyCase(name: string) {
  const src = join(CASES, name);
  const dir = mkdtempSync(join(tmpdir(), `coauthor-case-${name}-`));
  dirs.push(dir);
  for (const e of readdirSync(src, { withFileTypes: true })) {
    if (e.isFile()) writeFileSync(join(dir, e.name), readFileSync(join(src, e.name)));
  }
  return { dir, project: openProject(dir) };
}

describe.each(cases)("case: %s", (name) => {
  it("round-trips byte-identically", () => {
    const src = join(CASES, name, "main.md");
    expect(serialize(readLineFile(src)).equals(readFileSync(src))).toBe(true);
  });

  it("assembles a prompt without throwing", () => {
    const { project } = copyCase(name);
    const ctx = buildPrompt(project);
    expect(ctx.system).toContain("# Current draft");
    expect(ctx.blocks.length).toBeGreaterThan(0);
  });

  it("closes out every annotation, leaving no marker behind", () => {
    const { project } = copyCase(name);
    const before = readLineFile(project.draftPath);
    const anns = findAnnotations(splitBlocks(before));
    if (!anns.length) return;

    // Work high-to-low so earlier ordinals stay valid, as the prompt instructs.
    for (const a of [...anns].sort((x, y) => y.from - x.from)) {
      const blocks = splitBlocks(readLineFile(project.draftPath));
      const target = blocks.find((b) => b.n === a.from)!;
      revise.run(
        {
          from: a.from,
          to: a.to,
          expect: Array.from(target.text.trim()).slice(0, 8).join(""),
          text: "改写后的段落。",
        },
        { project },
      );
    }

    const after = readFileSync(project.draftPath, "utf8");
    expect(after.split(/\r?\n/).filter((l) => l.trim() === "---")).toHaveLength(0);
    expect(after).not.toContain("│");
    for (const a of anns) {
      if (a.kind === "note") expect(after).not.toContain(a.instruction.trim());
    }
  });

  it("preserves its original line endings through a write", () => {
    const { project } = copyCase(name);
    const original = readFileSync(join(CASES, name, "main.md"), "utf8");
    const wasCrlf = /\r\n/.test(original);
    const blocks = splitBlocks(readLineFile(project.draftPath));
    const first = blocks.find((b) => b.kind === "paragraph")!;
    revise.run(
      {
        from: first.n,
        to: first.n,
        expect: Array.from(first.text.trim()).slice(0, 8).join(""),
        text: "改写后的段落。",
      },
      { project },
    );
    const after = readFileSync(project.draftPath, "utf8");
    if (wasCrlf) {
      expect(after.match(/(?<!\r)\n/g)).toBeNull();
      expect((after.match(/\r\n/g) || []).length).toBeGreaterThan(0);
    } else {
      expect(after).not.toContain("\r\n");
    }
  });
});

/**
 * A fixture whose line endings git rewrites cannot test line-ending preservation.
 * `.gitattributes` marks test/cases/** as -text for exactly this reason; this guards
 * against that exemption being dropped, which would otherwise fail silently and only
 * in a fresh clone.
 */
describe("fixture line endings survive git", () => {
  it.each(cases)("%s matches its committed bytes", (name) => {
    const rel = `test/cases/${name}/main.md`;
    let committed: Buffer;
    try {
      committed = execFileSync("git", ["show", `HEAD:${rel}`], {
        cwd: resolve(import.meta.dirname, ".."),
        maxBuffer: 1 << 24,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      // Not in HEAD yet. A case being written is not a failure of this guard, and a
      // raw "exists on disk, but not in HEAD" would read as a line-ending problem.
      return;
    }
    expect(committed.equals(readFileSync(join(CASES, name, "main.md")))).toBe(true);
  });
});
