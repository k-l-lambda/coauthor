import { readFileSync, existsSync } from "node:fs";
import { resolve, isAbsolute, relative } from "node:path";
import { toPosix } from "../project.js";

/** `#[label](path)` — markdown image syntax with `#`, to avoid colliding with real links. */
const INCLUDE = /#\[([^\]]*)\]\(([^)]+)\)/g;

export interface Include {
  label: string;
  path: string;
  codepoints: number;
}

export interface ExpandedAgentMd {
  text: string;
  includes: Include[];
}

/**
 * Read AGENT.md and replace every `#[label](path)` with that file's full text, so
 * the agent sees the whole setting document at once instead of paging through it.
 *
 * One level only: an include directive inside an included file is left as literal
 * text. A missing target is a startup error, never a silent omission — a prompt
 * that quietly lost its canon would produce off-canon prose with no visible cause.
 */
export function expandAgentMd(agentPath: string, root: string): ExpandedAgentMd {
  const raw = readFileSync(agentPath, "utf8");
  const includes: Include[] = [];
  const missing: string[] = [];

  const text = raw.replace(INCLUDE, (_match, label: string, target: string) => {
    const abs = isAbsolute(target) ? target : resolve(root, target);
    if (!existsSync(abs)) {
      missing.push(target);
      return _match;
    }
    const content = readFileSync(abs, "utf8").replace(/\s+$/, "");
    const name = label.trim() || toPosix(relative(root, abs));
    const rel = toPosix(relative(root, abs));
    includes.push({ label: name, path: rel, codepoints: Array.from(content).length });
    return `<!-- ${name} — ${rel} -->\n${content}\n<!-- /${name} -->`;
  });

  if (missing.length) {
    throw new Error(
      `AGENT.md references ${missing.length === 1 ? "a file" : "files"} that ` +
        `${missing.length === 1 ? "does" : "do"} not exist: ${missing.join(", ")}\n` +
        `Paths resolve relative to ${root}.`,
    );
  }

  return { text, includes };
}
