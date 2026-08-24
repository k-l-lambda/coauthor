import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import type { Project } from "../project.js";

export interface ToolContext {
  project: Project;
  /** Notified after every successful mutation so the caller can print the diff. */
  onEdit?: (summary: string) => void;
}

export interface ToolDef<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  schema: S;
  run: (input: z.infer<S>, ctx: ToolContext) => string;
}

export function defineTool<S extends z.ZodType>(def: ToolDef<S>): ToolDef<S> {
  return def;
}

/** Anthropic tool definitions generated from the same zod schemas used for validation. */
export function toAnthropicTools(tools: ToolDef[]): Anthropic.Tool[] {
  return tools.map((t) => {
    const schema = z.toJSONSchema(t.schema, { io: "input" }) as Record<string, unknown>;
    delete schema.$schema;
    return {
      name: t.name,
      description: t.description,
      input_schema: schema as Anthropic.Tool.InputSchema,
    };
  });
}
