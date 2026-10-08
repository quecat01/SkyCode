/**
 * LiteLLM/OpenAI-compatible chat and model-discovery client.
 *
 * Responsible for retrieving the models exposed by the configured API endpoint
 * and for sending streamed chat-completion requests. It converts the endpoint's
 * Server-Sent Events (SSE) response into incremental text callbacks while also
 * returning the complete assistant response to the caller.
 *
 * The CLI in index.ts uses this module for model selection and normal
 * conversation turns. Configuration comes from config.ts, while tools.ts
 * supplies the default Sky Code system prompt.
 */

import type {
  AppConfig,
} from "./config.js";

import {
  SKY_CODE_SYSTEM_PROMPT,
} from "./tools.js";

import {
  NativeToolCallStreamAssembler,
  type NativeToolCallStreamAssemblerOptions,
} from "./native-tool-stream.js";

/**
 * Conversation roles that Sky Code includes in ordinary chat history.
 *
 * System messages are added separately by streamChatCompletion(), so stored
 * ChatMessage values represent only user and assistant conversation turns.
 */
export type ChatRole =
  | "user"
  | "assistant";

/**
 * One user or assistant message sent as part of model conversation history.
 */
export interface ChatMessage {
  /** Whether the message was produced by the user or the assistant. */
  role: ChatRole;
  /** Plain-text content supplied to the model for this conversation turn. */
  content: string;
}

/**
 * Minimal portion of an OpenAI-compatible model-list response used by this
 * module.
 *
 * Runtime validation is still performed because network JSON cannot be trusted
 * merely because this TypeScript interface describes the expected shape.
 */
interface ModelListResponse {
  /** Model records returned by the endpoint's /models API. */
  data: Array<{
    /** Identifier used when requesting this model. */
    id: string;
  }>;
}

/**
 * Removes one or more slash characters from the end of a URL string.
 *
 * This normalizes the configured API base before appending paths such as
 * /models or /chat/completions, preventing accidental double slashes.
 *
 * @param {string} value - URL or path text to normalize.
 * @returns {string} The same text without trailing slash characters.
 */
function removeTrailingSlashes(
  value: string,
): string {
  return value.replace(
    /\/+$/,
    "",
  );
}

/**
 * Extracts useful error text from an unsuccessful HTTP response.
 *
 * A non-empty response body is preferred because LiteLLM may return a more
 * specific explanation there. If the body is empty or cannot itself be read,
 * the function falls back to the HTTP status code and status text.
 *
 * @param {Response} response - Unsuccessful Fetch API response.
 * @returns {Promise<string>} Response body text when available, otherwise a
 * status-based fallback such as "500 Internal Server Error".
 *
 * Side effect: consumes the response body when it can be read.
 */
async function readErrorBody(
  response: Response,
): Promise<string> {
  try {
    const body =
      await response.text();

    if (body.trim() !== "") {
      return body;
    }
  } catch {
    // Ignore body-reading errors and use the HTTP status below.
  }

  return `${response.status} ${response.statusText}`.trim();
}

/**
 * Safely extracts assistant text from one parsed streaming response object.
 *
 * OpenAI-compatible streamed chat chunks store generated text at
 * choices[0].delta.content. Every level is checked at runtime because streamed
 * JSON originates outside the application and may be incomplete, malformed,
 * or contain events that do not carry textual content.
 *
 * @param {unknown} value - Parsed JSON value from one SSE data event.
 * @returns {string | null} The textual delta when the expected structure is
 * present, otherwise null.
 */
function extractStreamContent(
  value: unknown,
): string | null {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    return null;
  }

  const record =
    value as Record<
      string,
      unknown
    >;

  const choices =
    record.choices;

  if (
    !Array.isArray(choices) ||
    choices.length === 0
  ) {
    return null;
  }

  // Sky Code consumes the first choice only, matching the single-response
  // conversation behavior used by the CLI.
  const firstChoice =
    choices[0];

  if (
    typeof firstChoice !==
      "object" ||
    firstChoice === null ||
    Array.isArray(firstChoice)
  ) {
    return null;
  }

  const choiceRecord =
    firstChoice as Record<
      string,
      unknown
    >;

  const delta =
    choiceRecord.delta;

  if (
    typeof delta !== "object" ||
    delta === null ||
    Array.isArray(delta)
  ) {
    return null;
  }

  const deltaRecord =
    delta as Record<
      string,
      unknown
    >;

  const content =
    deltaRecord.content;

  return typeof content ===
    "string"
    ? content
    : null;
}

