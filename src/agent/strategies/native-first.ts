/**
 * NativeFirstStrategy: the automatic strategy for every model. It runs
 * NativeStrategy, and falls back to PromptedStrategy only when the endpoint
 * itself refuses native tool calling.
 *
 * What triggers the fallback is decided entirely by
 * isNativeToolsUnsupportedError() (native-support.ts): an HTTP 400/422 whose
 * body says tools or function calling are unsupported. Everything else the
 * native side throws (authentication, rate limiting, server errors, network
 * failures, timeouts, NativeStrategy's own corrective-retry exhaustion) is
 * rethrown unchanged, so the turn fails exactly as it would without this
 * wrapper. Model behavior (malformed arguments, several calls at once, an
 * unacceptable final answer) never reaches this wrapper at all: NativeStrategy
 * handles it internally.
 *
 * Once an endpoint + model has refused native tools, that finding is kept in
 * a NativeSupportCache for the rest of the process, so every later decision
 * (this turn and later turns) goes straight to PromptedStrategy instead of
 * repeating a request the provider has already refused. The cache is
 * per-process, never persisted.
 *
 * The fallback is safe mid-turn: both strategies build their requests from
 * the same AgentContext (prior turns, goal, and this turn's recorded
 * history), so PromptedStrategy sees every real tool result recorded so far.
 *
 * Every fallback is reported through the DiagnosticReporter (a
 * protocol_condition event in the session log, never shown to the model), in
 * the form "Strategy fallback: native -> prompted ... reason: ...".
 */
import {
  describeNativeRejection,
  isNativeToolsUnsupportedError,
  type NativeSupportCache,
} from "../native-support.js";

import type {
  AgentAction,
  AgentContext,
  DiagnosticReporter,
  ToolCallStrategy,
  ToolDefinition,
} from "../types.js";

/**
 * Tool-calling strategy that prefers native tool calling and falls back to
 * prompted selection only on a demonstrated native-protocol refusal.
 */
export class NativeFirstStrategy implements ToolCallStrategy {
  private native:
    ToolCallStrategy;

  private prompted:
    ToolCallStrategy;

  private cache:
    NativeSupportCache;

  private endpoint:
    string;

  /**
   * @param {ToolCallStrategy} native - The NativeStrategy to try first.
   * @param {ToolCallStrategy} prompted - The PromptedStrategy to fall back
   * to.
   * @param {NativeSupportCache} cache - Per-process record of endpoint +
   * model combinations that refused native tools; shared across every
   * strategy instance built during the session, so a /model switch back to
   * an already-refused model does not retry native.
   * @param {string} endpoint - API base URL the native requests go to, used
   * with the model name as the cache key.
   */
  constructor(
    native: ToolCallStrategy,
    prompted: ToolCallStrategy,
    cache: NativeSupportCache,
    endpoint: string,
  ) {
    this.native = native;
    this.prompted = prompted;
    this.cache = cache;
    this.endpoint = endpoint;
  }

  /** @inheritdoc */
  async getNextAction(
    context: AgentContext,
    tools: ToolDefinition[],
    model: string,
    onDiagnostic?: DiagnosticReporter,
    signal?: AbortSignal,
  ): Promise<AgentAction> {
    const known =
      this.cache.get(
        this.endpoint,
        model,
      );

    if (known) {
      // Reported once per turn (its first decision), not on every step.
      if (
        !context.history.some(
          (event) =>
            event.type ===
            "tool_requested",
        )
      ) {
        onDiagnostic?.(
          `Strategy: prompted for model "${model}" (native tools were rejected earlier this session; reason: ${known.reason}).`,
        );
      }

      return this.prompted.getNextAction(
        context,
        tools,
        model,
        onDiagnostic,
        signal,
      );
    }

    try {
      return await this.native.getNextAction(
        context,
        tools,
        model,
        onDiagnostic,
        signal,
      );
    } catch (error) {
      if (
        !isNativeToolsUnsupportedError(
          error,
        )
      ) {
        throw error;
      }

      const reason =
        describeNativeRejection(
          error,
        );

      this.cache.markRejected(
        this.endpoint,
        model,
        reason,
      );

      onDiagnostic?.(
        `Strategy fallback: native -> prompted for model "${model}"; reason: ${reason}`,
      );

      return this.prompted.getNextAction(
        context,
        tools,
        model,
        onDiagnostic,
        signal,
      );
    }
  }
}
