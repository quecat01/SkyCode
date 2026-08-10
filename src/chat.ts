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
