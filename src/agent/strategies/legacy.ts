/**
 * LegacyStrategy: obtains the next agent action using Sky Code's existing
 * sky-tool fenced-block text protocol (analyzeSkyToolResponse(), in
 * tools.ts), as the fallback for models/providers that cannot reliably use
 * native tool calling or PromptedStrategy's JSON selection format.
 *
 * This strategy owns sky.md rule 7 (the "a sky-tool block must open the
 * response" instruction): the systemPrompt passed to its constructor is
 * expected to already include it, since LegacyStrategy is the only strategy
 * whose underlying protocol depends on that rule. NativeStrategy and
 * PromptedStrategy do not need it and should not be given it.
 *
 * Every completion is classified by analyzeSkyToolResponse() into exactly
 * one of four outcomes (see SkyToolParseOutcome in tools.ts), and
 * LegacyStrategy reacts to each the same way NativeStrategy and
 * PromptedStrategy react to a non-compliant native/selection response:
 * - "single" (exactly one valid sky-tool block): returned as the next
 *   tool_call action.
 * - "none" (no sky-tool block at all): the completion is the model's real
 *   final answer, since nothing is pending that it claimed but did not
 *   request.
 * - "multiple" (more than one valid sky-tool block): nothing is executed.
 *   This strategy used to execute the leading block anyway, silently
 *   discarding the rest; that conflicted with the one-action-at-a-time
 *   architecture the same way a native provider returning several
 *   tool_calls at once would, so "multiple" is now handled exactly like
 *   NativeStrategy's own multi-tool-call case: one internal corrective
 *   follow-up asks the model to name exactly one next action, bounded and
 *   retried.
 * - "malformed" (a block was present but invalid): nothing is executed. The
 *   real parse/validation error is fed back to the model as a corrective
 *   follow-up, bounded and retried, instead of being silently swallowed.
 *
 * Both corrective cases are bounded by MAX_CORRECTIVE_ATTEMPTS and throw a
 * strategy-level error if the model still cannot produce a single valid
 * request after that budget is exhausted (see runAgentLoop in loop.ts: an
 * error thrown from getNextAction() propagates out of the turn, rather than
 * being treated as a tool failure the loop itself recovers from). The
 * corrective exchange itself is internal scratch, not recorded as
 * AgentEvent history: only real, executed tool results belong there (see
 * types.ts's AgentEvent doc comment), and a corrective retry has no
 * executed result of its own to record.
 *
 * LegacyStrategy never executes more than one block from a single
 * completion, even sequentially: after the one action it does return
 * actually runs, the next getNextAction() call asks the model again, fresh,
 * grounded in that real result, giving it a genuine opportunity to
 * reassess and (re-)request whatever else it needed rather than Sky Code
 * blindly working through a stale, pre-committed batch.
 */
import {
  v4 as createUuid,
} from "uuid";

import {
  analyzeSkyToolResponse,
} from "../../tools.js";

import {
  renderContextAsPlainTurns,
} from "../history-rendering.js";

import type {
  PlainConversationTurn,
  TextCompletionClient,
} from "../model-client.js";

import type {
  AgentAction,
  AgentContext,
  DiagnosticReporter,
  ToolCallStrategy,
  ToolDefinition,
} from "../types.js";

/**
 * Maximum number of internal corrective follow-up completions LegacyStrategy
 * will request, on top of the initial completion, before giving up on
 * obtaining one valid sky-tool request (or plain final answer) and
 * throwing.
 */
const MAX_CORRECTIVE_ATTEMPTS = 2;

/**
 * Builds the corrective follow-up message for a "multiple valid blocks"
 * outcome.
 *
 * @param {number} count - Total number of valid sky-tool blocks found in the
 * non-compliant response.
 * @returns {string} Corrective instruction to send back to the model.
 */
function describeMultipleBlocksCorrection(
  count: number,
): string {
  return (
    `Your previous response requested ${count} tool actions at once; only one at a time is allowed. ` +
    "Respond with exactly one sky-tool request, or plain text if no tool is needed."
  );
}

/**
 * Builds the corrective follow-up message for a "malformed block" outcome.
 *
 * @param {unknown} error - The original error value analyzeSkyToolResponse()
 * reported for this outcome.
 * @returns {string} Corrective instruction to send back to the model.
 */
