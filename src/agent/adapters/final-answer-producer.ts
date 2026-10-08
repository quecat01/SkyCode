/**
 * Live FinalAnswerProducer backed by a plain TextCompletionClient.
 *
 * Used by runAgentLoop() only when the active strategy signals `{ kind:
 * "done" }` without itself writing conversational prose (PromptedStrategy's
 * case today; see FinalAnswerProducer in agent/types.ts). This adapter's
 * only job is composing that reply: it renders the exact same full
 * AgentContext (priorTurns + goal + this turn's real recorded AgentEvent
 * history) every strategy receives, via renderContextAsPlainTurns()
 * (history-rendering.ts), and completes once against it. It never invents
 * execution state of its own - the recorded tool results already inside
 * `context.history` remain the only source of truth for what actually
 * happened this turn, exactly as rendered.
 *
 * Deliberately as thin as the strategy adapters: model, systemPrompt, and
 * client are all bound once at construction (mirroring NativeStrategy's and
 * LegacyStrategy's own constructor-bound systemPrompt), since
 * FinalAnswerProducer.produce() itself takes only an AgentContext (see
 * types.ts) and runAgentLoop() never passes `model` to it directly.
 */
import {
  renderContextAsPlainTurns,
} from "../history-rendering.js";

import type {
  PlainConversationTurn,
  TextCompletionClient,
} from "../model-client.js";

import type {
  AgentContext,
  FinalAnswerProducer,
} from "../types.js";

import {
  buildExecutionLedger,
  renderExecutionLedger,
} from "../execution-ledger.js";

/**
 * Creates a FinalAnswerProducer backed by a real plain-text completion
 * client.
 *
 * @param {TextCompletionClient} client - Adapter over the active
 * model/provider's plain-text completion endpoint (in production,
 * createLiteLLMTextCompletionClient(); see
 * agent/adapters/litellm-client.ts).
 * @param {string} systemPrompt - System prompt sent with this completion.
 * Callers should supply createSkyCodeFinalAnswerPrompt()'s output (tools.ts),
 * which never instructs the model to request a tool, since this call is only
 * ever asked to compose the final user-facing reply.
 * @param {string} model - Identifier of the active model for this turn,
 * exactly as passed to runAgentLoop() (see model-client.ts's
 * TextCompletionClient.complete()).
 * @returns {FinalAnswerProducer} Producer that completes using `client`,
 * `systemPrompt`, and `model`, grounded in whatever AgentContext it is given.
 */
export function createFinalAnswerProducer(
  client: TextCompletionClient,
  systemPrompt: string,
  model: string,
): FinalAnswerProducer {
  return {
    async produce(
      context: AgentContext,
      signal?: AbortSignal,
    ): Promise<string> {
      const turns: PlainConversationTurn[] =
        renderContextAsPlainTurns(
          context,
        );

      // The authoritative record of this turn's tool calls, so the reply is
      // written from what actually happened rather than from the model's
      // recollection (see execution-ledger.ts). Omitted when no tool ran.
      const ledger =
        buildExecutionLedger(
          context.history,
        );

      const groundedPrompt =
        ledger.length === 0
          ? systemPrompt
          : `${systemPrompt}\n\nExecution record for this turn (authoritative; the reply must agree with it exactly, including every success and every failure):\n${renderExecutionLedger(ledger)}`;

      return client.complete(
        model,
        groundedPrompt,
        turns,
        signal
          ? {
              signal,
            }
          : undefined,
      );
    },
  };
}
