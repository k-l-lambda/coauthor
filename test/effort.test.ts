import { describe, it, expect, afterEach } from "vitest";
import {
  resolveConfig,
  thinkingBudgetFor,
  DEFAULT_EFFORT,
  EFFORT_BUDGETS,
  EFFORT_LEVELS,
  MIN_THINKING_BUDGET,
  REPLY_HEADROOM,
  KNOWN_VARS,
} from "../src/env.js";

const saved = { ...process.env };
afterEach(() => {
  for (const k of KNOWN_VARS) delete process.env[k];
  Object.assign(process.env, saved);
});

describe("thinkingBudgetFor", () => {
  it("returns 0 for off, with nothing to report", () => {
    expect(thinkingBudgetFor("off", 8192)).toEqual({ budget: 0, note: null });
  });

  it("returns the nominal budget when it fits", () => {
    expect(thinkingBudgetFor("low", 100_000).budget).toBe(EFFORT_BUDGETS.low);
  });

  /**
   * The API requires budget_tokens < max_tokens. A nominal budget that does not fit is
   * clamped rather than refused: asking for `high` against a small max_tokens should
   * still think as hard as it can, not silently not think at all.
   */
  it("clamps a budget that would not fit under max_tokens", () => {
    const { budget, note } = thinkingBudgetFor("high", 8192);
    expect(budget).toBe(8192 - REPLY_HEADROOM);
    expect(budget).toBeLessThan(8192);
    expect(note).toContain("clamped");
  });

  it("always leaves room for the reply", () => {
    for (const level of EFFORT_LEVELS) {
      for (const max of [2048, 4096, 8192, 16384, 200_000]) {
        const { budget } = thinkingBudgetFor(level, max);
        if (budget) expect(budget).toBeLessThanOrEqual(max - REPLY_HEADROOM);
      }
    }
  });

  it("never returns a budget below the API floor", () => {
    for (const level of EFFORT_LEVELS) {
      for (const max of [1024, 1500, 2048, 3000]) {
        const { budget } = thinkingBudgetFor(level, max);
        if (budget) expect(budget).toBeGreaterThanOrEqual(MIN_THINKING_BUDGET);
      }
    }
  });

  it("refuses, with a reason, when max_tokens cannot fit floor plus headroom", () => {
    const { budget, note } = thinkingBudgetFor("medium", MIN_THINKING_BUDGET);
    expect(budget).toBe(0);
    expect(note).toContain("COAUTHOR_MAX_TOKENS");
  });
});

describe("COAUTHOR_EFFORT", () => {
  it("defaults to off, so a proxy that rejects `thinking` is unaffected", () => {
    delete process.env.COAUTHOR_EFFORT;
    const cfg = resolveConfig();
    expect(cfg.effort).toBe(DEFAULT_EFFORT);
    expect(cfg.thinkingBudget).toBe(0);
  });

  it.each(EFFORT_LEVELS)("accepts %s", (level) => {
    process.env.COAUTHOR_EFFORT = level;
    process.env.COAUTHOR_MAX_TOKENS = "200000";
    const cfg = resolveConfig();
    expect(cfg.effort).toBe(level);
    expect(cfg.thinkingBudget).toBe(EFFORT_BUDGETS[level]);
  });

  it("is case- and whitespace-insensitive", () => {
    process.env.COAUTHOR_EFFORT = "  HIGH  ";
    expect(resolveConfig().effort).toBe("high");
  });

  /** A typo must not silently mean a different amount of thinking. */
  it("falls back to the default for an unknown level, and says what was given", () => {
    process.env.COAUTHOR_EFFORT = "maximum";
    const cfg = resolveConfig();
    expect(cfg.effort).toBe(DEFAULT_EFFORT);
    expect(cfg.effortInvalid).toBe("maximum");
  });

  it("reports nothing invalid when the level is good", () => {
    process.env.COAUTHOR_EFFORT = "low";
    expect(resolveConfig().effortInvalid).toBeNull();
  });

  it("carries the clamp note through resolveConfig", () => {
    process.env.COAUTHOR_EFFORT = "high";
    process.env.COAUTHOR_MAX_TOKENS = "8192";
    const cfg = resolveConfig();
    expect(cfg.thinkingBudget).toBe(8192 - REPLY_HEADROOM);
    expect(cfg.effortNote).toContain("clamped");
  });

  it("keeps the budget under max_tokens even at the default max", () => {
    process.env.COAUTHOR_EFFORT = "high";
    delete process.env.COAUTHOR_MAX_TOKENS;
    const cfg = resolveConfig();
    expect(cfg.thinkingBudget).toBeLessThan(cfg.maxTokens);
  });
});
