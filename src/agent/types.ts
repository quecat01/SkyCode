/**
 * Core types for Sky Code's model/provider-independent agent execution layer.
 *
 * These types define the boundary between the common agent loop (loop.ts)
 * and the pluggable tool-calling strategies (agent/strategies/*.ts) that
 * decide how the next action is obtained from a given model/provider. The
 * loop, and every tool executor, depend only on these types and never on any
 * strategy-specific or provider-specific representation (raw OpenAI-style
 * tool_calls, sky-tool fenced blocks, etc.).
 *
 * Design invariants these types are meant to enforce:
 * - A strategy's getNextAction() returns exactly one action per call. There
 *   is no representation for "multiple pending actions": a strategy that
 *   receives more than one candidate action from its underlying model is
 *   responsible for resolving that down to a single action (or a done or
 *   failure outcome) itself, never for returning more than one and never for
 *   silently discarding the extras.
 * - AgentEvent stores only operational state: the requested action, the
 *   actual result, call state, and final answer text. There is no field for
 *   private model reasoning or a scratchpad trace.
 * - Verification is reported by the tool handler that actually ran, never
 *   inferred by the loop from the tool's name (see deriveCallState()).
 */

import type {
  PlainConversationTurn,
} from "./model-client.js";

/**
 * A JSON Schema object. Used both for request-time argument validation and
 * for describing a tool's parameters to native and prompted strategies.
 */
export type JsonSchema =
  Record<string, unknown>;

/**
 * One example call for a tool, shown in PromptedStrategy's selection prompt
 * to steer a model toward a correctly-shaped argument object. Not used by
 * NativeStrategy, whose provider is expected to work from the JSON Schema
 * alone.
 */
export interface ToolExample {
  /** A realistic, valid arguments object for this tool. */
  arguments: Record<string, unknown>;
  /** Optional short note on when this example applies. */
  note?: string;
}

/**
 * Canonical description of one tool available to the agent loop.
 *
 * This is Sky Code's single source of truth for a tool's shape. Native
 * strategies translate it into their provider's own function/tool
 * definition format; PromptedStrategy embeds it directly in its
 * tool-selection prompt; execution-time argument validation checks incoming
 * arguments against `parameters` before a handler ever runs.
 */
export interface ToolDefinition {
  /** Unique tool name, matching the name handlers and executors expect. */
  name: string;
  /** Human/model-readable description of what the tool does. */
  description: string;
  /** JSON Schema describing this tool's arguments object. */
  parameters: JsonSchema;
  /** Worked examples used by PromptedStrategy's selection prompt. */
  examples: ToolExample[];
  /**
   * Name of the permission category this tool maps to (e.g. "write-file",
   * "shell-command"). Kept as a plain string here, rather than importing
   * PermissionAction from permissions.ts, so this leaf module has no
   * dependency on the rest of the live conversation path; the wiring layer
   * that constructs real ToolDefinition values is responsible for using a
   * real PermissionAction value.
   */
  permissionCategory: string;
}

/**
 * Lifecycle state of one requested tool call, from the moment a strategy
 * proposes it through to its outcome.
 *
 * - pending: proposed by a strategy, not yet started.
 * - running: execution has begun.
 * - succeeded: the tool handler returned success with no independent
 *   post-condition check reported.
 * - verified: the tool handler returned success AND reported verified: true
 *   on its own result, meaning it performed some independent post-condition
 *   check as a normal part of its own execution. Never assigned by
 *   inferring from the tool's name; see deriveCallState(). Scope: this is
 *   the tool's own structural post-condition only - never proof that every
 *   semantic requirement in the user's actual goal was satisfied. Do not
 *   broaden it to mean "goal satisfied" anywhere it is read.
 * - failed: the tool handler ran and returned (or threw) a failure.
 * - interrupted: Sky stopped (crash, restart, session end) while this call
 *   was pending or running, with no result ever recorded. Distinct from
 *   failed: whether the tool actually completed is unknown, not negative.
 * - skipped: Sky Code deliberately did not run the tool, because this exact
 *   action (same tool, same normalized arguments) had already failed
 *   repeatedly this turn with the same result (see repeat-guard.ts). The
 *   tool never ran, so this is neither a success nor a real failure.
 * - rejected: the call's arguments were not valid JSON or failed the tool's
 *   schema, so it was refused before running (see argument-guidance.ts).
 *   Like skipped, the tool never ran; unlike failed, nothing was attempted.
 */
export type CallState =
  | "pending"
  | "running"
  | "succeeded"
  | "verified"
  | "failed"
  | "interrupted"
  | "skipped"
  | "rejected";

