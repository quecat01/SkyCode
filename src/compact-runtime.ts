/**
 * Runtime coordination for manual and automatic Sky Code context compaction.
 *
 * This module decides when automatic compaction is necessary, resolves runtime
 * settings from explicit options and AppConfig, supplies the default
 * model-backed summarizer, records successful compactions in the session log,
 * and formats compaction results for terminal display.
 *
 * The underlying compactConversation() operation mutates the active message
 * array. This layer keeps its own backup so that a session-log write failure can
 * restore the pre-compaction conversation before reporting the persistence
 * error.
 */
import type {
  ChatMessage,
} from "./chat.js";

import {
  summarizeConversationWithModel,
} from "./compact-model.js";

import {
  compactConversation,
  DEFAULT_RECENT_MESSAGE_COUNT,
  estimateConversationTokens,
  type CompactionReason,
  type CompactionResult,
  type ConversationSummarizer,
} from "./compact.js";

import type {
  AppConfig,
  CompactionStrategy,
} from "./config.js";

import type {
  HookRegistry,
} from "./hooks.js";

import type {
  SessionLogger,
} from "./session.js";

/**
 * Runtime dependencies and controls for one context-compaction operation.
 *
 * Explicit strategy, recent-window, and summarizer values override configured
 * defaults. messages is the live mutable conversation that may be compacted in
 * place.
 */
export interface RunContextCompactionOptions {
  config:
    AppConfig;

  model:
    string;

  messages:
    ChatMessage[];

  reason:
    CompactionReason;

  hookRegistry:
    HookRegistry;

  sessionLogger:
    SessionLogger;

  strategy?:
    CompactionStrategy;

  keepRecentMessages?:
    number;

  summarize?:
    ConversationSummarizer;
}

/**
 * Default approximate-token threshold that triggers automatic compaction.
 *
 * The estimate is heuristic rather than model-tokenizer exact.
 */
export const DEFAULT_AUTO_COMPACT_TOKEN_THRESHOLD =
  6_000;

/**
 * Validates a numeric runtime setting that must be a positive safe integer.
 *
 * @param {number} value - Candidate numeric value.
 * @param {string} fieldName - Setting name included in validation errors.
 * @returns {number} The validated positive whole number.
 * @throws {Error} If value is not a positive safe integer.
 */
function validatePositiveWholeNumber(
  value:
    number,

  fieldName:
    string,
): number {
  if (
    !Number.isSafeInteger(
      value,
    ) ||
    value < 1
  ) {
    throw new Error(
      `${fieldName} must be a positive whole number`,
    );
  }

  return value;
}

/**
 * Determines whether the current conversation should be compacted automatically.
 *
 * Automatic compaction requires both an estimated token count at or above the
 * configured threshold and at least two messages older than the protected
 * recent-message window. Threshold and window values are validated even when
 * the conversation is too short to compact.
 *
 * @param {readonly ChatMessage[]} messages - Current conversation history.
 * @param {number} tokenThreshold - Approximate token threshold for automatic
 * compaction.
 * @param {number} keepRecentMessages - Number of newest messages protected from
 * compaction.
 * @returns {boolean} True when token pressure and sufficient older history are
 * both present.
 * @throws {Error} If tokenThreshold or keepRecentMessages is not a positive
 * whole number.
 */
export function shouldAutoCompactContext(
  messages:
    readonly ChatMessage[],

  tokenThreshold:
    number =
      DEFAULT_AUTO_COMPACT_TOKEN_THRESHOLD,

  keepRecentMessages:
    number =
      DEFAULT_RECENT_MESSAGE_COUNT,
): boolean {
  const validatedThreshold =
    validatePositiveWholeNumber(
      tokenThreshold,
      "tokenThreshold",
    );

  const validatedRecentCount =
    validatePositiveWholeNumber(
      keepRecentMessages,
      "keepRecentMessages",
    );

  const olderMessageCount =
    messages.length -
    validatedRecentCount;

  if (
    olderMessageCount <
      2
  ) {
    return false;
  }

  return (
    estimateConversationTokens(
      messages,
    ) >=
    validatedThreshold
  );
}

/**
 * Runtime dependencies and optional overrides for automatic context compaction.
 *
 * tokenThreshold, keepRecentMessages, and strategy may override AppConfig.
 * summarize allows callers or tests to replace the default model-backed
 * summarizer.
 */
export interface RunAutomaticContextCompactionOptions {
  config:
    AppConfig;

  model:
    string;

