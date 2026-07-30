import {
  describe,
  expect,
  it,
} from "vitest";

import type {
  ChatMessage,
} from "../src/chat.ts";

import {
  DEFAULT_RECENT_MESSAGE_COUNT,
} from "../src/compact.ts";

import {
  DEFAULT_AUTO_COMPACT_TOKEN_THRESHOLD,
  runAutomaticContextCompaction,
  runContextCompaction,
} from "../src/compact-runtime.ts";

import type {
  AppConfig,
} from "../src/config.ts";

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
        `Configured message ${index + 1} ${"A".repeat(
          80,
        )}`,
    }),
  );
}

function createConfig(
  overrides:
    Partial<AppConfig> = {},
): AppConfig {
  return {
    apiUrl:
      "http://litellm.test/v1",

    apiKey:
      "test-key",

    defaultModel:
      "test-model",

    defaultPermissionMode:
      "default",

    compactionThreshold:
      6_000,

    compactionStrategy:
      "summarise",

    compactionWindowSize:
      20,

    mcpServers: [],

    pluginDirs: [],

    ...overrides,
  };
}

function createLogger(
  records:
    SessionRecordInput[],
): SessionLogger {
  return {
    sessionId:
      "configured-compaction-test",

    filePath:
      "/tmp/configured-compaction-test.jsonl",

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

describe(
  "configured compaction runtime",
  () => {
    it(
      "uses the Phase 3 default constants",
      () => {
        expect(
          DEFAULT_AUTO_COMPACT_TOKEN_THRESHOLD,
        ).toBe(
          6_000,
        );

        expect(
          DEFAULT_RECENT_MESSAGE_COUNT,
        ).toBe(
          20,
        );
      },
    );

    it(
      "uses configured automatic threshold and window",
      async () => {
        const messages =
          createMessages(
            10,
          );

        const records:
          SessionRecordInput[] = [];

        const result =
          await runAutomaticContextCompaction({
            config:
              createConfig({
                compactionThreshold:
                  1,

                compactionWindowSize:
                  4,
              }),

            model:
              "test-model",

            messages,

            hookRegistry:
              new HookRegistry(),

            sessionLogger:
              createLogger(
                records,
              ),

            summarize:
              async () =>
                "Configured automatic summary.",
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
          messages,
        ).toHaveLength(
          5,
        );

        expect(
          records,
        ).toHaveLength(
          1,
        );
      },
    );

    it(
      "uses configured manual window size",
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
              createConfig({
                compactionWindowSize:
                  3,
              }),

            model:
              "test-model",

            messages,

            reason:
              "manual",

            hookRegistry:
              new HookRegistry(),

            sessionLogger:
              createLogger(
                records,
              ),

            summarize:
              async () =>
                "Configured manual summary.",
          });

        expect(
          result,
        ).toMatchObject({
          compacted:
            true,

          beforeMessageCount:
            10,

          afterMessageCount:
            4,
        });

        expect(
          messages,
        ).toHaveLength(
          4,
        );

        expect(
          records[0],
        ).toMatchObject({
          type:
            "compaction",

          summary:
            "Configured manual summary.",
        });
      },
    );
  },
);
