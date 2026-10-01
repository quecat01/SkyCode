/**
 * Renders AgentContext into the plain-text and native tool-calling
 * conversation shapes strategies send to a model.
 *
 * Kept as one shared module, rather than duplicated inside each strategy, so
 * "what the model is shown" is assembled exactly the same way regardless of
 * which strategy is asking. This is the one place all three layers of an
 * AgentContext are combined into the turns a model call actually sends:
 * 1. `priorTurns` - every earlier completed conversation turn in the
 *    session, exactly as supplied.
 * 2. `goal` - the current user message, rendered as one user turn.
 * 3. `history` - this turn's real recorded events (tool calls, their
 *    results, protocol conditions), translated below by
 *    renderHistoryAsPlainTurns()/renderHistoryAsNativeTurns(). Both
 *    renderers only ever describe *recorded* events: neither can introduce
 *    a claim the loop did not actually record (see runAgentLoop in
 *    loop.ts), which is the structural property the new architecture exists
 *    to guarantee.
 *
 * renderContextAsPlainTurns() and renderContextAsNativeTurns() (below)
 * compose all three layers; every strategy uses one of them instead of
 * building its own turns array, so this composition cannot drift between
 * NativeStrategy, PromptedStrategy, and LegacyStrategy.
 */
import type {
  AgentContext,
  AgentEvent,
} from "./types.js";

import type {
  NativeConversationTurn,
  NativeToolCallRequest,
  PlainConversationTurn,
} from "./model-client.js";

/**
 * Describes one recorded tool result in a single readable block, shared by
 * both renderers below.
 *
 * @param {Extract<AgentEvent, {type: "tool_result"}>} event - A recorded
 * tool_result event.
 * @returns {string} Human/model-readable description of the real outcome.
 */
function describeToolResult(
  event: Extract<AgentEvent, { type: "tool_result" }>,
): string {
  const outcome =
    !event.success
      ? "failed"
      : event.verified
        ? "succeeded (independently verified)"
        : "succeeded";

  return `Result: ${outcome}\n${event.output}`;
}

/**
 * Renders AgentEvent history as a plain-text transcript, for strategies
 * (PromptedStrategy, LegacyStrategy) whose model call takes plain text turns
 * with no native tool-call structure.
 *
 * tool_requested/tool_result pairs are rendered together as one assistant
 * turn (the call) followed by one user turn (its real result).
 * tool_state_changed events are omitted (pure bookkeeping, not something the
 * model needs restated). protocol_condition events are rendered as a
 * clearly labeled note. final_answer should not normally appear mid-turn,
 * since runAgentLoop() returns as soon as one is recorded, but is rendered
 * defensively if present, for a caller inspecting a completed turn's
 * history.
 *
 * @param {readonly AgentEvent[]} history - Recorded events for this turn so
 * far.
 * @returns {PlainConversationTurn[]} Rendered turns, in the same order the
 * underlying events occurred.
 */
export function renderHistoryAsPlainTurns(
  history: readonly AgentEvent[],
): PlainConversationTurn[] {
  const turns: PlainConversationTurn[] = [];

  const pendingRequests = new Map<
    string,
    Extract<AgentEvent, { type: "tool_requested" }>
  >();

  for (
    const event of history
  ) {
    if (event.type === "tool_requested") {
      pendingRequests.set(
        event.callId,
        event,
      );
      continue;
    }

    if (event.type === "tool_state_changed") {
      continue;
    }

    if (event.type === "tool_result") {
      const request =
        pendingRequests.get(
          event.callId,
        );

      pendingRequests.delete(
        event.callId,
      );

      turns.push({
        role: "assistant",
        content: request
          ? `Tool call: ${request.tool}(${JSON.stringify(request.arguments)})`
          : `Tool call result received for an unrecorded request (call ${event.callId}).`,
      });

      turns.push({
        role: "user",
        content: describeToolResult(event),
      });
      continue;
    }

    if (event.type === "protocol_condition") {
      turns.push({
        role: "user",
        content: `[Sky Code note: ${event.detail}]`,
      });
      continue;
    }

    if (event.type === "final_answer") {
      turns.push({
        role: "assistant",
        content: event.text,
      });
    }
  }

  return turns;
}

