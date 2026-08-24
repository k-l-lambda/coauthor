import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export const ENV_FILE = ".env.local";

/** Every variable coauthor reads. `check` reports each one's resolved source. */
export const KNOWN_VARS = [
  "COAUTHOR_AUTH_TOKEN",
  "COAUTHOR_API_KEY",
  "COAUTHOR_BASE_URL",
  "COAUTHOR_MODEL",
  "COAUTHOR_MAX_TOKENS",
  "COAUTHOR_EFFORT",
] as const;

/**
 * Variables coauthor deliberately does NOT read, listed so `check` can say they are
 * being ignored. Reading them as a fallback would reintroduce the problem the
 * COAUTHOR_ prefix exists to solve: this machine exports ANTHROPIC_MODEL and
 * ANTHROPIC_BASE_URL for other tooling, and inheriting those silently made coauthor
 * appear to ignore its own configuration.
 */
export const IGNORED_VARS = [
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL",
] as const;

/** The SDK's own default. Passed explicitly so it cannot read ANTHROPIC_BASE_URL. */
export const DEFAULT_BASE_URL = "https://api.anthropic.com";
export const DEFAULT_MODEL = "claude-sonnet-4-6";
export const DEFAULT_MAX_TOKENS = 8192;

/**
 * Thinking effort, as named levels mapped onto a token budget.
 *
 * The API takes `budget_tokens`, not a level, but a number here would be a worse
 * knob: the useful values depend on the model and the caller has no way to know
 * them. Levels also survive a change of model.
 *
 * Default is off. Extended thinking is a Claude feature, and the base URL may be a
 * proxy serving something else that rejects the parameter outright — so it is opt-in,
 * never inferred.
 */
export const EFFORT_BUDGETS = {
  off: 0,
  low: 2048,
  medium: 8192,
  high: 24576,
} as const;

export type Effort = keyof typeof EFFORT_BUDGETS;
export const EFFORT_LEVELS = Object.keys(EFFORT_BUDGETS) as Effort[];
export const DEFAULT_EFFORT: Effort = "off";

/** The API's floor for `budget_tokens`. Below this, thinking cannot be enabled. */
export const MIN_THINKING_BUDGET = 1024;
/**
 * Room reserved for the visible reply. `budget_tokens` must be strictly less than
 * `max_tokens`, and a budget that consumed nearly all of it would leave the answer
 * truncated — the thinking would be spent with nothing to show for it.
 */
export const REPLY_HEADROOM = 1024;

/** Which directory a file was found in. Determines precedence. */
export type EnvScope = "project" | "cwd";

export interface EnvFile {
  /** Absolute path of the file. */
  path: string;
  scope: EnvScope;
  /** Variables this file supplied that are in effect. */
  applied: string[];
  /** Variables this file set that a higher-priority file overrode. */
  shadowed: string[];
  /** Variables this file set that coauthor does not read — usually a typo. */
  unknown: string[];
}

export interface EnvLoad {
  /** The highest-priority file that was found, or null if there was none. */
  path: string | null;
  /**
   * Every file that was looked for, highest priority first, whether or not it
   * exists. Quoted in credential errors: a message naming only ".env.local" reads
   * as "the file is not being loaded" when the real cause is a file sitting one
   * directory away from the one that was searched.
   */
  searched: string[];
  /** Files that were found, lowest priority first — the order they were applied. */
  files: EnvFile[];
  /** Which file supplied each variable in effect, keyed by variable name. */
  origin: Record<string, string>;
  /** Every variable in effect from a file, across all of them. */
  applied: string[];
  /** Variables a file set that coauthor does not read, across all of them. */
  unknown: string[];
  /** Variables where a file replaced a value that was already in the environment. */
  overridden: string[];
  /** ANTHROPIC_* variables present in the environment and being ignored. */
  ignored: string[];
}

/**
 * Parse dotenv-style text. Supports `#` comments, blank lines, `export ` prefixes,
 * and single- or double-quoted values (which may contain `#` and spaces). An
 * unquoted value has trailing comments and whitespace stripped.
 */
export function parseEnv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;

    const key = line.slice(0, eq).replace(/^export\s+/, "").trim();
    if (!key) continue;

    let value = line.slice(eq + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length > 1) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(" #");
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    out.set(key, value);
  }
  return out;
}

/**
 * Load `.env.local` into process.env, from the project directory and, at lower
 * priority, the working directory.
 *
 * Precedence, most specific first:
 *
 *   1. `<project>/.env.local`   — this project's own choice of model and proxy
 *   2. `<cwd>/.env.local`       — a fallback for whoever ran the command
 *   3. the ambient environment
 *
 * The working-directory file exists so a credential can be kept in one place
 * instead of copied into every writing project, which both is tedious and
 * multiplies the number of files holding a live token. It sits BELOW the project
 * file: a project that pins a model must not be redirected by where the command
 * happened to be typed.
 *
 * Both files beat the ambient environment. Node's own `process.loadEnvFile` does
 * the opposite, which is the wrong precedence here: a shell exporting
 * COAUTHOR_MODEL for another project would silently defeat this project's choice,
 * and the failure would look like coauthor ignoring its configuration.
 */
