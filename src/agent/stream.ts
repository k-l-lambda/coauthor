import type Anthropic from "@anthropic-ai/sdk";

type Event = Anthropic.RawMessageStreamEvent;
type Block = Record<string, unknown> & { type: string };

export interface StreamHooks {
  onText?: (chunk: string) => void;
  onThinking?: (chunk: string) => void;
}

export interface StreamResult {
  message: Anthropic.Message;
  /** Protocol deviations that were tolerated. Empty for a well-formed stream. */
  anomalies: string[];
  /**
   * A tool call arrived cut short: its JSON did not parse, or its block never
   * closed. The message is still usable, but the caller should prefer a retry.
   */
  truncated: boolean;
  trace: StreamTrace;
}

/** A stream that could not be turned into a message at all. Carries its trace. */
export class StreamError extends Error {
  constructor(
    message: string,
    readonly trace: StreamTrace,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "StreamError";
  }
}

/** Long payloads in a structural event are clipped, so one huge tool input cannot bloat the log. */
const CLIP = 1000;
/** Lines kept before the trace stops recording. Deltas are folded, so this is rarely reached. */
const MAX_LINES = 4000;

/**
 * Compact record of the raw SSE events, for diagnosing a proxy that breaks the
 * protocol. Structural events are kept whole; consecutive deltas for the same
 * block are folded into one line, so a 4000-event reply stays a few dozen lines.
 */
export class StreamTrace {
  private readonly t0 = Date.now();
  readonly lines: string[] = [];
  private run: { index: number; kind: string; count: number; chars: number; from: number } | null =
    null;
  private dropped = 0;

  private elapsed(): string {
    return ((Date.now() - this.t0) / 1000).toFixed(2).padStart(7) + "s";
  }

  private push(line: string): void {
    if (this.lines.length < MAX_LINES) this.lines.push(line);
    else this.dropped++;
  }

  private flush(): void {
    const r = this.run;
    if (!r) return;
    this.push(
      `${this.elapsed()}  content_block_delta #${r.index} ${r.kind} ×${r.count} (${r.chars} chars, from ${r.from.toFixed(2)}s)`,
    );
    this.run = null;
  }

  event(ev: Event): void {
    if (ev.type === "content_block_delta") {
      const kind = ev.delta.type;
      const chars = deltaLength(ev.delta);
      const r = this.run;
      if (r && r.index === ev.index && r.kind === kind) {
        r.count++;
        r.chars += chars;
        return;
      }
      this.flush();
      this.run = { index: ev.index, kind, count: 1, chars, from: (Date.now() - this.t0) / 1000 };
      return;
    }
    this.flush();
    let json = JSON.stringify(ev);
    if (json.length > CLIP) json = json.slice(0, CLIP) + `…(+${json.length - CLIP})`;
    this.push(`${this.elapsed()}  ${json}`);
  }

  /** An interpretation the accumulator made, interleaved with the events that caused it. */
  note(text: string): void {
    this.flush();
    this.push(`${this.elapsed()}  !! ${text}`);
  }

  text(): string {
    this.flush();
    const tail = this.dropped ? [`… ${this.dropped} more lines not recorded`] : [];
    return [...this.lines, ...tail].join("\n");
  }
}

function deltaLength(d: Anthropic.RawContentBlockDelta): number {
  switch (d.type) {
    case "text_delta":
      return d.text.length;
    case "thinking_delta":
      return d.thinking.length;
    case "input_json_delta":
      return d.partial_json.length;
    case "signature_delta":
      return d.signature.length;
    default:
      return 0;
  }
}

interface Current {
  message: Anthropic.Message;
  blocks: Map<number, Block>;
  /** Raw partial JSON per tool_use block, parsed at content_block_stop. */
  json: Map<number, string>;
  closed: Set<number>;
  stopped: boolean;
}

function finish(
  cur: Current,
  anomalies: string[],
  trace: StreamTrace,
  cut: { truncated: boolean },
): Anthropic.Message {
  const content: Block[] = [];
  for (const [index, block] of [...cur.blocks].sort((a, b) => a[0] - b[0])) {
    // A tool call whose block never closed has input that was never fully received.
    // Running it would act on a guess, so it is dropped instead.
    if (block.type === "tool_use" && !cur.closed.has(index)) {
      const msg = `dropped unfinished tool_use #${index} (${String(block.name)})`;
      cut.truncated = true;
      anomalies.push(msg);
      trace.note(msg);
      continue;
    }
    content.push(block);
  }
  return { ...cur.message, content: content as unknown as Anthropic.ContentBlock[] };
}

/**
 * Accumulate a raw event stream into a message, tolerating proxy deviations.
 *
 * Used instead of the SDK's MessageStream, whose accumulator throws on any event
 * out of order. Anthropic-compatible proxies translating another vendor's stream
 * have been seen to emit a second `message_start` in one response — the SDK then
 * fails with "got message_start before receiving message_stop" (it says so even
 * when message_stop did arrive, because it never clears its snapshot), and the
 * whole turn is lost. Here each deviation is recorded and the stream recovered:
 *
 * - A `message_start` while a message is open means the upstream restarted. The
 *   partial message is discarded; nothing from it has been acted on yet.
 * - A `message_start` after `message_stop` begins a trailing message. The last one
 *   that completed with content wins.
 * - A missing `message_stop` at end of stream is accepted if the message has content.
 *
 * Anything that leaves no usable message throws a StreamError with the trace.
 */
