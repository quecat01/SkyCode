/**
 * Content-free diagnostics for native tool-calling requests and responses.
 *
 * When a native response turns out unusable (for example, "neither a tool
 * call nor any text"), the session log must show whether the provider
 * really sent nothing or Sky Code lost something on the way. This module
 * builds one short summary line per request and per response from the wire
 * data chat.ts already has, so the two cases can be told apart afterwards:
 * - a request summary: the role sequence with call IDs, each tool result's
 *   recorded status and size, whether every assistant tool call is answered
 *   exactly once by a role:"tool" message, and the total body size;
 * - a response summary: the finish reason, how many stream chunks arrived
 *   (and how many had no choices), how much text, reasoning text and
 *   tool-call data they carried, any error the gateway sent inside the
 *   stream, token usage when the provider reports it, and whether the
 *   stream's end marker arrived.
 *
 * Only counts, sizes, statuses, call IDs, tool names, and finish reasons are
 * recorded: never message text, tool arguments, tool output, reasoning
 * text, the system prompt, the endpoint, or credentials. The one free-text
 * field, a gateway error message, is truncated and has key-like values
 * masked (redactSecrets()).
 *
 * Wire-level and pure: no network access and no dependency on agent/ code.
 * Nothing here changes how a response is classified or handled.
 */

/** Longest gateway error message kept in a summary, in characters. */
const MAX_ERROR_MESSAGE_LENGTH = 300;

/** Longest role sequence kept in a request summary, in characters. */
const MAX_ROLE_SEQUENCE_LENGTH = 2000;

/**
 * The fields of one outgoing native message that a request summary reads.
 */
export interface SummarizableNativeMessage {
  role: string;
  content?: string | null;
  tool_call_id?: string;
  tool_calls?: {
    id: string;
    function: {
      name: string;
    };
  }[];
}

/**
 * Content-free facts about one native response, collected while it is read.
 */
export interface NativeResponseStats {
  transport:
    | "streaming"
    | "non_streaming";
  finishReason: string | null;
  /** Parsed stream data events (streaming only). */
  chunks?: number;
  /** Stream data events with no choices, e.g. an error or usage chunk. */
  choicelessChunks?: number;
  contentChars: number;
  /** Characters of reasoning text, which Sky Code does not otherwise use. */
  reasoningChars: number;
  /** Tool-call fragments (streaming) or complete tool calls (non-streaming). */
  toolCallParts: number;
  /** Error messages the gateway sent inside the response, already redacted. */
  errors: string[];
  promptTokens?: number;
  completionTokens?: number;
  /** Whether the stream's [DONE] marker arrived (streaming only). */
  doneMarker?: boolean;
}

/**
 * Masks values that look like credentials in a gateway error message.
 *
 * @param {string} text - Raw message text.
 * @returns {string} The text with bearer tokens, sk- style keys, and
 * key/token/password assignments masked.
 *
 * Side effects: none.
 */
export function redactSecrets(
  text: string,
): string {
  return text
    .replace(
      /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
      "Bearer [redacted]",
    )
    .replace(
      /\b(api[_-]?key|token|password|secret)(["']?\s*[:=]\s*["']?)[^\s"',;)}\]]+/gi,
      "$1$2[redacted]",
    )
    .replace(
      /\bsk-[A-Za-z0-9_-]{4,}/g,
      "sk-[redacted]",
    );
}

/**
 * Extracts a gateway error message from one parsed response or stream
 * chunk, if it carries one (`{"error": {"message": ...}}` or
 * `{"error": "..."}`).
 *
 * @param {Record<string, unknown>} record - A parsed chunk or body.
 * @returns {string | undefined} The redacted, truncated message, or
 * undefined when there is no error field.
 *
 * Side effects: none.
 */
export function extractGatewayError(
  record: Record<string, unknown>,
): string | undefined {
  const error =
    record.error;

  if (
    error === undefined ||
    error === null
  ) {
    return undefined;
  }

  const raw =
    typeof error === "string"
      ? error
      : typeof error === "object" &&
          typeof (
            error as Record<string, unknown>
          ).message === "string"
        ? String(
            (
              error as Record<string, unknown>
            ).message,
          )
        : JSON.stringify(error);

  const redacted =
    redactSecrets(
      raw,
    );

  return redacted.length >
    MAX_ERROR_MESSAGE_LENGTH
    ? `${redacted.slice(0, MAX_ERROR_MESSAGE_LENGTH)}...`
    : redacted;
}

/**
 * Counts the characters of reasoning text in one message or stream delta.
 * Providers use different field names for it; all known ones are counted.
 *
 * @param {Record<string, unknown>} record - A message or delta object.
 * @returns {number} Total reasoning characters (0 when there is none).
 *
 * Side effects: none.
 */
export function countReasoningChars(
  record: Record<string, unknown>,
): number {
  return [
    "reasoning_content",
    "reasoning",
    "thinking",
  ].reduce(
    (total, field) =>
      total +
      (typeof record[field] === "string"
        ? (record[field] as string).length
        : 0),
    0,
  );
}

/**
 * Reads token usage from one parsed response or stream chunk, if present.
 *
 * @param {Record<string, unknown>} record - A parsed chunk or body.
 * @returns {{promptTokens?: number, completionTokens?: number}} The
 * reported counts, each only when it is a number.
 *
 * Side effects: none.
 */