  messages:
    ChatMessage[];

  hookRegistry:
    HookRegistry;

  sessionLogger:
    SessionLogger;

  strategy?:
    CompactionStrategy;

  tokenThreshold?:
    number;

  keepRecentMessages?:
    number;

  summarize?:
    ConversationSummarizer;
}

/**
 * Runs context compaction only when the automatic token-pressure test passes.
 *
 * Runtime values use the precedence: explicit option, corresponding AppConfig
 * value, then the built-in default. If compaction is not needed, no mutation or
 * session-log entry occurs and null is returned. Otherwise the work is delegated
 * to runContextCompaction() with reason `token-pressure`.
 *
 * @param {RunAutomaticContextCompactionOptions} options - Automatic-compaction
 * dependencies and overrides.
 * @returns {Promise<CompactionResult | null>} Compaction result when automatic
 * compaction ran, otherwise null.
 * @throws {Error} If threshold/window validation fails or delegated compaction,
 * hooks, summarization, or session logging fails.
 *
 * Side effects: when triggered, may call a model, run hooks, mutate messages,
 * and append a compaction record to the session log.
 */
export async function runAutomaticContextCompaction(
  options:
    RunAutomaticContextCompactionOptions,
): Promise<CompactionResult | null> {
  // Automatic settings consistently prefer per-call overrides, then
  // persisted configuration, then built-in defaults.
  const tokenThreshold =
    options.tokenThreshold ??
    options.config
      .compactionThreshold ??
    DEFAULT_AUTO_COMPACT_TOKEN_THRESHOLD;

  const keepRecentMessages =
    options.keepRecentMessages ??
    options.config
      .compactionWindowSize ??
    DEFAULT_RECENT_MESSAGE_COUNT;

  const strategy =
    options.strategy ??
    options.config
      .compactionStrategy ??
    "summarise";

  // Returning null distinguishes "automatic compaction was unnecessary" from
  // a CompactionResult produced by an attempted compaction.
  if (
    !shouldAutoCompactContext(
      options.messages,
      tokenThreshold,
      keepRecentMessages,
    )
  ) {
    return null;
  }

  return runContextCompaction({
    config:
      options.config,

    model:
      options.model,

    messages:
      options.messages,

    reason:
      "token-pressure",

    hookRegistry:
      options.hookRegistry,

    sessionLogger:
      options.sessionLogger,

    strategy,

    keepRecentMessages,

    summarize:
      options.summarize,
  });
}

/**
 * Creates independent role/content copies of conversation messages.
 *
 * @param {readonly ChatMessage[]} messages - Conversation messages to copy.
 * @returns {ChatMessage[]} New message objects preserving order and contents.
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
 * Restores a mutable conversation array from a previously cloned snapshot.
 *
 * splice() preserves the caller's array identity while replacing all contents.
 *
 * @param {ChatMessage[]} messages - Live conversation array to restore.
 * @param {readonly ChatMessage[]} originalMessages - Snapshot to restore from.
 * @returns {void}
 *
 * Side effect: replaces every item in messages.
 */
function restoreMessages(
  messages:
    ChatMessage[],

  originalMessages:
    readonly ChatMessage[],
): void {
  messages.splice(
    0,
    messages.length,
    ...cloneMessages(
      originalMessages,
    ),
  );
}

/**
 * Executes context compaction and persists the successful result to the session
 * log.
 *
 * A complete conversation snapshot is captured before compaction. Strategy and
 * recent-window settings prefer explicit options, then AppConfig, then built-in
 * defaults. Unless a custom summarizer is supplied, older messages are
 * summarized with the active model through summarizeConversationWithModel().
 *
 * compactConversation() owns the actual compaction and hook lifecycle. If it
 * reports that compaction was unnecessary, the result is returned without
 * writing a session record.
 *
 * After a successful compaction, a `compaction` session-log record is appended.
 * Sliding-window results additionally persist strategy and before/after
 * reduction metrics. If logging fails, the live conversation is restored from
 * the pre-compaction snapshot and a persistence-specific error is thrown.
 *
 * Note that restoration can undo the message-array mutation, but cannot undo
 * external side effects already performed by compaction hooks or a summarizer.
 *
 * @param {RunContextCompactionOptions} options - Runtime configuration,
 * conversation, hooks, logger, and optional compaction overrides.
 * @returns {Promise<CompactionResult>} Result returned by compactConversation().
 * @throws {Error} If compaction configuration, summarization, hooks, or session
 * logging fails.
 *
 * Side effects: may call a model, execute compaction hooks, mutate the live
 * conversation, and append to the session log.
 */
