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
 *
 * Native models also have a transport setting (NATIVE_TRANSPORT_CONFIG):
 * whether their native tool-calling requests are streamed or sent as one
 * non-streaming request. It is separate from strategy selection because it
 * changes only how a response arrives, not how the agent loop behaves.
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
 * Evidence behind the current entries:
 * - gemma4-e2b-sky, gemma4-e4b-sky, and chatgpt-gpt-5.6-sol were run
 *   through AnythingLLM's native, streamed tool-calling agent path, via the
 *   same LiteLLM gateway Sky Code uses, in a controlled comparison: all
 *   three completed autonomous multi-step tool sequences there
 *   substantially better than through Sky Code's text-protocol strategies.
 *   That establishes that each model and this gateway support native tool
 *   calling; Sky Code's own native path still needs the same acceptance
 *   test (development VM first) before the evidence counts for it.
 * - Earlier evidence for gemma4-e4b-sky, still valid for its fallback:
 *   identical P1-P5 prompts run against LegacyStrategy and PromptedStrategy
 *   on real hardware. Legacy stalled after a single tool call on every
 *   multi-step prompt tried (2 for 2 failures), while Prompted completed
 *   every multi-step prompt tried (3 for 3) and recovered cleanly from
 *   genuine tool-execution failures. If the native path does not hold up for
 *   this model, "prompted" is the evidence-backed fallback entry to restore.
 *
 * Add further entries only after the same kind of real, recorded testing
 * for that exact model name, e.g.:
 *   "some-model-name": "native",
 */
export const MODEL_STRATEGY_CONFIG: Readonly<
  Record<string, StrategyKind>
> = {
  "gemma4-e2b-sky": "native",
  "gemma4-e4b-sky": "native",
  "chatgpt-gpt-5.6-sol": "native",
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

/**
 * How a native-strategy model's completions are requested.
 *
 * - streaming: `stream: true`, with tool-call fragments assembled by index
 *   before anything is acted on (see streamNativeToolCompletion(), chat.ts).
 * - non_streaming: one complete JSON response
 *   (requestNativeToolCompletion(), chat.ts) - the original implementation,
 *   kept as the fallback until streaming is proven for a given model.
 */
export type NativeTransport =
  | "streaming"
  | "non_streaming";

/**
 * Transport used by any native-strategy model with no explicit entry in
 * NATIVE_TRANSPORT_CONFIG: the original, simpler non-streaming request.
 */
export const DEFAULT_NATIVE_TRANSPORT: NativeTransport =
  "non_streaming";

/**
 * Explicit native transport per model name, keyed exactly like
 * MODEL_STRATEGY_CONFIG.
 *
 * The three native models are set to "streaming" because that is the
 * transport AnythingLLM used successfully with them through the same
 * gateway (see MODEL_STRATEGY_CONFIG's evidence notes). Changing an entry
 * to "non_streaming" (or deleting it) falls that model back to the
 * original non-streaming request without touching anything else.
 */
export const NATIVE_TRANSPORT_CONFIG: Readonly<
  Record<string, NativeTransport>
> = {
  "gemma4-e2b-sky": "streaming",
  "gemma4-e4b-sky": "streaming",
  "chatgpt-gpt-5.6-sol": "streaming",
};

/**
 * Resolves which transport a native-strategy model's requests use.
 *
 * @param {string} model - Active model identifier, exactly as configured.
 * @param {Readonly<Record<string, NativeTransport>>} [config] - Transport
 * config to consult. Defaults to NATIVE_TRANSPORT_CONFIG; overridable for
 * tests.
 * @returns {NativeTransport} The configured transport, or
 * DEFAULT_NATIVE_TRANSPORT when no entry exists.
 *
 * Side effects: none.
 */
export function resolveNativeTransport(
  model: string,
  config: Readonly<Record<string, NativeTransport>> = NATIVE_TRANSPORT_CONFIG,
): NativeTransport {
  return (
    config[model.trim()] ??
    DEFAULT_NATIVE_TRANSPORT
  );
}
