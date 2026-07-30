import {
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";

import {
  tmpdir,
} from "node:os";

import {
  join,
} from "node:path";

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import {
  formatHistorySearchResults,
  parseHistoryCommand,
  searchSessionHistory,
} from "../src/history.ts";

import {
  createSessionLogger,
} from "../src/session.ts";

describe(
  "current-session history search",
  () => {
    let testDirectory:
      string;

    beforeEach(
      async () => {
        testDirectory =
          await mkdtemp(
            join(
              tmpdir(),
              "sky-code-history-",
            ),
          );
      },
    );

    afterEach(
      async () => {
        await rm(
          testDirectory,
          {
            recursive:
              true,

            force:
              true,
          },
        );
      },
    );

    it(
      "parses a history search command and preserves a multi-word term",
      () => {
        expect(
          parseHistoryCommand(
            "/history search context compaction",
          ),
        ).toEqual({
          action:
            "search",

          term:
            "context compaction",
        });
      },
    );

    it(
      "returns null for unrelated commands",
      () => {
        expect(
          parseHistoryCommand(
            "/catalog list",
          ),
        ).toBeNull();

        expect(
          parseHistoryCommand(
            "ordinary conversation",
          ),
        ).toBeNull();
      },
    );

    it(
      "rejects missing and unknown history actions",
      () => {
        expect(
          () =>
            parseHistoryCommand(
              "/history",
            ),
        ).toThrow(
          "Usage: /history search <term>",
        );

        expect(
          () =>
            parseHistoryCommand(
              "/history search",
            ),
        ).toThrow(
          "Missing history search term",
        );

        expect(
          () =>
            parseHistoryCommand(
              "/history remove old",
            ),
        ).toThrow(
          'Unknown history action "remove"',
        );
      },
    );

    it(
      "searches message records in the active JSONL session case-insensitively",
      async () => {
        const logger =
          await createSessionLogger(
            testDirectory,
          );

        await logger.append({
          type:
            "session_start",

          model:
            "test-model",
        });

        await logger.append({
          type:
            "message",

          role:
            "user",

          content:
            "Please review the Context Compaction implementation.",

          model:
            "test-model",
        });

        await logger.append({
          type:
            "message",

          role:
            "assistant",

          content:
            "The compaction tests pass.",

          model:
            "test-model",
        });

        await logger.append({
          type:
            "tool_result",

          role:
            "tool",

          content:
            "context compaction tool output",

          tool:
            "run_shell_command",

          success:
            true,
        });

        const matches =
          await searchSessionHistory(
            logger.filePath,
            "context compaction",
          );

        expect(
          matches,
        ).toHaveLength(
          1,
        );

        expect(
          matches[0],
        ).toMatchObject({
          role:
            "user",

          content:
            "Please review the Context Compaction implementation.",

          lineNumber:
            2,
        });

        expect(
          typeof matches[0]
            ?.timestamp,
        ).toBe(
          "string",
        );
      },
    );

    it(
      "returns matching user and assistant turns in append order",
      async () => {
        const logger =
          await createSessionLogger(
            testDirectory,
          );

        await logger.append({
          type:
            "message",

          role:
            "user",

          content:
            "The catalog needs tests.",
        });

        await logger.append({
          type:
            "message",

          role:
            "assistant",

          content:
            "The catalog tests now pass.",
        });

        const matches =
          await searchSessionHistory(
            logger.filePath,
            "catalog",
          );

        expect(
          matches.map(
            (
              match,
            ) =>
              match.role,
          ),
        ).toEqual([
          "user",
          "assistant",
        ]);
      },
    );

    it(
      "returns an empty result when no conversation turn matches",
      async () => {
        const logger =
          await createSessionLogger(
            testDirectory,
          );

        await logger.append({
          type:
            "message",

          role:
            "user",

          content:
            "A completely unrelated message.",
        });

        await expect(
          searchSessionHistory(
            logger.filePath,
            "missing phrase",
          ),
        ).resolves.toEqual([]);
      },
    );

    it(
      "formats matches with timestamps, roles, and multiline content",
      () => {
        expect(
          formatHistorySearchResults(
            "catalog",
            [
              {
                timestamp:
                  "2026-07-28T22:00:00.000Z",

                role:
                  "assistant",

                content:
                  "Catalog tests passed.\nNo restart is required.",

                lineNumber:
                  4,
              },
            ],
          ),
        ).toBe(
          [
            'History matches for "catalog":',
            "[2026-07-28T22:00:00.000Z] assistant: Catalog tests passed.",
            "  No restart is required.",
          ].join(
            "\n",
          ),
        );

        expect(
          formatHistorySearchResults(
            "absent",
            [],
          ),
        ).toBe(
          'No matching conversation turns found for "absent".',
        );
      },
    );

    it(
      "reports the exact line number of malformed JSONL",
      async () => {
        const filePath =
          join(
            testDirectory,
            "broken.jsonl",
          );

        await writeFile(
          filePath,
          [
            JSON.stringify({
              timestamp:
                "2026-07-28T22:00:00.000Z",

              sessionId:
                "test-session",

              type:
                "message",

              role:
                "user",

              content:
                "Valid line",
            }),
            "{broken-json",
            "",
          ].join(
            "\n",
          ),
          "utf8",
        );

        await expect(
          searchSessionHistory(
            filePath,
            "valid",
          ),
        ).rejects.toThrow(
          `Unable to parse session history line 2 in ${filePath}`,
        );
      },
    );
  },
);
