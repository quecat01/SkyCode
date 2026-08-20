import {
  describe,
  expect,
  it,
} from "vitest";

import {
  createBackgroundTerminalReporter,
  type BackgroundTerminalOutput,
} from "../src/background-terminal.ts";

import type {
  BackgroundTaskSnapshot,
} from "../src/background.ts";

function createTask():
  BackgroundTaskSnapshot {
  return {
    id:
      "task-test",
    label:
      "Test task",
    status:
      "running",
    startedAt:
      "2026-07-25T20:00:00.000Z",
    updatedAt:
      "2026-07-25T20:00:01.000Z",
    progressMessage:
      "Working.",
  };
}

function createOutput(
  isTTY:
    boolean,
): {
  output:
    BackgroundTerminalOutput;
  getText():
    string;
} {
  let text =
    "";

  return {
    output: {
      isTTY,

      write(
        chunk:
          string |
          Uint8Array,
      ): boolean {
        text +=
          typeof chunk ===
            "string"
            ? chunk
            : Buffer.from(
                chunk,
              ).toString(
                "utf8",
              );

        return true;
      },
    },

    getText:
      () =>
        text,
  };
}

describe(
  "background terminal reporter",
  () => {
    it(
      "prints a normal status line when no prompt is active",
      async () => {
        const target =
          createOutput(
            true,
          );

        const reporter =
          createBackgroundTerminalReporter({
            output:
              target.output,
            isPromptActive:
              () =>
                false,
            getCurrentInput:
              () =>
                "",
          });

        await reporter(
          "[Task task-test] Started: Test task",
          createTask(),
          "started",
        );

        expect(
          target.getText(),
        ).toBe(
          "[Task task-test] Started: Test task\n",
        );
      },
    );

    it(
      "clears and redraws an active TTY prompt",
      async () => {
        const target =
          createOutput(
            true,
          );

        const reporter =
          createBackgroundTerminalReporter({
            output:
              target.output,
            isPromptActive:
              () =>
                true,
            getCurrentInput:
              () =>
                "partially typed",
          });

        await reporter(
          "[Task task-test] Progress: Working.",
          createTask(),
          "progress",
        );

        expect(
          target.getText(),
        ).toBe(
          "\r\u001b[2K" +
          "[Task task-test] Progress: Working.\n" +
          "You ❯ partially typed",
        );
      },
    );

    it(
      "uses a newline instead of terminal control codes for non-TTY output",
      async () => {
        const target =
          createOutput(
            false,
          );

        const reporter =
          createBackgroundTerminalReporter({
            output:
              target.output,
            isPromptActive:
              () =>
                true,
            getCurrentInput:
              () =>
                "draft",
            promptText:
              "Input: ",
          });

        await reporter(
          "[Task task-test] Completed: Test task",
          {
            ...createTask(),
            status:
              "completed",
          },
          "completed",
        );

        expect(
          target.getText(),
        ).toBe(
          "\n" +
          "[Task task-test] Completed: Test task\n" +
          "Input: draft",
        );
      },
    );
      it(
        "queues status lines while foreground output is active",
        async () => {
          const target =
            createOutput(
              true,
            );

          let outputActive =
            true;

          const reporter =
            createBackgroundTerminalReporter({
              output:
                target.output,
              isPromptActive:
                () =>
                  false,
              getCurrentInput:
                () =>
                  "",
              isOutputActive:
                () =>
                  outputActive,
            });

          await reporter(
            "[Task task-test] Progress: Working.",
            createTask(),
            "progress",
          );

          expect(
            target.getText(),
          ).toBe(
            "",
          );

          outputActive =
            false;

          await reporter
            .flushPending();

          expect(
            target.getText(),
          ).toBe(
            "[Task task-test] Progress: Working.\n",
          );
        },
      );

      it(
        "flushes queued lines in order with one prompt redraw",
        async () => {
          const target =
            createOutput(
              true,
            );

          let outputActive =
            true;

          const reporter =
            createBackgroundTerminalReporter({
              output:
                target.output,
              isPromptActive:
                () =>
                  true,
              getCurrentInput:
                () =>
                  "draft",
              isOutputActive:
                () =>
                  outputActive,
            });

          await reporter(
            "[Task task-test] Started: Test task",
            createTask(),
            "started",
          );

          await reporter(
            "[Task task-test] Progress: Working.",
            createTask(),
            "progress",
          );

          outputActive =
            false;

          await reporter
            .flushPending();

          expect(
            target.getText(),
          ).toBe(
            "\r\u001b[2K" +
            "[Task task-test] Started: Test task\n" +
            "[Task task-test] Progress: Working.\n" +
            "You ❯ draft",
          );
        },
      );

      it(
        "delegates active prompt restoration to readline",
        async () => {
          const target =
            createOutput(
              true,
            );

          let redrawCount =
            0;

          const reporter =
            createBackgroundTerminalReporter({
              output:
                target.output,
              isPromptActive:
                () =>
                  true,
              getCurrentInput:
                () =>
                  "must not be printed manually",
              redrawPrompt:
                () => {
                  redrawCount +=
                    1;
                },
            });

          await reporter(
            "[Task task-test] Progress: Working.",
            createTask(),
            "progress",
          );

          expect(
            target.getText(),
          ).toBe(
            "\r\u001b[2K" +
            "[Task task-test] Progress: Working.\n",
          );

          expect(
            redrawCount,
          ).toBe(
            1,
          );
        },
      );

  },
);
