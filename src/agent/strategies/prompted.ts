/**
 * PromptedStrategy: obtains the next agent action from any model/provider,
 * including one with no native tool-calling support at all, by asking a
 * dedicated, narrow model completion to select exactly one tool or signal
 * that none are needed.
 *
 * This is a first-class strategy, not a degraded fallback: it uses the
 * currently active model (the `model` parameter given to getNextAction(),
 * the same value every other strategy receives) rather than a separate
 * "tool-selection model" configuration, and it is given the full canonical
 * schema set (ToolDefinition[], including examples) so its selection prompt
 * is built from the same source of truth NativeStrategy's tool definitions
 * and execution-time argument validation use.
 *
 * The selection call is deliberately narrow: it is asked to return exactly
 * one JSON object, either a tool call or {"action":"done"}, and is never
 * asked to also write conversational prose (see AgentAction's "done" case
 * in types.ts). When PromptedStrategy signals "done", runAgentLoop()
 * performs a separate plain completion, grounded in the real recorded
 * history, to produce the user-facing answer; PromptedStrategy itself never
 * fabricates that text.
 *
 * A malformed or otherwise unusable selection response is fed back to the
 * model as a corrective follow-up, bounded by MAX_CORRECTIVE_ATTEMPTS, with
 * a strategy-level error thrown if the model still cannot produce a valid
 * selection after that budget is exhausted (mirroring NativeStrategy's
 * corrective-retry contract; see native.ts).
 *
 * getNextAction() is called fresh on every step of runAgentLoop(), with the
 * full tool list and the complete real history (including any prior failed
 * tool_result this turn) rendered back into the selection prompt - see
 * renderContextAsPlainTurns(), history-rendering.ts. A failed tool result
 * therefore never narrows what is offered next: the selection prompt also
 * explicitly tells the model it may reassess and pick a different tool, or
 * conclude {"action":"done"}, after seeing one. This is a generic property
 * of every tool, never special-cased for any specific tool name.
 */
import {
  v4 as createUuid,
} from "uuid";

import {
  renderContextAsPlainTurns,
} from "../history-rendering.js";

import {
  validateSkyToolRequest,
} from "../../tools.js";

import {
  throwIfCancelled,
} from "../cancellation.js";

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
 * Maximum number of internal corrective follow-up completions
 * PromptedStrategy will request, on top of the initial completion, before
 * giving up on obtaining one valid selection and throwing.
 */
const MAX_CORRECTIVE_ATTEMPTS = 2;

/**
 * Outcome of parsing one selection-call response.
 */
type Selection =
  | {
      kind: "tool_call";
      tool: string;
      arguments: unknown;
    }
  | {
      kind: "done";
    }
  | {
      kind: "invalid";
      reason: string;
    };

/**
 * Builds the system prompt for one selection call, embedding the full
 * canonical schema (name, description, JSON Schema parameters, and worked
 * examples) for every offered tool.
 *
 * @param {ToolDefinition[]} tools - Tools available this turn.
 * @returns {string} Complete system prompt for the selection call.
 */
function buildSelectionSystemPrompt(
  tools: ToolDefinition[],
): string {
  const toolDescriptions =
    tools
      .map((tool) => {
        const exampleLines =
          tool.examples.map(
            (example) =>
              `  example arguments: ${JSON.stringify(example.arguments)}${
                example.note ? ` (${example.note})` : ""
              }`,
          );

        return [
          `- ${tool.name}: ${tool.description}`,
          `  parameters (JSON Schema): ${JSON.stringify(tool.parameters)}`,
          ...exampleLines,
        ].join("\n");
      })
      .join("\n");

  return [
    "You are selecting the single next tool call for an automated agent, or signaling that no further tool call is needed.",
    "Respond with exactly one JSON object and nothing else: no prose, no explanation, no markdown code fencing.",
    'To call a tool, respond with: {"action":"tool_call","tool":"<tool name>","arguments":{...}}',
    'When no further tool call is needed, respond with: {"action":"done"}',
    "Do not write a user-facing answer here; only select an action.",
    "If the most recent tool result shown to you failed, reassess using the full list of tools below: select a different tool call if one could resolve or work around the failure, or respond {\"action\":\"done\"} if the goal cannot be completed with the available tools. Never assume a tool call succeeded only because you requested it; go only by the result you were actually shown.",
    "Available tools:",
    toolDescriptions,
  ].join("\n\n");
}

/**
 * Parses and validates one selection-call response.
 *
 * @param {string} text - Raw text returned by the selection completion.
 * @param {ToolDefinition[]} tools - Tools that were offered, used to confirm
 * a selected tool name is actually one that was offered.
 * @returns {Selection} The parsed selection, or an "invalid" outcome
 * describing why the response could not be used.
 */
