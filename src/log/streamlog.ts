import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { localStamp } from "./editlog.js";

export interface StreamDump {
  reason: string;
  model: string;
  baseUrl: string;
  step: number;
  /** HTTP status and response headers, when the response was received. */
  status?: number;
  headers?: Headers;
  anomalies: string[];
  trace: string;
}

/**
 * Headers worth keeping: request ids let a proxy operator find the request, and
 * the rest say which upstream answered. Cookies are never written.
 */
function headerLines(h: Headers): string[] {
  const out: string[] = [];
  h.forEach((v, k) => {
    if (k === "set-cookie") return;
    out.push(`  ${k}: ${v}`);
  });
  return out.sort();
}

/**
 * Append one raw-event trace to the project's stream log. Written when a stream
 * deviates from the protocol, or for every step under COAUTHOR_DEBUG. The request
 * body and credential are never written: the trace holds event shapes, with
 * long payloads clipped.
 */
export function appendStreamDump(logPath: string, d: StreamDump): void {
  const lines = [
    "",
    `## ${localStamp()} · ${d.reason} · step ${d.step}`,
    "",
    `model: ${d.model}`,
    `base url: ${d.baseUrl}`,
    ...(d.status !== undefined ? [`status: ${d.status}`] : []),
    ...(d.headers ? ["headers:", ...headerLines(d.headers)] : []),
    ...(d.anomalies.length ? ["anomalies:", ...d.anomalies.map((a) => `  - ${a}`)] : []),
    "",
    "```",
    d.trace,
    "```",
    "",
  ];
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, lines.join("\n"), "utf8");
}
