import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { createTwoFilesPatch } from "diff";

const TRAILING_WS = new RegExp(String.raw`\s+$`);
const EMPTY = "";

export interface EditRecord {
  tool: string;
  /** Human-readable target, e.g. "86-88" or "after 12". */
  where: string;
  before: string;
  after: string;
}

/** Local time, not UTC: the journals are read by the author, not a machine. */
export function localStamp(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

/**
 * Append a unified diff for one mutation. This is the review mechanism in place of
 * interactive confirmation: writes land immediately and the journal is what the
 * author reads afterwards.
 */
export function appendEdit(logPath: string, rec: EditRecord, draftName = "main.md"): string {
  const patch = createTwoFilesPatch(
    `${draftName} (before)`,
    `${draftName} (after)`,
    rec.before.endsWith("\n") ? rec.before : rec.before + "\n",
    rec.after.endsWith("\n") ? rec.after : rec.after + "\n",
    undefined,
    undefined,
    { context: 1 },
  );
  // Drop the file headers: this diff covers only the changed region, so the
  // ---/+++ pair is noise, and a half-stripped pair reads as broken.
  const hunk = patch.indexOf("@@");
  const stripped = hunk < 0 ? patch : patch.slice(hunk);
  const body = stripped.replace(TRAILING_WS, EMPTY);
  const stamp = localStamp();
  const entry =
    `\n## ${stamp} · ${draftName} · ${rec.tool} · ${rec.where}\n\n` +
    "```diff\n" +
    body +
    "\n```\n";

  mkdirSync(dirname(logPath), { recursive: true });
  if (!existsSync(logPath)) {
    appendFileSync(logPath, "# coauthor edit log\n", "utf8");
  }
  appendFileSync(logPath, entry, "utf8");
  return body;
}

/** Most recent entries, newest last, for the REPL's /log command. */
export function tailLog(logPath: string, count = 3): string {
  if (!existsSync(logPath)) return "(no edits recorded yet)";
  const text = readFileSync(logPath, "utf8");
  const entries = text.split(/\n(?=## )/).slice(1);
  if (!entries.length) return "(no edits recorded yet)";
  return entries.slice(-count).join("\n").trim();
}
