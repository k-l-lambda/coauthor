import type { LineFile } from "./linefile.js";

export type BlockKind = "heading" | "paragraph" | "separator" | "skeleton" | "fence" | "list";

export interface Block {
  /** 1-based global ordinal, headings included. */
  n: number;
  kind: BlockKind;
  /** 0-based inclusive line span in the LineFile. */
  from: number;
  to: number;
  /** Block text with the file's line breaks normalized to \n for display. */
  text: string;
  /** Heading depth, only for kind === "heading". */
  depth?: number;
}

const FENCE = /^(?:```|~~~)/;
const HEADING = /^(#{1,6})\s+/;
/**
 * A line that is exactly a thematic-break run. This is the annotation separator.
 *
 * Deliberate deviation from CommonMark: in main.md:172-173 a prose paragraph is
 * followed with no blank line by `---`, which CommonMark parses as a setext
 * heading underline — making the whole paragraph an <h2>. A markdown-AST
 * round-trip would re-emit that prose as `## "这就要说到回像了。"…` and corrupt the
 * manuscript. Here a lone `---` is ALWAYS its own separator block and never an
 * underline, so the paragraph above it stays a paragraph.
 */
const SEPARATOR = /^(?:-{3,}|\*{3,}|_{3,})\s*$/;
const LIST_ITEM = /^\s{0,3}(?:[-*+]\s|\d{1,9}[.)]\s)/;
const BLANK = /^\s*$/;

function classify(text: string, first: string): BlockKind {
  if (FENCE.test(first)) return "fence";
  if (HEADING.test(first)) return "heading";
  if (SEPARATOR.test(first)) return "separator";
  if (LIST_ITEM.test(first)) return "list";
  const t = text.trim();
  if (t.startsWith("[[") && t.endsWith("]]")) return "skeleton";
  return "paragraph";
}

/**
 * Split into blocks. Blank lines separate blocks and occupy no ordinal. A block
 * may span several lines (continuation, list items, fenced content) but always
 * gets exactly one ordinal — ordinals address 自然段, not lines.
 */
export function splitBlocks(f: LineFile): Block[] {
  const blocks: Block[] = [];
  const lines = f.lines;
  let i = 0;
  let n = 1;

  const push = (from: number, to: number) => {
    const raw = lines.slice(from, to + 1);
    const text = raw.join("\n");
    blocks.push({
      n: n++,
      kind: classify(text, raw[0]),
      from,
      to,
      text,
      ...(HEADING.test(raw[0]) ? { depth: raw[0].match(HEADING)![1].length } : {}),
    });
  };

  while (i < lines.length) {
    if (BLANK.test(lines[i])) {
      i++;
      continue;
    }

    // A fence runs to its closing marker regardless of blank lines inside.
    if (FENCE.test(lines[i])) {
      const marker = lines[i].trim().slice(0, 3);
      let j = i + 1;
      while (j < lines.length && !lines[j].trim().startsWith(marker)) j++;
      if (j < lines.length) j++; // include the closing fence
      push(i, j - 1);
      i = j;
      continue;
    }

    // Headings and separators are always single-line blocks.
    if (HEADING.test(lines[i]) || SEPARATOR.test(lines[i])) {
      push(i, i);
      i++;
      continue;
    }

    // Paragraph or list item: consume continuation lines. Stop at a blank line,
    // a heading, a separator, a fence, or the start of a new list item.
    const start = i;
    const startedAsList = LIST_ITEM.test(lines[i]);
    let j = i + 1;
    while (j < lines.length) {
      const l = lines[j];
      if (BLANK.test(l) || HEADING.test(l) || SEPARATOR.test(l) || FENCE.test(l)) break;
      if (LIST_ITEM.test(l)) break;
      if (startedAsList && !/^\s/.test(l)) break;
      j++;
    }
    push(start, j - 1);
    i = j;
  }

  return blocks;
}

export interface Annotation {
  kind: "note" | "skeleton";
  /** Inclusive ordinal span the agent should replace in one revise call. */
  from: number;
  to: number;
  /** Ordinal of the paragraph the note critiques (note annotations only). */
  target?: number;
  /** The note text, or the skeleton body. */
  instruction: string;
}

/**
 * Locate pending annotations. A `---` separator critiques the block ABOVE it and
 * carries its note BELOW; the span therefore covers target + separator + note, so
 * one revise replaces all three and the marker disappears in the same splice.
 */
export function findAnnotations(blocks: Block[]): Annotation[] {
  const out: Annotation[] = [];
  for (let k = 0; k < blocks.length; k++) {
    const b = blocks[k];
    if (b.kind === "skeleton") {
      out.push({ kind: "skeleton", from: b.n, to: b.n, instruction: b.text });
      continue;
    }
    if (b.kind !== "separator") continue;
    const prev = blocks[k - 1];
    const next = blocks[k + 1];
    if (!prev || !next) continue;
    out.push({
      kind: "note",
      from: prev.n,
      to: next.n,
      target: prev.n,
      instruction: next.text,
    });
  }
  return out;
}
