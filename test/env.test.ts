import { describe, it, expect, afterEach, afterAll } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  parseEnv,
  loadEnvLocal,
  originOf,
  maskSecret,
  resolveConfig,
  ENV_FILE,
  KNOWN_VARS,
  IGNORED_VARS,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
} from "../src/env.js";

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function projectWith(envText: string | null) {
  const dir = mkdtempSync(join(tmpdir(), "coauthor-env-"));
  dirs.push(dir);
  if (envText !== null) writeFileSync(join(dir, ENV_FILE), envText, "utf8");
  return dir;
}

const saved = { ...process.env };
const savedCwd = process.cwd();
afterEach(() => {
  process.chdir(savedCwd);
  for (const k of [...KNOWN_VARS, ...IGNORED_VARS]) delete process.env[k];
  Object.assign(process.env, saved);
});

/**
 * Run with the working directory somewhere empty.
 *
 * `.env.local` is now also read from the working directory, at lower priority than
 * the project's own. Left alone, these tests would run with the repo root as cwd
 * and silently load the developer's real token file, so a suite that passes on a
 * clean checkout could fail on a configured machine, or pass for the wrong reason.
 */
function inEmptyCwd<T>(fn: () => T): T {
  const empty = mkdtempSync(join(tmpdir(), "coauthor-cwd-"));
  dirs.push(empty);
  process.chdir(empty);
  return fn();
}

describe("parseEnv", () => {
  it("reads plain assignments", () => {
    expect(parseEnv("A=1\nB=two")).toEqual(new Map([["A", "1"], ["B", "two"]]));
  });

  it("skips comments and blank lines", () => {
    expect(parseEnv("# note\n\nA=1\n  # indented\n")).toEqual(new Map([["A", "1"]]));
  });

  it("keeps quoted values intact, including spaces and #", () => {
    const m = parseEnv(`A="has space"\nB='sq'\nC="a#b"`);
    expect(m.get("A")).toBe("has space");
    expect(m.get("B")).toBe("sq");
    expect(m.get("C")).toBe("a#b");
  });

  it("strips a trailing comment from an unquoted value", () => {
    expect(parseEnv("A=value # why").get("A")).toBe("value");
  });

  it("keeps a bare # inside an unquoted value", () => {
    expect(parseEnv("A=va#lue").get("A")).toBe("va#lue");
  });

  it("accepts an export prefix", () => {
    expect(parseEnv("export A=1").get("A")).toBe("1");
  });

  it("keeps = inside a value, as tokens may contain it", () => {
    expect(parseEnv("A=a=b=c").get("A")).toBe("a=b=c");
  });

  it("allows an empty value", () => {
    expect(parseEnv("A=").get("A")).toBe("");
  });

  it("ignores a line with no =", () => {
    expect(parseEnv("garbage\nA=1")).toEqual(new Map([["A", "1"]]));
  });
});

