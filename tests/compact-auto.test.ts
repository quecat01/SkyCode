import {
  describe,
  expect,
  it,
} from "vitest";

import type {
  ChatMessage,
} from "../src/chat.ts";

import {
  estimateConversationTokens,
} from "../src/compact.ts";

import {
  DEFAULT_AUTO_COMPACT_TOKEN_THRESHOLD,
  shouldAutoCompactContext,
} from "../src/compact-runtime.ts";

function createMessages(
  count:
    number,
  content:
    string = "Test message",
): ChatMessage[] {
  return Array.from(
    {
      length:
        count,
    },
    (
      _,
      index,
    ) => ({
      role:
        index % 2 ===
          0
          ? "user"
          : "assistant",
      content:
        `${content} ${index + 1}`,
    }),
  );
}

describe(
  "automatic context compaction policy",
  () => {
    it(
      "uses the simple Phase 2 threshold of 24000 estimated tokens",
      () => {
        expect(
          DEFAULT_AUTO_COMPACT_TOKEN_THRESHOLD,
        ).toBe(
          24_000,
        );
      },
    );

    it(
      "triggers when estimated tokens reach the selected threshold",
      () => {
        const messages =
          createMessages(
            10,
            "A".repeat(
              200,
            ),
          );

        const estimatedTokens =
          estimateConversationTokens(
            messages,
          );

        expect(
          shouldAutoCompactContext(
            messages,
            estimatedTokens,
            6,
          ),
        ).toBe(
          true,
        );

        expect(
          shouldAutoCompactContext(
            messages,
            estimatedTokens +
              1,
            6,
          ),
        ).toBe(
          false,
        );
      },
    );

    it(
      "does not trigger without at least two older messages to summarize",
      () => {
        const messages =
          createMessages(
            7,
            "A".repeat(
              20_000,
            ),
          );

        expect(
          shouldAutoCompactContext(
            messages,
            1,
            6,
          ),
        ).toBe(
          false,
        );
      },
    );

    it(
      "rejects invalid threshold and recent-message settings",
      () => {
        const messages =
          createMessages(
            10,
          );

        expect(
          () =>
            shouldAutoCompactContext(
              messages,
              0,
              6,
            ),
        ).toThrow(
          "tokenThreshold must be a positive whole number",
        );

        expect(
          () =>
            shouldAutoCompactContext(
              messages,
              100,
              0,
            ),
        ).toThrow(
          "keepRecentMessages must be a positive whole number",
        );
      },
    );
  },
);
