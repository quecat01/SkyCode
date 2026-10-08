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
  AgentAction,
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

import {
  describeBlockedRepeat,
  RepeatGuard,
} from "./repeat-guard.js";

import {
  isTurnCancellation,
} from "./cancellation.js";

import {
  extractSafeRecovery,
} from "./recovery.js";

import {
  buildExecutionLedger,
  buildLedgerStopAnswer,
  buildRepeatStopAnswer,
} from "./execution-ledger.js";

import {
  MAX_BLOCKED_REPEATS,
} from "./repeat-guard.js";

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
 * How many times, within one turn, the model may correct a rejected call to
 * the same tool (arguments that were not valid JSON or failed the schema)
 * before the turn ends. With 2, the first and second rejections are answered
 * with guidance; the third rejection for that tool ends the turn with a
 * truthful account of everything recorded so far. A successful run of the
 * tool resets its count.
 */
export const MAX_ARGUMENT_CORRECTIONS = 2;

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
 * @param {AbortSignal} [signal] - The turn's cancellation signal (see
 * cancellation.ts). Once aborted, the loop makes no further model request
 * and starts no further tool; a tool already running finishes and its real
 * result is recorded, then the turn ends with a "cancelled" outcome. A
 * cancellation is never recorded as a tool failure.
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
  signal?: AbortSignal,
): Promise<AgentTurnOutcome> {
  const context: AgentContext = {
    priorTurns,
    goal,
    history: [],
  };

  // One per turn: remembers failed actions so an identical action that keeps
  // failing the same way is not executed indefinitely (see repeat-guard.ts).
  const repeatGuard =
    new RepeatGuard();

  // Rejected-argument calls per tool this turn (see MAX_ARGUMENT_CORRECTIONS).
  const argumentRejections =
    new Map<string, number>();

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

  // Ends the turn as cancelled. Reported on the diagnostic channel (session
  // log) only; nothing is added to history and no final answer is
  // fabricated.
  const endCancelled = (
    when: string,
  ): AgentTurnOutcome => {
    reportDiagnostic(
      `Turn cancelled by the user ${when}.`,
    );

    return {
      kind: "cancelled",
    };
  };

  for (
    let step = 0;
    step < MAX_AGENT_STEPS;
    step += 1
  ) {
    if (signal?.aborted) {
      return endCancelled(
        "before the next model request",
      );
    }

    let action: AgentAction;

    try {
      action =
        await strategy.getNextAction(
          context,
          tools,
          model,
          reportDiagnostic,
          signal,
        );
    } catch (error) {
      if (
        isTurnCancellation(
          error,
          signal,
        )
      ) {
        return endCancelled(
          "during a model request",
        );
      }

      throw error;
    }

    // A response that arrived after Ctrl+C is never acted on.
    if (signal?.aborted) {
      return endCancelled(
        "before acting on the model's response",
      );
    }

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
      let text: string;

      try {
        text =
          await finalAnswerProducer.produce(
            context,
            signal,
          );
      } catch (error) {
        if (
          isTurnCancellation(
            error,
            signal,
          )
        ) {
          return endCancelled(
            "while the final answer was being written",
          );
        }

        throw error;
      }

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

    if (action.kind === "rejected_tool_call") {
      // The tool never runs. The call is still recorded under the model's
      // own call ID and answered with concrete correction guidance, so native
      // history stays canonical and the model can fix it on its next step.
      record({
        type: "tool_requested",
        callId: action.callId,
        tool: action.tool,
        arguments: action.arguments,
      });

      record({
        type: "tool_state_changed",
        callId: action.callId,
        state: "rejected",
      });

      record({
        type: "tool_result",
        callId: action.callId,
        success: false,
        verified: false,
        output: action.guidance,
        notExecuted: true,
        notExecutedReason:
          "invalid_arguments",
        validationError:
          action.validationError,
        errorCode:
          action.errorCode,
        recoveryHint:
          `Correct the arguments and call ${action.tool} again.`,
      });

      const rejections =
        (argumentRejections.get(
          action.tool,
        ) ?? 0) + 1;

      argumentRejections.set(
        action.tool,
        rejections,
      );

      if (
        rejections >
        MAX_ARGUMENT_CORRECTIONS
      ) {
        // The configured number of corrections has been used up for this
        // tool. Everything done so far stays accurately reported.
        const text =
          buildLedgerStopAnswer(
            buildExecutionLedger(
              context.history,
            ),
            `the model repeatedly supplied invalid arguments for ${action.tool}, so it was never run`,
          );

        reportDiagnostic(
          `Argument rejections for "${action.tool}" reached the limit (${rejections} rejected calls, ${MAX_ARGUMENT_CORRECTIONS} corrections allowed); ending the turn with the recorded results.`,
        );

        record({
          type: "final_answer",
          text,
        });

        return {
          kind: "final_answer",
          text,
          alreadyDisplayed: false,
        };
      }

      continue;
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

    const repeat =
      repeatGuard.check(
        action.tool,
        action.arguments,
      );

    if (repeat.blocked) {
      // The model's call is still recorded (above) and answered (below), so
      // native history keeps a matching tool result for every assistant tool
      // call; the external tool itself is never run again. Then the loop
      // simply continues: the model sees why and can choose another action.
      record({
        type: "tool_state_changed",
        callId,
        state: "skipped",
      });

      record({
        type: "tool_result",
        callId,
        success: false,
        verified: false,
        output:
          describeBlockedRepeat(
            action.tool,
            repeat,
          ),
        notExecuted: true,
        notExecutedReason:
          "repeat_blocked",
        // The original failure's safe recovery, carried forward unchanged
        // so the model is given the same concrete next step again.
        ...(repeat.recovery
          ? {
              ...(repeat.recovery.errorCode !== undefined
                ? {
                    errorCode: repeat.recovery.errorCode,
                  }
                : {}),
              recoverable: true as const,
              ...(repeat.recovery.recoveryHint !== undefined
                ? {
                    recoveryHint: repeat.recovery.recoveryHint,
                  }
                : {}),
              suggestedArguments:
                repeat.recovery.suggestedArguments,
            }
          : {}),
      });

      repeatGuard.recordBlocked(
        action.tool,
        action.arguments,
      );

      // Diagnostic only (session log), never added to history: the tool
      // result above already tells the model everything it needs.
      reportDiagnostic(
        `Repeated-action breaker: did not run "${action.tool}" again; the identical call already failed ${repeat.failures} times this turn with the same result.`,
      );

      // The model already received this exact not-executed reply (with any
      // safe recovery) and asked for the identical call again: answering the
      // same way would only consume steps, so the turn ends honestly with a
      // deterministic account of what happened.
      if (
        repeat.priorBlocks >=
        MAX_BLOCKED_REPEATS
      ) {
        const text =
          buildRepeatStopAnswer(
            buildExecutionLedger(
              context.history,
            ),
            action.tool,
            repeat.recovery,
          );

        reportDiagnostic(
          `Repeated-action breaker: "${action.tool}" was requested again after being blocked; ending the turn with the recorded results.`,
        );

        record({
          type: "final_answer",
          text,
        });

        return {
          kind: "final_answer",
          text,
          alreadyDisplayed: false,
        };
      }

      continue;
    }

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
          signal,
        );
    } catch (error) {
      // Cancellation before the tool started (the executor refused to start
      // it, or Ctrl+C was pressed inside its approval prompt) is not a tool
      // failure: the call is marked interrupted, with no tool_result, and
      // the turn ends. Classified by the error alone, never by the signal,
      // so a tool that genuinely failed on its own is still recorded as a
      // failure.
      if (
        isTurnCancellation(
          error,
        )
      ) {
        record({
          type: "tool_state_changed",
          callId,
          state: "interrupted",
        });

        return endCancelled(
          `before "${action.tool}" started`,
        );
      }

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

    const recovery =
      extractSafeRecovery(
        result,
      );

    record({
      type: "tool_result",
      callId,
      success: result.success,
      verified:
        result.verified === true,
      output: result.output,
      // Failure metadata, recorded only when the tool reported it.
      ...(!result.success &&
      result.errorCode !== undefined
        ? {
            errorCode: result.errorCode,
          }
        : {}),
      ...(recovery
        ? {
            recoverable: true as const,
            ...(recovery.recoveryHint !== undefined
              ? {
                  recoveryHint: recovery.recoveryHint,
                }
              : {}),
            suggestedArguments:
              recovery.suggestedArguments,
          }
        : {}),
    });

    repeatGuard.recordResult(
      action.tool,
      action.arguments,
      result.success,
      result.output,
      recovery,
    );

    if (result.success) {
      argumentRejections.delete(
        action.tool,
      );
    }

    // Ctrl+C while the tool was running: it was allowed to finish and its
    // real result is recorded above, but the model is never called again.
    if (signal?.aborted) {
      return endCancelled(
        `after "${action.tool}" finished running`,
      );
    }

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
