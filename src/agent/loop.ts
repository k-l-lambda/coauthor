import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { buildPrompt } from "../prompt/build.js";
import { toAnthropicTools, type ToolContext, type ToolDef } from "../tools/index.js";
import { readDraft, readSetting } from "../tools/read.js";
import { revise, insert, append } from "../tools/write.js";
import type { Project } from "../project.js";
import { ENV_FILE, resolveConfig, type EnvLoad } from "../env.js";

export const TOOLS: ToolDef[] = [readDraft, readSetting, revise, insert, append] as ToolDef[];

/** Guards against a runaway tool loop within a single turn. */
const MAX_STEPS = 24;

export interface TurnHooks {
  onText: (chunk: string) => void;
  /** Extended-thinking text, when COAUTHOR_EFFORT enables it. */
  onThinking?: (chunk: string) => void;
  onToolCall: (name: string, input: unknown) => void;
  onToolError: (name: string, message: string) => void;
  onEdit: (summary: string) => void;
  onStep?: (step: number) => void;
}

export interface Model {
  client: Anthropic;
  model: string;
  maxTokens: number;
  /** Tokens for extended thinking, 0 to leave the parameter off entirely. */
  thinkingBudget: number;
}

export function createModel(env?: EnvLoad): Model {
  const cfg = resolveConfig();
  if (!cfg.token) {
    // Name the paths that were actually searched. "Set it in .env.local" sends the
    // reader to look at a file they may already have — one directory away from
    // anywhere this looked.
    const where = env?.searched.length
      ? env.searched.map((p) => `  ${p}`).join("\n  or\n")
      : `  ${ENV_FILE} beside AGENT.md`;
    throw new Error(
      [
        "No API credential. Set COAUTHOR_AUTH_TOKEN in:",
        where,
        "Add COAUTHOR_BASE_URL too if you use a proxy.",
      ].join("\n"),
    );
  }
  // baseURL is always passed explicitly: given undefined, the SDK reads
  // ANTHROPIC_BASE_URL from the environment, which would let an ambient variable
  // silently redirect the project past its own configuration.
  return {
    client: new Anthropic({ apiKey: cfg.token, baseURL: cfg.baseUrl }),
    model: cfg.model,
    maxTokens: cfg.maxTokens,
    thinkingBudget: cfg.thinkingBudget,
  };
}

/**
 * Run one turn to completion.
 *
 * Every turn is a fresh session: the system prompt is rebuilt from disk and the
 * message list starts from just this request. Nothing accumulates across turns, so
 * the prompt always reflects the current files and last turn's writes are simply
 * visible in this one. The tool loop below is hand-written rather than using the
 * SDK's tool runner, because the target may be a non-Claude model behind an
 * Anthropic-compatible proxy.
 */
export async function runTurn(
  model: Model,
  project: Project,
  request: string,
  hooks: TurnHooks,
): Promise<void> {
  const { system } = buildPrompt(project);
  const tools = toAnthropicTools(TOOLS);
  const ctx: ToolContext = { project, onEdit: hooks.onEdit };
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: request }];

  for (let step = 0; step < MAX_STEPS; step++) {
    hooks.onStep?.(step);

    // `thinking` is omitted entirely when off, not sent as {type:"disabled"}: the
    // base URL may be a proxy serving a non-Claude model that rejects the field.
    const stream = model.client.messages.stream({
      model: model.model,
      max_tokens: model.maxTokens,
      system,
      tools,
      messages,
      ...(model.thinkingBudget
        ? { thinking: { type: "enabled" as const, budget_tokens: model.thinkingBudget } }
        : {}),
    });

    stream.on("text", (chunk) => hooks.onText(chunk));
    if (hooks.onThinking) {
      stream.on("thinking", (chunk) => hooks.onThinking!(chunk));
    }
    const response = await stream.finalMessage();

    const calls = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );
    if (!calls.length) return;

    messages.push({ role: "assistant", content: response.content });
    const results: Anthropic.ToolResultBlockParam[] = [];

    for (const call of calls) {
      const def = TOOLS.find((t) => t.name === call.name);
      if (!def) {
        hooks.onToolError(call.name, "unknown tool");
        results.push({
          type: "tool_result",
          tool_use_id: call.id,
          is_error: true,
          content: `No such tool: ${call.name}. Available: ${TOOLS.map((t) => t.name).join(", ")}`,
        });
        continue;
      }

      // Validate at runtime: a proxied non-Claude model may not honour the schema.
      const parsed = def.schema.safeParse(call.input);
      if (!parsed.success) {
        const msg = z.prettifyError(parsed.error);
        hooks.onToolError(call.name, msg);
        results.push({
          type: "tool_result",
          tool_use_id: call.id,
          is_error: true,
          content: `Invalid arguments for ${call.name}:\n${msg}`,
        });
        continue;
      }

      hooks.onToolCall(call.name, parsed.data);
      try {
        results.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: def.run(parsed.data, ctx),
        });
      } catch (e) {
        const msg = (e as Error).message;
        hooks.onToolError(call.name, msg);
        results.push({
          type: "tool_result",
          tool_use_id: call.id,
          is_error: true,
          content: msg,
        });
      }
    }

    messages.push({ role: "user", content: results });
  }

  hooks.onToolError("(loop)", `Stopped after ${MAX_STEPS} tool steps in one turn.`);
}
