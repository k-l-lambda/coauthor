import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";

const BOM = "﻿";

/**
 * A file as a line array plus a parallel array of the exact terminator that
 * ended each line. Every mutation splices both arrays, so bytes outside the
 * spliced range are never re-encoded — byte fidelity is structural, not tested.
 *
 * Per-line terminators (rather than one file-level EOL) mean a file with mixed
 * endings round-trips exactly instead of being silently normalized. That matters
 * here: main.md is all CRLF and setting-notes.md is all LF, in the same directory.
 */
export interface LineFile {
  path: string;
  /** Preserved if present on read. NEVER added to a file that lacked one. */
  bom: boolean;
  /** Line content, terminators excluded. */
  lines: string[];
  /** eols[i] terminates lines[i]. The final entry is "" for a file with no trailing newline. */
  eols: string[];
  /** Used only for lines this harness inserts. */
  dominantEol: "\r\n" | "\n";
  /** sha256 of the bytes as last read from disk, for stale-write detection. */
  diskHash: string;
}

export function hashBytes(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

export function readLineFile(path: string): LineFile {
  const buf = readFileSync(path);
  let text = buf.toString("utf8");

  const bom = text.startsWith(BOM);
  if (bom) text = text.slice(BOM.length);

  const lines: string[] = [];
  const eols: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "\n") continue;
    const crlf = i > start && text[i - 1] === "\r";
    lines.push(text.slice(start, crlf ? i - 1 : i));
    eols.push(crlf ? "\r\n" : "\n");
    start = i + 1;
  }
  // Trailing content with no terminator. Also covers the empty-file case, which
  // yields one empty line with an empty terminator and serializes back to "".
  lines.push(text.slice(start));
  eols.push("");

  let crlfCount = 0;
  let lfCount = 0;
  for (const e of eols) {
    if (e === "\r\n") crlfCount++;
    else if (e === "\n") lfCount++;
  }

  return {
    path,
    bom,
    lines,
    eols,
    dominantEol: crlfCount > lfCount ? "\r\n" : "\n",
    diskHash: hashBytes(buf),
  };
}

export function serialize(f: LineFile): Buffer {
  let out = f.bom ? BOM : "";
  for (let i = 0; i < f.lines.length; i++) out += f.lines[i] + f.eols[i];
  return Buffer.from(out, "utf8");
}

export class StaleFileError extends Error {
  constructor(path: string) {
    super(
      `${path} changed on disk since it was read. The write was refused to avoid ` +
        `overwriting an external edit. Reload and retry.`,
    );
    this.name = "StaleFileError";
  }
}

/**
 * Atomic write: temp file + rename, so a crash cannot leave a truncated file.
 * Re-reads the target first and refuses if its bytes no longer match diskHash —
 * the "unexpectedly modified" case becomes a loud error, never a silent clobber.
 */
export function writeLineFile(f: LineFile): LineFile {
  let current: Buffer;
  try {
    current = readFileSync(f.path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    current = Buffer.alloc(0);
  }
  if (current.length && hashBytes(current) !== f.diskHash) throw new StaleFileError(f.path);

  const bytes = serialize(f);
  const tmp = `${f.path}.coauthor-tmp-${process.pid}`;
  try {
    writeFileSync(tmp, bytes);
    renameSync(tmp, f.path);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* temp file may not exist; the original error is what matters */
    }
    throw e;
  }
  return { ...f, diskHash: hashBytes(bytes) };
}

/**
 * Replace lines [from, to] (0-based, inclusive) with newLines. Inserted lines get
 * dominantEol; a splice that reaches the final line keeps that line's terminator
 * so a file without a trailing newline does not silently gain one.
 */
export function spliceLines(f: LineFile, from: number, to: number, newLines: string[]): LineFile {
  const lines = f.lines.slice();
  const eols = f.eols.slice();
  const tailEol = eols[to];
  const newEols: string[] = newLines.map(() => f.dominantEol as string);
  if (newEols.length && to === f.lines.length - 1) newEols[newEols.length - 1] = tailEol;
  lines.splice(from, to - from + 1, ...newLines);
  eols.splice(from, to - from + 1, ...newEols);
  return { ...f, lines, eols };
}

export function countCodepoints(s: string): number {
  return Array.from(s).length;
}

export function countHan(s: string): number {
  let n = 0;
  for (const c of s) if (/\p{Script=Han}/u.test(c)) n++;
  return n;
}