/**
 * The next action a tool-calling strategy proposes to the agent loop.
 *
 * - tool_call: run exactly one tool with the given arguments.
 * - final_answer: the strategy itself already produced the user-facing
 *   reply text. This is how NativeStrategy and LegacyStrategy conclude a
 *   turn, since their underlying completion naturally produces prose when
 *   it isn't calling a tool.
 * - done: no more tools are needed, but this strategy's own call was
 *   deliberately narrow and did not produce user-facing text. This is how
 *   PromptedStrategy concludes a turn: runAgentLoop() performs a separate
 *   plain completion for this case, using the real recorded history, rather
 *   than asking the narrow tool-selection call to also write prose.
 */
export type AgentAction =
  | {
      kind: "tool_call";
      tool: string;
      arguments: unknown;
      callId: string;
    }
  | {
      kind: "final_answer";
      text: string;
      /**
       * Whether `text` has already been shown to the user (e.g. streamed
       * live to the terminal as the completion arrived), so a caller never
       * renders it a second time.
       *
       * This is a documented contract of the completion client each
       * strategy is constructed with, not something dynamically detected at
       * call time: LegacyStrategy is always given a visible/streaming
       * client, so it reports `true`; NativeStrategy is always given a
       * non-streaming client, so it reports `false` (see each strategy's own
       * class doc comment). A caller (in production,
       * completeConversationTurn(), index.ts) reads only this field and
       * never branches on which concrete strategy produced the action - see
       * AgentTurnOutcome's matching field below, which carries this same
       * information out of runAgentLoop().
       */
      alreadyDisplayed: boolean;
    }
  | {
      kind: "done";
    }
  | {
      /**
       * A native tool call whose arguments were not valid JSON or failed the
       * tool's schema. Nothing is executed. runAgentLoop() records it under
       * the model's own call ID with `guidance` as its not-executed tool
       * result, so the model sees exactly what to fix on its next step.
       */
      kind: "rejected_tool_call";
      tool: string;
      callId: string;
      /** The parsed arguments when they were JSON, otherwise {}. */
      arguments: unknown;
      errorCode:
        | "TOOL_ARGUMENTS_INVALID_JSON"
        | "TOOL_ARGUMENT_VALIDATION_FAILED";
      /** The JSON parse error or the validation error, verbatim. */
      validationError: string;
      /** The full not-executed result text shown to the model. */
      guidance: string;
    };

/**
 * One immutable record of something that actually happened during an agent
 * turn. AgentEvent values are the only input a strategy receives about
 * conversation history: nothing else (no hidden reasoning trace, no
 * strategy-declared-but-unrecorded claim) is ever fed back in.
 */
export type AgentEvent =
  | {
      type: "tool_requested";
      callId: string;
      tool: string;
      arguments: unknown;
    }
  | {
      type: "tool_state_changed";
      callId: string;
      state: CallState;
    }
  | {
      type: "tool_result";
      callId: string;
      success: boolean;
      verified: boolean;
      output: string;
      /**
       * Present (true) only when Sky Code answered this call without running
       * the tool at all - today, only the repeated-action breaker (see
       * repeat-guard.ts). `success` is false and `output` explains why it
       * was not run. Consumers that summarize what actually happened must
       * not count such a result as a real tool failure.
       */
      notExecuted?: true;
      /**
       * Why a not-executed call never ran: the repeated-action breaker
       * ("repeat_blocked"), or arguments rejected before running
       * ("invalid_arguments"). Lets the execution ledger keep validation
       * failures (the tool never ran) separate from execution failures (it
       * ran and failed).
       */
      notExecutedReason?:
        | "repeat_blocked"
        | "invalid_arguments";
      /** For invalid_arguments: the JSON parse or validation error. */
      validationError?: string;
      /**
       * Recovery metadata, passed through unchanged from the tool's own
       * failure result (see ToolExecutionResult in tools.ts). Present only on
       * a failure the tool marked as safely recoverable, or on a blocked
       * repeat of one (see repeat-guard.ts). Generic: nothing in the agent
       * interprets errorCode beyond displaying it.
       */
      errorCode?: string;
      recoverable?: true;
      recoveryHint?: string;
      suggestedArguments?: Record<string, unknown>;
    }
  | {
      type: "final_answer";
      text: string;
    }
  | {
      type: "protocol_condition";
      detail: string;
    };

