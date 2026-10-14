import { existsSync, writeFileSync } from "node:fs";
import { resolve, join, basename } from "node:path";

const BACKSLASH = String.fromCharCode(92);

/** Normalize a Windows path for display, without an escaped backslash in source. */
export function toPosix(p: string): string {
  return p.split(BACKSLASH).join("/");
}

export const AGENT_FILE = "AGENT.md";
/** The draft's default name. Override per project with `--draft`. */
export const DEFAULT_DRAFT_FILE = "main.md";

export interface Project {
  root: string;
  agentPath: string;
  draftPath: string;
  /** The draft's file name, for prompts, logs and tool messages. */
  draftName: string;
  logPath: string;
  /** Raw stream traces, written when a model stream breaks protocol. Not per draft. */
  streamLogPath: string;
}

/**
 * Reject anything that is not a plain file name in the project directory.
 *
 * The draft is the one file the write tools may touch, and they take no path
 * argument precisely so that a single validated name is the whole of their reach.
 * A `--draft ../../notes.md` would quietly widen that to anywhere on disk.
 */
export function validateDraftName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("--draft needs a file name.");
  if (trimmed !== basename(trimmed)) {
    throw new Error(
      `--draft takes a file name inside the project, not a path: received ${name}\n` +
        `Point coauthor at the other directory instead.`,
    );
  }
  if (trimmed === AGENT_FILE) {
    throw new Error(
      `--draft cannot be ${AGENT_FILE}: it is the prompt, and the write tools would edit it.`,
    );
  }
  return trimmed;
}

export function openProject(dir: string, draftFile: string = DEFAULT_DRAFT_FILE): Project {
  const draftName = validateDraftName(draftFile);
  const root = resolve(dir);
  const agentPath = join(root, AGENT_FILE);
  const draftPath = join(root, draftName);

  if (!existsSync(root)) throw new Error(`No such directory: ${root}`);
  if (!existsSync(agentPath)) {
    throw new Error(
      `No ${AGENT_FILE} in ${root}.\n` +
        `coauthor needs one: it describes the writing task in plain language and ` +
        `doubles as the system prompt. Reference setting documents from it with ` +
        `#[label](path) and their full text is inlined into the prompt.`,
    );
  }
  if (!existsSync(draftPath)) {
    if (draftName === DEFAULT_DRAFT_FILE) {
      throw new Error(
        `No ${draftName} in ${root}. Name the draft ${draftName}, or pass --draft <file>.`,
      );
    }
    writeFileSync(draftPath, "", { encoding: "utf8", flag: "wx" });
  }

  return {
    root,
    agentPath,
    draftPath,
    draftName,
    logPath: join(root, ".coauthor", `${draftName}.edit-log.md`),
    streamLogPath: join(root, ".coauthor", "stream-debug.log.md"),
  };
}
