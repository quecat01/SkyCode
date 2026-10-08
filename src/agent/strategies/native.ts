/**
 * NativeStrategy: obtains the next agent action using a provider's own
 * native tool-calling protocol (OpenAI-compatible `tools`,
 * proper assistant tool-call records, role: "tool" results).
 *
 * One call to getNextAction() is one model decision. runAgentLoop()
 * (loop.ts) executes the returned action for real, records the real result,
 * and calls getNextAction() again with that result in the history, so a
 * multi-step request (create a DOCX, then an XLSX, then a PDF...) proceeds
 * one native tool call at a time with no user input between steps. The
 * conversation each call sends is rebuilt from recorded events as genuine
 * native turns: an assistant message carrying the call (same ID, name, and
 * complete arguments the model sent) followed by a role:"tool" message
 * carrying the real output (see renderHistoryAsNativeTurns(),
 * history-rendering.ts).
 *
 * Every request records parallelToolCalls: false as Sky Code's intent (see
 * NativeCompletionRequest in model-client.ts; the field is not sent to the
 * provider, since some backends reject it), and this strategy enforces one
 * action per step itself. A response NativeStrategy cannot use as one
 * action is non-compliant, and nothing from it is ever executed or shown:
 * - more than one tool call, an unknown tool
 *   name, arguments that are not valid JSON, or arguments that fail the
 *   tool's schema;
 * - a streamed call the client could not fully assemble (see
 *   NativeCompletionResult.protocolIssues);
 * - plain text that is not a genuine final answer: a tool request written
 *   as text, or a promise of work that will not happen because the turn
 *   would end (see checkFinalAnswerSafety(), final-answer-safety.ts).
 *
 * A non-compliant response gets one internal corrective follow-up
 * completion, bounded by MAX_CORRECTIVE_ATTEMPTS. Extra calls are never
 * silently discarded: every call in the rejected response is echoed back to
 * the model with its own role:"tool" message saying it was not executed and
 * why, which also keeps the corrective request valid under the native
 * protocol (an assistant tool-call record must be answered by a tool message
 * for every call ID). After the budget is exhausted:
 * - for a structural failure (calls that cannot be used), a strategy-level
 *   error is thrown (see runAgentLoop in loop.ts: it propagates out of the
 *   turn rather than being treated as a tool failure);
 * - for text that kept failing the final-answer check, "done" is returned
 *   instead, so the loop's FinalAnswerProducer writes the reply from the
 *   real recorded history, under its own honesty instructions, rather than
 *   showing the user a reply that promises unexecuted work.
 *
 * The corrective exchange is internal scratch, not recorded as AgentEvent
 * history: only real, executed tool results belong in that history (see
 * types.ts's AgentEvent doc comment), and a corrective retry has no
 * executed result of its own to record.
 */
import {
  renderContextAsNativeTurns,
} from "../history-rendering.js";

import {
  checkFinalAnswerSafety,
} from "../final-answer-safety.js";

import {
  validateSkyToolRequest,
} from "../../tools.js";

import type {
  NativeCompletionClient,
  NativeCompletionRequest,
  NativeCompletionResult,
  NativeConversationTurn,
  NativeToolCallRequest,
} from "../model-client.js";

import type {
  AgentAction,
  AgentContext,
  DiagnosticReporter,
  ToolCallStrategy,
  ToolDefinition,
} from "../types.js";

/**
 * Maximum number of internal corrective follow-up completions NativeStrategy
 * will request, on top of the initial completion, before giving up on
 * obtaining one compliant action.
 */
const MAX_CORRECTIVE_ATTEMPTS = 2;

/**
 * Outcome of classifying one NativeCompletionResult.
 *
 * "unsafe_final_answer" is kept separate from "non_compliant" because its
 * exhaustion is handled differently (see this module's doc comment).
 */
type Compliance =
  | {
      kind: "compliant_tool_call";
      call: NativeToolCallRequest;
      parsedArguments: unknown;
    }
  | {
      kind: "compliant_final_answer";
      text: string;
    }
  | {
      kind: "non_compliant";
      reason: string;
    }
  | {
      kind: "unsafe_final_answer";
      reason: string;
    };