/**
 * Retrieves the model identifiers advertised by the configured LiteLLM or
 * OpenAI-compatible endpoint.
 *
 * Sends an authenticated GET request to /models, validates that the response
 * contains a data array, ignores malformed individual entries, and removes
 * duplicate model IDs while preserving their first-seen order.
 *
 * @param {AppConfig} config - Validated Sky Code API configuration containing
 * the endpoint URL and API key.
 * @returns {Promise<string[]>} Unique model identifiers returned by the
 * endpoint.
 * @throws {Error} If the HTTP request is unsuccessful or the response does not
 * contain the expected top-level object and data-array structure.
 * @throws {TypeError} If fetch itself fails, for example because the endpoint
 * cannot be reached.
 *
 * Side effect: performs an authenticated HTTP request to the configured API.
 */
export async function fetchAvailableModels(
  config: AppConfig,
): Promise<string[]> {
  const apiUrl =
    removeTrailingSlashes(
      config.apiUrl,
    );

  const response =
    await fetch(
      `${apiUrl}/models`,
      {
        method: "GET",
        headers: {
          Authorization:
            `Bearer ${config.apiKey}`,
          Accept:
            "application/json",
        },
      },
    );

  if (!response.ok) {
    // Prefer the endpoint's own error text when available so CLI diagnostics
    // contain more than the numeric HTTP status.
    const errorBody =
      await readErrorBody(
        response,
      );

    throw new Error(
      `Unable to retrieve LiteLLM models: HTTP ${response.status}: ${errorBody}`,
    );
  }

  // Treat network JSON as unknown until its structure has been checked.
  const payload: unknown =
    await response.json();

  if (
    typeof payload !==
      "object" ||
    payload === null ||
    Array.isArray(payload)
  ) {
    throw new Error(
      "LiteLLM returned an invalid model-list response",
    );
  }

  const modelList =
    payload as Partial<
      ModelListResponse
    >;

  if (
    !Array.isArray(
      modelList.data,
    )
  ) {
    throw new Error(
      'LiteLLM model-list response does not contain a "data" array',
    );
  }

  // Invalid individual records are ignored rather than making the entire
  // model list unusable when other entries still contain valid string IDs.
  const models =
    modelList.data
      .map((entry) => {
        if (
          typeof entry ===
            "object" &&
          entry !== null &&
          !Array.isArray(
            entry,
          ) &&
          typeof (
            entry as Record<
              string,
              unknown
            >
          ).id === "string"
        ) {
          return (
            entry as Record<
              string,
              unknown
            >
          ).id as string;
        }

        return null;
      })
      .filter(
        (
          model,
        ): model is string =>
          model !== null,
      );

  // Set removes duplicate IDs while retaining insertion order.
  return [
    ...new Set(models),
  ];
}

/**
 * Sends a streamed chat-completion request and incrementally delivers generated
 * assistant text to the supplied callback.
 *
 * The request uses the configured model, prepends one system message to the
 * provided conversation history, and asks the endpoint for an SSE stream.
 * Incoming byte chunks are decoded incrementally because UTF-8 characters and
 * SSE lines may be divided across arbitrary network chunks.
 *
 * Each complete SSE `data:` line is parsed as JSON. Text found at
 * choices[0].delta.content is appended to the accumulated response and passed
 * immediately to onContent(). Comment lines, blank lines, unrelated SSE
 * fields, and valid chunks without text are ignored. `[DONE]` marks normal
 * stream completion.
 *
 * @param {AppConfig} config - Validated API configuration containing endpoint
 * and credentials.
 * @param {string} model - Model identifier to request.
 * @param {ChatMessage[]} messages - Existing user/assistant conversation
 * history. The system prompt is added separately ahead of these messages.
 * @param {(content: string) => void} onContent - Callback invoked synchronously
 * for every non-empty generated text fragment received from the stream.
 * @param {string} systemPrompt - System instruction placed at the beginning of
 * the request. Defaults to SKY_CODE_SYSTEM_PROMPT.
 * @param {"json_object"} [responseFormat] - When supplied, requests the
 * endpoint's JSON-mode/constrained-decoding feature via `response_format`.
 * Added for PromptedStrategy's tool-selection calls (see
 * agent/adapters/litellm-client.ts); omitted by every existing caller, so
 * this has no effect unless a caller opts in.
 * @param {AbortSignal} [signal] - Aborts the request (and stops reading the
 * stream) when the user cancels the turn; see agent/cancellation.ts.
 * @returns {Promise<string>} Complete assistant text assembled from every
 * streamed content fragment.
 * @throws {Error} If the HTTP response is unsuccessful, has no stream body, or
 * contains an SSE data event with invalid JSON.
 * @throws {TypeError} If the network request or response-stream reading fails.
 *
 * Side effects: performs an authenticated HTTP request and invokes onContent()
 * repeatedly while response text is arriving.
 */