/**
 * Renders AgentEvent history as native tool-calling conversation turns, for
 * NativeStrategy.
 *
 * Mirrors renderHistoryAsPlainTurns()'s event handling exactly, but produces
 * proper assistant tool-call records and role: "tool" results with matching
 * call IDs instead of plain text, matching what OpenAI-compatible providers
 * expect.
 *
 * @param {readonly AgentEvent[]} history - Recorded events for this turn so
 * far.
 * @returns {NativeConversationTurn[]} Rendered turns, in the same order the
 * underlying events occurred.
 */
export function renderHistoryAsNativeTurns(
  history: readonly AgentEvent[],
): NativeConversationTurn[] {
  const turns: NativeConversationTurn[] = [];

  const pendingRequests = new Map<
    string,
    Extract<AgentEvent, { type: "tool_requested" }>
  >();

  for (
    const event of history
  ) {
    if (event.type === "tool_requested") {
      pendingRequests.set(
        event.callId,
        event,
      );
      continue;
    }

    if (event.type === "tool_state_changed") {
      continue;
    }

    if (event.type === "tool_result") {
      const request =
        pendingRequests.get(
          event.callId,
        );

      pendingRequests.delete(
        event.callId,
      );

      // A missing request should not happen in practice (every tool_result
      // the loop records follows a tool_requested with the same callId),
      // but a placeholder name keeps this renderer total rather than
      // throwing on an unexpected input.
      const toolCall: NativeToolCallRequest = {
        id: event.callId,
        name: request?.tool ?? "unknown_tool",
        argumentsJson: JSON.stringify(
          request?.arguments ?? {},
        ),
      };

      turns.push({
        role: "assistant",
        content: null,
        toolCalls: [toolCall],
      });

      turns.push({
        role: "tool",
        toolCallId: event.callId,
        content: describeToolResult(event),
      });
      continue;
    }

    if (event.type === "protocol_condition") {
      turns.push({
        role: "user",
        content: `[Sky Code note: ${event.detail}]`,
      });
      continue;
    }

    if (event.type === "final_answer") {
      turns.push({
        role: "assistant",
        content: event.text,
      });
    }
  }

  return turns;
}

/**
 * Renders a complete AgentContext as the plain-text turns a
 * TextCompletionClient call should send: every prior session turn, then the
 * current goal, then this turn's real events.
 *
 * @param {AgentContext} context - Full context for the current turn.
 * @returns {PlainConversationTurn[]} Prior turns, the goal, and rendered
 * current-turn history, in that order.
 */
export function renderContextAsPlainTurns(
  context: AgentContext,
): PlainConversationTurn[] {
  return [
    ...context.priorTurns,
    {
      role: "user",
      content: context.goal,
    },
    ...renderHistoryAsPlainTurns(
      context.history,
    ),
  ];
}

/**
 * Converts one prior plain-text turn into its native tool-calling
 * equivalent (the plain "user" or "assistant" variant, never a tool-call or
 * tool-result turn: a prior turn is, by definition, from before this turn's
 * own tool activity).
 *
 * Written as an explicit branch, rather than a single object-literal
 * spread, because PlainConversationTurn.role is the union "user" |
 * "assistant": TypeScript cannot match that directly against
 * NativeConversationTurn's discriminated union without first narrowing to
 * one literal role per branch.
 *
 * @param {PlainConversationTurn} turn - One prior conversation turn.
 * @returns {NativeConversationTurn} The equivalent native turn.
 */
function convertPriorTurnToNativeTurn(
  turn: PlainConversationTurn,
): NativeConversationTurn {
  if (turn.role === "user") {
    return {
      role: "user",
      content: turn.content,
    };
  }

  return {
    role: "assistant",
    content: turn.content,
  };
}

/**
 * Renders a complete AgentContext as the native tool-calling turns a
 * NativeCompletionClient call should send: every prior session turn
 * (converted to plain user/assistant turns), then the current goal, then
 * this turn's real events rendered as proper tool-call/tool-result turns.
 *
 * @param {AgentContext} context - Full context for the current turn.
 * @returns {NativeConversationTurn[]} Prior turns, the goal, and rendered
 * current-turn history, in that order.
 */
export function renderContextAsNativeTurns(
  context: AgentContext,
): NativeConversationTurn[] {
  return [
    ...context.priorTurns.map(
      convertPriorTurnToNativeTurn,
    ),
    {
      role: "user",
      content: context.goal,
    },
    ...renderHistoryAsNativeTurns(
      context.history,
    ),
  ];
}