/**
 * Selects which of the available tools to offer for one decision, plus a
 * reason for diagnostics. In production, selectRelevantTools()
 * (tool-relevance.ts).
 */
export type NativeToolSelector = (
  context: AgentContext,
  tools: readonly ToolDefinition[],
) => {
  tools: ToolDefinition[];
  reason: string;
};

/**
 * Optional NativeStrategy behavior.
 */
export interface NativeStrategyOptions {
  /**
   * Narrows the tools offered to the model. Omitted, every available tool
   * is offered (the original behavior).
   */
  selectTools?: NativeToolSelector;
}

/**
 * Checks whether one NativeCompletionResult is a usable, single-action
 * response, and if so, which kind.
 *
 * @param {NativeCompletionResult} result - The provider's raw completion
 * result.
 * @param {ToolDefinition[]} offeredTools - Tools actually offered in this
 * request; a call naming any other tool is non-compliant.
 * @param {readonly string[]} knownToolNames - Every tool name available
 * this turn (offered or not), used to recognize a tool request written as
 * text.
 * @returns {Compliance} The classified outcome.
 */
function checkCompliance(
  result: NativeCompletionResult,
  offeredTools: ToolDefinition[],
  knownToolNames: readonly string[],
): Compliance {
  if (
    result.protocolIssues &&
    result.protocolIssues.length > 0
  ) {
    return {
      kind: "non_compliant",
      reason: `The streamed response could not be assembled into a usable tool call: ${result.protocolIssues.join(" ")}`,
    };
  }

  if (result.toolCalls.length > 1) {
    return {
      kind: "non_compliant",
      reason: `It requested ${result.toolCalls.length} tool calls at once; only one at a time is allowed.`,
    };
  }

  if (result.toolCalls.length === 0) {
    if (
      result.content !== null &&
      result.content.trim() !== ""
    ) {
      const safety =
        checkFinalAnswerSafety(
          result.content,
          knownToolNames,
        );

      if (!safety.acceptable) {
        return {
          kind: "unsafe_final_answer",
          reason: `Its reply cannot be accepted as a final answer: ${safety.reason}`,
        };
      }

      return {
        kind: "compliant_final_answer",
        text: result.content,
      };
    }

    return {
      kind: "non_compliant",
      reason: "It returned neither a tool call nor any text.",
    };
  }

  const call =
    result.toolCalls[0]!;

  if (
    !offeredTools.some(
      (tool) => tool.name === call.name,
    )
  ) {
    return {
      kind: "non_compliant",
      reason: `It requested "${call.name}", which is not one of the offered tools.`,
    };
  }

  let parsedArguments: unknown;

  try {
    parsedArguments =
      JSON.parse(
        call.argumentsJson,
      );
  } catch (error) {
    return {
      kind: "non_compliant",
      reason: `Its arguments for "${call.name}" were not valid JSON: ${
        error instanceof Error
          ? error.message
          : String(error)
      }`,
    };
  }

  // Validate against the tool's own argument schema before this candidate
  // becomes an AgentAction: a schema-invalid call has not executed anything,
  // so it belongs in the same corrective retry loop as any other
  // non-compliant response, not silently forwarded to the executor. This
  // unconditional call is correct for every currently offered tool, which
  // are all built-in Sky Code tools; once individually-exposed MCP tools are
  // wired into NativeStrategy (they are currently only reachable via the
  // generic mcp_call built-in), this step will need to become
  // built-in-tool-specific rather than applying to every tool name.
  try {
    validateSkyToolRequest(
      call.name,
      parsedArguments,
    );
  } catch (error) {
    return {
      kind: "non_compliant",
      reason: `Its arguments for "${call.name}" did not pass validation: ${
        error instanceof Error
          ? error.message
          : String(error)
      }`,
    };
  }

  // The complete parsed arguments the model sent are returned, not
  // validation's schema-trimmed copy: they are what gets recorded and later
  // echoed back in native history, so the model sees its own call exactly as
  // it made it. The executor re-validates and runs only the validated form
  // (see createLiveToolExecutor(), adapters/tool-executor.ts), so nothing
  // unvalidated is ever executed.
  return {
    kind: "compliant_tool_call",
    call,
    parsedArguments,
  };
}