export function readUsage(
  record: Record<string, unknown>,
): {
  promptTokens?: number;
  completionTokens?: number;
} {
  const usage =
    record.usage;

  if (
    typeof usage !== "object" ||
    usage === null
  ) {
    return {};
  }

  const fields =
    usage as Record<string, unknown>;

  return {
    ...(typeof fields.prompt_tokens ===
    "number"
      ? {
          promptTokens:
            fields.prompt_tokens,
        }
      : {}),
    ...(typeof fields.completion_tokens ===
    "number"
      ? {
          completionTokens:
            fields.completion_tokens,
        }
      : {}),
  };
}

/**
 * Reads the recorded status from a role:"tool" message's JSON envelope (see
 * describeToolResultForNative(), agent/history-rendering.ts).
 *
 * @param {string | null | undefined} content - The tool message content.
 * @returns {string} The envelope's status, or "unparsed".
 */
function toolMessageStatus(
  content: string | null | undefined,
): string {
  try {
    const parsed: unknown =
      JSON.parse(
        content ?? "",
      );

    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (
        parsed as Record<string, unknown>
      ).status === "string"
    ) {
      return String(
        (
          parsed as Record<string, unknown>
        ).status,
      );
    }
  } catch {
    // Not an envelope; reported as such below.
  }

  return "unparsed";
}

/**
 * Checks that every assistant tool call is answered exactly once by a
 * role:"tool" message before the next non-tool message, and that every
 * tool message answers a call that was made.
 *
 * @param {readonly SummarizableNativeMessage[]} messages - Outgoing
 * messages, in order.
 * @returns {string[]} Problems found; empty when the history is canonical.
 */
function findPairingProblems(
  messages: readonly SummarizableNativeMessage[],
): string[] {
  const problems: string[] = [];
  let open: string[] = [];

  const closeOpen = (): void => {
    for (
      const id of open
    ) {
      problems.push(
        `call ${id} has no tool result`,
      );
    }

    open = [];
  };

  for (
    const message of messages
  ) {
    if (message.role === "tool") {
      const id =
        message.tool_call_id ?? "";

      const position =
        open.indexOf(
          id,
        );

      if (position === -1) {
        problems.push(
          `tool result ${id || "(no id)"} answers no open call`,
        );
      } else {
        open.splice(
          position,
          1,
        );
      }

      continue;
    }

    closeOpen();

    if (
      message.role === "assistant" &&
      message.tool_calls
    ) {
      open =
        message.tool_calls.map(
          (call) => call.id,
        );
    }
  }

  closeOpen();

  return problems;
}

/**
 * Builds the one-line, content-free summary of an outgoing native request.
 *
 * @param {readonly SummarizableNativeMessage[]} messages - Every message
 * sent, including the system message.
 * @param {number} toolCount - Number of tool definitions offered.
 * @param {number} bodyChars - Length of the serialized request body.
 * @returns {string} e.g. `request: 4 messages [system, user,
 * assistant(call_1 create_docx), tool(call_1 failed 812 chars)]; pairing
 * ok; 9 tools; body 18234 chars`.
 *
 * Side effects: none.
 */
export function summarizeNativeRequest(
  messages: readonly SummarizableNativeMessage[],
  toolCount: number,
  bodyChars: number,
): string {
  const roles =
    messages
      .map(
        (message) => {
          if (
            message.role === "assistant" &&
            message.tool_calls &&
            message.tool_calls.length > 0
          ) {
            return `assistant(${message.tool_calls
              .map(
                (call) =>
                  `${call.id} ${call.function.name}`,
              )
              .join(", ")})`;
          }

          if (message.role === "tool") {
            return `tool(${message.tool_call_id ?? "(no id)"} ${toolMessageStatus(message.content)} ${(message.content ?? "").length} chars)`;
          }

          return message.role;
        },
      )
      .join(", ");

  const problems =
    findPairingProblems(
      messages,
    );

  return [
    `request: ${messages.length} messages [${
      roles.length >
      MAX_ROLE_SEQUENCE_LENGTH
        ? `${roles.slice(0, MAX_ROLE_SEQUENCE_LENGTH)}...`
        : roles
    }]`,
    problems.length === 0
      ? "pairing ok"
      : `pairing problems: ${problems.join("; ")}`,
    `${toolCount} tools`,
    `body ${bodyChars} chars`,
  ].join("; ");
}

/**
 * Builds the one-line, content-free summary of one native response.
 *
 * @param {NativeResponseStats} stats - Facts collected while reading it.
 * @returns {string} e.g. `response (streaming): finish_reason=stop;
 * chunks=3; choiceless_chunks=0; content_chars=0; reasoning_chars=0;
 * tool_call_parts=0; errors=0; done=true`.
 *
 * Side effects: none.
 */
export function summarizeNativeResponse(
  stats: NativeResponseStats,
): string {
  const parts = [
    `finish_reason=${stats.finishReason ?? "none"}`,
    ...(stats.chunks !== undefined
      ? [
          `chunks=${stats.chunks}`,
        ]
      : []),
    ...(stats.choicelessChunks !== undefined
      ? [
          `choiceless_chunks=${stats.choicelessChunks}`,
        ]
      : []),
    `content_chars=${stats.contentChars}`,
    `reasoning_chars=${stats.reasoningChars}`,
    `tool_call_parts=${stats.toolCallParts}`,
    `errors=${stats.errors.length}`,
    ...(stats.promptTokens !== undefined
      ? [
          `prompt_tokens=${stats.promptTokens}`,
        ]
      : []),
    ...(stats.completionTokens !== undefined
      ? [
          `completion_tokens=${stats.completionTokens}`,
        ]
      : []),
    ...(stats.doneMarker !== undefined
      ? [
          `done=${stats.doneMarker}`,
        ]
      : []),
    ...stats.errors.map(
      (message) =>
        `error="${message}"`,
    ),
  ];

  return `response (${stats.transport}): ${parts.join("; ")}`;
}
