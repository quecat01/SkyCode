/**
 * Conversation-context compaction primitives for Sky Code.
 *
 * Supports summarise and sliding-window compaction strategies, approximate
 * token estimation, stale tool-output reduction, and PreCompact/PostCompact
 * lifecycle hooks.
 *
 * Compaction mutates the supplied message array in place. Before mutation, the
 * original conversation is cloned so it can be restored if a PostCompact hook
 * fails.
 */
import type {
  ChatMessage,
} from "./chat.js";

import type {
  CompactionStrategy,
} from "./config.js";

import {
  HookRegistry,
  type HookMetadata,
} from "./hooks.js";

/**
 * Default number of newest conversation messages preserved verbatim during
 * compaction.
 */
export const DEFAULT_RECENT_MESSAGE_COUNT =
  20;

/**
 * Heuristic character-to-token ratio used for lightweight context estimates.
 *
 * This intentionally avoids model-specific tokenizers; it is an approximation
 * for compaction decisions and reporting rather than billing-grade accounting.
 */
export const APPROXIMATE_CHARACTERS_PER_TOKEN =
  4;

/**
 * Reason context compaction was initiated.
 *
 * `manual` is explicitly requested, while `token-pressure` indicates automatic
 * compaction caused by conversation growth.
 */
export type CompactionReason =
  | "manual"
  | "token-pressure";

/**
 * Function capable of summarizing older conversation messages.
 *
 * @param {readonly ChatMessage[]} messages - Older messages selected for
 * summarization.
 * @returns {Promise<string>} Generated summary text.
 */
export type ConversationSummarizer = (
  messages:
    readonly ChatMessage[],
) => Promise<string>;

/**
 * Controls one compactConversation() operation.
 *
 * strategy defaults to `summarise`. summarize is required only for that
 * strategy. keepRecentMessages defaults to DEFAULT_RECENT_MESSAGE_COUNT.
 * hookRegistry receives lifecycle events before and after successful mutation.
 */
export interface CompactConversationOptions {
  reason:
    CompactionReason;

  strategy?:
    CompactionStrategy;

  summarize?:
    ConversationSummarizer;

  hookRegistry:
    HookRegistry;

  keepRecentMessages?:
    number;
}

/**
 * Outcome and statistics for one attempted conversation compaction.
 *
 * compacted is false when there are too few older messages to compact.
 * Optional summary and post-compaction token fields describe data produced only
 * when the corresponding operation occurs.
 */
export interface CompactionResult {
  compacted:
    boolean;

  reason:
    CompactionReason;

  strategy?:
    CompactionStrategy;

  beforeMessageCount:
    number;

  afterMessageCount:
    number;

  compactedTurnCount?:
    number;

  estimatedTokensBefore:
    number;

  estimatedTokensAfter?:
    number;

  estimatedTokenReduction?:
    number;

  droppedToolOutputCount:
    number;

  summary?:
    string;
}

/**
 * Validates the number of recent messages that must remain untouched.
 *
 * @param {number} value - Candidate recent-message count.
 * @returns {number} Validated positive safe integer.
 * @throws {Error} If value is not a positive whole safe integer.
 */
function validateRecentMessageCount(
  value:
    number,
): number {
  if (
    !Number.isSafeInteger(
      value,
    ) ||
    value < 1
  ) {
    throw new Error(
      "keepRecentMessages must be a positive whole number",
    );
  }

  return value;
}

/**
 * Validates a configured compaction strategy at runtime.
 *
 * @param {CompactionStrategy} value - Candidate compaction strategy.
 * @returns {CompactionStrategy} The validated strategy.
 * @throws {Error} Unless value is `summarise` or `sliding-window`.
 */
function validateStrategy(
  value:
    CompactionStrategy,
): CompactionStrategy {
  if (
    value !==
      "summarise" &&
    value !==
      "sliding-window"
  ) {
    throw new Error(
      'compactionStrategy must be either "summarise" or "sliding-window"',
    );
  }

  return value;
}

/**
 * Creates shallow value copies of conversation messages.
 *
 * ChatMessage currently contains scalar role/content fields, so copying those
 * fields is sufficient to isolate the backup and recent-message arrays from
 * later splice operations.
 *
 * @param {readonly ChatMessage[]} messages - Messages to copy.
 * @returns {ChatMessage[]} Independent message objects in the same order.
 */
function cloneMessages(
  messages:
    readonly ChatMessage[],
): ChatMessage[] {
  return messages.map(
    (
      message,
    ) => ({
      role:
        message.role,

      content:
        message.content,
    }),
  );
}