export async function runContextCompaction(
  options:
    RunContextCompactionOptions,
): Promise<CompactionResult> {
  // Keep a runtime-level snapshot in addition to compactConversation()'s own
  // hook rollback so persistence failure can also restore active history.
  const originalMessages =
    cloneMessages(
      options.messages,
    );

  // Manual/runtime overrides take precedence over AppConfig; summarise is
  // the final fallback.
  const strategy =
    options.strategy ??
    options.config
      .compactionStrategy ??
    "summarise";

  const keepRecentMessages =
    options.keepRecentMessages ??
    options.config
      .compactionWindowSize ??
    DEFAULT_RECENT_MESSAGE_COUNT;

  // A supplied summarizer is useful for alternate runtimes and tests; normal
  // operation falls back to the active model-backed compaction summarizer.
  const summarize =
    options.summarize ??
    (
      (
        olderMessages,
      ) =>
        summarizeConversationWithModel(
          options.config,
          options.model,
          olderMessages,
        )
    );

  const result =
    await compactConversation(
      options.messages,
      {
        reason:
          options.reason,

        strategy,

        summarize,

        hookRegistry:
          options.hookRegistry,

        keepRecentMessages,
      },
    );

  if (
    !result.compacted
  ) {
    return result;
  }

  // Persist compaction only after the in-memory operation and its hooks have
  // completed successfully.
  try {
    await options
      .sessionLogger
      .append({
        type:
          "compaction",

        model:
          options.model,

        reason:
          result.reason,

        beforeMessageCount:
          result.beforeMessageCount,

        afterMessageCount:
          result.afterMessageCount,

        estimatedTokens:
          result.estimatedTokensBefore,

        droppedToolOutputCount:
          result.droppedToolOutputCount,

        // Sliding-window compaction has no generated summary, so persist its
        // explicit reduction metrics for later diagnostics instead.
        ...(result.strategy ===
          "sliding-window"
          ? {
              strategy:
                result.strategy,

              compactedTurnCount:
                result.compactedTurnCount,

              estimatedTokensAfter:
                result.estimatedTokensAfter,

              estimatedTokenReduction:
                result.estimatedTokenReduction,
            }
          : {}),

        summary:
          result.summary,
      });
  } catch (error) {
    // A compaction that cannot be recorded is not allowed to remain active in
    // memory; restore the caller's original conversation contents.
    restoreMessages(
      options.messages,
      originalMessages,
    );

    throw new Error(
      `Unable to record context compaction: ${
        error instanceof Error
          ? error.message
          : String(
              error,
            )
      }`,
    );
  }

  return result;
}

/**
 * Formats a compaction result into terminal-friendly status lines.
 *
 * Non-compacted results explain that insufficient older history was available.
 * Successful results always report message counts, the pre-compaction token
 * estimate, and stale tool-output count. When all detailed reduction metrics
 * are available, an additional one-line compaction report is inserted.
 *
 * @param {CompactionResult} result - Compaction outcome to present.
 * @returns {string[]} Ordered lines suitable for terminal output.
 */
export function formatContextCompactionResult(
  result:
    CompactionResult,
): string[] {
  if (
    !result.compacted
  ) {
    return [
      "Context compaction was not needed.",
      `Active history: ${result.beforeMessageCount} messages.`,
      "There are not enough older messages to summarize.",
    ];
  }

  const lines = [
    "Context compacted successfully.",
    `Messages: ${result.beforeMessageCount} -> ${result.afterMessageCount}`,
    `Estimated tokens before compaction: ${result.estimatedTokensBefore}`,
    `Stale tool outputs omitted: ${result.droppedToolOutputCount}`,
  ];

  // Emit the detailed report only as a complete set; avoid displaying a
  // partially populated reduction summary.
  if (
    result.compactedTurnCount !==
      undefined &&
    result.estimatedTokensAfter !==
      undefined &&
    result.estimatedTokenReduction !==
      undefined
  ) {
    lines.splice(
      1,
      0,
      [
        "Compaction report:",
        `${result.compactedTurnCount} turns compacted using ${result.strategy ?? "summarise"};`,
        `estimated token reduction ${result.estimatedTokenReduction}`,
        `(${result.estimatedTokensBefore} -> ${result.estimatedTokensAfter}).`,
      ].join(
        " ",
      ),
    );
  }

  return lines;
}