describe("loadEnvLocal", () => {
  it("reports no file when there is none", () => {
    const load = inEmptyCwd(() => loadEnvLocal(projectWith(null)));
    expect(load.path).toBeNull();
    expect(load.applied).toEqual([]);
  });

  it("names every path it searched, so a misplaced file is findable", () => {
    const load = inEmptyCwd(() => loadEnvLocal(projectWith(null)));
    expect(load.searched).toHaveLength(2);
    expect(load.searched.every((p) => p.endsWith(ENV_FILE))).toBe(true);
  });

  it("lists the path once when the project IS the working directory", () => {
    const dir = projectWith(null);
    process.chdir(dir);
    expect(loadEnvLocal(".").searched).toHaveLength(1);
  });

  it("applies variables from the file", () => {
    delete process.env.COAUTHOR_MODEL;
    const load = inEmptyCwd(() => loadEnvLocal(projectWith("COAUTHOR_MODEL=from-file\n")));
    expect(process.env.COAUTHOR_MODEL).toBe("from-file");
    expect(load.applied).toContain("COAUTHOR_MODEL");
    expect(load.overridden).toEqual([]);
  });

  /**
   * The precedence that matters: a shell exporting COAUTHOR_MODEL for another project
   * must not silently defeat the project's own choice. Node's process.loadEnvFile
   * has the opposite behaviour, which is why this is hand-rolled.
   */
  it("overrides a variable already in the environment, and says so", () => {
    process.env.COAUTHOR_MODEL = "from-shell";
    const load = inEmptyCwd(() => loadEnvLocal(projectWith("COAUTHOR_MODEL=from-file\n")));
    expect(process.env.COAUTHOR_MODEL).toBe("from-file");
    expect(load.overridden).toContain("COAUTHOR_MODEL");
  });

  it("does not report an override when the value is identical", () => {
    process.env.COAUTHOR_MODEL = "same";
    expect(
      inEmptyCwd(() => loadEnvLocal(projectWith("COAUTHOR_MODEL=same\n"))).overridden,
    ).toEqual([]);
  });

  it("flags a variable coauthor does not read", () => {
    const load = inEmptyCwd(() => loadEnvLocal(projectWith("COAUTHOR_MODLE=typo\n")));
    expect(load.unknown).toEqual(["COAUTHOR_MODLE"]);
  });

  it("does not flag known variables as unknown", () => {
    const text = KNOWN_VARS.map((k) => `${k}=x`).join("\n");
    expect(inEmptyCwd(() => loadEnvLocal(projectWith(text))).unknown).toEqual([]);
  });
});

/**
 * A credential kept beside the harness should work for any project it is pointed at,
 * so the working directory is searched too. It must stay BELOW the project's own
 * file: a project that pins a model cannot be redirected by where the command was
 * typed.
 */
describe("working-directory fallback", () => {
  function cwdWith(text: string) {
    const dir = mkdtempSync(join(tmpdir(), "coauthor-cwd-"));
    dirs.push(dir);
    writeFileSync(join(dir, ENV_FILE), text, "utf8");
    process.chdir(dir);
    return dir;
  }

  it("applies the working-directory file when the project has none", () => {
    cwdWith("COAUTHOR_AUTH_TOKEN=from-cwd" + "\n");
    const load = loadEnvLocal(projectWith(null));
    expect(process.env.COAUTHOR_AUTH_TOKEN).toBe("from-cwd");
    expect(load.files).toHaveLength(1);
    expect(load.files[0]!.scope).toBe("cwd");
  });

  it("lets the project file win over the working-directory file", () => {
    cwdWith("COAUTHOR_MODEL=from-cwd" + "\n");
    const project = projectWith("COAUTHOR_MODEL=from-project" + "\n");
    const load = loadEnvLocal(project);
    expect(process.env.COAUTHOR_MODEL).toBe("from-project");
    expect(originOf(load, "COAUTHOR_MODEL")).toBe(resolve(project, ENV_FILE));
  });

  it("reports the shadowed variable against the file that lost it", () => {
    cwdWith("COAUTHOR_MODEL=from-cwd" + "\n");
    const load = loadEnvLocal(projectWith("COAUTHOR_MODEL=from-project" + "\n"));
    const fromCwd = load.files.find((f) => f.scope === "cwd")!;
    expect(fromCwd.shadowed).toContain("COAUTHOR_MODEL");
    expect(fromCwd.applied).not.toContain("COAUTHOR_MODEL");
  });

  it("merges keys the project file does not set", () => {
    cwdWith("COAUTHOR_AUTH_TOKEN=tok" + "\n" + "COAUTHOR_MODEL=from-cwd" + "\n");
    const load = loadEnvLocal(projectWith("COAUTHOR_MODEL=from-project" + "\n"));
    expect(resolveConfig().token).toBe("tok");
    expect(resolveConfig().model).toBe("from-project");
    expect(load.applied.sort()).toEqual(["COAUTHOR_AUTH_TOKEN", "COAUTHOR_MODEL"]);
  });

  it("points `path` at the highest-priority file present", () => {
    cwdWith("COAUTHOR_MODEL=from-cwd" + "\n");
    const project = projectWith("COAUTHOR_MODEL=from-project" + "\n");
    expect(loadEnvLocal(project).path).toBe(resolve(project, ENV_FILE));
  });

  it("still beats the ambient environment", () => {
    process.env.COAUTHOR_MODEL = "from-shell";
    cwdWith("COAUTHOR_MODEL=from-cwd" + "\n");
    const load = loadEnvLocal(projectWith(null));
    expect(process.env.COAUTHOR_MODEL).toBe("from-cwd");
    expect(load.overridden).toContain("COAUTHOR_MODEL");
  });
});