/**
 * Mutable-by-append conversation state passed to a strategy on every call.
 *
 * `priorTurns` is every earlier completed user/assistant exchange in the
 * session, strictly before this turn began, already rendered as plain
 * role/content turns. It is supplied once by runAgentLoop()'s caller (in
 * production, index.ts, derived from its own session-spanning message
 * history) and never mutated by the loop or by any strategy. It must not
 * include the current user message: that belongs in `goal` alone, so
 * history-rendering.ts's renderContextAsPlainTurns()/
 * renderContextAsNativeTurns() never show it to the model twice.
 *
 * `goal` is the original user request for this turn. `history` is the
 * ordered, append-only record of every real event so far within this turn
 * (tool calls, their results, and the eventual final answer).
 *
 * Every strategy and the FinalAnswerProducer receive the same AgentContext,
 * so `priorTurns + goal + history` is exactly the same conversational
 * grounding regardless of which is active - see renderContextAsPlainTurns()
 * and renderContextAsNativeTurns() in history-rendering.ts, the one place
 * these three layers are actually combined into what a model call sends.
 */
export interface AgentContext {
  priorTurns: PlainConversationTurn[];
  goal: string;
  history: AgentEvent[];
}

/**
 * Result of actually executing one tool call.
 *
 * Structurally compatible with Sky Code's existing ToolExecutionResult in
 * tools.ts, with two additions: `verified` and `endsTurn`.
 *
 * A handler sets `verified: true` only when it performed some independent
 * post-condition check as a normal part of its own execution (for example,
 * the document-generation tools already re-parse the file they just wrote
 * to confirm its structure before returning success). A handler with no
 * such check omits the field, or sets it false; either is treated as "not
 * verified" by deriveCallState().
 *
 * Scope: `verified: true` means only that the tool's own structural
 * post-condition held, nothing more. It is not, and must never be read as,
 * proof that every semantic requirement in the user's actual goal was
 * satisfied - a tool handler has no way to check that. Do not silently
 * broaden its meaning elsewhere in the codebase.
 *
 * `endsTurn: true` marks a result that should end the agent turn
 * immediately, without asking the strategy for another action - Sky Code's
 * existing background-tool behavior (a successful `run_shell_command` with
 * `background: true` returns control to the user prompt right away; see
 * shouldReturnToPromptAfterBackgroundTool() in background-turn.ts). This is
 * never a model-produced final answer: runAgentLoop() surfaces it as a
 * distinct `return_to_prompt` outcome (see AgentTurnOutcome below), and
 * never fabricates or asks for conversational text to go with it. The
 * executor adapter that knows a request was a background shell command is
 * responsible for setting this field; it is false/omitted for every other
 * tool result.
 */
export interface AgentToolResult {
  success: boolean;
  output: string;
  verified?: boolean;
  endsTurn?: boolean;
  /**
   * Optional failure-recovery metadata, exactly as the tool handler reported
   * it (see ToolExecutionResult in tools.ts for each field's meaning).
   */
  errorCode?: string;
  recoverable?: boolean;
  recoveryHint?: string;
  suggestedArguments?: Record<string, unknown>;
}

/**
 * The outcome of one complete agent turn, as returned by runAgentLoop().
 *
 * - final_answer: the turn ended with a model-produced (or, for
 *   PromptedStrategy's "done" case, FinalAnswerProducer-produced)
 *   user-facing answer. `alreadyDisplayed` carries the same meaning as on
 *   AgentAction's own "final_answer" case (see types.ts above): whether
 *   `text` has already been shown to the user, so a caller renders it
 *   itself only when this is false, regardless of which strategy or
 *   FinalAnswerProducer actually produced it.
 * - return_to_prompt: the turn ended because a tool result had
 *   `endsTurn: true` (see AgentToolResult). `result` is that real,
 *   already-recorded tool result; there is no model-produced text for this
 *   outcome, and none is fabricated to stand in for it. A caller that wants
 *   to show the user something uses `result.output` directly, exactly as
 *   Sky Code's existing background-tool handling already does.
 * - cancelled: the user cancelled the turn (see cancellation.ts). Nothing
 *   further was requested from the model or started as a tool; there is no
 *   final answer, and none is fabricated.
 */
export type AgentTurnOutcome =
  | {
      kind: "final_answer";
      text: string;
      alreadyDisplayed: boolean;
    }
  | {
      kind: "return_to_prompt";
      result: AgentToolResult;
    }
  | {
      kind: "cancelled";
    };

/**
 * Derives a terminal CallState from an actual tool result.
 *
 * This is the only place call state is decided from a result, and it never
 * inspects the tool's name: `verified` is exactly what the handler reported,
 * nothing more. Kept as a small pure function, rather than inlined in the
 * loop, so strategy code and session-resume reconstruction can reuse the
 * exact same rule.
 *
 * @param {AgentToolResult} result - The real result returned by a tool
 * handler.
 * @returns {"succeeded" | "verified" | "failed"} The resulting terminal call
 * state.
 */
export function deriveCallState(
  result: AgentToolResult,
): "succeeded" | "verified" | "failed" {
  if (!result.success) {
    return "failed";
  }

  return result.verified === true
    ? "verified"
    : "succeeded";
}