export async function streamChatCompletion(
  config: AppConfig,
  model: string,
  messages: ChatMessage[],
  onContent:
    (content: string) => void,
  systemPrompt: string =
    SKY_CODE_SYSTEM_PROMPT,
  responseFormat?: "json_object",
  signal?: AbortSignal,
): Promise<string> {
  const apiUrl =
    removeTrailingSlashes(
      config.apiUrl,
    );

  const response =
    await fetch(
      `${apiUrl}/chat/completions`,
      {
        method: "POST",
        headers: {
          Authorization:
            `Bearer ${config.apiKey}`,
          "Content-Type":
            "application/json",
          Accept:
            "text/event-stream",
        },
        signal,
        body: JSON.stringify({
          model,
          stream: true,
          messages: [
            {
              role: "system",
              content:
                systemPrompt,
            },
            ...messages,
          ],
          ...(responseFormat
            ? {
                response_format: {
                  type: responseFormat,
                },
              }
            : {}),
        }),
      },
    );

  if (!response.ok) {
    const errorBody =
      await readErrorBody(
        response,
      );

    throw new Error(
      `LiteLLM chat request failed: HTTP ${response.status}: ${errorBody}`,
    );
  }

  if (!response.body) {
    throw new Error(
      "LiteLLM returned a streaming response without a body",
    );
  }

  const reader =
    response.body.getReader();

  // TextDecoder is kept across reads so a multibyte UTF-8 character divided
  // between network chunks can be reconstructed correctly.
  const decoder =
    new TextDecoder();

  // buffer retains an incomplete final SSE line between reader.read() calls.
  let buffer = "";
  let fullResponse = "";
  let streamFinished = false;

  /**
   * Processes one complete line from the Server-Sent Events response.
   *
   * Only SSE `data:` fields are relevant. Blank lines, comment/keepalive lines
   * beginning with ":", and other SSE fields are ignored. `[DONE]` marks the
   * end of generation; all other data values are parsed as JSON and inspected
   * for assistant delta content.
   *
   * @param {string} line - One complete decoded SSE line.
   * @returns {void} This function does not return a value.
   * @throws {Error} If a data event that should contain JSON cannot be parsed.
   *
   * Side effects: may mark the stream complete, append to fullResponse, and
   * invoke the caller-provided onContent callback.
   */
  function processLine(
    line: string,
  ): void {
    const trimmedLine =
      line.trim();

    // SSE uses blank lines as event separators and ":" lines for comments or
    // keepalives. Neither contributes assistant content.
    if (
      trimmedLine === "" ||
      trimmedLine.startsWith(
        ":",
      ) ||
      !trimmedLine.startsWith(
        "data:",
      )
    ) {
      return;
    }

    const data =
      trimmedLine
        .slice(
          "data:".length,
        )
        .trim();

    // OpenAI-compatible streaming uses this sentinel instead of JSON to signal
    // that no further generated content should be processed.
    if (data === "[DONE]") {
      streamFinished = true;
      return;
    }

    let parsed: unknown;

    try {
      parsed =
        JSON.parse(data);
    } catch (error) {
      throw new Error(
        `LiteLLM returned invalid streaming JSON: ${
          error instanceof Error
            ? error.message
            : String(error)
        }`,
      );
    }

    const content =
      extractStreamContent(
        parsed,
      );

    // Streaming events may legitimately contain metadata or empty deltas, so
    // only actual non-empty textual content is accumulated and exposed.
    if (
      content !== null &&
      content !== ""
    ) {
      fullResponse +=
        content;

      onContent(content);
    }
  }

  while (!streamFinished) {
    const {
      done,
      value,
    } = await reader.read();

    if (done) {
      break;
    }

    // `stream: true` tells TextDecoder to retain any incomplete multibyte
    // character for completion by the next byte chunk.
    buffer +=
      decoder.decode(
        value,
        {
          stream: true,
        },
      );

    // Network chunks need not align with SSE line boundaries. Process all
    // complete lines now and retain the last partial line in buffer.
    const lines =
      buffer.split(
        /\r?\n/,
      );

    buffer =
      lines.pop() ?? "";

    for (
      const line of lines
    ) {
      processLine(line);

      if (streamFinished) {
        break;
      }
    }
  }

  // Flush any bytes still held internally by TextDecoder after the byte stream
  // ends.
  buffer += decoder.decode();

  // A server can close the body without sending a final newline or [DONE].
  // Process that last buffered line rather than silently dropping its content.
  if (
    !streamFinished &&
    buffer.trim() !== ""
  ) {
    processLine(buffer);
  }

  return fullResponse;
}

