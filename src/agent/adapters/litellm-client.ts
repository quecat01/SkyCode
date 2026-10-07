/**
 * Adapts Sky Code's real LiteLLM/OpenAI-compatible endpoint (chat.ts) to the
 * TextCompletionClient and NativeCompletionClient interfaces
 * (agent/model-client.ts) that PromptedStrategy, LegacyStrategy, and
 * NativeStrategy depend on.
 *
 * This is the one place agent/ code is allowed to depend on chat.ts and
 * config.ts: every strategy and the agent loop itself only ever see the
 * plain interfaces in model-client.ts, so this module is the seam where
 * "the agent execution layer" actually becomes "Sky Code talking to a real
 * model". Nothing above this module needs to change if chat.ts's own wire
 * protocol details change, as long as this adapter's translation stays
 * correct.
 */
import {
  requestNativeToolCompletion,
  streamChatCompletion,
  streamNativeToolCompletion,
  type ChatMessage,
  type ChatToolCall,
  type ChatToolDefinition,
  type NativeChatMessage,
} from "../../chat.js";

import type {
  AppConfig,
} from "../../config.js";

import type {
  NativeCompletionClient,
  NativeCompletionRequest,
  NativeCompletionResult,
  NativeConversationTurn,
  NativeToolCallRequest,
  TextCompletionClient,
} from "../model-client.js";

import type {
  ToolDefinition,
} from "../types.js";

import type {
  NativeTransport,
} from "../strategy-selection.js";

/**
 * Translates one canonical ToolDefinition into the OpenAI-compatible wire
 * format chat.ts's requestNativeToolCompletion() sends.
 *
 * @param {ToolDefinition} tool - One offered tool, from
 * NativeCompletionRequest.tools.
 * @returns {ChatToolDefinition} Its wire-format equivalent.
 */
function buildChatToolDefinition(
  tool: ToolDefinition,
): ChatToolDefinition {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

/**
 * Translates one NativeToolCallRequest (agent/model-client.ts's shape) into
 * its OpenAI-compatible wire format.
 *
 * @param {NativeToolCallRequest} call - One tool call to render into an
 * assistant message's tool_calls array.
 * @returns {ChatToolCall} Its wire-format equivalent.
 */
function buildChatToolCall(
  call: NativeToolCallRequest,
): ChatToolCall {
  return {
    id: call.id,
    type: "function",
    function: {
      name: call.name,
      arguments: call.argumentsJson,
    },
  };
}

/**
 * Translates one NativeConversationTurn into its OpenAI-compatible wire
 * format.
 *
 * @param {NativeConversationTurn} turn - One turn from
 * history-rendering.ts's renderHistoryAsNativeTurns(), or the leading goal
 * turn NativeStrategy prepends.
 * @returns {NativeChatMessage} Its wire-format equivalent.
 */
function buildNativeChatMessage(
  turn: NativeConversationTurn,
): NativeChatMessage {
  if (turn.role === "user") {
    return {
      role: "user",
      content: turn.content,
    };
  }

  if (turn.role === "assistant") {
    return {
      role: "assistant",
      content: turn.content,
      tool_calls:
        turn.toolCalls?.map(
          buildChatToolCall,
        ),
    };
  }

  return {
    role: "tool",
    tool_call_id: turn.toolCallId,
    content: turn.content,
  };
}

/**
 * Creates a TextCompletionClient backed by chat.ts's existing
 * streamChatCompletion(), for PromptedStrategy and LegacyStrategy.
 *
 * @param {AppConfig} config - Validated Sky Code API configuration.
 * @param {(content: string) => void} [onContent] - Optional forwarding
 * callback for streamed text fragments, e.g. to mirror them to the live
 * terminal the way Sky Code's existing conversation turns do. Omit for a
 * client whose caller only needs the final accumulated text (for example,
 * PromptedStrategy's selection calls, which are never shown to the user).
 * @returns {TextCompletionClient} A client backed by the real endpoint.
 */
export function createLiteLLMTextCompletionClient(
  config: AppConfig,
  onContent?: (content: string) => void,
): TextCompletionClient {
  return {
    async complete(
      model,
      systemPrompt,
      turns,
      options,
    ) {
      const messages: ChatMessage[] =
        turns.map(
          (turn): ChatMessage => ({
            role: turn.role,
            content: turn.content,
          }),
        );

      return streamChatCompletion(
        config,
        model,
        messages,
        onContent ?? (() => {}),
        systemPrompt,
        options?.jsonMode
          ? "json_object"
          : undefined,
      );
    },
  };
}

/**
 * Creates a NativeCompletionClient for NativeStrategy, backed by chat.ts's
 * streamed (streamNativeToolCompletion()) or non-streaming
 * (requestNativeToolCompletion()) native tool-calling request.
 *
 * The transport is decided per request, from the request's own model,
 * so one client stays correct across a /model switch without being
 * rebuilt.
 *
 * @param {AppConfig} config - Validated Sky Code API configuration.
 * @param {(model: string) => NativeTransport} [resolveTransport] - Picks
 * the transport for a model (in production, resolveNativeTransport(),
 * agent/strategy-selection.ts). Omitted, every request is non-streaming,
 * exactly as before streaming support existed.
 * @returns {NativeCompletionClient} A client backed by the real endpoint.
 */
export function createLiteLLMNativeCompletionClient(
  config: AppConfig,
  resolveTransport: (
    model: string,
  ) => NativeTransport = () => "non_streaming",
): NativeCompletionClient {
  return {
    async complete(
      request: NativeCompletionRequest,
    ): Promise<NativeCompletionResult> {
      const tools =
        request.tools.map(
          buildChatToolDefinition,
        );

      const messages =
        request.turns.map(
          buildNativeChatMessage,
        );

      const send =
        resolveTransport(
          request.model,
        ) === "streaming"
          ? streamNativeToolCompletion
          : requestNativeToolCompletion;

      const result =
        await send(
          config,
          request.model,
          request.systemPrompt,
          messages,
          tools,
          request.parallelToolCalls,
        );

      return {
        content: result.content,
        toolCalls:
          result.toolCalls.map(
            (call): NativeToolCallRequest => ({
              id: call.id,
              name: call.function.name,
              argumentsJson:
                call.function.arguments,
            }),
          ),
        // Only a streamed response can carry these (see
        // NativeChatCompletionResult, chat.ts); spread conditionally so a
        // non-streaming result's shape is exactly what it always was.
        ...(result.protocolIssues &&
        result.protocolIssues.length > 0
          ? {
              protocolIssues:
                result.protocolIssues,
            }
          : {}),
        ...(result.protocolNotes &&
        result.protocolNotes.length > 0
          ? {
              protocolNotes:
                result.protocolNotes,
            }
          : {}),
      };
    },
  };
}