/**
 * Executes one tool call and returns its real result.
 *
 * Implemented in production by an adapter over Sky Code's existing
 * ToolHandlers (see toolhandlers.ts); implemented in tests by a fake that
 * returns scripted results, so agent-loop tests never depend on a real model
 * or real tool side effects.
 */
export interface ToolExecutor {
  /**
   * @param {string} tool - Tool name.
   * @param {unknown} args - Tool arguments.
   * @param {AbortSignal} [signal] - The turn's cancellation signal (see
   * cancellation.ts). An implementation must not start a tool once it is
   * aborted (throw TurnCancelledError instead); a tool already running is
   * allowed to finish.
   */
  execute(
    tool: string,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<AgentToolResult>;
}

/**
 * Produces the final user-facing answer text from a completed turn's full
 * context.
 *
 * Used by runAgentLoop() only when the active strategy returns
 * `{ kind: "done" }`: PromptedStrategy's normal case, since its narrow
 * tool-selection call never writes conversational prose, and NativeStrategy's
 * fallback when its model's reply keeps failing the final-answer check (see
 * final-answer-safety.ts). Either way the strategy has no usable reply text,
 * so the loop asks for that text separately. Strategies that return
 * `{ kind: "final_answer", text }` (Native, Legacy) bypass this entirely,
 * since their own completion already produced the reply.
 *
 * Receives the same AgentContext (priorTurns, goal, and this turn's real
 * history) every strategy receives, so this completion has exactly the same
 * conversational grounding - including earlier session turns - as the
 * tool-selection call that led up to it.
 *
 * Documented contract: an implementation's produced text is always already
 * shown to the user by the time produce() resolves (in production, streamed
 * live to the terminal - see createFinalAnswerProducer(),
 * agent/adapters/final-answer-producer.ts, always constructed with a
 * visible/streaming completion client). runAgentLoop() relies on this
 * directly - see AgentTurnOutcome's "final_answer" case above, whose
 * `alreadyDisplayed` is hardcoded `true` for a produce()-sourced answer
 * rather than derived from anything reported at call time - so an
 * implementation that could not guarantee this would need
 * runAgentLoop() itself updated, not just a new class written against this
 * interface.
 */
export interface FinalAnswerProducer {
  /**
   * @param {AgentContext} context - Full turn context.
   * @param {AbortSignal} [signal] - The turn's cancellation signal; aborts
   * the underlying model request.
   */
  produce(
    context: AgentContext,
    signal?: AbortSignal,
  ): Promise<string>;
}

/**
 * Reports one diagnostic-only note produced while deciding the next action -
 * today, exclusively a strategy's own internal corrective retry (a
 * non-compliant response fed back for one more attempt, or the final
 * exhaustion of that retry budget).
 *
 * Deliberately separate from AgentEvent/context.history: a corrective retry
 * is internal scratch (see LegacyStrategy, NativeStrategy, and
 * PromptedStrategy's own doc comments), never something a strategy actually
 * executed, so it must never become part of what a later getNextAction()
 * call within the same turn sees rendered back as conversation history (see
 * renderContextAsPlainTurns()/renderContextAsNativeTurns(),
 * history-rendering.ts) - only real, executed events belong there. A
 * DiagnosticReporter exists purely so this detail is not lost entirely: in
 * production (runAgentLoop(), loop.ts) it is wired to the same AgentEvent
 * listener used for real events, but reported as a "protocol_condition" that
 * is never pushed into context.history, so it reaches session
 * logging/diagnostics without ever reaching the model.
 */
export type DiagnosticReporter =
  (detail: string) => void;

/**
 * Decides the next action for one step of an agent turn.
 *
 * Implementations (NativeStrategy, PromptedStrategy, LegacyStrategy) are the
 * only place that knows how a particular model/provider actually produces a
 * tool call. Every implementation must return exactly one AgentAction per
 * call: an implementation that receives multiple candidate actions from its
 * underlying model (for example, a native provider that returns several
 * tool calls in one response) is responsible for resolving that down to one
 * action itself, never for returning more than one and never for silently
 * discarding extras.
 */
export interface ToolCallStrategy {
  /**
   * @param {AgentContext} context - Full turn context.
   * @param {ToolDefinition[]} tools - Tools available this turn.
   * @param {string} model - Active model.
   * @param {DiagnosticReporter} [onDiagnostic] - Diagnostic channel.
   * @param {AbortSignal} [signal] - The turn's cancellation signal (see
   * cancellation.ts). Implementations pass it to every model request they
   * make, including corrective retries, and stop retrying once it is
   * aborted.
   */
  getNextAction(
    context: AgentContext,
    tools: ToolDefinition[],
    model: string,
    onDiagnostic?: DiagnosticReporter,
    signal?: AbortSignal,
  ): Promise<AgentAction>;
}
