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
  findLatestResumableSession,
  loadResumableSession,
  readSessionRecords,
  reconstructSessionMessages,
} from "../src/session-resume.ts";

import {
  createSessionLogger,
  type SessionRecord,
} from "../src/session.ts";

describe(
  "session resume core",
  () => {
    let rootDirectory:
      string;

    let sessionDirectory:
      string;

    let projectDirectory:
      string;

    beforeEach(
      async () => {
        rootDirectory =
          await mkdtemp(
            join(
              tmpdir(),
              "sky-code-session-resume-",
            ),
          );

        sessionDirectory =
          join(
            rootDirectory,
            "sessions",
          );

        projectDirectory =
          join(
            rootDirectory,
            "project",
          );
      },
    );

    afterEach(
      async () => {
        await rm(
          rootDirectory,
          {
            recursive:
              true,

            force:
              true,
          },
        );
      },
    );

    function createRecord(
      overrides:
        Partial<SessionRecord>,
    ): SessionRecord {
      return {
        timestamp:
          "2026-07-28T22:00:00.000Z",

        sessionId:
          "resume-test-session",

        type:
          "message",

        ...overrides,
      };
    }

    it(
      "reconstructs ordinary user and assistant messages",
      () => {
        expect(
          reconstructSessionMessages([
            createRecord({
              role:
                "user",

              content:
                "Inspect the project.",
            }),
            createRecord({
              role:
                "assistant",

              content:
                "The inspection is complete.",
            }),
          ]),
        ).toEqual([
          {
            role:
              "user",

            content:
              "Inspect the project.",
          },
          {
            role:
              "assistant",

            content:
              "The inspection is complete.",
          },
        ]);
      },
    );

    it(
      "reconstructs a foreground tool result as model context",
      () => {
        const messages =
          reconstructSessionMessages([
            createRecord({
              role:
                "assistant",

              content: [
                "```sky-tool",
                '{"tool":"read_file","args":{"path":"src/index.ts"}}',
                "```",
              ].join(
                "\n",
              ),
            }),
            createRecord({
              type:
                "tool_result",

              role:
                "tool",

              tool:
                "read_file",

              success:
                true,

              content:
                "file contents",
            }),
          ]);

        expect(
          messages,
        ).toHaveLength(
          2,
        );

        expect(
          messages[1]
            ?.role,
        ).toBe(
          "user",
        );

        expect(
          messages[1]
            ?.content,
        ).toContain(
          "Sky Code tool result for read_file:",
        );

        expect(
          messages[1]
            ?.content,
        ).toContain(
          "file contents",
        );
      },
    );

    it(
      "does not insert a completed background tool result into context",
      () => {
        const messages =
          reconstructSessionMessages([
            createRecord({
              role:
                "assistant",

              content: [
                "```sky-tool",
                '{"tool":"run_shell_command","args":{"command":"sleep 10","background":true}}',
                "```",
              ].join(
                "\n",
              ),
            }),
            createRecord({
              type:
                "tool_result",

              role:
                "tool",

              tool:
                "run_shell_command",

              success:
                true,

              content:
                "Background task started.",
            }),
          ]);

        expect(
          messages,
        ).toHaveLength(
          1,
        );
      },
    );

    it(
      "replays summarise compaction using the stored summary",
      () => {
        const messages =
          reconstructSessionMessages([
            createRecord({
              role:
                "user",

              content:
                "Old request",
            }),
            createRecord({
              role:
                "assistant",

              content:
                "Old response",
            }),
            createRecord({
              role:
                "user",

              content:
                "Recent request",
            }),
            createRecord({
              role:
                "assistant",

              content:
                "Recent response",
            }),
            createRecord({
              type:
                "compaction",

              strategy:
                "summarise",

              summary:
                "The old request and response were completed.",

              afterMessageCount:
                3,
            }),
          ]);

        expect(
          messages,
        ).toHaveLength(
          3,
        );

        expect(
          messages[0]
            ?.content,
        ).toContain(
          "The old request and response were completed.",
        );

        expect(
          messages.slice(
            1,
          ),
        ).toEqual([
          {
            role:
              "user",

            content:
              "Recent request",
          },
          {
            role:
              "assistant",

            content:
              "Recent response",
          },
        ]);
      },
    );

    it(
      "replays sliding-window compaction using the recorded window",
      () => {
        const messages =
          reconstructSessionMessages([
            createRecord({
              role:
                "user",

              content:
                "Message one",
            }),
            createRecord({
              role:
                "assistant",

              content:
                "Message two",
            }),
            createRecord({
              role:
                "user",

              content:
                "Message three",
            }),
            createRecord({
              role:
                "assistant",

              content:
                "Message four",
            }),
            createRecord({
              type:
                "compaction",

              strategy:
                "sliding-window",

              afterMessageCount:
                2,
            }),
          ]);

        expect(
          messages,
        ).toEqual([
          {
            role:
              "user",

            content:
              "Message three",
          },
          {
            role:
              "assistant",

            content:
              "Message four",
          },
        ]);
      },
    );

    it(
      "loads working directory, model, and reconstructed messages",
      async () => {
        const logger =
          await createSessionLogger(
            sessionDirectory,
          );

        await logger.append({
          type:
            "session_start",

          workingDirectory:
            projectDirectory,

          model:
            "test-model",
        });

        await logger.append({
          type:
            "message",

          role:
            "user",

          content:
            "Resume this request.",

          model:
            "test-model",
        });

        const candidate =
          await loadResumableSession(
            logger.filePath,
          );

        expect(
          candidate,
        ).toMatchObject({
          sessionId:
            logger.sessionId,

          workingDirectory:
            projectDirectory,

          model:
            "test-model",

          recordCount:
            2,
        });

        expect(
          candidate
            ?.messages,
        ).toEqual([
          {
            role:
              "user",

            content:
              "Resume this request.",
          },
        ]);
      },
    );

    it(
      "selects the latest session for the current directory and ignores legacy logs",
      async () => {
        const legacyLogger =
          await createSessionLogger(
            sessionDirectory,
          );

        await legacyLogger.append({
          type:
            "session_start",

          model:
            "legacy-model",
        });

        await legacyLogger.append({
          type:
            "message",

          role:
            "user",

          content:
            "Legacy session without a directory.",
        });

        const otherLogger =
          await createSessionLogger(
            sessionDirectory,
          );

        await otherLogger.append({
          type:
            "session_start",

          workingDirectory:
            join(
              rootDirectory,
              "other-project",
            ),

          model:
            "other-model",
        });

        await otherLogger.append({
          type:
            "message",

          role:
            "user",

          content:
            "Other project.",
        });

        const matchingLogger =
          await createSessionLogger(
            sessionDirectory,
          );

        await matchingLogger.append({
          type:
            "session_start",

          workingDirectory:
            projectDirectory,

          model:
            "matching-model",
        });

        await matchingLogger.append({
          type:
            "message",

          role:
            "user",

          content:
            "Matching project.",
        });

        const candidate =
          await findLatestResumableSession(
            projectDirectory,
            sessionDirectory,
          );

        expect(
          candidate
            ?.sessionId,
        ).toBe(
          matchingLogger.sessionId,
        );

        expect(
          candidate
            ?.messages[0]
            ?.content,
        ).toBe(
          "Matching project.",
        );
      },
    );

    it(
      "reports the exact line of malformed session JSONL",
      async () => {
        const filePath =
          join(
            rootDirectory,
            "broken.jsonl",
          );

        await writeFile(
          filePath,
          [
            JSON.stringify({
              timestamp:
                "2026-07-28T22:00:00.000Z",

              sessionId:
                "broken-session",

              type:
                "session_start",

              workingDirectory:
                projectDirectory,
            }),
            "{broken-json",
            "",
          ].join(
            "\n",
          ),
          "utf8",
        );

        await expect(
          readSessionRecords(
            filePath,
          ),
        ).rejects.toThrow(
          `Unable to parse session line 2 in ${filePath}`,
        );
      },
    );
  },
);
