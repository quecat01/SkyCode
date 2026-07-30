import {
  describe,
  expect,
  it,
} from "vitest";

import {
  formatResumableSessionSummary,
  parseSessionResumeSelection,
  promptForSessionResume,
  type SessionResumePromptIO,
} from "../src/session-resume-prompt.ts";

import type {
  ResumableSession,
} from "../src/session-resume.ts";

function createSession():
  ResumableSession {
  return {
    filePath:
      "/tmp/session.jsonl",

    sessionId:
      "resume-session-id",

    workingDirectory:
      "~/sky-code",

    startedAt:
      "2026-07-28T20:00:00.000Z",

    updatedAt:
      "2026-07-28T21:00:00.000Z",

    model:
      "chatgpt-gpt-5.5",

    recordCount:
      8,

    messages: [
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
    ],
  };
}

function createPromptIO(
  answers:
    readonly string[],
): {
  io:
    SessionResumePromptIO;

  output:
    string[];

  prompts:
    string[];
} {
  const output:
    string[] = [];

  const prompts:
    string[] = [];

  let answerIndex =
    0;

  return {
    output,
    prompts,

    io: {
      async question(
        prompt:
          string,
      ): Promise<string> {
        prompts.push(
          prompt,
        );

        const answer =
          answers[
            answerIndex
          ];

        answerIndex +=
          1;

        return answer ??
          "";
      },

      write(
        line:
          string,
      ): void {
        output.push(
          line,
        );
      },
    },
  };
}

describe(
  "session resume startup prompt",
  () => {
    it(
      "formats the previous session details and both choices",
      () => {
        expect(
          formatResumableSessionSummary(
            createSession(),
          ),
        ).toEqual([
          "Previous Sky Code session found for this directory.",
          "Last updated: 2026-07-28T21:00:00.000Z",
          "Stored conversation messages: 2",
          "Previous model: chatgpt-gpt-5.5",
          "",
          "1. Resume the previous session",
          "2. Start fresh",
        ]);
      },
    );

    it(
      "accepts resume selections",
      () => {
        expect(
          parseSessionResumeSelection(
            "1",
          ),
        ).toBe(
          "resume",
        );

        expect(
          parseSessionResumeSelection(
            "resume",
          ),
        ).toBe(
          "resume",
        );

        expect(
          parseSessionResumeSelection(
            "R",
          ),
        ).toBe(
          "resume",
        );
      },
    );

    it(
      "accepts fresh selections and defaults Enter to fresh",
      () => {
        expect(
          parseSessionResumeSelection(
            "2",
          ),
        ).toBe(
          "fresh",
        );

        expect(
          parseSessionResumeSelection(
            "fresh",
          ),
        ).toBe(
          "fresh",
        );

        expect(
          parseSessionResumeSelection(
            "",
          ),
        ).toBe(
          "fresh",
        );
      },
    );

    it(
      "prompts and returns resume",
      async () => {
        const {
          io,
          output,
          prompts,
        } =
          createPromptIO([
            "1",
          ]);

        await expect(
          promptForSessionResume(
            createSession(),
            io,
          ),
        ).resolves.toBe(
          "resume",
        );

        expect(
          output,
        ).toContain(
          "Previous Sky Code session found for this directory.",
        );

        expect(
          prompts,
        ).toEqual([
          "Enter 1 to resume, or 2 to start fresh [2]: ",
        ]);
      },
    );

    it(
      "rejects an invalid answer and asks again",
      async () => {
        const {
          io,
          output,
          prompts,
        } =
          createPromptIO([
            "invalid",
            "2",
          ]);

        await expect(
          promptForSessionResume(
            createSession(),
            io,
          ),
        ).resolves.toBe(
          "fresh",
        );

        expect(
          output,
        ).toContain(
          "Invalid selection. Enter 1 to resume or 2 to start fresh.",
        );

        expect(
          prompts,
        ).toHaveLength(
          2,
        );
      },
    );
  },
);