/**
 * One OpenAI-compatible "function" tool definition sent to the endpoint's
 * native tool-calling API.
 *
 * Kept separate from agent/types.ts's ToolDefinition, which is Sky Code's
 * own canonical, provider-agnostic shape: this type is the wire format a
 * native tool-calling request actually sends, and agent/adapters translates
 * between the two (see buildChatToolDefinition() there).
 */
export interface ChatToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/**
 * One tool call as returned by the endpoint's native tool-calling API,
 * matching the OpenAI-compatible response shape exactly (arguments arrive
 * as a raw, possibly malformed JSON string; this module makes no attempt to
 * parse or validate it, since that is agent/strategies/native.ts's job).
 */
export interface ChatToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

/**
 * One message in a native tool-calling conversation.
 *
 * Kept separate from ChatMessage/ChatRole (used by streamChatCompletion)
 * rather than extending them, so the existing plain conversation path used
 * by every current caller is completely untouched by native tool-calling
 * support.
 */
export type NativeChatMessage =
  | {
      role: "user";
      content: string;
    }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: ChatToolCall[];
    }
  | {
      role: "tool";
      tool_call_id: string;
      content: string;
    };

/**
 * Result of one native tool-calling completion request.
 */
export interface NativeChatCompletionResult {
  content: string | null;
  toolCalls: ChatToolCall[];
  /**
   * Reasons this response is unusable as-is, found while assembling a
   * streamed response (see NativeToolCallStreamAssembler,
   * native-tool-stream.ts). Absent or empty for a usable response, and
   * always absent for the non-streaming path, whose response arrives whole.
   * A caller must never execute any of `toolCalls` when this is non-empty.
   */
  protocolIssues?: string[];
  /**
   * Non-fatal irregularities corrected locally while assembling a streamed
   * response (for example, a synthesized call ID), for diagnostics only.
   */
  protocolNotes?: string[];
}

/**
 * Extracts a NativeChatCompletionResult from one parsed chat-completion
 * response body.
 *
 * Network JSON is treated as untrusted at every level, matching
 * extractStreamContent()'s defensive style above. An individual malformed
 * tool_calls entry is skipped rather than making the whole response
 * unusable, matching fetchAvailableModels()'s handling of individual
 * malformed model-list entries.
 *
 * @param {unknown} value - Parsed JSON body of a non-streaming
 * chat-completion response.
 * @returns {NativeChatCompletionResult} The extracted content and tool
 * calls.
 * @throws {Error} If the response does not contain the expected top-level
 * choices/message structure.
 */
