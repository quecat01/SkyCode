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

export const DEFAULT_AUTO_COMPACT_TOKEN_THRESHOLD =
  6_000;

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

export async function runAutomaticContextCompaction(
  options:
    RunAutomaticContextCompactionOptions,
): Promise<CompactionResult | null> {
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

export async function runContextCompaction(
  options:
    RunContextCompactionOptions,
): Promise<CompactionResult> {
  const originalMessages =
    cloneMessages(
      options.messages,
    );

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
