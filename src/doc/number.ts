import type { Block } from "./blocks.js";
import { countCodepoints } from "./linefile.js";

/**
 * Render blocks with their ordinals for injection into the system prompt.
 * A multi-line block shows its ordinal once; continuation lines are aligned
 * under it with no number of their own.
 */
export function renderNumbered(blocks: Block[]): string {
  const width = Math.max(3, String(blocks.length ? blocks[blocks.length - 1].n : 0).length);
  const out: string[] = [];
  for (const b of blocks) {
    const lines = b.text.split("\n");
    out.push(`${String(b.n).padStart(width)}│${lines[0]}`);
    for (const l of lines.slice(1)) out.push(`${" ".repeat(width)}│${l}`);
  }
  return out.join("\n");
}

export class OrdinalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrdinalError";
  }
}

export function blockAt(blocks: Block[], n: number): Block {
  const b = blocks.find((x) => x.n === n);
  if (!b) {
    const last = blocks.length ? blocks[blocks.length - 1].n : 0;
    throw new OrdinalError(`No block ${n}. The draft currently has blocks 1..${last}.`);
  }
  return b;
}

/** How many leading characters of `expect` must match before a write is allowed. */
const MIN_EXPECT = 4;

/**
 * Guard against writing at a shifted ordinal. The agent already holds the draft
 * text, so echoing back the opening characters of the block it means to change is
 * nearly free — and it catches every misaligned write, which the edit log could
 * only reveal after the damage.
 */
export function assertExpect(blocks: Block[], n: number, expected: string): Block {
  const b = blockAt(blocks, n);
  const want = Array.from(expected.trim());
  if (want.length < MIN_EXPECT) {
    throw new OrdinalError(
      `"expect" must be at least ${MIN_EXPECT} characters copied from the start of block ${n}.`,
    );
  }
  const actual = Array.from(b.text.trim()).slice(0, want.length).join("");
  if (actual !== want.join("")) {
    throw new OrdinalError(
      `Block ${n} does not start with the expected text — the ordinal is stale or wrong, ` +
        `so nothing was written.\n` +
        `  expected: ${want.join("")}\n` +
        `  actual:   ${actual}\n` +
        `Block ${n} is currently:\n${b.text}\n` +
        `Re-read the draft with read_draft to get current ordinals.`,
    );
  }
  return b;
}

export interface Renumber {
  totalBlocks: number;
  delta: number;
  /** Numbered view of the changed region plus a little context on each side. */
  context: string;
}

/** What a write tool hands back so the agent never has to recompute shifted ordinals. */
export function renumber(before: Block[], after: Block[], from: number, span = 3): Renumber {
  const lo = Math.max(1, from - span);
  const hi = Math.min(after.length ? after[after.length - 1].n : 0, from + span * 2);
  return {
    totalBlocks: after.length,
    delta: after.length - before.length,
    context: renderNumbered(after.filter((b) => b.n >= lo && b.n <= hi)),
  };
}

export interface DraftStats {
  blocks: number;
  codepoints: number;
  sections: number;
}

export function stats(blocks: Block[]): DraftStats {
  return {
    blocks: blocks.length,
    codepoints: blocks.reduce((s, b) => s + countCodepoints(b.text), 0),
    sections: blocks.filter((b) => b.kind === "heading").length,
  };
}
