/**
 * Model/provider-independent agent execution loop.
 *
 * runAgentLoop() is the one place that implements Sky Code's tool-use cycle:
 * ask the active strategy for the next action, execute it for real, record
 * the actual result, and ask again, until a final answer is produced. It has
 * no knowledge of which model or provider is active, of native tool-calling
 * protocols, or of the sky-tool text convention; all of that lives behind
 * the ToolCallStrategy interface (see agent/types.ts and
 * agent/strategies/*.ts).
 *
 * Two invariants this module exists to guarantee:
 * - Only one action is ever executed per step (see AgentAction in
 *   types.ts): a strategy that cannot resolve its underlying model's
 *   response down to a single action is a strategy bug, not something this
 *   loop works around.
 * - context.history only ever grows from real, recorded events. A
 *   strategy's own text is never treated as evidence that a tool call
 *   succeeded; only executor.execute()'s actual return value is.
 */
import type {
  AgentContext,
  AgentEvent,
  AgentToolResult,
  AgentTurnOutcome,
  DiagnosticReporter,
  FinalAnswerProducer,
  ToolCallStrategy,
  ToolDefinition,
  ToolExecutor,
} from "./types.js";

import {
  deriveCallState,
} from "./types.js";

import type {
  PlainConversationTurn,
} from "./model-client.js";

/**
 * Safety bound on the number of tool-call steps a single turn may take
 * before runAgentLoop() gives up. This is the one limit of its kind in Sky
 * Code: index.ts's old completeConversationTurn() had its own separate
 * MAX_TOOL_ROUNDS (20), but that function is retired by the live agent-loop
 * wiring, so this is now the single shared bound for every strategy.
 * Prevents a misbehaving strategy, or a genuine model/tool loop, from running
 * forever.
 */
const MAX_AGENT_STEPS = 20;

/**
 * Optional hook invoked once for every AgentEvent the loop records, in
 * order. Used by the live CLI to mirror events into session logging and
 * terminal output; entirely optional so tests can run without a logger.
 */
export type AgentEventListener =
  (event: AgentEvent) => void;

/**
 * Runs one complete agent turn: from the user's goal to a final answer.
 *
 * @param {string} goal - The user's request for this turn.
 * @param {PlainConversationTurn[]} priorTurns - Every earlier completed
 * conversation turn in the session, strictly before this turn began. Must
 * not include the current `goal` message (see AgentContext.priorTurns in
 * types.ts). Passed straight through into the AgentContext every strategy
 * and the FinalAnswerProducer receive; runAgentLoop() itself never mutates
 * or reads it beyond that.
 * @param {ToolCallStrategy} strategy - The active strategy, already bound to
 * whichever model/provider is selected for this turn.
 * @param {ToolDefinition[]} tools - Canonical definitions of every tool
 * available this turn.
 * @param {string} model - Identifier of the active model, passed through to
 * the strategy on every call (see ToolCallStrategy.getNextAction).
 * @param {ToolExecutor} executor - Executes a tool call and returns its real
 * result. In production, an adapter over Sky Code's existing ToolHandlers;
 * in tests, a fake returning scripted results.
 * @param {FinalAnswerProducer} finalAnswerProducer - Produces the
 * user-facing reply when the strategy signals "done" without itself writing
 * that text (PromptedStrategy's case, or NativeStrategy's final-answer
 * fallback; see AgentAction in types.ts).
 * @param {AgentEventListener} [onEvent] - Optional listener invoked once for
 * every event, in order, as it is recorded.
 * @returns {Promise<AgentTurnOutcome>} Either the final user-facing answer
 * text, or a real tool result that ended the turn early without one (see
 * AgentTurnOutcome and AgentToolResult.endsTurn in types.ts).
 * @throws {Error} If the turn exceeds MAX_AGENT_STEPS consecutive tool calls
 * without reaching a final answer, indicating a runaway strategy or tool
 * loop.
 *
 * Side effects: invokes executor.execute() (which may have arbitrary real
 * side effects, e.g. writing files, exactly as today), invokes
 * strategy.getNextAction() and finalAnswerProducer.produce() (both of which
 * may perform network requests to the active model), and invokes onEvent for
 * every recorded event.
 */