/**
 * Returns a tool call's arguments in a form that is safe to echo back in a
 * corrective request: unchanged when it is a JSON object, otherwise "{}".
 *
 * A gateway may parse echoed arguments while translating the request for
 * its backend, so echoing malformed JSON could turn a recoverable model
 * mistake into a hard request failure. The original text is still shown to
 * the model, in that call's "not executed" tool message.
 *
 * @param {NativeToolCallRequest} call - One call from a rejected response.
 * @returns {NativeToolCallRequest} The call with echo-safe arguments.
 */
function toEchoSafeCall(
  call: NativeToolCallRequest,
): NativeToolCallRequest {
  try {
    const parsed: unknown =
      JSON.parse(
        call.argumentsJson,
      );

    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      return call;
    }
  } catch {
    // Fall through to the replacement below.
  }

  return {
    ...call,
    argumentsJson: "{}",
  };
}

/**
 * Builds the corrective turns that follow one rejected response.
 *
 * @param {NativeCompletionResult} result - The rejected response.
 * @param {Compliance & {reason: string}} compliance - Why it was rejected.
 * @returns {NativeConversationTurn[]} Turns to append before retrying.
 */
function buildCorrectiveTurns(
  result: NativeCompletionResult,
  compliance: Extract<
    Compliance,
    { reason: string }
  >,
): NativeConversationTurn[] {
  if (result.toolCalls.length > 0) {
    const echoed =
      result.toolCalls.map(
        toEchoSafeCall,
      );

    return [
      {
        role: "assistant",
        content: result.content,
        toolCalls: echoed,
      },
      ...result.toolCalls.map(
        (call): NativeConversationTurn => ({
          role: "tool",
          toolCallId: call.id,
          content: JSON.stringify({
            status: "not_executed",
            error: compliance.reason,
            arguments_received:
              call.argumentsJson,
          }),
        }),
      ),
      {
        role: "user",
        content:
          `Your previous response was not usable: ${compliance.reason} ` +
          "Nothing from it was executed. Respond with exactly one tool call, or plain text if no tool is needed.",
      },
    ];
  }

  if (
    compliance.kind ===
    "unsafe_final_answer"
  ) {
    return [
      {
        role: "assistant",
        content: result.content,
      },
      {
        role: "user",
        content:
          `${compliance.reason} ` +
          "If an action is still needed, request it now as a native tool call, one at a time. " +
          "Otherwise, reply with a final answer that describes only actions whose tool results are shown above, including any that failed, and promises nothing further.",
      },
    ];
  }

  // Neither text nor calls: there is nothing to echo, and an assistant turn
  // with neither is not a valid native message.
  return [
    {
      role: "user",
      content:
        `Your previous response was not usable: ${compliance.reason} ` +
        "Respond with exactly one tool call, or plain text if no tool is needed.",
    },
  ];
}

/**
 * Tool-calling strategy backed by a provider's native function/tool-calling
 * protocol.
 *
 * Documented contract: the NativeCompletionClient never streams anything to
 * the terminal (in production, createLiteLLMNativeCompletionClient(),
 * agent/adapters/litellm-client.ts, whose streamed transport assembles the
 * response silently), so a "compliant_final_answer" completion (this
 * strategy's final answer) has not been shown to the user anywhere yet by
 * the time getNextAction() returns it - see the "final_answer" action's
 * `alreadyDisplayed: false` below, and AgentAction's own doc comment in
 * types.ts. That is deliberate: the text is only shown after it has passed
 * the final-answer check. A caller (in production,
 * completeConversationTurn(), index.ts) is responsible for rendering this
 * text itself, through the same Markdown rendering system a streamed
 * response uses.
 */
export class NativeStrategy implements ToolCallStrategy {
  private client:
    NativeCompletionClient;

  private systemPrompt:
    string;

  private selectTools:
    NativeToolSelector | undefined;