function parseSelection(
  text: string,
  tools: ToolDefinition[],
): Selection {
  let parsed: unknown;

  try {
    parsed =
      JSON.parse(
        text.trim(),
      );
  } catch (error) {
    return {
      kind: "invalid",
      reason: `The response was not valid JSON: ${
        error instanceof Error
          ? error.message
          : String(error)
      }`,
    };
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    return {
      kind: "invalid",
      reason: "The response was not a single JSON object.",
    };
  }

  const record =
    parsed as Record<
      string,
      unknown
    >;

  if (record.action === "done") {
    return {
      kind: "done",
    };
  }

  if (record.action !== "tool_call") {
    return {
      kind: "invalid",
      reason:
        'The "action" field must be exactly "tool_call" or "done".',
    };
  }

  if (typeof record.tool !== "string") {
    return {
      kind: "invalid",
      reason:
        'A "tool_call" response must include a string "tool" field.',
    };
  }

  if (
    !tools.some(
      (tool) => tool.name === record.tool,
    )
  ) {
    return {
      kind: "invalid",
      reason: `"${record.tool}" is not one of the offered tools.`,
    };
  }

  if (
    typeof record.arguments !== "object" ||
    record.arguments === null ||
    Array.isArray(record.arguments)
  ) {
    return {
      kind: "invalid",
      reason:
        'A "tool_call" response must include an object "arguments" field.',
    };
  }

  // Validate against the tool's own argument schema before this candidate
  // becomes an AgentAction: a schema-invalid selection has not executed
  // anything, so it belongs in the same corrective retry loop as any other
  // invalid response, not silently forwarded to the executor. This
  // unconditional call is correct for every currently offered tool, which
  // are all built-in Sky Code tools; once individually-exposed MCP tools are
  // wired into PromptedStrategy (they are currently only reachable via the
  // generic mcp_call built-in), this step will need to become
  // built-in-tool-specific rather than applying to every tool name.
  let validated:
    ReturnType<typeof validateSkyToolRequest>;

  try {
    validated =
      validateSkyToolRequest(
        record.tool,
        record.arguments,
      );
  } catch (error) {
    return {
      kind: "invalid",
      reason: `Arguments for "${record.tool}" did not pass validation: ${
        error instanceof Error
          ? error.message
          : String(error)
      }`,
    };
  }

  return {
    kind: "tool_call",
    tool: record.tool,
    arguments: validated.args,
  };
}

/**
 * Tool-calling strategy backed by a dedicated, narrow, model-agnostic
 * tool-selection prompt.
 */
export class PromptedStrategy implements ToolCallStrategy {
  private client:
    TextCompletionClient;

  /**
   * @param {TextCompletionClient} client - Adapter over the active
   * model/provider's plain-text completion endpoint.
   */
  constructor(
    client: TextCompletionClient,
  ) {
    this.client = client;
  }

  /** @inheritdoc */
  async getNextAction(
    context: AgentContext,
    tools: ToolDefinition[],
    model: string,
    onDiagnostic?: DiagnosticReporter,
    signal?: AbortSignal,
  ): Promise<AgentAction> {
    const systemPrompt =
      buildSelectionSystemPrompt(
        tools,
      );

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
      // A cancelled turn makes no further requests, including corrective
      // retries (see cancellation.ts).
      throwIfCancelled(
        signal,
      );

      const rawResponse =
        await this.client.complete(
          model,
          systemPrompt,
          [
            ...baseTurns,
            ...correctiveTurns,
          ],
          {
            jsonMode: true,
            ...(signal
              ? {
                  signal,
                }
              : {}),
          },
        );

      const selection =
        parseSelection(
          rawResponse,
          tools,
        );

      if (selection.kind === "done") {
        return {
          kind: "done",
        };
      }

      if (selection.kind === "tool_call") {
        return {
          kind: "tool_call",
          tool: selection.tool,
          arguments: selection.arguments,
          callId: createUuid(),
        };
      }

      // Non-compliant: extend the corrective turns and try again. The raw
      // response is never treated as a "done" or an executable action.
      onDiagnostic?.(
        `PromptedStrategy corrective retry (attempt ${attempt + 1} of ${MAX_CORRECTIVE_ATTEMPTS}): ${selection.reason}`,
      );

      correctiveTurns.push(
        {
          role: "assistant",
          content: rawResponse,
        },
        {
          role: "user",
          content:
            `Your previous response was not usable: ${selection.reason} ` +
            "Respond again with exactly one JSON object in the required format.",
        },
      );
    }

    const exhaustionMessage =
      "PromptedStrategy could not obtain one valid selection from the model " +
      `after ${MAX_CORRECTIVE_ATTEMPTS} corrective attempt(s).`;

    onDiagnostic?.(
      exhaustionMessage,
    );

    throw new Error(
      exhaustionMessage,
    );
  }
}