export async function runAgentLoop(
  goal: string,
  priorTurns: PlainConversationTurn[],
  strategy: ToolCallStrategy,
  tools: ToolDefinition[],
  model: string,
  executor: ToolExecutor,
  finalAnswerProducer: FinalAnswerProducer,
  onEvent?: AgentEventListener,
): Promise<AgentTurnOutcome> {
  const context: AgentContext = {
    priorTurns,
    goal,
    history: [],
  };

  // Centralizes every state mutation through one function so "history only
  // grows from recorded events, in order, with the listener kept in sync"
  // cannot drift apart as more event types are added later.
  function record(
    event: AgentEvent,
  ): void {
    context.history.push(event);
    onEvent?.(event);
  }

  // Diagnostic-only channel for a strategy's own internal corrective
  // retries (see DiagnosticReporter, types.ts): reported to the same
  // AgentEvent listener as every real event, as a "protocol_condition", but
  // deliberately never pushed into context.history - a corrective retry is
  // internal scratch, not something the strategy actually executed, and
  // must stay invisible to any later getNextAction() call within this same
  // turn, exactly as it always has been.
  const reportDiagnostic: DiagnosticReporter =
    (detail) => {
      onEvent?.({
        type: "protocol_condition",
        detail,
      });
    };

  for (
    let step = 0;
    step < MAX_AGENT_STEPS;
    step += 1
  ) {
    const action =
      await strategy.getNextAction(
        context,
        tools,
        model,
        reportDiagnostic,
      );

    if (action.kind === "final_answer") {
      // The strategy's own completion already produced the reply (Native,
      // Legacy): nothing further to synthesize. `alreadyDisplayed` is
      // passed straight through from the strategy's own action - see its
      // doc comment in types.ts - so a caller never has to know which
      // concrete strategy produced it.
      record({
        type: "final_answer",
        text: action.text,
      });

      return {
        kind: "final_answer",
        text: action.text,
        alreadyDisplayed:
          action.alreadyDisplayed,
      };
    }

    if (action.kind === "done") {
      // The strategy has no usable reply text of its own: either its call
      // was deliberately narrow and never wrote conversational prose
      // (PromptedStrategy), or its model's reply kept failing the
      // final-answer check (NativeStrategy, after its corrective budget;
      // see final-answer-safety.ts). Either way the loop, not the strategy,
      // produces the user-facing text, grounded in the same full context
      // (prior session turns, goal, and this turn's real recorded history)
      // rather than anything the strategy's own call said.
      const text =
        await finalAnswerProducer.produce(
          context,
        );

      record({
        type: "final_answer",
        text,
      });

      return {
        kind: "final_answer",
        text,
        // Hardcoded true, not derived from anything reported at call time:
        // FinalAnswerProducer's own documented contract (types.ts) is that
        // its produced text is always already shown to the user by the time
        // produce() resolves.
        alreadyDisplayed: true,
      };
    }

    // action.kind === "tool_call" from here on.
    const callId =
      action.callId;

    record({
      type: "tool_requested",
      callId,
      tool: action.tool,
      arguments: action.arguments,
    });

    record({
      type: "tool_state_changed",
      callId,
      state: "running",
    });

    let result:
      AgentToolResult;

    try {
      result =
        await executor.execute(
          action.tool,
          action.arguments,
        );
    } catch (error) {
      // A thrown executor error is still a real outcome, just one the
      // executor failed to convert into a normal {success:false} result
      // itself. Recording it as a failed result, rather than letting the
      // rejection propagate and abort the whole turn, keeps the "record the
      // actual result, then reassess" contract intact even when a tool
      // implementation has a bug.
      result = {
        success: false,
        output:
          error instanceof Error
            ? error.message
            : String(error),
      };
    }

    const state =
      deriveCallState(
        result,
      );

    record({
      type: "tool_state_changed",
      callId,
      state,
    });

    record({
      type: "tool_result",
      callId,
      success: result.success,
      verified:
        result.verified === true,
      output: result.output,
    });

    if (result.endsTurn === true) {
      // The real, already-recorded tool result marks this turn as over
      // (e.g. a background shell command): return control immediately
      // without asking the strategy to reassess and without fabricating a
      // model final answer for it. See AgentToolResult.endsTurn and
      // AgentTurnOutcome in types.ts.
      record({
        type: "protocol_condition",
        detail:
          `Tool "${action.tool}" ended the turn early (endsTurn): returning to prompt without a further model call.`,
      });

      return {
        kind: "return_to_prompt",
        result,
      };
    }
  }

  throw new Error(
    `Sky Code's agent loop stopped after ${MAX_AGENT_STEPS} consecutive tool calls without a final answer.`,
  );
}