/**
 * Identifies persisted Sky Code tool-result messages that can be shortened
 * during summarization.
 *
 * Tool results are represented as user-role messages beginning with the
 * standard `Sky Code tool result for ` prefix.
 *
 * @param {ChatMessage} message - Conversation message to inspect.
 * @returns {boolean} True when the message is a Sky Code tool result.
 */
export function isStaleToolResultMessage(
  message:
    ChatMessage,
): boolean {
  return (
    message.role ===
      "user" &&
    message.content
      .trimStart()
      .startsWith(
        "Sky Code tool result for ",
      )
  );
}

/**
 * Estimates conversation size using a simple character-count heuristic.
 *
 * Each message contributes its content length, role length, and four extra
 * characters of structural overhead. The total is divided by
 * APPROXIMATE_CHARACTERS_PER_TOKEN and rounded upward.
 *
 * @param {readonly ChatMessage[]} messages - Conversation to estimate.
 * @returns {number} Approximate token count, or zero for an empty total.
 */
export function estimateConversationTokens(
  messages:
    readonly ChatMessage[],
): number {
  const characterCount =
    messages.reduce(
      (
        total,
        message,
      ) =>
        total +
        message.content.length +
        message.role.length +
        4,
      0,
    );

  if (
    characterCount ===
      0
  ) {
    return 0;
  }

  return Math.ceil(
    characterCount /
      APPROXIMATE_CHARACTERS_PER_TOKEN,
  );
}

/**
 * Replaces verbose stale tool output with a compact placeholder for summary
 * generation.
 *
 * Non-tool messages are copied unchanged. Tool-result messages retain only
 * their first line plus a notice that older output was omitted, reducing the
 * amount of tool payload sent to the summarizer without modifying the original
 * conversation array.
 *
 * @param {ChatMessage} message - Older conversation message to process.
 * @returns {ChatMessage} Copied message with stale tool output shortened when
 * applicable.
 */
function removeStaleToolOutput(
  message:
    ChatMessage,
): ChatMessage {
  if (
    !isStaleToolResultMessage(
      message,
    )
  ) {
    return {
      role:
        message.role,

      content:
        message.content,
    };
  }

  const firstLine =
    message.content
      .split(
        /\r?\n/,
        1,
      )[0]
      ?.trim() ||
    "Sky Code tool result";

  return {
    role:
      message.role,

    content: [
      firstLine,
      "[Stale tool output omitted during context compaction.]",
    ].join(
      "\n",
    ),
  };
}

/**
 * Wraps generated summary text in the conversation message format used by Sky
 * Code after summarise compaction.
 *
 * The summary is represented as a user-role message with an explicit heading so
 * later model calls know that the text represents earlier conversation history.
 *
 * @param {string} summary - Generated summary text.
 * @returns {ChatMessage} Conversation message containing the trimmed summary.
 * @throws {Error} If the supplied summary is empty after trimming.
 */
export function createCompactionSummaryMessage(
  summary:
    string,
): ChatMessage {
  const trimmedSummary =
    summary.trim();

  if (
    trimmedSummary ===
      ""
  ) {
    throw new Error(
      "Context compaction returned an empty summary",
    );
  }

  return {
    role:
      "user",

    content: [
      "Earlier conversation summary generated by Sky Code context compaction:",
      "",
      trimmedSummary,
    ].join(
      "\n",
    ),
  };
}

/**
 * Compacts older conversation context while preserving a recent message window.
 *
 * When fewer than two messages fall outside the preserved recent window, no
 * compaction is performed. Otherwise PreCompact hooks run before mutation.
 *
 * With `summarise`, older messages are first stripped of verbose stale tool
 * output and passed to the supplied summarizer. The resulting single summary
 * message is followed by the untouched recent window. With `sliding-window`,
 * the older messages are discarded and only the recent window remains.
 *
 * The supplied messages array is replaced in place. If PostCompact fails, the
 * original cloned conversation is restored before the hook error is rethrown,
 * giving the operation transactional behavior around post-compaction hooks.
 *
 * @param {ChatMessage[]} messages - Mutable conversation array to compact.
 * @param {CompactConversationOptions} options - Strategy, reason, hooks,
 * summarizer, and recent-window settings.
 * @returns {Promise<CompactionResult>} Compaction status and before/after
 * statistics.
 * @throws {Error} If configuration is invalid, summarise mode has no summarizer,
 * summary generation is empty or fails, or a compaction hook fails.
 *
 * Side effects: may run hooks, call a summarizer, and replace the contents of
 * the supplied messages array.
 */