export async function consumeStream(
  events: AsyncIterable<Event>,
  hooks: StreamHooks = {},
): Promise<StreamResult> {
  const trace = new StreamTrace();
  const anomalies: string[] = [];
  const flag = (msg: string) => {
    anomalies.push(msg);
    trace.note(msg);
  };

  let cur: Current | null = null;
  let completed: Anthropic.Message | null = null;
  const cut = { truncated: false };
  let starts = 0;

  try {
    for await (const ev of events) {
      trace.event(ev);

      if (ev.type === "message_start") {
        starts++;
        if (cur && cur.stopped) {
          const done = finish(cur, anomalies, trace, cut);
          if (done.content.length) completed = done;
          flag(`message_start #${starts} after message_stop; previous message kept as fallback`);
        } else if (cur) {
          flag(
            `message_start #${starts} before message_stop; discarded partial message with ${cur.blocks.size} block(s)`,
          );
        }
        cur = {
          message: { ...ev.message, content: [] },
          blocks: new Map(),
          json: new Map(),
          closed: new Set(),
          stopped: false,
        };
        continue;
      }

      if (!cur) throw new StreamError(`got ${ev.type} before any message_start`, trace);
      if (cur.stopped) {
        flag(`${ev.type} after message_stop; ignored`);
        continue;
      }

      switch (ev.type) {
        case "content_block_start": {
          if (cur.blocks.has(ev.index)) flag(`content_block_start #${ev.index} repeated; replaced`);
          const block = { ...ev.content_block } as Block;
          cur.blocks.set(ev.index, block);
          cur.closed.delete(ev.index);
          if (block.type === "tool_use" || block.type === "server_tool_use") cur.json.set(ev.index, "");
          break;
        }
        case "content_block_delta": {
          const block = cur.blocks.get(ev.index);
          if (!block) {
            flag(`content_block_delta for unknown block #${ev.index}; ignored`);
            break;
          }
          const d = ev.delta;
          if (d.type === "text_delta") {
            block.text = String(block.text ?? "") + d.text;
            hooks.onText?.(d.text);
          } else if (d.type === "thinking_delta") {
            block.thinking = String(block.thinking ?? "") + d.thinking;
            hooks.onThinking?.(d.thinking);
          } else if (d.type === "signature_delta") {
            block.signature = d.signature;
          } else if (d.type === "input_json_delta") {
            cur.json.set(ev.index, (cur.json.get(ev.index) ?? "") + d.partial_json);
          } else if (d.type === "citations_delta") {
            block.citations = [...((block.citations as unknown[]) ?? []), d.citation];
          }
          break;
        }
        case "content_block_stop": {
          const block = cur.blocks.get(ev.index);
          if (!block) {
            flag(`content_block_stop for unknown block #${ev.index}; ignored`);
            break;
          }
          const raw = cur.json.get(ev.index);
          if (raw !== undefined) {
            if (!raw.trim()) block.input = block.input ?? {};
            else {
              try {
                block.input = JSON.parse(raw);
              } catch {
                // An empty object fails the tool's schema, and that validation error
                // goes back to the model, which can retry the call.
                flag(`tool_use #${ev.index} input is not valid JSON (${raw.length} chars); used {}`);
                cut.truncated = true;
                block.input = {};
              }
            }
          }
          cur.closed.add(ev.index);
          break;
        }
        case "message_delta": {
          const m = cur.message;
          if (ev.delta.stop_reason != null) m.stop_reason = ev.delta.stop_reason;
          if (ev.delta.stop_sequence != null) m.stop_sequence = ev.delta.stop_sequence;
          if (ev.usage) {
            for (const [k, v] of Object.entries(ev.usage)) {
              if (v != null) (m.usage as unknown as Record<string, unknown>)[k] = v;
            }
          }
          break;
        }
        case "message_stop":
          cur.stopped = true;
          break;
        default:
          flag(`unknown event type ${(ev as { type: string }).type}; ignored`);
      }
    }
  } catch (e) {
    if (e instanceof StreamError) throw e;
    trace.note(`stream threw: ${(e as Error).message}`);
    throw new StreamError((e as Error).message, trace, e);
  }

  if (!cur) throw new StreamError("stream ended without any message_start", trace);

  const last = finish(cur, anomalies, trace, cut);
  if (!cur.stopped) flag("stream ended without message_stop");
  if (last.content.length || !completed) {
    if (!last.content.length && !cur.stopped) {
      throw new StreamError("stream ended before any content arrived", trace);
    }
    return { message: last, anomalies, truncated: cut.truncated, trace };
  }
  flag("last message was empty; used the earlier completed message");
  return { message: completed, anomalies, truncated: cut.truncated, trace };
}
