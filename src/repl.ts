import * as readline from "node:readline";
import chalk from "chalk";
import { buildPrompt } from "./prompt/build.js";
import { createModel, runTurn, TOOLS } from "./agent/loop.js";
import { tailLog } from "./log/editlog.js";
import { toPosix, type Project } from "./project.js";
import { ENV_FILE, type EnvLoad } from "./env.js";

function banner(project: Project): string {
  const ctx = buildPrompt(project);
  const inc = ctx.includes.map((i) => i.label).join("、") || "无";
  const pending = ctx.pendingAnnotations
    ? chalk.yellow(`${ctx.pendingAnnotations} 处待处理标记`)
    : chalk.dim("无待处理标记");
  return [
    chalk.bold(`coauthor`) + chalk.dim(`  ${toPosix(project.root)}`),
    chalk.dim(`正文 ${ctx.blocks.length} 段 / ${ctx.draftCodepoints} 字 · 设定 ${inc} · `) + pending,
    chalk.dim(`/log 看编辑记录 · /status 看状态 · /exit 退出 · 每轮独立，不累积上下文`),
    "",
  ].join("\n");
}

/**
 * readline rather than a raw-mode TUI: the terminal keeps handling input itself, so
 * Chinese IME composition works normally. A raw-mode reader intercepts keystrokes
 * and breaks composition on Windows terminals.
 */
export async function startRepl(project: Project, env?: EnvLoad): Promise<void> {
  const model = createModel(env);
  process.stdout.write(banner(project));
  if (env?.path) {
    console.log(
      chalk.dim(`已载入 ${ENV_FILE}（${env.applied.length} 项）
`),
    );
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: chalk.cyan("› "),
    historySize: 200,
  });

  // Input is queued and drained one at a time. Lines can arrive while a turn is
  // still running — the author hits enter twice, or stdin is a pipe delivering
  // everything at once — and running them concurrently would interleave writes to
  // the same draft. Likewise, stdin closing must not kill work already in flight.
  const queue: string[] = [];
  let draining = false;
  let stop = false;
  let closed = false;

  const farewell = () => {
    console.log(chalk.dim("再见。"));
    process.exit(0);
  };

  const runOne = async (line: string): Promise<void> => {
    if (line === "/exit" || line === "/quit") {
      stop = true;
      return;
    }
    if (line === "/log") {
      console.log(tailLog(project.logPath, 3));
      return;
    }
    if (line === "/status") {
      process.stdout.write(banner(project));
      console.log(
        chalk.dim(
          `模型 ${model.model} · 思考 ${
            model.thinkingBudget ? `${model.thinkingBudget} tokens` : "关"
          } · 工具 ${TOOLS.map((t) => t.name).join(", ")}` +
            (env?.path ? ` · 配置 ${ENV_FILE}` : ""),
        ),
      );
      return;
    }
    if (line.startsWith("/")) {
      console.log(chalk.dim("可用命令：/log /status /exit"));
      return;
    }

    let sawText = false;
    const breakLine = () => {
      if (sawText) process.stdout.write("\n");
      sawText = false;
    };

    // Thinking is dimmed and labelled once, so a reader cannot mistake it for the
    // reply or, worse, for prose meant to go into the draft.
    let inThinking = false;
    const endThinking = () => {
      if (inThinking) {
        process.stdout.write("\n");
        inThinking = false;
      }
    };

    try {
      await runTurn(model, project, line, {
        onText: (chunk) => {
          endThinking();
          sawText = true;
          process.stdout.write(chunk);
        },
        ...(model.thinkingBudget
          ? {
              onThinking: (chunk: string) => {
                if (!inThinking) {
                  if (sawText) process.stdout.write("\n");
                  process.stdout.write(chalk.dim("  ⟪思考⟫ "));
                  inThinking = true;
                  sawText = false;
                }
                process.stdout.write(chalk.dim(chunk));
              },
            }
          : {}),
        onToolCall: (name, input) => {
          endThinking();
          const d = input as Record<string, unknown>;
          const where =
            d.from !== undefined
              ? `${d.from}-${d.to}`
              : d.after !== undefined
                ? `after ${d.after}`
                : d.heading !== undefined
                  ? String(d.heading)
                  : "";
          breakLine();
          console.log(chalk.blue(`  ⟢ ${name}${where ? " " + chalk.dim(where) : ""}`));
        },
        onEdit: (summary) => {
          endThinking();
          const [head, ...diff] = summary.split("\n");
          console.log(chalk.green(`  ✎ ${head}`));
          for (const l of diff) {
            if (l.startsWith("+")) console.log(chalk.green(`    ${l}`));
            else if (l.startsWith("-")) console.log(chalk.red(`    ${l}`));
            else console.log(chalk.dim(`    ${l}`));
          }
        },
        onToolError: (name, message) => {
          endThinking();
          breakLine();
          console.log(chalk.red(`  ✗ ${name}: ${message.split("\n")[0]}`));
        },
      });
      process.stdout.write("\n");
    } catch (e) {
      process.stdout.write("\n");
      console.error(chalk.red(`✗ ${(e as Error).message}`));
    }
  };

  const drain = async (): Promise<void> => {
    if (draining) return;
    draining = true;
    while (queue.length && !stop) await runOne(queue.shift()!);
    draining = false;
    if (stop || closed) return farewell();
    rl.prompt();
  };

  rl.on("line", (raw) => {
    const line = raw.trim();
    if (line) queue.push(line);
    void drain();
  });

  // stdin ended. Finish queued work first, then leave.
  rl.on("close", () => {
    closed = true;
    if (!draining && !queue.length) farewell();
  });

  rl.prompt();
}
