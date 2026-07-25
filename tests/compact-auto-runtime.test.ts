import {
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type {
  ChatMessage,
} from "../src/chat.ts";

import {
  runAutomaticContextCompaction,
} from "../src/compact-runtime.ts";

import {
  HookRegistry,
} from "../src/hooks.ts";

import type {
  SessionLogger,
  SessionRecordInput,
} from "../src/session.ts";

function createMessages(
  count:
    number,
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
        `Automatic test message ${index + 1}`,
    }),
  );
}

function createLogger(
  records:
    SessionRecordInput[],
): SessionLogger {
  return {
    sessionId:
      "automatic-test-session",
    filePath:
      "/tmp/automatic-test-session.jsonl",
    append:
      async (
        record,
      ) => {
        records.push(
          record,
        );
      },
  };
}

const testConfig = {
  apiUrl:
    "http://litellm.test/v1",
  apiKey:
    "test-key",
} as const;

describe(
  "automatic context compaction runtime",
  () => {
    it(
      "does nothing when the token threshold has not been reached",
      async () => {
        const messages =
          createMessages(
            10,
          );

        const originalMessages =
          messages.map(
            (
              message,
            ) => ({
              ...message,
            }),
          );

        const records:
          SessionRecordInput[] = [];

        const summarizer =
          vi.fn(
            async () =>
              "Unused summary",
          );

        const result =
          await runAutomaticContextCompaction({
            config:
              testConfig,
            model:
              "test-model",
            messages,
            hookRegistry:
              new HookRegistry(),
            sessionLogger:
              createLogger(
                records,
              ),
            tokenThreshold:
              1_000_000,
            summarize:
              summarizer,
          });

        expect(
          result,
        ).toBeNull();

        expect(
          messages,
        ).toEqual(
          originalMessages,
        );

        expect(
          records,
        ).toEqual([]);

        expect(
          summarizer,
        ).not.toHaveBeenCalled();
      },
    );

    it(
      "compacts with token-pressure reason and fires both compact hooks",
      async () => {
        const messages =
          createMessages(
            10,
          );

        const records:
          SessionRecordInput[] = [];

        const hookOrder:
          string[] = [];

        const registry =
          new HookRegistry();

        registry.register(
          "PreCompact",
          (
            event,
          ) => {
            hookOrder.push(
              "PreCompact",
            );

            expect(
              event.reason,
            ).toBe(
              "token-pressure",
            );
          },
        );

        registry.register(
          "PostCompact",
          (
            event,
          ) => {
            hookOrder.push(
              "PostCompact",
            );

            expect(
              event.metadata
                .reason,
            ).toBe(
              "token-pressure",
            );
          },
        );

        const result =
          await runAutomaticContextCompaction({
            config:
              testConfig,
            model:
              "test-model",
            messages,
            hookRegistry:
              registry,
            sessionLogger:
              createLogger(
                records,
              ),
            tokenThreshold:
              1,
            keepRecentMessages:
              4,
            summarize:
              async () =>
                "The older automatic-test messages were summarized.",
          });

        expect(
          result,
        ).toMatchObject({
          compacted:
            true,
          reason:
            "token-pressure",
          beforeMessageCount:
            10,
          afterMessageCount:
            5,
        });

        expect(
          hookOrder,
        ).toEqual([
          "PreCompact",
          "PostCompact",
        ]);

        expect(
          records,
        ).toHaveLength(
          1,
        );

        expect(
          records[0],
        ).toMatchObject({
          type:
            "compaction",
          model:
            "test-model",
          reason:
            "token-pressure",
          beforeMessageCount:
            10,
          afterMessageCount:
            5,
          summary:
            "The older automatic-test messages were summarized.",
        });
      },
    );
  },
);
