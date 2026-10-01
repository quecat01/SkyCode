/**
 * NativeStrategy: obtains the next agent action using a provider's own
 * native tool-calling protocol (OpenAI-compatible `tools`/`tool_choice`,
 * proper assistant tool-call records, role: "tool" results).
 *
 * Every request sets parallelToolCalls: false (see NativeCompletionRequest
 * in model-client.ts), since Sky Code's agent loop only ever executes one
 * action per step. A provider that still returns more than one tool call,
 * an unknown tool name, or a tool call whose arguments are not valid JSON is
 * non-compliant with that request: NativeStrategy never executes anything
 * from a non-compliant response, and never silently discards the extra
 * calls it contained. Instead it issues one internal corrective follow-up
 * completion asking the model to name exactly one action, bounded by
 * MAX_CORRECTIVE_ATTEMPTS, and throws a strategy-level error if the
 * provider is still non-compliant after that budget is exhausted (see
 * runAgentLoop in loop.ts: an error thrown from getNextAction() propagates
 * out of the turn, rather than being treated as a tool failure the loop
 * itself recovers from).
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
 * obtaining one compliant action and throwing.
 */
const MAX_CORRECTIVE_ATTEMPTS = 2;

/**
 * Outcome of classifying one NativeCompletionResult.
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
    };

/**
 * Checks whether one NativeCompletionResult is a usable, single-action
 * response, and if so, which kind.
 *
 * @param {NativeCompletionResult} result - The provider's raw completion
 * result.
 * @param {ToolDefinition[]} tools - Tools that were offered, used only to
 * confirm a returned tool name is actually one that was offered.
 * @returns {Compliance} The classified outcome.
 */
function checkCompliance(
  result: NativeCompletionResult,
  tools: ToolDefinition[],
): Compliance {
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
    !tools.some(
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
  let validated:
    ReturnType<typeof validateSkyToolRequest>;

  try {
    validated =
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

  return {
    kind: "compliant_tool_call",
    call,
    parsedArguments: validated.args,
  };
}

/**
 * Tool-calling strategy backed by a provider's native function/tool-calling
 * protocol.
 *
 * Documented contract: always constructed with a non-streaming
 * NativeCompletionClient (in production,
 * createLiteLLMNativeCompletionClient(), agent/adapters/litellm-client.ts;
 * kept non-streaming deliberately for now), so a "compliant_final_answer"
 * completion (this strategy's final answer) has not been shown to the user
 * anywhere yet by the time getNextAction() returns it - see the
 * "final_answer" action's `alreadyDisplayed: false` below, and
 * AgentAction's own doc comment in types.ts. A caller (in production,
 * completeConversationTurn(), index.ts) is responsible for rendering this
 * text itself, through the same Markdown rendering system a streamed
 * response uses.
 */
export class NativeStrategy implements ToolCallStrategy {
  private client:
    NativeCompletionClient;

  private systemPrompt:
    string;

  /**
   * @param {NativeCompletionClient} client - Adapter over the active
   * model/provider's native tool-calling completion endpoint.
   * @param {string} systemPrompt - System prompt to send with every
   * completion. Unlike LegacyStrategy, NativeStrategy does not need sky.md's
   * sky-tool-block instruction, since native tool definitions replace it;
   * the caller is still responsible for supplying whatever system prompt
   * content Sky Code wants the model to have.
   */
  constructor(
    client: NativeCompletionClient,
    systemPrompt: string,
  ) {
    this.client = client;
    this.systemPrompt = systemPrompt;
  }

  /** @inheritdoc */
  async getNextAction(
    context: AgentContext,
    tools: ToolDefinition[],
    model: string,
    onDiagnostic?: DiagnosticReporter,
  ): Promise<AgentAction> {
    const baseTurns: NativeConversationTurn[] =
      renderContextAsNativeTurns(
        context,
      );

    const correctiveTurns: NativeConversationTurn[] = [];

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
        tools,
        parallelToolCalls: false,
      };

      const result =
        await this.client.complete(
          request,
        );

      const compliance =
        checkCompliance(
          result,
          tools,
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
      onDiagnostic?.(
        `NativeStrategy corrective retry (attempt ${attempt + 1} of ${MAX_CORRECTIVE_ATTEMPTS}): ${compliance.reason}`,
      );

      correctiveTurns.push(
        {
          role: "assistant",
          content: result.content,
          toolCalls: result.toolCalls,
        },
        {
          role: "user",
          content:
            `Your previous response was not usable: ${compliance.reason} ` +
            "Respond with exactly one tool call, or plain text if no tool is needed.",
        },
      );
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