  /**
   * @param {NativeCompletionClient} client - Adapter over the active
   * model/provider's native tool-calling completion endpoint.
   * @param {string} systemPrompt - System prompt to send with every
   * completion. Unlike LegacyStrategy, NativeStrategy does not need sky.md's
   * sky-tool-block instruction, since native tool definitions replace it;
   * the caller is still responsible for supplying whatever system prompt
   * content Sky Code wants the model to have.
   * @param {NativeStrategyOptions} [options] - Optional behavior, such as
   * relevant-tool filtering.
   */
  constructor(
    client: NativeCompletionClient,
    systemPrompt: string,
    options: NativeStrategyOptions = {},
  ) {
    this.client = client;
    this.systemPrompt = systemPrompt;
    this.selectTools = options.selectTools;
  }

  /** @inheritdoc */
  async getNextAction(
    context: AgentContext,
    tools: ToolDefinition[],
    model: string,
    onDiagnostic?: DiagnosticReporter,
  ): Promise<AgentAction> {
    let offeredTools =
      tools;

    if (this.selectTools) {
      const selection =
        this.selectTools(
          context,
          tools,
        );

      offeredTools =
        selection.tools;

      // Reported once per turn (on its first decision), not every step: the
      // selection depends only on the turn's goal and tools already used, so
      // repeating it each step would add noise without new information.
      if (
        !context.history.some(
          (event) =>
            event.type ===
            "tool_requested",
        )
      ) {
        onDiagnostic?.(
          selection.reason,
        );
      }
    }

    const knownToolNames =
      tools.map(
        (tool) => tool.name,
      );

    const baseTurns: NativeConversationTurn[] =
      renderContextAsNativeTurns(
        context,
      );

    const correctiveTurns: NativeConversationTurn[] = [];

    let lastRejection:
      | Extract<
          Compliance,
          { reason: string }
        >
      | undefined;

    for (
      let attempt = 0;
      attempt <= MAX_CORRECTIVE_ATTEMPTS;
      attempt += 1
    ) {
      const request: NativeCompletionRequest = {
        model,
        systemPrompt: this.systemPrompt,
        turns: [
          ...baseTurns,
          ...correctiveTurns,
        ],
        tools: offeredTools,
        parallelToolCalls: false,
      };

      const result =
        await this.client.complete(
          request,
        );

      for (
        const note of result.protocolNotes ?? []
      ) {
        onDiagnostic?.(
          `NativeStrategy protocol note: ${note}`,
        );
      }

      const compliance =
        checkCompliance(
          result,
          offeredTools,
          knownToolNames,
        );

      if (compliance.kind === "compliant_tool_call") {
        return {
          kind: "tool_call",
          tool: compliance.call.name,
          arguments: compliance.parsedArguments,
          callId: compliance.call.id,
        };
      }

      if (compliance.kind === "compliant_final_answer") {
        // Not yet shown anywhere: this.client never streams to the terminal
        // (see this class's doc comment above). The caller renders it.
        return {
          kind: "final_answer",
          text: compliance.text,
          alreadyDisplayed: false,
        };
      }

      // Non-compliant: extend the corrective turns and try again. Nothing
      // from `result` is treated as an executable action or trusted text.
      lastRejection =
        compliance;

      onDiagnostic?.(
        `NativeStrategy corrective retry (attempt ${attempt + 1} of ${MAX_CORRECTIVE_ATTEMPTS}): ${compliance.reason}`,
      );

      correctiveTurns.push(
        ...buildCorrectiveTurns(
          result,
          compliance,
        ),
      );
    }

    if (
      lastRejection?.kind ===
      "unsafe_final_answer"
    ) {
      onDiagnostic?.(
        "NativeStrategy could not obtain an acceptable final answer from the model " +
          `after ${MAX_CORRECTIVE_ATTEMPTS} corrective attempt(s); the reply will be written from the recorded tool results instead.`,
      );

      return {
        kind: "done",
      };
    }

    const exhaustionMessage =
      "NativeStrategy could not obtain one compliant action from the model " +
      `after ${MAX_CORRECTIVE_ATTEMPTS} corrective attempt(s).`;

    onDiagnostic?.(
      exhaustionMessage,
    );

    throw new Error(
      exhaustionMessage,
    );
  }
}
