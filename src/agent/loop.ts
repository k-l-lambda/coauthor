import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { buildPrompt } from "../prompt/build.js";
import { toAnthropicTools, type ToolContext, type ToolDef } from "../tools/index.js";
import { readDraft, readSetting } from "../tools/read.js";
import { revise, insert, append } from "../tools/write.js";
import type { Project } from "../project.js";
import { ENV_FILE, resolveConfig, type EnvLoad } from "../env.js";
import { appendStreamDump } from "../log/streamlog.js";
import { toPosix } from "../project.js";
import { consumeStream, StreamError } from "./stream.js";

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
  /** A tolerated stream deviation, already recorded in the stream log. */
  onNotice?: (message: string) => void;
}

export interface Model {
  client: Anthropic;
  model: string;
  baseUrl: string;
  maxTokens: number;
  /** Tokens for extended thinking, 0 to leave the parameter off entirely. */
  thinkingBudget: number;
  /** Trace every stream, not only the ones that break protocol. */
  debug: boolean;
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
    baseUrl: cfg.baseUrl,
    maxTokens: cfg.maxTokens,
    thinkingBudget: cfg.thinkingBudget,
    debug: cfg.debug,
  };
}

/**
 * Attempts per step. A retry re-sends the same request, so it is safe: no tool from
 * a failed attempt has run, and the draft is untouched until the tool loop.
 */
const MAX_ATTEMPTS = 3;

function stackHead(e: unknown): string {
  const err = e as Error;
  const frames = (err?.stack ?? "").split("\n").slice(1, 9).join("\n");
  // The constructor name, not err.name: SDK errors all report name "Error", and the
  // class (BadRequestError, APIConnectionError, …) is the useful part.
  const kind = err?.constructor?.name ?? err?.name ?? typeof e;
  return `${kind}: ${err?.message ?? String(e)}\n${frames}`;
}

/**
 * One model call, accumulated by consumeStream, with every failure written to the
 * stream log before it surfaces — an error with no trace behind it cannot be
 * diagnosed afterwards, which is how the last occurrence went unexplained.
 *
 * Retried, up to MAX_ATTEMPTS:
 * - a stream that broke mid-way (StreamError);
 * - a stream whose tool call arrived cut short, which a proxy reports as a clean
 *   end_turn — acting on it would send the model a validation error for a call it
 *   never finished making;
 * - an error raised by an SSE `error` event, which carries no HTTP status.
 * An HTTP error with a status is not retried here: the SDK already retries the
 * transient ones, and the rest are deterministic.
 */
async function requestStep(
  model: Model,
  project: Project,
  step: number,
  req: { system: string; tools: Anthropic.Tool[]; messages: Anthropic.MessageParam[] },
  hooks: TurnHooks,
): Promise<Anthropic.Message> {
  const log = toPosix(project.streamLogPath);
  for (let attempt = 1; ; attempt++) {
    const last = attempt >= MAX_ATTEMPTS;
    const retry = (why: string) => {
      hooks.onNotice?.(`${why}; retrying step (attempt ${attempt + 1}/${MAX_ATTEMPTS})`);
    };
    let http: { status?: number; headers?: Headers } | undefined;
    const dump = (reason: string, trace: string, anomalies: string[]) =>
      appendStreamDump(project.streamLogPath, {
        reason: attempt > 1 ? `${reason} · attempt ${attempt}` : reason,
        model: model.model,
        baseUrl: model.baseUrl,
        step,
        status: http?.status,
        headers: http?.headers,
        anomalies,
        trace,
      });

    try {
      // `thinking` is omitted entirely when off, not sent as {type:"disabled"}: the
      // base URL may be a proxy serving a non-Claude model that rejects the field.
      //
      // Raw events rather than messages.stream(): the SDK's accumulator throws on the
      // first out-of-order event, and proxies do emit them. consumeStream recovers
      // and keeps a trace; see stream.ts.
      const { data: events, response } = await model.client.messages
        .create({
          model: model.model,
          max_tokens: model.maxTokens,
          ...req,
          stream: true,
          ...(model.thinkingBudget
            ? { thinking: { type: "enabled" as const, budget_tokens: model.thinkingBudget } }
            : {}),
        })
        .withResponse();
      http = response;

      const result = await consumeStream(events, {
        onText: hooks.onText,
        onThinking: hooks.onThinking,
      });
      if (result.anomalies.length || model.debug) {
        dump(
          result.anomalies.length ? "protocol anomalies tolerated" : "debug trace",
          result.trace.text(),
          result.anomalies,
        );
      }
      for (const a of result.anomalies) hooks.onNotice?.(a);
      if (result.truncated && !last) {
        retry("tool call arrived incomplete");
        continue;
      }
      return result.message;
    } catch (e) {
      if (e instanceof StreamError) {
        dump(`stream error: ${e.message}`, `${e.trace.text()}\n\n${stackHead(e.cause ?? e)}`, []);
        if (!last) {
          retry(`stream broke: ${e.message}`);
          continue;
        }
        throw new Error(`${e.message}\n  raw stream trace: ${log}`);
      }
      // Not a stream fault: an HTTP error, a connection failure, or a bug. Logged
      // with its class and stack, so the source is never a guess.
      const status = e instanceof Anthropic.APIError ? e.status : undefined;
      if (e instanceof Anthropic.APIError && !http && e.headers) {
        http = { status: e.status, headers: e.headers };
      }
      const body =
        e instanceof Anthropic.APIError && e.error !== undefined
          ? `error body: ${JSON.stringify(e.error).slice(0, 2000)}\n\n`
          : "";
      dump(`request error: ${(e as Error).message}`, body + stackHead(e), []);
      // The proxy can relay its own upstream's stream-assembly failure as an HTTP
      // error. That one is transient — the next request usually streams cleanly —
      // so it is retried even though it has a status.
      const upstreamOrder = /Unexpected event order/i.test((e as Error).message);
      if (e instanceof Anthropic.APIError && (status === undefined || upstreamOrder) && !last) {
        retry(`${status === undefined ? "stream error event" : "upstream stream error"}: ${e.message}`);
        continue;
      }
      throw new Error(`${(e as Error).message}\n  details: ${log}`);
    }
  }
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
    const response = await requestStep(model, project, step, { system, tools, messages }, hooks);

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
