import {
  mkdtemp,
  readFile,
  rm,
} from "node:fs/promises";

import {
  tmpdir,
} from "node:os";

import {
  join,
} from "node:path";

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
  runAutomaticContextCompaction,
  runContextCompaction,
} from "../src/compact-runtime.ts";

import type {
  AppConfig,
} from "../src/config.ts";

import {
  HookRegistry,
} from "../src/hooks.ts";

import {
  createSessionLogger,
  type SessionLogger,
  type SessionRecord,
  type SessionRecordInput,
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
        `Strategy runtime message ${index + 1} ${"A".repeat(
          100,
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

function createMemoryLogger(
  records:
    SessionRecordInput[],
): SessionLogger {
  return {
    sessionId:
      "strategy-runtime-memory",

    filePath:
      "/tmp/strategy-runtime-memory.jsonl",

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
  "compaction strategy runtime",
  () => {
    it(
      "runs configured automatic sliding-window through hooks and JSONL",
      async () => {
        const directory =
          await mkdtemp(
            join(
              tmpdir(),
              "sky-code-strategy-runtime-",
            ),
          );

        try {
          const messages =
            createMessages(
              8,
            );

          const summarizer =
            vi.fn(
              async () =>
                "This summarizer must not run.",
            );

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
                "pre",
              );

              expect(
                event.metadata
                  .strategy,
              ).toBe(
                "sliding-window",
              );
            },
          );

          registry.register(
            "PostCompact",
            (
              event,
            ) => {
              hookOrder.push(
                "post",
              );

              expect(
                event.metadata
                  .estimatedTokenReduction,
              ).toBeGreaterThan(
                0,
              );
            },
          );

          const logger =
            await createSessionLogger(
              directory,
            );

          const result =
            await runAutomaticContextCompaction({
              config:
                createConfig({
                  compactionThreshold:
                    1,

                  compactionStrategy:
                    "sliding-window",

                  compactionWindowSize:
                    3,
                }),

              model:
                "test-model",

              messages,

              hookRegistry:
                registry,

              sessionLogger:
                logger,

              summarize:
                summarizer,
            });

          expect(
            summarizer,
          ).not.toHaveBeenCalled();

          expect(
            hookOrder,
          ).toEqual([
            "pre",
            "post",
          ]);

          expect(
            result,
          ).toMatchObject({
            compacted:
              true,

            strategy:
              "sliding-window",

            beforeMessageCount:
              8,

            afterMessageCount:
              3,

            compactedTurnCount:
              5,
          });

          const records =
            (
              await readFile(
                logger.filePath,
                "utf8",
              )
            )
              .trim()
              .split(
                "\n",
              )
              .map(
                (
                  line,
                ) =>
                  JSON.parse(
                    line,
                  ) as
                    SessionRecord,
              );

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

            reason:
              "token-pressure",

            strategy:
              "sliding-window",

            beforeMessageCount:
              8,

            afterMessageCount:
              3,

            compactedTurnCount:
              5,
          });

          expect(
            records[0]
              ?.estimatedTokenReduction,
          ).toBeGreaterThan(
            0,
          );
        } finally {
          await rm(
            directory,
            {
              recursive:
                true,

              force:
                true,
            },
          );
        }
      },
    );

    it(
      "uses configured manual sliding-window and formats the report",
      async () => {
        const messages =
          createMessages(
            9,
          );

        const records:
          SessionRecordInput[] = [];

        const result =
          await runContextCompaction({
            config:
              createConfig({
                compactionStrategy:
                  "sliding-window",

                compactionWindowSize:
                  4,
              }),

            model:
              "test-model",

            messages,

            reason:
              "manual",

            hookRegistry:
              new HookRegistry(),

            sessionLogger:
              createMemoryLogger(
                records,
              ),
          });

        expect(
          result,
        ).toMatchObject({
          compacted:
            true,

          strategy:
            "sliding-window",

          beforeMessageCount:
            9,

          afterMessageCount:
            4,

          compactedTurnCount:
            5,
        });

        expect(
          formatContextCompactionResult(
            result,
          ),
        ).toContain(
          [
            "Compaction report:",
            "5 turns compacted using sliding-window;",
            `estimated token reduction ${result.estimatedTokenReduction}`,
            `(${result.estimatedTokensBefore} -> ${result.estimatedTokensAfter}).`,
          ].join(
            " ",
          ),
        );

        expect(
          records[0],
        ).toMatchObject({
          type:
            "compaction",

          reason:
            "manual",

          strategy:
            "sliding-window",

          compactedTurnCount:
            5,
        });
      },
    );
  },
);
