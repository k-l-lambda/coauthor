import { describe, it, expect } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { MessageStream } from "@anthropic-ai/sdk/lib/MessageStream";
import { consumeStream, StreamError } from "../src/agent/stream.js";

type Ev = Anthropic.RawMessageStreamEvent;

async function* from(events: Ev[]): AsyncIterable<Ev> {
  for (const e of events) yield e;
}

const usage = { input_tokens: 10, output_tokens: 0 } as Anthropic.Usage;

const start = (id: string): Ev =>
  ({
    type: "message_start",
    message: {
      id,
      type: "message",
      role: "assistant",
      model: "m",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage,
    },
  }) as unknown as Ev;
const textBlock = (index: number, ...chunks: string[]): Ev[] => [
  { type: "content_block_start", index, content_block: { type: "text", text: "", citations: null } } as Ev,
  ...chunks.map((text) => ({ type: "content_block_delta", index, delta: { type: "text_delta", text } }) as Ev),
  { type: "content_block_stop", index } as Ev,
];
const toolBlock = (index: number, json: string[], close = true): Ev[] => [
  {
    type: "content_block_start",
    index,
    content_block: { type: "tool_use", id: `call_${index}`, name: "append", input: {} },
  } as Ev,
  ...json.map(
    (partial_json) =>
      ({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json } }) as Ev,
  ),
  ...(close ? [{ type: "content_block_stop", index } as Ev] : []),
];
const end = (stop_reason: Anthropic.StopReason): Ev[] => [
  { type: "message_delta", delta: { stop_reason, stop_sequence: null }, usage: { output_tokens: 7 } } as Ev,
  { type: "message_stop" } as Ev,
];

describe("consumeStream", () => {
  it("accumulates a well-formed stream with text and a tool call", async () => {
    const seen: string[] = [];
    const r = await consumeStream(
      from([start("a"), ...textBlock(0, "你", "好"), ...toolBlock(1, ['{"text":', '"一句"}']), ...end("tool_use")]),
      { onText: (t) => seen.push(t) },
    );
    expect(r.anomalies).toEqual([]);
    expect(r.truncated).toBe(false);
    expect(seen.join("")).toBe("你好");
    expect(r.message.stop_reason).toBe("tool_use");
    expect(r.message.usage.output_tokens).toBe(7);
    expect(r.message.content).toEqual([
      { type: "text", text: "你好", citations: null },
      { type: "tool_use", id: "call_1", name: "append", input: { text: "一句" } },
    ]);
  });

  /**
   * The failure that motivated this module. The SDK's accumulator throws
   * "got message_start before receiving message_stop" here and the turn is lost.
   */
  it("survives a second message_start mid-stream by discarding the partial message", async () => {
    const events = [start("a"), ...textBlock(0, "半截"), start("b"), ...textBlock(0, "完整"), ...end("end_turn")];

    const sdk = MessageStream.fromReadableStream(
      new ReadableStream({
        start(c) {
          for (const e of events) c.enqueue(new TextEncoder().encode(JSON.stringify(e) + "\n"));
          c.close();
        },
      }),
    );
    await expect(sdk.finalMessage()).rejects.toThrow(/message_start before receiving "message_stop"/);

    const r = await consumeStream(from(events));
    expect(r.message.id).toBe("b");
    expect(r.message.content).toEqual([{ type: "text", text: "完整", citations: null }]);
    expect(r.anomalies[0]).toMatch(/before message_stop; discarded partial/);
  });

  it("keeps the completed message when an empty trailing message follows", async () => {
    const r = await consumeStream(
      from([start("a"), ...toolBlock(0, ['{"text":"x"}']), ...end("tool_use"), start("b"), ...end("end_turn")]),
    );
    expect(r.message.id).toBe("a");
    expect(r.message.content).toHaveLength(1);
    expect(r.anomalies.join("\n")).toMatch(/after message_stop/);
  });

  it("accepts a stream missing message_stop, and drops a tool call that never closed", async () => {
    const r = await consumeStream(from([start("a"), ...textBlock(0, "正文"), ...toolBlock(1, ['{"te'], false)]));
    expect(r.message.content).toEqual([{ type: "text", text: "正文", citations: null }]);
    expect(r.anomalies.join("\n")).toMatch(/dropped unfinished tool_use #1/);
    expect(r.truncated).toBe(true);
    expect(r.anomalies.join("\n")).toMatch(/without message_stop/);
  });

  it("replaces invalid tool JSON with {} so schema validation reports it to the model", async () => {
    const r = await consumeStream(from([start("a"), ...toolBlock(0, ['{"text":']), ...end("tool_use")]));
    expect((r.message.content[0] as Anthropic.ToolUseBlock).input).toEqual({});
    expect(r.anomalies[0]).toMatch(/not valid JSON/);
    expect(r.truncated).toBe(true);
  });

  it("throws a StreamError carrying the trace when no message ever starts", async () => {
    const err = await consumeStream(from(textBlock(0, "x"))).catch((e) => e);
    expect(err).toBeInstanceOf(StreamError);
    expect(err.trace.text()).toContain("content_block_start");
  });

  it("wraps an error thrown mid-stream, keeping the events seen so far", async () => {
    async function* broken(): AsyncIterable<Ev> {
      yield start("a");
      throw new Error("upstream reset");
    }
    const err = await consumeStream(broken()).catch((e) => e);
    expect(err).toBeInstanceOf(StreamError);
    expect(err.message).toBe("upstream reset");
    expect(err.trace.text()).toMatch(/message_start[\s\S]*stream threw: upstream reset/);
  });

  it("folds runs of deltas so a long reply stays a short trace", async () => {
    const chunks = Array.from({ length: 500 }, () => "字");
    const r = await consumeStream(from([start("a"), ...textBlock(0, ...chunks), ...end("end_turn")]));
    const trace = r.trace.text();
    expect(trace.split("\n").length).toBeLessThan(10);
    expect(trace).toContain("text_delta ×500 (500 chars");
  });
});