export async function compactConversation(
  messages:
    ChatMessage[],

  options:
    CompactConversationOptions,
): Promise<CompactionResult> {
  const strategy =
    validateStrategy(
      options.strategy ??
        "summarise",
    );

  const keepRecentMessages =
    validateRecentMessageCount(
      options
        .keepRecentMessages ??
      DEFAULT_RECENT_MESSAGE_COUNT,
    );

  const beforeMessageCount =
    messages.length;

  const estimatedTokensBefore =
    estimateConversationTokens(
      messages,
    );

  // Only messages outside the protected recent window are eligible for
  // compaction.
  const olderMessageCount =
    beforeMessageCount -
    keepRecentMessages;

  // Avoid replacing a negligible amount of history; at least two older
  // messages must exist before compaction is worthwhile.
  if (
    olderMessageCount <
      2
  ) {
    return {
      compacted:
        false,

      reason:
        options.reason,

      strategy,

      beforeMessageCount,

      afterMessageCount:
        beforeMessageCount,

      compactedTurnCount:
        0,

      estimatedTokensBefore,

      estimatedTokensAfter:
        estimatedTokensBefore,

      estimatedTokenReduction:
        0,

      droppedToolOutputCount:
        0,
    };
  }

  // Preserve a complete backup before hooks or mutation so PostCompact
  // failure can restore the conversation exactly.
  const originalMessages =
    cloneMessages(
      messages,
    );

  const olderMessages =
    messages.slice(
      0,
      olderMessageCount,
    );

  const recentMessages =
    cloneMessages(
      messages.slice(
        olderMessageCount,
      ),
    );

  // Report how many older tool-result messages will have their verbose body
  // removed before summarization.
  const droppedToolOutputCount =
    olderMessages.filter(
      isStaleToolResultMessage,
    ).length;

  const metadata:
    HookMetadata = {
    reason:
      options.reason,

    strategy,

    keepRecentMessages,

    droppedToolOutputCount,
  };

  // PreCompact runs before summary generation and before the caller's message
  // array is mutated.
  await options
    .hookRegistry
    .run(
      "PreCompact",
      {
        messageCount:
          beforeMessageCount,

        reason:
          options.reason,

        estimatedTokens:
          estimatedTokensBefore,

        metadata,
      },
    );

  let summary:
    string | undefined;

  let compactedMessages:
    ChatMessage[];

  // Summarise replaces old history with one generated summary; sliding-window
  // skips model summarization and simply retains the recent window.
  if (
    strategy ===
      "summarise"
  ) {
    if (
      options.summarize ===
        undefined
    ) {
      throw new Error(
        "Summarise compaction requires a summarizer",
      );
    }

    // Shorten stale tool payloads only in the summarizer input. The backup and
    // currently active conversation remain unchanged at this point.
    const messagesForSummary =
      olderMessages.map(
        removeStaleToolOutput,
      );

    // Trim immediately so whitespace-only summarizer output is rejected by
    // createCompactionSummaryMessage().
    summary =
      (
        await options
          .summarize(
            messagesForSummary,
          )
      ).trim();

    compactedMessages = [
      createCompactionSummaryMessage(
        summary,
      ),
      ...recentMessages,
    ];
  } else {
    compactedMessages =
      recentMessages;
  }

  // Preserve the identity of the caller's array while replacing all of its
  // contents with the compacted conversation.
  messages.splice(
    0,
    messages.length,
    ...compactedMessages,
  );

  const estimatedTokensAfter =
    estimateConversationTokens(
      messages,
    );

  // Clamp at zero because the heuristic summary can occasionally estimate
  // larger than the original conversation.
  const estimatedTokenReduction =
    Math.max(
      0,
      estimatedTokensBefore -
        estimatedTokensAfter,
    );

  const compactedTurnCount =
    beforeMessageCount -
    messages.length;

  metadata.compactedTurnCount =
    compactedTurnCount;

  metadata.estimatedTokensAfter =
    estimatedTokensAfter;

  metadata.estimatedTokenReduction =
    estimatedTokenReduction;

  // PostCompact observes the already-mutated conversation and final metrics.
  try {
    await options
      .hookRegistry
      .run(
        "PostCompact",
        {
          beforeMessageCount,

          afterMessageCount:
            messages.length,

          summary,

          metadata,
        },
      );
  // Treat PostCompact as part of the transaction: restore the exact original
  // message contents if a post-hook rejects.
  } catch (error) {
    messages.splice(
      0,
      messages.length,
      ...originalMessages,
    );

    throw error;
  }

  return {
    compacted:
      true,

    reason:
      options.reason,

    strategy,

    beforeMessageCount,

    afterMessageCount:
      messages.length,

    compactedTurnCount,

    estimatedTokensBefore,

    estimatedTokensAfter,

    estimatedTokenReduction,

    droppedToolOutputCount,

    summary,
  };
}