function describeMalformedBlockCorrection(
  error: unknown,
): string {
  const message =
    error instanceof Error
      ? error.message
      : String(error);

  return (
    `Your previous response could not be used: ${message} ` +
    "Please resend a single corrected sky-tool request."
  );
}

/**
 * Tool-calling strategy backed by Sky Code's existing sky-tool fenced-block
 * text protocol.
 *
 * Documented contract: always constructed with a visible/streaming
 * TextCompletionClient (in production, createVisibleTextCompletionClient(),
 * index.ts), so a "none" completion (this strategy's final answer) has
 * already been shown to the user live, chunk by chunk, by the time
 * getNextAction() returns it - see the "final_answer" action's
 * `alreadyDisplayed: true` below, and AgentAction's own doc comment in
 * types.ts. A caller constructing this strategy with a client that does not
 * stream to the terminal would make that field inaccurate.
 */
export class LegacyStrategy implements ToolCallStrategy {
  private client:
    TextCompletionClient;

  private systemPrompt:
    string;

  /**
   * @param {TextCompletionClient} client - Adapter over the active
   * model/provider's plain-text completion endpoint.
   * @param {string} systemPrompt - System prompt to send with every
   * completion. Must already include sky.md's sky-tool-block instruction
   * (rule 7); LegacyStrategy does not add it itself.
   */
  constructor(
    client: TextCompletionClient,
    systemPrompt: string,
  ) {
    this.client = client;
    this.systemPrompt = systemPrompt;
  }

  /**
   * @inheritdoc
   *
   * `tools` is accepted to satisfy the ToolCallStrategy interface but is not
   * used: analyzeSkyToolResponse() already validates a request against
   * tools.ts's own exhaustive list of the 12 built-in tools (MCP tools are
   * reached through the existing generic mcp_call built-in, not as
   * individually named sky-tool blocks), so there is nothing this strategy
   * needs from the externally supplied canonical ToolDefinition[] beyond
   * what tools.ts already enforces.
   */
  async getNextAction(
    context: AgentContext,
    _tools: ToolDefinition[],
    model: string,
    onDiagnostic?: DiagnosticReporter,
  ): Promise<AgentAction> {
    const baseTurns: PlainConversationTurn[] =
      renderContextAsPlainTurns(
        context,
      );

    const correctiveTurns: PlainConversationTurn[] = [];

    for (
      let attempt = 0;
      attempt <= MAX_CORRECTIVE_ATTEMPTS;
      attempt += 1
    ) {
      const rawResponse =
        await this.client.complete(
          model,
          this.systemPrompt,
          [
            ...baseTurns,
            ...correctiveTurns,
          ],
        );

      const outcome =
        analyzeSkyToolResponse(
          rawResponse,
        );

      if (outcome.kind === "none") {
        // No sky-tool block at all: this completion is the model's real
        // final answer, with no pending tool call it claimed but did not
        // request. Already shown to the user live via this.client's own
        // streaming (see this class's doc comment above).
        return {
          kind: "final_answer",
          text: rawResponse,
          alreadyDisplayed: true,
        };
      }

      if (outcome.kind === "single") {
        return {
          kind: "tool_call",
          tool: outcome.request.tool,
          arguments: outcome.request.args,
          callId: createUuid(),
        };
      }

      // "multiple" or "malformed" from here on: nothing is executed, and
      // the raw response is never treated as a final answer. Extend the
      // corrective turns and try again.
      const correctionMessage =
        outcome.kind === "multiple"
          ? describeMultipleBlocksCorrection(
              outcome.count,
            )
          : describeMalformedBlockCorrection(
              outcome.error,
            );

      onDiagnostic?.(
        `LegacyStrategy corrective retry (attempt ${attempt + 1} of ${MAX_CORRECTIVE_ATTEMPTS}): ${correctionMessage}`,
      );

      correctiveTurns.push(
        {
          role: "assistant",
          content: rawResponse,
        },
        {
          role: "user",
          content: correctionMessage,
        },
      );
    }

    const exhaustionMessage =
      "LegacyStrategy could not obtain one valid sky-tool request from the model " +
      `after ${MAX_CORRECTIVE_ATTEMPTS} corrective attempt(s).`;

    onDiagnostic?.(
      exhaustionMessage,
    );

    throw new Error(
      exhaustionMessage,
    );
  }
}
