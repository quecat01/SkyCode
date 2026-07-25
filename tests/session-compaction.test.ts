import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import {
  mkdtemp,
  readFile,
  rm,
  stat,
} from "node:fs/promises";

import {
  tmpdir,
} from "node:os";

import {
  join,
} from "node:path";

import {
  createSessionLogger,
  type SessionRecord,
} from "../src/session.ts";

describe(
  "compaction session logging",
  () => {
    let testDirectory:
      string;

    beforeEach(
      async () => {
        testDirectory =
          await mkdtemp(
            join(
              tmpdir(),
              "sky-code-compaction-session-",
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
      "writes a complete compaction event to JSONL",
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
            "compaction",
          model:
            "test-model",
          reason:
            "manual",
          beforeMessageCount:
            14,
          afterMessageCount:
            7,
          estimatedTokens:
            2400,
          droppedToolOutputCount:
            2,
          summary:
            "The earlier conversation established the current task.",
        });

        await logger.append({
          type:
            "session_end",
          model:
            "test-model",
        });

        const contents =
          await readFile(
            logger.filePath,
            "utf8",
          );

        const records =
          contents
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
          3,
        );

        expect(
          records[1],
        ).toMatchObject({
          sessionId:
            logger.sessionId,
          type:
            "compaction",
          model:
            "test-model",
          reason:
            "manual",
          beforeMessageCount:
            14,
          afterMessageCount:
            7,
          estimatedTokens:
            2400,
          droppedToolOutputCount:
            2,
          summary:
            "The earlier conversation established the current task.",
        });

        expect(
          typeof records[1]
            ?.timestamp,
        ).toBe(
          "string",
        );
      },
    );

    it(
      "keeps compaction records in append order",
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
            "Before compaction",
          model:
            "test-model",
        });

        await logger.append({
          type:
            "compaction",
          reason:
            "token-pressure",
          beforeMessageCount:
            12,
          afterMessageCount:
            7,
          estimatedTokens:
            8000,
          droppedToolOutputCount:
            1,
          summary:
            "Automatic summary",
          model:
            "test-model",
        });

        await logger.append({
          type:
            "message",
          role:
            "user",
          content:
            "After compaction",
          model:
            "test-model",
        });

        const contents =
          await readFile(
            logger.filePath,
            "utf8",
          );

        const eventTypes =
          contents
            .trim()
            .split(
              "\n",
            )
            .map(
              (
                line,
              ) =>
                (
                  JSON.parse(
                    line,
                  ) as
                    SessionRecord
                ).type,
            );

        expect(
          eventTypes,
        ).toEqual([
          "message",
          "compaction",
          "message",
        ]);
      },
    );

    it(
      "preserves private file permissions for compaction logs",
      async () => {
        const logger =
          await createSessionLogger(
            testDirectory,
          );

        await logger.append({
          type:
            "compaction",
          reason:
            "manual",
          beforeMessageCount:
            10,
          afterMessageCount:
            7,
          estimatedTokens:
            1000,
          droppedToolOutputCount:
            0,
          summary:
            "Private summary",
          model:
            "test-model",
        });

        const details =
          await stat(
            logger.filePath,
          );

        expect(
          details.mode &
            0o777,
        ).toBe(
          0o600,
        );
      },
    );
  },
);
