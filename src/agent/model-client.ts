/**
 * Model-completion client interfaces used by tool-calling strategies.
 *
 * A strategy (agent/strategies/*.ts) needs exactly one thing from whichever
 * model/provider is active: a way to obtain one completion. These two
 * interfaces are that boundary:
 * - TextCompletionClient: a plain assistant-text completion, given a system
 *   prompt and a list of prior turns. Used by PromptedStrategy and
 *   LegacyStrategy, both of which embed everything the model needs (tool
 *   schemas, or the sky-tool block instructions) directly inside text.
 * - NativeCompletionClient: a completion using a provider's own
 *   function/tool-calling protocol (tools, proper assistant
 *   tool-call records, role: "tool" results). Used only by NativeStrategy.
 *
 * Neither interface is implemented in this module. Production
 * implementations will adapt Sky Code's existing chat.ts (streamChatCompletion
 * for TextCompletionClient; an extended version supporting tools
 * for NativeCompletionClient); test implementations are fakes that return
 * scripted completions, so strategy tests never depend on a real model or
 * network access. Keeping these as plain interfaces here, rather than
 * importing chat.ts, is what keeps agent/strategies/*.ts isolated from the
 * live conversation path until it is deliberately wired in.
 */
import type {
  ToolDefinition,
} from "./types.js";

/**
 * One prior turn in a plain-text conversation, as sent to a
 * TextCompletionClient. There is no tool-call structure here: PromptedStrategy
 * and LegacyStrategy both represent tool activity as plain text within
 * `content` (see history-rendering.ts's renderHistoryAsPlainTurns()).
 */
export interface PlainConversationTurn {
  role: "user" | "assistant";
  content: string;
}

/**
 * Optional per-call hints a TextCompletionClient implementation may honor
 * when its underlying model/endpoint is known (via per-model capability
 * configuration, not built yet) to support them. An implementation that does
 * not support a given hint is free to ignore it; strategies must not depend
 * on a hint actually being honored, only request it.
 */
export interface TextCompletionOptions {
  /**
   * Requests a response constrained to a single JSON value, when the
   * underlying model/endpoint supports a JSON-mode or constrained-decoding
   * feature. PromptedStrategy sets this, since its selection response must
   * be exactly one JSON object.
   */
  jsonMode?: boolean;
  /**
   * The turn's cancellation signal (see cancellation.ts); aborts the
   * underlying HTTP request when the user cancels.
   */
  signal?: AbortSignal;
}

/**
 * Obtains one plain assistant-text completion for a system prompt plus
 * conversation history.
 */
export interface TextCompletionClient {
  complete(
    model: string,
    systemPrompt: string,
    turns: PlainConversationTurn[],
    options?: TextCompletionOptions,
  ): Promise<string>;
}

/**
 * One tool call as returned by a native tool-calling provider: an opaque
 * provider-issued ID, the tool name it selected, and its arguments as a raw
 * (possibly malformed) JSON string, exactly as the provider returned it.
 * NativeStrategy is responsible for parsing and validating argumentsJson;
 * this type makes no claim that it is well-formed.
 */
export interface NativeToolCallRequest {
  id: string;
  name: string;
  argumentsJson: string;
}

/**
 * One prior turn in a native tool-calling conversation. Mirrors the shape
 * OpenAI-compatible providers expect: an assistant turn that requested tools
 * carries them in `toolCalls` (with `content` typically null), and each
 * tool's real result is fed back as its own "tool" turn matched by
 * `toolCallId`.
 */
export type NativeConversationTurn =
  | {
      role: "user";
      content: string;
    }
  | {
      role: "assistant";
      content: string | null;
      toolCalls?: NativeToolCallRequest[];
    }
  | {
      role: "tool";
      toolCallId: string;
      content: string;
    };

/**
 * Result of one native tool-calling completion.
 *
 * A compliant single-action response has either exactly one entry in
 * toolCalls (content is typically null in that case), or an empty toolCalls
 * array with non-null, non-empty content. NativeStrategy is responsible for
 * detecting and correcting a non-compliant response (zero content and zero
 * tool calls, more than one tool call, an unknown tool name, or malformed
 * argumentsJson); this type does not enforce compliance itself, since a real
 * provider is exactly what might violate it.
 */
export interface NativeCompletionResult {
  content: string | null;
  toolCalls: NativeToolCallRequest[];
  /**
   * Reasons the response is unusable as-is, found by the client while
   * assembling it (today, only a streamed client: for example, a streamed
   * tool call that never received a function name). NativeStrategy treats
   * any entry as non-compliant and never executes anything from the
   * response. Absent or empty means no such issue was found.
   */
  protocolIssues?: string[];
  /**
   * Non-fatal irregularities the client corrected locally (for example, a
   * call ID the provider never sent), reported by NativeStrategy as
   * diagnostics only.
   */
  protocolNotes?: string[];
}

/**
 * One request for a native tool-calling completion.
 */
export interface NativeCompletionRequest {
  model: string;
  systemPrompt: string;
  turns: NativeConversationTurn[];
  tools: ToolDefinition[];
  /**
   * Whether the provider may return more than one tool call in a single
   * response, as Sky Code's own intent. NativeStrategy always sets this to
   * false, since Sky Code's agent loop only ever executes one action per
   * step.
   *
   * It is not sent to the provider: the production client
   * (createLiteLLMNativeCompletionClient(), adapters/litellm-client.ts)
   * omits the `parallel_tool_calls` wire field entirely, because some
   * gateway backends reject it outright (see the note above
   * requestNativeToolCompletion() in chat.ts). One action per step is
   * enforced by NativeStrategy itself, which treats a multi-tool-call
   * response as non-compliant regardless of this field. It stays here as the
   * single place a future provider-specific override could read from, if a
   * provider ever demonstrably needs the wire field.
   */
  parallelToolCalls: boolean;
  /**
   * The turn's cancellation signal (see cancellation.ts); aborts the
   * underlying HTTP request when the user cancels.
   */
  signal?: AbortSignal;
}

/**
 * Obtains one completion using a provider's native tool-calling protocol.
 */
export interface NativeCompletionClient {
  complete(
    request: NativeCompletionRequest,
  ): Promise<NativeCompletionResult>;
}
