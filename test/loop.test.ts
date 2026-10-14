import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { openProject } from "../src/project.js";
import { runTurn, type Model, type TurnHooks } from "../src/agent/loop.js";

type Ev = Anthropic.RawMessageStreamEvent;
const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function project() {
  const dir = mkdtempSync(join(tmpdir(), "coauthor-loop-"));
  dirs.push(dir);
  writeFileSync(join(dir, "AGENT.md"), "写作助手。\n", "utf8");
  writeFileSync(join(dir, "main.md"), "第一段。\n", "utf8");
  return openProject(dir);
}

const msg = (id: string): Ev =>
  ({
    type: "message_start",
    message: { id, type: "message", role: "assistant", model: "m", content: [], stop_reason: null,
      stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } },
  }) as unknown as Ev;
const stop = (r: string): Ev[] => [
  { type: "message_delta", delta: { stop_reason: r, stop_sequence: null }, usage: { output_tokens: 1 } } as Ev,
  { type: "message_stop" } as Ev,
];
const text = (t: string): Ev[] => [
  msg("t"),
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } as Ev,
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } } as Ev,
  { type: "content_block_stop", index: 0 } as Ev,
  ...stop("end_turn"),
];
/** What the proxy sent in the logged failure: half a tool call, reported as end_turn. */
const cutToolCall: Ev[] = [
  msg("cut"),
  { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "c1", name: "append", input: {} } } as Ev,
  { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"text":"未完' } } as Ev,
  { type: "content_block_stop", index: 0 } as Ev,
  ...stop("end_turn"),
];

/** A client whose messages.create().withResponse() replays scripted attempts in order. */
function fakeModel(attempts: Array<Ev[] | Error>): { model: Model; calls: () => number } {
  let n = 0;
  const create = () => ({
    withResponse: async () => {
      const a = attempts[Math.min(n++, attempts.length - 1)];
      if (a instanceof Error) throw a;
      return {
        data: (async function* () {
          yield* a;
        })(),
        response: new Response(null, { status: 200, headers: { "x-request-id": `req-${n}` } }),
      };
    },
  });
  const client = { messages: { create } } as unknown as Anthropic;
  return {
    model: { client, model: "fake", baseUrl: "http://fake", maxTokens: 4096, thinkingBudget: 0, debug: false },
    calls: () => n,
  };
}

function hooks() {
  const out = { text: "", notices: [] as string[], toolErrors: [] as string[] };
  const h: TurnHooks = {
    onText: (t) => (out.text += t),
    onToolCall: () => {},
    onToolError: (name, m) => out.toolErrors.push(`${name}: ${m}`),
    onEdit: () => {},
    onNotice: (m) => out.notices.push(m),
  };
  return { h, out };
}

describe("runTurn retries", () => {
  it("re-requests a step whose tool call arrived cut short, without running it", async () => {
    const p = project();
    const { model, calls } = fakeModel([cutToolCall, text("好的。")]);
    const { h, out } = hooks();
    await runTurn(model, p, "追加一句", h);

    expect(calls()).toBe(2);
    expect(out.text).toBe("好的。");
    expect(out.toolErrors).toEqual([]);
    expect(readFileSync(p.draftPath, "utf8")).toBe("第一段。\n");
    expect(out.notices.join("\n")).toMatch(/incomplete; retrying step \(attempt 2\/3\)/);
    const log = readFileSync(p.streamLogPath, "utf8");
    expect(log).toContain("x-request-id: req-1");
    expect(log).toContain("not valid JSON");
  });

  it("retries an SSE error event, which carries no HTTP status", async () => {
    const p = project();
    const sse = new Anthropic.APIError(undefined, { message: "upstream hiccup" }, undefined, new Headers());
    const { model, calls } = fakeModel([sse, text("恢复了。")]);
    const { h, out } = hooks();
    await runTurn(model, p, "写", h);
    expect(calls()).toBe(2);
    expect(out.text).toBe("恢复了。");
    expect(readFileSync(p.streamLogPath, "utf8")).toMatch(/request error: upstream hiccup[\s\S]*APIError: upstream hiccup/);
  });

  it("does not retry an HTTP error, and logs its class, body and stack", async () => {
    const p = project();
    const e400 = Anthropic.APIError.generate(400, { message: "bad field" }, undefined, new Headers({ "x-request-id": "r400" }));
    const { model, calls } = fakeModel([e400]);
    const { h } = hooks();
    await expect(runTurn(model, p, "写", h)).rejects.toThrow(/400 bad field[\s\S]*details: /);
    expect(calls()).toBe(1);
    const log = readFileSync(p.streamLogPath, "utf8");
    expect(log).toContain("status: 400");
    expect(log).toContain("x-request-id: r400");
    expect(log).toContain('error body: {"message":"bad field"}');
    expect(log).toMatch(/BadRequestError/);
  });

  /** The reported failure: the proxy relaying its own upstream SDK's accumulator error. */
  it("retries an upstream event-order error even when it carries a status", async () => {
    const p = project();
    const relayed = Anthropic.APIError.generate(
      500,
      { message: 'Unexpected event order, got message_start before receiving "message_stop"' },
      undefined,
      new Headers({ "x-aiproxy-request-id": "relay1" }),
    );
    const { model, calls } = fakeModel([relayed, text("第二次成功。")]);
    const { h, out } = hooks();
    await runTurn(model, p, "写", h);
    expect(calls()).toBe(2);
    expect(out.text).toBe("第二次成功。");
    expect(out.notices.join("\n")).toMatch(/upstream stream error: 500 Unexpected event order/);
    expect(readFileSync(p.streamLogPath, "utf8")).toContain("x-aiproxy-request-id: relay1");
  });

  it("gives up after the last attempt and keeps the final message", async () => {
    const p = project();
    const { model, calls } = fakeModel([cutToolCall, cutToolCall, cutToolCall, text("改用文字。")]);
    const { h, out } = hooks();
    await runTurn(model, p, "写", h);
    // Three attempts for step 0, then step 1 answers in text.
    expect(calls()).toBe(4);
    expect(out.text).toBe("改用文字。");
    // The last attempt is used as is: its empty input fails the schema, and that
    // error is reported to the model like any other invalid call.
    expect(out.toolErrors.join("\n")).toMatch(/append/);
    expect(existsSync(p.streamLogPath)).toBe(true);
  });
});