function extractNativeCompletionResult(
  value: unknown,
): NativeChatCompletionResult {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new Error(
      "LiteLLM returned an invalid chat-completion response",
    );
  }

  const record =
    value as Record<
      string,
      unknown
    >;

  const choices =
    record.choices;

  if (
    !Array.isArray(choices) ||
    choices.length === 0
  ) {
    throw new Error(
      "LiteLLM chat-completion response did not contain any choices",
    );
  }

  // Sky Code consumes the first choice only, matching
  // extractStreamContent()'s single-response behavior.
  const firstChoice =
    choices[0];

  if (
    typeof firstChoice !==
      "object" ||
    firstChoice === null ||
    Array.isArray(firstChoice)
  ) {
    throw new Error(
      "LiteLLM chat-completion response contained an invalid choice",
    );
  }

  const choiceRecord =
    firstChoice as Record<
      string,
      unknown
    >;

  const message =
    choiceRecord.message;

  if (
    typeof message !== "object" ||
    message === null ||
    Array.isArray(message)
  ) {
    throw new Error(
      "LiteLLM chat-completion response did not contain a message",
    );
  }

  const messageRecord =
    message as Record<
      string,
      unknown
    >;

  const content =
    typeof messageRecord.content ===
      "string"
      ? messageRecord.content
      : null;

  const rawToolCalls =
    messageRecord.tool_calls;

  const toolCalls: ChatToolCall[] = [];

  if (Array.isArray(rawToolCalls)) {
    for (
      const rawCall of
      rawToolCalls
    ) {
      if (
        typeof rawCall !==
          "object" ||
        rawCall === null ||
        Array.isArray(rawCall)
      ) {
        continue;
      }

      const callRecord =
        rawCall as Record<
          string,
          unknown
        >;

      const id =
        callRecord.id;

      const fn =
        callRecord.function;

      if (
        typeof id !== "string" ||
        typeof fn !== "object" ||
        fn === null ||
        Array.isArray(fn)
      ) {
        continue;
      }

      const fnRecord =
        fn as Record<
          string,
          unknown
        >;

      const name =
        fnRecord.name;

      const args =
        fnRecord.arguments;

      if (
        typeof name !== "string" ||
        typeof args !== "string"
      ) {
        continue;
      }

      toolCalls.push({
        id,
        type: "function",
        function: {
          name,
          arguments: args,
        },
      });
    }
  }

  return {
    content,
    toolCalls,
  };
}

/**
 * An unsuccessful HTTP response to a native tool-calling request.
 *
 * Carries the real status code and response body as fields, so a caller can
 * tell a provider that rejects native tool calling apart from every other
 * failure (authentication, rate limiting, a server error) without parsing
 * the message (see isNativeToolsUnsupportedError(),
 * agent/native-support.ts). The message is exactly the one these requests
 * have always thrown, so anything that displays or matches it is
 * unchanged.
 */
export class NativeRequestHttpError extends Error {
  /** HTTP status code of the failed response. */
  readonly status: number;

  /** Response body text (or "status statusText" when the body was empty). */
  readonly body: string;

  /**
   * @param {number} status - HTTP status code.
   * @param {string} body - Response body text, as read by readErrorBody().
   */
  constructor(
    status: number,
    body: string,
  ) {
    super(
      `LiteLLM native tool-calling request failed: HTTP ${status}: ${body}`,
    );

    this.name =
      "NativeRequestHttpError";
    this.status = status;
    this.body = body;
  }
}

/*
 * Why native requests send neither `tool_choice` nor `parallel_tool_calls`
 * (applies to requestNativeToolCompletion() and streamNativeToolCompletion()
 * alike, kept here so the rationale has one home):
 *
 * - `parallel_tool_calls` is not supported by every backend behind the
 *   LiteLLM gateway. LiteLLM's `ollama_chat` backend (serving
 *   gemma4-e4b-sky) rejects it with HTTP 400 UnsupportedParamsError before
 *   the model ever runs, observed in Sky Code's first live native
 *   acceptance test. Sky Code does not depend on it anyway: NativeStrategy
 *   enforces one action per step itself, executing nothing from a response
 *   with more than one call and asking the model again (see
 *   agent/strategies/native.ts). NativeCompletionRequest.parallelToolCalls
 *   still records that intent inside Sky Code; it is simply not put on the
 *   wire, so a provider-specific override could send it later if one ever
 *   demonstrably needs it.
 * - `tool_choice: "auto"` is already the default whenever `tools` is
 *   supplied, so sending it changes nothing while adding one more field a
 *   backend could reject.
 *
 * This matches the request shape AnythingLLM's native agent path uses
 * successfully through the same gateway with the same models.
 */

