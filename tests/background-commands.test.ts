import {
  describe,
  expect,
  it,
} from "vitest";

import {
  executeBackgroundTasksCommand,
  formatBackgroundTaskList,
  parseBackgroundTasksCommand,
} from "../src/background-commands.ts";

import type {
  BackgroundTaskSnapshot,
} from "../src/background.ts";

function createTask(
  overrides:
    Partial<
      BackgroundTaskSnapshot
    > = {},
): BackgroundTaskSnapshot {
  return {
    id:
      "task-1",

    label:
      "Shell: sleep 10",

    status:
      "running",

    startedAt:
      "2026-07-28T20:00:00.000Z",

    updatedAt:
      "2026-07-28T20:00:01.000Z",

    ...overrides,
  };
}

describe(
  "background task commands",
  () => {
    it(
      "ignores unrelated input",
      () => {
        expect(
          parseBackgroundTasksCommand(
            "/model",
          ),
        ).toBeNull();

        expect(
          parseBackgroundTasksCommand(
            "/tasksmith",
          ),
        ).toBeNull();
      },
    );

    it(
      "parses the task-list command",
      () => {
        expect(
          parseBackgroundTasksCommand(
            "  /tasks  ",
          ),
        ).toEqual({
          kind:
            "list",
        });
      },
    );

    it(
      "parses task cancellation",
      () => {
        expect(
          parseBackgroundTasksCommand(
            "/tasks cancel task-123",
          ),
        ).toEqual({
          kind:
            "cancel",

          id:
            "task-123",
        });
      },
    );

    it(
      "rejects cancellation without a task ID",
      () => {
        expect(
          parseBackgroundTasksCommand(
            "/tasks cancel",
          ),
        ).toEqual({
          kind:
            "invalid",

          message:
            "Usage: /tasks or /tasks cancel <task-id>",
        });
      },
    );

    it(
      "rejects cancellation with extra arguments",
      () => {
        expect(
          parseBackgroundTasksCommand(
            "/tasks cancel task-1 extra",
          ),
        ).toEqual({
          kind:
            "invalid",

          message:
            "Usage: /tasks or /tasks cancel <task-id>",
        });
      },
    );

    it(
      "rejects unsupported task subcommands",
      () => {
        expect(
          parseBackgroundTasksCommand(
            "/tasks remove task-1",
          ),
        ).toEqual({
          kind:
            "invalid",

          message:
            "Usage: /tasks or /tasks cancel <task-id>",
        });
      },
    );

    it(
      "formats an empty task registry",
      () => {
        expect(
          formatBackgroundTaskList(
            [],
          ),
        ).toBe(
          "No background tasks have been started in this session.",
        );
      },
    );

    it(
      "formats mixed task statuses and details",
      () => {
        expect(
          formatBackgroundTaskList([
            createTask({
              progressMessage:
                "Shell command has been running for 5 seconds.",
            }),

            createTask({
              id:
                "task-2",

              label:
                "Shell: echo done",

              status:
                "completed",
            }),

            createTask({
              id:
                "task-3",

              label:
                "Shell: false",

              status:
                "failed",

              error:
                "Exit code: 1",
            }),

            createTask({
              id:
                "task-4",

              label:
                "Shell: sleep 60",

              status:
                "cancelled",

              cancellationReason:
                "Cancelled by user.",
            }),
          ]),
        ).toBe(
          [
            "Background tasks: 4 total, 1 running",
            "[running] task-1 - Shell: sleep 10 - Shell command has been running for 5 seconds.",
            "[completed] task-2 - Shell: echo done - Completed successfully.",
            "[failed] task-3 - Shell: false - Exit code: 1",
            "[cancelled] task-4 - Shell: sleep 60 - Cancelled by user.",
          ].join(
            "\n",
          ),
        );
      },
    );

    it(
      "executes the task-list command",
      () => {
        const task =
          createTask();

        const result =
          executeBackgroundTasksCommand(
            {
              kind:
                "list",
            },
            {
              list:
                () => [
                  task,
                ],

              get:
                () =>
                  null,

              cancel:
                () =>
                  false,
            },
          );

        expect(
          result,
        ).toContain(
          "Background tasks: 1 total, 1 running",
        );

        expect(
          result,
        ).toContain(
          task.id,
        );
      },
    );

    it(
      "returns invalid command usage",
      () => {
        expect(
          executeBackgroundTasksCommand(
            {
              kind:
                "invalid",

              message:
                "Usage message",
            },
            {
              list:
                () => [],

              get:
                () =>
                  null,

              cancel:
                () =>
                  false,
            },
          ),
        ).toBe(
          "Usage message",
        );
      },
    );

    it(
      "reports an unknown task ID",
      () => {
        expect(
          executeBackgroundTasksCommand(
            {
              kind:
                "cancel",

              id:
                "missing-task",
            },
            {
              list:
                () => [],

              get:
                () =>
                  null,

              cancel:
                () =>
                  false,
            },
          ),
        ).toBe(
          'Background task "missing-task" was not found.',
        );
      },
    );

    it(
      "does not cancel a finished task",
      () => {
        let cancelCalled =
          false;

        expect(
          executeBackgroundTasksCommand(
            {
              kind:
                "cancel",

              id:
                "task-1",
            },
            {
              list:
                () => [],

              get:
                () =>
                  createTask({
                    status:
                      "completed",
                  }),

              cancel:
                () => {
                  cancelCalled =
                    true;

                  return true;
                },
            },
          ),
        ).toBe(
          'Background task "task-1" is already completed.',
        );

        expect(
          cancelCalled,
        ).toBe(
          false,
        );
      },
    );

    it(
      "requests cancellation for a running task",
      () => {
        const calls:
          Array<{
            id:
              string;

            reason:
              string |
              undefined;
          }> = [];

        expect(
          executeBackgroundTasksCommand(
            {
              kind:
                "cancel",

              id:
                "task-1",
            },
            {
              list:
                () => [],

              get:
                () =>
                  createTask(),

              cancel:
                (
                  id,
                  reason,
                ) => {
                  calls.push({
                    id,
                    reason,
                  });

                  return true;
                },
            },
          ),
        ).toBe(
          'Cancellation requested for background task "task-1".',
        );

        expect(
          calls,
        ).toEqual([
          {
            id:
              "task-1",

            reason:
              "Cancellation requested by the user.",
          },
        ]);
      },
    );

    it(
      "reports a cancellation race",
      () => {
        expect(
          executeBackgroundTasksCommand(
            {
              kind:
                "cancel",

              id:
                "task-1",
            },
            {
              list:
                () => [],

              get:
                () =>
                  createTask(),

              cancel:
                () =>
                  false,
            },
          ),
        ).toBe(
          'Unable to cancel background task "task-1".',
        );
      },
    );

  },
);
