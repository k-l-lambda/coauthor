import { describe, it, expect } from "vitest";
import { readLineFile } from "../src/doc/linefile.js";
import { splitBlocks, findAnnotations } from "../src/doc/blocks.js";
import { renderNumbered, assertExpect, blockAt, stats, OrdinalError } from "../src/doc/number.js";

const S3 = "C:/Users/kllam/documents/wechat-articles/s3";

describe("the real draft", () => {
  const blocks = splitBlocks(readLineFile(`${S3}/main.md`));

  it("finds the two section headings", () => {
    const h = blocks.filter((b) => b.kind === "heading");
    expect(h.map((b) => b.text)).toEqual(["## 1.虫洞", "## 2.万境号"]);
  });

  it("counts codepoints, not bytes", () => {
    const s = stats(blocks);
    expect(s.codepoints).toBeGreaterThan(7500);
    expect(s.codepoints).toBeLessThan(8200);
    expect(s.sections).toBe(2);
  });

  it("has exactly one separator", () => {
    expect(blocks.filter((b) => b.kind === "separator")).toHaveLength(1);
  });

  it("keeps the prose above `---` a paragraph, not a setext heading", () => {
    const sep = blocks.find((b) => b.kind === "separator")!;
    const target = blocks.find((b) => b.n === sep.n - 1)!;
    expect(target.kind).toBe("paragraph");
    expect(target.depth).toBeUndefined();
    expect(target.text).toContain("这就要说到回像了");
  });

  it("reports the annotation as one replaceable span", () => {
    const ann = findAnnotations(blocks);
    expect(ann).toHaveLength(1);
    const a = ann[0];
    expect(a.kind).toBe("note");
    expect(a.to - a.from).toBe(2); // target + separator + note
    expect(a.target).toBe(a.from);
    expect(a.instruction).toContain("太罗嗦了");
    expect(blockAt(blocks, a.from).text).toContain("这就要说到回像了");
    expect(blockAt(blocks, a.from + 1).text).toBe("---");
  });

  it("numbers every block including headings, starting at 1", () => {
    expect(blocks[0].n).toBe(1);
    expect(blocks[0].kind).toBe("heading");
    expect(blocks.map((b) => b.n)).toEqual(blocks.map((_, i) => i + 1));
  });
});

describe("the real canon", () => {
  const blocks = splitBlocks(readLineFile(`${S3}/setting-notes.md`));

  it("finds its headings at both depths", () => {
    const h = blocks.filter((b) => b.kind === "heading");
    expect(h.length).toBeGreaterThanOrEqual(9);
    expect(h.some((b) => b.depth === 1)).toBe(true);
    expect(h.some((b) => b.depth === 3)).toBe(true);
  });

  it("keeps list items as separate blocks", () => {
    expect(blocks.filter((b) => b.kind === "list").length).toBeGreaterThanOrEqual(6);
  });

  it("has no stray separators to mistake for annotations", () => {
    expect(findAnnotations(blocks)).toHaveLength(0);
  });
});

describe("splitter edge cases", () => {
  const from = (text: string) =>
    splitBlocks({
      path: "x",
      bom: false,
      lines: text.split("\n"),
      eols: text.split("\n").map(() => "\n"),
      dominantEol: "\n",
      diskHash: "",
    });

  it("does not split on blank lines inside a fence", () => {
    const b = from("```js\na\n\nb\n```\ntail");
    expect(b).toHaveLength(2);
    expect(b[0].kind).toBe("fence");
    expect(b[0].text).toContain("\n\n");
  });

  it("recognizes a skeleton paragraph", () => {
    const b = from("[[示例文本，此处补全……]]");
    expect(b[0].kind).toBe("skeleton");
    expect(findAnnotations(b)[0].kind).toBe("skeleton");
  });

  it("treats `---` as a separator even with no blank line above", () => {
    const b = from("prose here\n---\nthe note");
    expect(b.map((x) => x.kind)).toEqual(["paragraph", "separator", "paragraph"]);
  });

  it("joins continuation lines into one block with one ordinal", () => {
    const b = from("line one\nline two\n\nnext");
    expect(b).toHaveLength(2);
    expect(b[0].text).toBe("line one\nline two");
    expect(b[1].n).toBe(2);
  });
});

describe("expect validation", () => {
  const blocks = splitBlocks(readLineFile(`${S3}/main.md`));
  const sep = blocks.find((b) => b.kind === "separator")!;
  const target = sep.n - 1;

  it("accepts the true opening characters", () => {
    expect(assertExpect(blocks, target, "“这就要说到回像了").n).toBe(target);
  });

  it("rejects a shifted ordinal", () => {
    expect(() => assertExpect(blocks, target + 5, "“这就要说到回像了")).toThrow(OrdinalError);
  });

  it("rejects an expect that is too short to be a real guard", () => {
    expect(() => assertExpect(blocks, target, "“这")).toThrow(/at least/);
  });

  it("rejects an out-of-range ordinal with the valid range", () => {
    expect(() => blockAt(blocks, 9999)).toThrow(/blocks 1\.\./);
  });
});

describe("numbered rendering", () => {
  it("puts the ordinal on the first line only", () => {
    const out = renderNumbered([
      { n: 7, kind: "paragraph", from: 0, to: 1, text: "first\nsecond" },
    ]);
    const [a, b] = out.split("\n");
    expect(a).toMatch(/^\s+7│first$/);
    expect(b).toMatch(/^\s+│second$/);
  });
});