/**
 * Sends one non-streaming chat-completion request using the endpoint's
 * native tool-calling protocol (OpenAI-compatible `tools`) and returns the
 * model's chosen tool call(s), if any, plus any plain text content.
 *
 * The request carries only `model`, `stream`, `messages`, and `tools`.
 * `tool_choice` and `parallel_tool_calls` are deliberately not sent (see the
 * note directly above this function for why).
 *
 * Deliberately non-streaming, unlike streamChatCompletion(): reassembling
 * tool-call argument fragments that can arrive split across streamed
 * deltas, matched by index, is a real source of provider bugs (see two
 * open LiteLLM issues found during this architecture's design: #39796,
 * dropped tool_calls[].id/function.name on a full single-delta tool call,
 * and #17246, missing tool_calls emission entirely for some backends). A
 * single complete JSON response avoids that class of failure entirely.
 * NativeStrategy (agent/strategies/native.ts) does not need streaming here:
 * the eventual user-facing prose answer still streams normally, through
 * streamChatCompletion(), once a turn reaches a final answer.
 *
 * @param {AppConfig} config - Validated API configuration containing
 * endpoint and credentials.
 * @param {string} model - Model identifier to request.
 * @param {string} systemPrompt - System instruction placed at the beginning
 * of the request.
 * @param {NativeChatMessage[]} messages - Conversation turns, including any
 * prior assistant tool-call records and "tool" result turns.
 * @param {ChatToolDefinition[]} tools - Native tool definitions offered to
 * the model.
 * @param {AbortSignal} [signal] - Aborts the request when the user cancels
 * the turn; see agent/cancellation.ts.
 * @returns {Promise<NativeChatCompletionResult>} The model's response,
 * unvalidated beyond basic structural shape (see NativeStrategy for
 * argument/compliance validation).
 * @throws {NativeRequestHttpError} If the HTTP response is unsuccessful.
 * @throws {Error} If the response does not contain the expected top-level
 * choices/message structure.
 * @throws {TypeError} If the network request itself fails.
 *
 * Side effect: performs an authenticated HTTP request.
 */
export async function requestNativeToolCompletion(
  config: AppConfig,
  model: string,
  systemPrompt: string,
  messages: NativeChatMessage[],
  tools: ChatToolDefinition[],
  signal?: AbortSignal,
): Promise<NativeChatCompletionResult> {
  const apiUrl =
    removeTrailingSlashes(
      config.apiUrl,
    );

  const response =
    await fetch(
      `${apiUrl}/chat/completions`,
      {
        method: "POST",
        headers: {
          Authorization:
            `Bearer ${config.apiKey}`,
          "Content-Type":
            "application/json",
          Accept:
            "application/json",
        },
        signal,
        body: JSON.stringify({
          model,
          stream: false,
          messages: [
            {
              role: "system",
              content:
                systemPrompt,
            },
            ...messages,
          ],
          tools,
        }),
      },
    );

  if (!response.ok) {
    const errorBody =
      await readErrorBody(
        response,
      );

    throw new NativeRequestHttpError(
      response.status,
      errorBody,
    );
  }

  const payload: unknown =
    await response.json();

  return extractNativeCompletionResult(
    payload,
  );
}

/**
 * Sends one streamed chat-completion request using the endpoint's native
 * tool-calling protocol and assembles the result once the stream ends.
 *
 * Sends the same request body as requestNativeToolCompletion() (`model`,
 * `messages`, `tools`; no `tool_choice` or `parallel_tool_calls`, see the note
 * above requestNativeToolCompletion()) with `stream: true`. Every
 * SSE `data:` chunk is handed to a NativeToolCallStreamAssembler
 * (native-tool-stream.ts), which accumulates content and
 * `delta.tool_calls` fragments by index. Nothing is returned, and so nothing
 * can be executed, until the whole stream has been consumed and every call
 * fully assembled; argument JSON is never parsed here (NativeStrategy does
 * that after assembly).
 *
 * Kept alongside, not instead of, requestNativeToolCompletion(): the
 * non-streaming request stays available as a per-model fallback (see
 * NATIVE_TRANSPORT_CONFIG, agent/strategy-selection.ts) until streamed
 * assembly has been proven against each model.
 *
 * Streamed text content is accumulated, not displayed: a native response's
 * text is only shown after NativeStrategy has checked it is a genuine final
 * answer (see final-answer-safety.ts), so it can never be shown before that
 * check.
 *
 * @param {AppConfig} config - Validated API configuration containing
 * endpoint and credentials.
 * @param {string} model - Model identifier to request.
 * @param {string} systemPrompt - System instruction placed at the beginning
 * of the request.
 * @param {NativeChatMessage[]} messages - Conversation turns, including any
 * prior assistant tool-call records and "tool" result turns.
 * @param {ChatToolDefinition[]} tools - Native tool definitions offered to
 * the model.
 * @param {NativeToolCallStreamAssemblerOptions} [assemblerOptions] -
 * Optional assembler dependencies (tests inject a deterministic ID
 * generator).
 * @param {AbortSignal} [signal] - Aborts the request (and stops reading the
 * stream) when the user cancels the turn; see agent/cancellation.ts.
 * @returns {Promise<NativeChatCompletionResult>} The assembled response,
 * including any protocol issues/notes found during assembly.
 * @throws {NativeRequestHttpError} If the HTTP response is unsuccessful.
 * @throws {Error} If the response has no body or contains an SSE data event
 * that is not valid JSON.
 * @throws {TypeError} If the network request or stream reading fails.
 *
 * Side effect: performs an authenticated HTTP request.
 */
