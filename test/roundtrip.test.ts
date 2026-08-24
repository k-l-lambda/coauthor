import { describe, it, expect, afterAll } from "vitest";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readLineFile,
  serialize,
  spliceLines,
  writeLineFile,
  countCodepoints,
  countHan,
  StaleFileError,
} from "../src/doc/linefile.js";

const S3 = "C:/Users/kllam/documents/wechat-articles/s3";
const REAL = [
  { path: `${S3}/main.md`, eol: "\r\n", codepoints: 8144, han: 6534 },
  { path: `${S3}/setting-notes.md`, eol: "\n", codepoints: 16686, han: 13453 },
];

describe("byte fidelity on the real manuscript", () => {
  for (const f of REAL) {
    it(`${f.path.split("/").pop()} round-trips byte-identically`, () => {
      const original = readFileSync(f.path);
      expect(serialize(readLineFile(f.path)).equals(original)).toBe(true);
    });

    it(`${f.path.split("/").pop()} detects its own line endings as ${JSON.stringify(f.eol)}`, () => {
      expect(readLineFile(f.path).dominantEol).toBe(f.eol);
    });

    it(`${f.path.split("/").pop()} has no BOM and gains none`, () => {
      const lf = readLineFile(f.path);
      expect(lf.bom).toBe(false);
      expect(serialize(lf)[0]).not.toBe(0xef);
    });

    it(`${f.path.split("/").pop()} counts codepoints, not bytes`, () => {
      const text = readFileSync(f.path, "utf8");
      expect(countCodepoints(text)).toBe(f.codepoints);
      expect(countHan(text)).toBe(f.han);
    });
  }
});

describe("line-ending edge cases", () => {
  let dir: string;
  const write = (name: string, content: string) => {
    dir ??= mkdtempSync(join(tmpdir(), "coauthor-"));
    const p = join(dir, name);
    writeFileSync(p, content);
    return p;
  };

  it("preserves mixed line endings exactly", () => {
    const p = write("mixed.md", "a\r\nb\nc\r\nd");
    const original = readFileSync(p);
    expect(serialize(readLineFile(p)).equals(original)).toBe(true);
  });

  it("preserves a BOM that was present", () => {
    const p = write("bom.md", "\uFEFFhello\n");
    const lf = readLineFile(p);
    expect(lf.bom).toBe(true);
    expect(serialize(lf).equals(readFileSync(p))).toBe(true);
  });

  it("does not add a trailing newline to a file lacking one", () => {
    const p = write("notrail.md", "a\nb");
    const lf = readLineFile(p);
    expect(serialize(spliceLines(lf, 0, 0, ["A"])).toString()).toBe("A\nb");
  });

  it("keeps the trailing state when splicing the final line", () => {
    const p = write("tail.md", "a\nb");
    const lf = readLineFile(p);
    expect(serialize(spliceLines(lf, 1, 1, ["B"])).toString()).toBe("a\nB");
  });

  it("round-trips an empty file as empty", () => {
    const p = write("empty.md", "");
    expect(serialize(readLineFile(p)).length).toBe(0);
  });

  it("inserts new lines with the file's dominant ending", () => {
    const p = write("crlf.md", "a\r\nb\r\n");
    const out = serialize(spliceLines(readLineFile(p), 0, 0, ["x", "y"])).toString();
    expect(out).toBe("x\r\ny\r\nb\r\n");
  });

  it("refuses to write over an external modification", () => {
    const p = write("stale.md", "a\n");
    const lf = readLineFile(p);
    writeFileSync(p, "changed elsewhere\n");
    expect(() => writeLineFile(spliceLines(lf, 0, 0, ["b"]))).toThrow(StaleFileError);
    expect(readFileSync(p, "utf8")).toBe("changed elsewhere\n");
  });

  it("writes atomically and updates the hash for the next write", () => {
    const p = write("seq.md", "a\nb\n");
    let lf = readLineFile(p);
    lf = writeLineFile(spliceLines(lf, 0, 0, ["A"]));
    lf = writeLineFile(spliceLines(lf, 1, 1, ["B"]));
    expect(readFileSync(p, "utf8")).toBe("A\nB\n");
  });

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
});