describe("maskSecret", () => {
  it("keeps head and tail of a long secret", () => {
    const masked = maskSecret("RDb1I3O1zIuaAvPAlMWx6XU00IeO69UQltY2vm7toB1vLxmk");
    expect(masked.startsWith("RDb1I3")).toBe(true);
    expect(masked.endsWith("xmk")).toBe(true);
    expect(masked).not.toContain("AvPAlMWx");
  });

  it("reveals nothing from a short secret", () => {
    expect(maskSecret("short")).toBe("*****");
  });
});

/**
 * The reason for the COAUTHOR_ prefix. This machine exports ANTHROPIC_MODEL and
 * ANTHROPIC_BASE_URL for other tooling; inheriting them made coauthor look like it
 * was ignoring its own configuration.
 */
describe("isolation from ANTHROPIC_*", () => {
  it("ignores an ambient ANTHROPIC_MODEL", () => {
    process.env.ANTHROPIC_MODEL = "ambient-model";
    delete process.env.COAUTHOR_MODEL;
    expect(resolveConfig().model).toBe(DEFAULT_MODEL);
  });

  it("ignores an ambient ANTHROPIC_BASE_URL", () => {
    process.env.ANTHROPIC_BASE_URL = "https://ambient.example.com";
    delete process.env.COAUTHOR_BASE_URL;
    expect(resolveConfig().baseUrl).toBe(DEFAULT_BASE_URL);
  });

  it("ignores an ambient ANTHROPIC_AUTH_TOKEN", () => {
    process.env.ANTHROPIC_AUTH_TOKEN = "ambient-token";
    delete process.env.COAUTHOR_AUTH_TOKEN;
    delete process.env.COAUTHOR_API_KEY;
    expect(resolveConfig().token).toBeNull();
  });

  it("reports ambient ANTHROPIC_* variables so the rename is discoverable", () => {
    process.env.ANTHROPIC_MODEL = "ambient";
    process.env.ANTHROPIC_BASE_URL = "https://ambient.example.com";
    const load = inEmptyCwd(() => loadEnvLocal(projectWith(null)));
    expect(load.ignored).toContain("ANTHROPIC_MODEL");
    expect(load.ignored).toContain("ANTHROPIC_BASE_URL");
  });

  it("prefers COAUTHOR_AUTH_TOKEN over COAUTHOR_API_KEY", () => {
    process.env.COAUTHOR_AUTH_TOKEN = "auth";
    process.env.COAUTHOR_API_KEY = "api";
    const cfg = resolveConfig();
    expect(cfg.tokenVar).toBe("COAUTHOR_AUTH_TOKEN");
    expect(cfg.token).toBe("auth");
  });

  it("falls back to COAUTHOR_API_KEY when no auth token is set", () => {
    delete process.env.COAUTHOR_AUTH_TOKEN;
    process.env.COAUTHOR_API_KEY = "api";
    expect(resolveConfig().tokenVar).toBe("COAUTHOR_API_KEY");
  });
});

describe("gitignore", () => {
  const root = resolve(import.meta.dirname, "..");
  const ignored = (p: string) => {
    try {
      execFileSync("git", ["check-ignore", "-q", p], { cwd: root });
      return true;
    } catch {
      return false;
    }
  };

  // `*.local.*` requires a suffix after `.local.`, so it does not cover a name
  // ending in `.local`. Without a dedicated rule a token file would be committed.
  it("ignores .env.local", () => {
    expect(ignored(".env.local")).toBe(true);
  });

  it("does not ignore .env.example, which is documentation", () => {
    expect(ignored(".env.example")).toBe(false);
  });
});