export async function streamNativeToolCompletion(
  config: AppConfig,
  model: string,
  systemPrompt: string,
  messages: NativeChatMessage[],
  tools: ChatToolDefinition[],
  assemblerOptions?: NativeToolCallStreamAssemblerOptions,
  signal?: AbortSignal,
): Promise<NativeChatCompletionResult> {
  const apiUrl =
    removeTrailingSlashes(
      config.apiUrl,
    );

  const response =
    await fetch(
      `${apiUrl}/chat/completions`,
      {
        method: "POST",
        headers: {
          Authorization:
            `Bearer ${config.apiKey}`,
          "Content-Type":
            "application/json",
          Accept:
            "text/event-stream",
        },
        signal,
        body: JSON.stringify({
          model,
          stream: true,
          messages: [
            {
              role: "system",
              content:
                systemPrompt,
            },
            ...messages,
          ],
          tools,
        }),
      },
    );

  if (!response.ok) {
    const errorBody =
      await readErrorBody(
        response,
      );

    throw new NativeRequestHttpError(
      response.status,
      errorBody,
    );
  }

  if (!response.body) {
    throw new Error(
      "LiteLLM returned a streaming native tool-calling response without a body",
    );
  }

  const assembler =
    new NativeToolCallStreamAssembler(
      assemblerOptions,
    );

  const reader =
    response.body.getReader();

  // Same incremental decoding approach as streamChatCompletion(): network
  // chunks need not align with UTF-8 characters or SSE line boundaries.
  const decoder =
    new TextDecoder();

  let buffer = "";
  let streamFinished = false;

  const processLine = (
    line: string,
  ): void => {
    const trimmedLine =
      line.trim();

    if (
      trimmedLine === "" ||
      !trimmedLine.startsWith(
        "data:",
      )
    ) {
      return;
    }

    const data =
      trimmedLine
        .slice(
          "data:".length,
        )
        .trim();

    if (data === "[DONE]") {
      streamFinished = true;
      return;
    }

    let parsed: unknown;

    try {
      parsed =
        JSON.parse(data);
    } catch (error) {
      throw new Error(
        `LiteLLM returned invalid streaming JSON: ${
          error instanceof Error
            ? error.message
            : String(error)
        }`,
      );
    }

    assembler.push(
      parsed,
    );
  };

  while (!streamFinished) {
    const {
      done,
      value,
    } = await reader.read();

    if (done) {
      break;
    }

    buffer +=
      decoder.decode(
        value,
        {
          stream: true,
        },
      );

    const lines =
      buffer.split(
        /\r?\n/,
      );

    buffer =
      lines.pop() ?? "";

    for (
      const line of lines
    ) {
      processLine(line);

      if (streamFinished) {
        break;
      }
    }
  }

  buffer += decoder.decode();

  if (
    !streamFinished &&
    buffer.trim() !== ""
  ) {
    processLine(buffer);
  }

  const assembled =
    assembler.finish();

  return {
    content:
      assembled.content,
    toolCalls:
      assembled.toolCalls,
    protocolIssues:
      assembled.protocolIssues,
    protocolNotes:
      assembled.protocolNotes,
  };
}
