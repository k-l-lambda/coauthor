#!/usr/bin/env node
import { Command } from "commander";
import chalk from "chalk";
import { relative } from "node:path";
import { DEFAULT_DRAFT_FILE, openProject, toPosix } from "./project.js";
import { buildPrompt } from "./prompt/build.js";
import {
  EFFORT_LEVELS,
  ENV_FILE,
  loadEnvLocal,
  maskSecret,
  originOf,
  resolveConfig,
  type EnvLoad,
} from "./env.js";

const program = new Command();

program
  .name("coauthor")
  .description("Creative-writing agent harness with a closed, document-model-aware tool surface")
  .version("0.1.0")
  .option("-d, --draft <file>", "draft file name", DEFAULT_DRAFT_FILE);

/** Resolve a global option from either the root action or a subcommand action. */
function draftFrom(command: Command): string {
  return (command.optsWithGlobals() as { draft?: string }).draft ?? DEFAULT_DRAFT_FILE;
}

program
  .command("dev-prompt", { hidden: true })
  .description("Print the assembled system prompt and exit (no model call)")
  .argument("[dir]", "writing project directory", ".")
  .option("--stats-only", "print only the size summary")
  .action((dir: string, opts: { statsOnly?: boolean }, command: Command) => {
    loadEnvLocal(dir);
    const project = openProject(dir, draftFrom(command));
    const ctx = buildPrompt(project);
    if (!opts.statsOnly) console.log(ctx.system);
    const sys = Array.from(ctx.system).length;
    console.error(
      chalk.dim(
        [
          "",
          `system prompt : ${sys} codepoints`,
          `draft         : ${ctx.blocks.length} blocks, ${ctx.draftCodepoints} codepoints`,
          `includes      : ${
            ctx.includes.map((i) => `${i.label} (${i.path}, ${i.codepoints})`).join(", ") || "none"
          }`,
          `pending marks : ${ctx.pendingAnnotations}`,
        ].join("\n"),
      ),
    );
  });

/** Where a value came from, so an ambient variable cannot masquerade as configuration. */
function source(env: EnvLoad, key: string): string {
  const from = originOf(env, key);
  if (from) {
    // Which file matters once there are two: a value can come from the project or
    // from the directory the command was run in, and those have different owners.
    const where = toPosix(relative(process.cwd(), from) || from);
    return env.overridden.includes(key)
      ? chalk.dim(`(${where}, overrode environment)`)
      : chalk.dim(`(${where})`);
  }
  // Say nothing for a value nothing supplied; labelling a built-in default
  // "(environment)" would imply the shell had set it.
  return process.env[key] !== undefined ? chalk.dim("(environment)") : "";
}

program
  .command("sys")
  .description("Print the assembled LLM system prompt and exit (no model call)")
  .argument("[dir]", "writing project directory", ".")
  .action((dir: string, _opts: object, command: Command) => {
    loadEnvLocal(dir);
    const project = openProject(dir, draftFrom(command));
    console.log(buildPrompt(project).system);
  });

