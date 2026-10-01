/**
 * Per-model tool-calling strategy selection.
 *
 * The agent loop (loop.ts) runs identically regardless of which
 * ToolCallStrategy is active; this module is the one place that decides
 * which strategy a given model actually uses. Selection is explicit and
 * evidence-based, keyed by model name - never guessed from a provider name,
 * a model-name substring ("gpt", "claude", "gemma"), or any other
 * capability heuristic. An entry belongs in MODEL_STRATEGY_CONFIG only once
 * that specific model has actually been tested end to end (real
 * completions, real tool calls) with the strategy it is assigned; until
 * then, every model falls through to DEFAULT_STRATEGY_KIND.
 *
 * This keeps the promise the wider redesign exists to make: changing
 * /model changes only the reasoning engine, never which tools are
 * available or how reliably they run - a model with no recorded evidence
 * gets the same proven, conservative strategy as every other unproven
 * model, rather than an optimistic guess.
 */

/**
 * The three interchangeable ways runAgentLoop() can obtain its next action
 * from a model (see ToolCallStrategy in agent/types.ts and
 * agent/strategies/*.ts).
 */
export type StrategyKind =
  | "native"
  | "prompted"
  | "legacy";

/**
 * Strategy used for any model with no explicit entry in
 * MODEL_STRATEGY_CONFIG.
 *
 * Legacy is the only strategy with real production experience against Sky
 * Code's live conversation path (the existing sky-tool fenced-block
 * protocol, unchanged), so it is the safe default until a specific model's
 * Native or Prompted support has actually been verified by testing -
 * never assumed from architectural plausibility alone.
 */
export const DEFAULT_STRATEGY_KIND: StrategyKind =
  "legacy";

/**
 * Explicit, evidence-based strategy assignment per model name.
 *
 * Keyed exactly as the model is configured (the LiteLLM model name used
 * throughout Sky Code, e.g. in ~/.sky-code/config.json's `defaultModel` or
 * a session's active model). Deliberately contains no automatic capability
 * guessing: this map is never populated by pattern-matching a model or
 * provider name, only by a real recorded test result for that exact model
 * name.
 *
 * gemma4-e4b-sky was evidence-tested against this agent-loop architecture
 * (identical P1-P5 prompts run against both LegacyStrategy and
 * PromptedStrategy on real hardware): Legacy stalled after a single tool
 * call on every multi-step prompt tried (2 for 2 failures), while Prompted
 * completed every multi-step prompt tried (3 for 3) and recovered cleanly
 * from genuine tool-execution failures. Add further entries only after the
 * same kind of real, recorded testing for that exact model name, e.g.:
 *   "some-model-name": "native",
 */
export const MODEL_STRATEGY_CONFIG: Readonly<
  Record<string, StrategyKind>
> = {
  "gemma4-e4b-sky": "prompted",
};

/**
 * Resolves which tool-calling strategy a given model should use.
 *
 * @param {string} model - Active model identifier, exactly as configured.
 * @param {Readonly<Record<string, StrategyKind>>} [config] - Strategy
 * config to consult. Defaults to MODEL_STRATEGY_CONFIG; overridable so
 * tests can exercise the resolution logic against a fake config without
 * needing real entries in the production map.
 * @returns {StrategyKind} The explicitly configured strategy for this
 * model, or DEFAULT_STRATEGY_KIND when no entry exists.
 *
 * Side effects: none.
 */
export function resolveStrategyKind(
  model: string,
  config: Readonly<Record<string, StrategyKind>> = MODEL_STRATEGY_CONFIG,
): StrategyKind {
  return (
    config[model.trim()] ??
    DEFAULT_STRATEGY_KIND
  );
}
