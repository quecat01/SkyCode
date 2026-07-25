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
  formatContextCompactionResult,
  runContextCompaction,
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
        `Message ${index + 1}`,
    }),
  );
}

function createTestLogger(
  records:
    SessionRecordInput[],
): SessionLogger {
  return {
    sessionId:
      "test-session",
    filePath:
      "/tmp/test-session.jsonl",
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

function createTestConfig() {
  return {
    apiUrl:
      "http://litellm.test/v1",
    apiKey:
      "test-api-key",
  } as const;
}

describe(
  "context compaction runtime",
  () => {
    it(
      "compacts history and records the complete JSONL event",
      async () => {
        const messages =
          createMessages(
            10,
          );

        const records:
          SessionRecordInput[] = [];

        const result =
          await runContextCompaction({
            config:
              createTestConfig(),
            model:
              "test-model",
            messages,
            reason:
              "manual",
            hookRegistry:
              new HookRegistry(),
            sessionLogger:
              createTestLogger(
                records,
              ),
            keepRecentMessages:
              4,
            summarize:
              async () =>
                "The earlier conversation contained test messages.",
          });

        expect(
          result,
        ).toMatchObject({
          compacted:
            true,
          reason:
            "manual",
          beforeMessageCount:
            10,
          afterMessageCount:
            5,
          droppedToolOutputCount:
            0,
          summary:
            "The earlier conversation contained test messages.",
        });

        expect(
          messages,
        ).toHaveLength(
          5,
        );

        expect(
          records,
        ).toEqual([
          {
            type:
              "compaction",
            model:
              "test-model",
            reason:
              "manual",
            beforeMessageCount:
              10,
            afterMessageCount:
              5,
            estimatedTokens:
              result
                .estimatedTokensBefore,
            droppedToolOutputCount:
              0,
            summary:
              "The earlier conversation contained test messages.",
          },
        ]);
      },
    );

    it(
      "does not call the summarizer or logger when compaction is unnecessary",
      async () => {
        const messages =
          createMessages(
            7,
          );

        const records:
          SessionRecordInput[] = [];

        const summarizer =
          vi.fn(
            async () =>
              "Unused summary",
          );

        const result =
          await runContextCompaction({
            config:
              createTestConfig(),
            model:
              "test-model",
            messages,
            reason:
              "manual",
            hookRegistry:
              new HookRegistry(),
            sessionLogger:
              createTestLogger(
                records,
              ),
            summarize:
              summarizer,
          });

        expect(
          result.compacted,
        ).toBe(
          false,
        );

        expect(
          messages,
        ).toHaveLength(
          7,
        );

        expect(
          summarizer,
        ).not.toHaveBeenCalled();

        expect(
          records,
        ).toEqual([]);
      },
    );

    it(
      "restores the original history when session logging fails",
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

        const failingLogger:
          SessionLogger = {
            sessionId:
              "test-session",
            filePath:
              "/tmp/test-session.jsonl",
            append:
              async () => {
                throw new Error(
                  "disk unavailable",
                );
              },
          };

        await expect(
          runContextCompaction({
            config:
              createTestConfig(),
            model:
              "test-model",
            messages,
            reason:
              "manual",
            hookRegistry:
              new HookRegistry(),
            sessionLogger:
              failingLogger,
            keepRecentMessages:
              4,
            summarize:
              async () =>
                "Temporary summary",
          }),
        ).rejects.toThrow(
          "Unable to record context compaction: disk unavailable",
        );

        expect(
          messages,
        ).toEqual(
          originalMessages,
        );
      },
    );

    it(
      "formats a successful compaction result for the terminal",
      () => {
        expect(
          formatContextCompactionResult({
            compacted:
              true,
            reason:
              "manual",
            beforeMessageCount:
              16,
            afterMessageCount:
              7,
            estimatedTokensBefore:
              4200,
            droppedToolOutputCount:
              2,
            summary:
              "Summary",
          }),
        ).toEqual([
          "Context compacted successfully.",
          "Messages: 16 -> 7",
          "Estimated tokens before compaction: 4200",
          "Stale tool outputs omitted: 2",
        ]);
      },
    );

    it(
      "formats an unnecessary compaction result for the terminal",
      () => {
        expect(
          formatContextCompactionResult({
            compacted:
              false,
            reason:
              "manual",
            beforeMessageCount:
              5,
            afterMessageCount:
              5,
            estimatedTokensBefore:
              100,
            droppedToolOutputCount:
              0,
          }),
        ).toEqual([
          "Context compaction was not needed.",
          "Active history: 5 messages.",
          "There are not enough older messages to summarize.",
        ]);
      },
    );
  },
);
