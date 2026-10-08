/**
 * Tool-calling strategy and native transport selection.
 *
 * The agent loop (loop.ts) runs identically regardless of which
 * ToolCallStrategy is active; this module decides which one a model starts
 * with. The rule is the same for every model, whatever its name, size, or
 * perceived capability:
 *
 * - NativeStrategy is the default for every model, including a model Sky
 *   Code has never seen. Native tool calling is the provider-standard
 *   protocol, and how well a model uses it is ordinary agent behavior,
 *   handled inside NativeStrategy (validation, bounded correction,
 *   final-answer checks), never by switching strategies.
 * - PromptedStrategy is reached automatically only when the actual
 *   endpoint demonstrably rejects native tool calling. That decision is
 *   made at runtime from the provider's own response, not from any table
 *   here (see native-support.ts and NativeFirstStrategy,
 *   strategies/native-first.ts).
 * - LegacyStrategy is never selected automatically. It is kept for
 *   backward compatibility and is reachable only through an explicit
 *   override entry below.
 *
 * Model names are never classified here: no table maps a model family or
 * strength to a strategy. The override tables exist only for genuine
 * compatibility or debugging needs and are empty by default.
 *
 * History: earlier builds defaulted to Legacy and listed models one by one
 * as each was tested (gemma4-e4b-sky moved Legacy → Prompted → Native that
 * way). The four-document native acceptance test at commit 264b4b1 passed on
 * gemma4-e4b-sky with no per-model tuning, and AnythingLLM's native agent
 * path uses one loop for every model, so the per-model entries were removed.
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
 * Strategy used for every model without an explicit override.
 */
export const DEFAULT_STRATEGY_KIND: StrategyKind =
  "native";

/**
 * Explicit per-model strategy overrides, for genuine compatibility or
 * debugging needs only. Empty by default; Sky Code never adds to it
 * automatically.
 *
 * Keyed exactly as the model is configured (the LiteLLM model name, e.g. in
 * ~/.sky-code/config.json's `defaultModel` or a session's active model). An
 * entry forces that strategy with no automatic fallback, for example:
 *   "some-model-name": "prompted",
 *   "another-model": "legacy",
 */
export const MODEL_STRATEGY_CONFIG: Readonly<
  Record<string, StrategyKind>
> = {};

/**
 * Resolves which tool-calling strategy a given model starts with.
 *
 * @param {string} model - Active model identifier, exactly as configured.
 * @param {Readonly<Record<string, StrategyKind>>} [config] - Override table
 * to consult. Defaults to MODEL_STRATEGY_CONFIG; overridable so tests can
 * exercise overrides without editing the production table.
 * @returns {StrategyKind} The explicit override for this model, or
 * DEFAULT_STRATEGY_KIND when none exists.
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
 * How native-strategy completions are requested.
 *
 * - streaming: `stream: true`, with tool-call fragments assembled by index
 *   before anything is acted on (see streamNativeToolCompletion(), chat.ts).
 * - non_streaming: one complete JSON response
 *   (requestNativeToolCompletion(), chat.ts), kept as a compatibility
 *   override for an endpoint that cannot stream native tool calls.
 */
export type NativeTransport =
  | "streaming"
  | "non_streaming";

/**
 * Transport used by every native model without an explicit override.
 */
export const DEFAULT_NATIVE_TRANSPORT: NativeTransport =
  "streaming";

/**
 * Explicit per-model native transport overrides, keyed exactly like
 * MODEL_STRATEGY_CONFIG. Empty by default. An entry represents an actual
 * endpoint/provider compatibility need, never model capability, e.g.:
 *   "some-model-name": "non_streaming",
 */
export const NATIVE_TRANSPORT_CONFIG: Readonly<
  Record<string, NativeTransport>
> = {};

/**
 * Resolves which transport a native-strategy model's requests use.
 *
 * @param {string} model - Active model identifier, exactly as configured.
 * @param {Readonly<Record<string, NativeTransport>>} [config] - Override
 * table to consult. Defaults to NATIVE_TRANSPORT_CONFIG; overridable for
 * tests.
 * @returns {NativeTransport} The explicit override, or
 * DEFAULT_NATIVE_TRANSPORT when none exists.
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