program
  .command("check")
  .description("Validate a writing project and show what the agent would see (no model call)")
  .argument("[dir]", "writing project directory", ".")
  .action((dir: string, _opts: object, command: Command) => {
    const env = loadEnvLocal(dir);
    const project = openProject(dir, draftFrom(command));
    const ctx = buildPrompt(project);
    const ok = chalk.green("ok");
    const warn = chalk.yellow("!");

    console.log(`${ok}  AGENT.md          ${toPosix(project.agentPath)}`);
    console.log(
      `${ok}  ${project.draftName.padEnd(17)} ${ctx.blocks.length} paragraphs, ` +
        `${ctx.draftCodepoints} codepoints` +
        (project.draftName === DEFAULT_DRAFT_FILE ? "" : chalk.dim(" (--draft)")),
    );
    for (const i of ctx.includes) {
      console.log(`${ok}  include           ${i.label} -> ${i.path} (${i.codepoints} codepoints)`);
    }
    if (!ctx.includes.length) {
      console.log(
        `${warn}   include           none. Reference a setting document with #[label](path) ` +
          `in AGENT.md to inline its full text.`,
      );
    }

    const marks = ctx.pendingAnnotations;
    console.log(
      `${marks ? chalk.yellow(String(marks)) : ok}  pending marks     ${marks} ` +
        `annotation${marks === 1 ? "" : "s"} awaiting revision`,
    );
    console.log(`${ok}  system prompt     ${Array.from(ctx.system).length} codepoints per turn`);

    if (env.files.length) {
      // Highest priority first, matching the order a reader should think about them.
      for (const f of [...env.files].reverse()) {
        const label = f.scope === "project" ? "project" : "cwd";
        console.log(
          `${ok}  ${ENV_FILE}        ${f.applied.length} variable${
            f.applied.length === 1 ? "" : "s"
          } ${chalk.dim(`${label} · ${toPosix(relative(process.cwd(), f.path) || f.path)}`)}` +
            (f.shadowed.length
              ? chalk.dim(` — ${f.shadowed.join(", ")} overridden by a higher-priority file`)
              : ""),
        );
      }
    } else {
      console.log(
        `${chalk.dim("--")}  ${ENV_FILE}        none ${chalk.dim(
          `(optional; looked in ${env.searched
            .map((p) => toPosix(relative(process.cwd(), p) || p))
            .join(", ")})`,
        )}`,
      );
    }
    for (const key of env.unknown) {
      console.log(`${warn}   ${ENV_FILE}        ${key} is not a variable coauthor reads`);
    }

    const cfg = resolveConfig();
    console.log(
      cfg.token
        ? `${ok}  credential        ${maskSecret(cfg.token)} ` +
            chalk.dim(`via ${cfg.tokenVar} `) +
            source(env, cfg.tokenVar!)
        : `${chalk.red("--")}  credential        missing. Set COAUTHOR_AUTH_TOKEN in ` +
            env.searched.map((p) => toPosix(relative(process.cwd(), p) || p)).join(" or "),
    );
    console.log(
      `${ok}  model             ${cfg.model}${process.env.COAUTHOR_MODEL ? "" : " (default)"} ` +
        source(env, "COAUTHOR_MODEL"),
    );
    console.log(
      `${ok}  base url          ${cfg.baseUrl}${
        process.env.COAUTHOR_BASE_URL ? "" : " (default)"
      } ` + source(env, "COAUTHOR_BASE_URL"),
    );
    console.log(
      `${ok}  max tokens        ${cfg.maxTokens}${
        process.env.COAUTHOR_MAX_TOKENS ? "" : " (default)"
      } ` + source(env, "COAUTHOR_MAX_TOKENS"),
    );

    // Say the token budget, not just the level: "medium" alone gives no way to see
    // that it was clamped to fit max_tokens, or refused for being unable to.
    const budget = cfg.thinkingBudget
      ? `${cfg.effort} · ${cfg.thinkingBudget} thinking tokens`
      : cfg.effort === "off"
        ? "off"
        : chalk.yellow(`${cfg.effort} · unavailable`);
    console.log(
      `${cfg.effortNote ? warn + "  " : ok + "  "}effort            ${budget}` +
        `${process.env.COAUTHOR_EFFORT ? "" : " (default)"} ` +
        source(env, "COAUTHOR_EFFORT"),
    );
    if (cfg.effortInvalid !== null) {
      console.log(
        `${warn}   effort            ${chalk.dim(
          `“${cfg.effortInvalid}” is not a level; using ${cfg.effort}. ` +
            `Levels: ${EFFORT_LEVELS.join(", ")}`,
        )}`,
      );
    }
    if (cfg.effortNote) {
      console.log(`${warn}   effort            ${chalk.dim(cfg.effortNote)}`);
    }

    // Naming these explicitly is the point of the COAUTHOR_ prefix: coauthor reads
    // only COAUTHOR_*, so a leftover ANTHROPIC_* in the shell would otherwise look
    // like it ought to work and fail as an unexplained default.
    if (env.ignored.length) {
      console.log(
        `${warn}   ignored           ${env.ignored.join(", ")} ` +
          chalk.dim("— coauthor reads COAUTHOR_* only; rename these to configure it"),
      );
    }

    console.log(chalk.dim(`\nRun \`coauthor dev-prompt ${dir}\` to read the assembled prompt.`));
  });

// The argument must be declared before the action, or the handler's parameters do
// not line up and `dir` arrives undefined.
program
  .argument("[dir]", "writing project directory", ".")
  .action(async (dir: string, _opts: object, command: Command) => {
    const env = loadEnvLocal(dir);
    const { startRepl } = await import("./repl.js");
    await startRepl(openProject(dir, draftFrom(command)), env);
  });

try {
  await program.parseAsync(process.argv);
} catch (e) {
  console.error(chalk.red((e as Error).message));
  process.exit(1);
}