export function loadEnvLocal(projectDir: string): EnvLoad {
  const projectPath = resolve(projectDir, ENV_FILE);
  const cwdPath = resolve(process.cwd(), ENV_FILE);

  // Running inside the project is the ordinary case, and then the two paths are
  // the same file. Listing it once keeps it from being reported twice.
  const candidates: Array<{ path: string; scope: EnvScope }> =
    projectPath === cwdPath
      ? [{ path: projectPath, scope: "project" }]
      : [
          { path: projectPath, scope: "project" },
          { path: cwdPath, scope: "cwd" },
        ];

  const load: EnvLoad = {
    path: null,
    searched: candidates.map((c) => c.path),
    files: [],
    origin: {},
    applied: [],
    unknown: [],
    overridden: [],
    ignored: IGNORED_VARS.filter((v) => process.env[v] !== undefined),
  };

  // What the shell supplied, captured before any file touches process.env, so an
  // override of the environment can be told from one file overriding another.
  const ambient = new Map(Object.entries(process.env));

  // Lowest priority first, so a higher-priority assignment simply overwrites.
  for (const { path, scope } of [...candidates].reverse()) {
    if (!existsSync(path)) continue;

    const vars = parseEnv(readFileSync(path, "utf8"));
    const file: EnvFile = { path, scope, applied: [], shadowed: [], unknown: [] };

    for (const [key, value] of vars) {
      process.env[key] = value;
      file.applied.push(key);
      // A file read later is more specific, so it takes the key from whichever
      // file claimed it before.
      const previous = load.origin[key];
      if (previous) {
        const loser = load.files.find((f) => f.path === previous);
        loser?.shadowed.push(key);
        loser?.applied.splice(loser.applied.indexOf(key), 1);
      }
      load.origin[key] = path;
      if (!(KNOWN_VARS as readonly string[]).includes(key)) file.unknown.push(key);
    }
    load.files.push(file);
  }

  for (const key of Object.keys(load.origin)) {
    load.applied.push(key);
    const was = ambient.get(key);
    if (was !== undefined && was !== process.env[key]) load.overridden.push(key);
  }
  for (const file of load.files) load.unknown.push(...file.unknown);

  // `path` names the file a reader should edit first: the highest-priority one present.
  load.path = load.files.length ? load.files[load.files.length - 1]!.path : null;
  return load;
}

/** The file a variable's value came from, or null if nothing on disk supplied it. */
export function originOf(env: EnvLoad, key: string): string | null {
  return env.origin[key] ?? null;
}

/** Keep enough of a secret to recognize it, not enough to use it. */
export function maskSecret(value: string): string {
  const chars = Array.from(value);
  if (chars.length <= 12) return "*".repeat(chars.length);
  return `${chars.slice(0, 6).join("")}${"*".repeat(8)}${chars.slice(-4).join("")}`;
}

export interface Resolved {
  tokenVar: "COAUTHOR_AUTH_TOKEN" | "COAUTHOR_API_KEY" | null;
  token: string | null;
  baseUrl: string;
  model: string;
  maxTokens: number;
  /** The requested level, as written. Invalid input falls back to the default. */
  effort: Effort;
  /** What COAUTHOR_EFFORT was set to, if it was not a valid level. */
  effortInvalid: string | null;
  /**
   * Tokens to give thinking, already clamped to fit under maxTokens, or 0 for off.
   * 0 also means "not possible here": a maxTokens too small to leave both the API's
   * 1024 floor and room for a reply cannot support thinking at all.
   */
  thinkingBudget: number;
  /** Set when a level was requested but had to be reduced or refused. */
  effortNote: string | null;
}

/**
 * Turn a level into a `budget_tokens` that satisfies the API's two constraints:
 * at least 1024, and strictly less than max_tokens. A level whose nominal budget
 * does not fit is clamped rather than refused — asking for `high` against a small
 * max_tokens should still think as hard as it can, not silently think not at all.
 */
export function thinkingBudgetFor(effort: Effort, maxTokens: number): {
  budget: number;
  note: string | null;
} {
  const want = EFFORT_BUDGETS[effort];
  if (!want) return { budget: 0, note: null };

  const ceiling = maxTokens - REPLY_HEADROOM;
  if (ceiling < MIN_THINKING_BUDGET) {
    return {
      budget: 0,
      note:
        `effort=${effort} needs COAUTHOR_MAX_TOKENS of at least ` +
        `${MIN_THINKING_BUDGET + REPLY_HEADROOM}; it is ${maxTokens}, so thinking is off`,
    };
  }
  if (want > ceiling) {
    return {
      budget: ceiling,
      note: `effort=${effort} clamped from ${want} to ${ceiling} tokens to fit max_tokens ${maxTokens}`,
    };
  }
  return { budget: want, note: null };
}

/** Single place where configuration becomes values, so CLI and loop cannot diverge. */
export function resolveConfig(): Resolved {
  const raw = process.env.COAUTHOR_EFFORT?.trim().toLowerCase();
  const valid = raw !== undefined && (EFFORT_LEVELS as string[]).includes(raw);
  const effort = (valid ? raw : DEFAULT_EFFORT) as Effort;
  const maxTokens = Number(process.env.COAUTHOR_MAX_TOKENS ?? DEFAULT_MAX_TOKENS);
  const { budget, note } = thinkingBudgetFor(effort, maxTokens);

  const tokenVar = process.env.COAUTHOR_AUTH_TOKEN
    ? ("COAUTHOR_AUTH_TOKEN" as const)
    : process.env.COAUTHOR_API_KEY
      ? ("COAUTHOR_API_KEY" as const)
      : null;
  return {
    tokenVar,
    token: tokenVar ? process.env[tokenVar]! : null,
    baseUrl: process.env.COAUTHOR_BASE_URL ?? DEFAULT_BASE_URL,
    model: process.env.COAUTHOR_MODEL ?? DEFAULT_MODEL,
    maxTokens,
    effort,
    effortInvalid: raw !== undefined && !valid ? (process.env.COAUTHOR_EFFORT ?? null) : null,
    thinkingBudget: budget,
    effortNote: note,
  };
}
