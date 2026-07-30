import {
  describe,
  expect,
  it,
} from "vitest";

import {
  createBackgroundSessionReporter,
} from "../src/background-session.ts";

import type {
  BackgroundTaskLifecycleEvent,
  BackgroundTaskSnapshot,
} from "../src/background.ts";

import type {
  SessionLogger,
  SessionRecordInput,
} from "../src/session.ts";

function createLogger(
  records:
    SessionRecordInput[],
): SessionLogger {
  return {
    sessionId:
      "background-session-test",

    filePath:
      "/tmp/background-session-test.jsonl",

    append:
      async (
        record,
      ): Promise<void> => {
        records.push(
          record,
        );
      },
  };
}

function createTask(
  overrides:
    Partial<
      BackgroundTaskSnapshot
    > = {},
): BackgroundTaskSnapshot {
  return {
    id:
      "task-123",

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

async function recordEvent(
  event:
    BackgroundTaskLifecycleEvent,
  task:
    BackgroundTaskSnapshot,
  line:
    string,
): Promise<
  SessionRecordInput
> {
  const records:
    SessionRecordInput[] = [];

  const reporter =
    createBackgroundSessionReporter(
      createLogger(
        records,
      ),
    );

  await reporter(
    line,
    task,
    event,
  );

  expect(
    records,
  ).toHaveLength(
    1,
  );

  return records[0]!;
}

describe(
  "background task session reporter",
  () => {
    it(
      "records a started event",
      async () => {
        const record =
          await recordEvent(
            "started",
            createTask(),
            "[Task task-123] Started: Shell: sleep 10",
          );

        expect(
          record,
        ).toEqual({
          type:
            "background_task",

          role:
            "system",

          content:
            "[Task task-123] Started: Shell: sleep 10",

          backgroundEvent:
            "started",

          taskId:
            "task-123",

          taskLabel:
            "Shell: sleep 10",

          taskStatus:
            "running",

          taskStartedAt:
            "2026-07-28T20:00:00.000Z",

          taskUpdatedAt:
            "2026-07-28T20:00:01.000Z",

          taskCompletedAt:
            undefined,

          progressMessage:
            undefined,

          error:
            undefined,

          cancellationReason:
            undefined,
        });
      },
    );

    it(
      "records a progress event",
      async () => {
        const record =
          await recordEvent(
            "progress",
            createTask({
              updatedAt:
                "2026-07-28T20:00:05.000Z",

              progressMessage:
                "Shell command has been running for 5 seconds.",
            }),
            "[Task task-123] Progress: Shell command has been running for 5 seconds.",
          );

        expect(
          record,
        ).toMatchObject({
          type:
            "background_task",

          backgroundEvent:
            "progress",

          taskStatus:
            "running",

          taskUpdatedAt:
            "2026-07-28T20:00:05.000Z",

          progressMessage:
            "Shell command has been running for 5 seconds.",
        });
      },
    );

    it(
      "records a completed event",
      async () => {
        const record =
          await recordEvent(
            "completed",
            createTask({
              status:
                "completed",

              updatedAt:
                "2026-07-28T20:00:10.000Z",

              completedAt:
                "2026-07-28T20:00:10.000Z",

              result: {
                exitCode:
                  0,
              },
            }),
            "[Task task-123] Completed: Shell: sleep 10",
          );

        expect(
          record,
        ).toMatchObject({
          backgroundEvent:
            "completed",

          taskStatus:
            "completed",

          taskCompletedAt:
            "2026-07-28T20:00:10.000Z",
        });
      },
    );

    it(
      "records a failed event",
      async () => {
        const record =
          await recordEvent(
            "failed",
            createTask({
              status:
                "failed",

              updatedAt:
                "2026-07-28T20:00:03.000Z",

              completedAt:
                "2026-07-28T20:00:03.000Z",

              error:
                "Exit code: 1",
            }),
            "[Task task-123] Failed: Exit code: 1",
          );

        expect(
          record,
        ).toMatchObject({
          backgroundEvent:
            "failed",

          taskStatus:
            "failed",

          error:
            "Exit code: 1",
        });
      },
    );

    it(
      "records a cancelled event",
      async () => {
        const record =
          await recordEvent(
            "cancelled",
            createTask({
              status:
                "cancelled",

              updatedAt:
                "2026-07-28T20:00:04.000Z",

              completedAt:
                "2026-07-28T20:00:04.000Z",

              cancellationReason:
                "Cancellation requested by the user.",
            }),
            "[Task task-123] Cancelled: Cancellation requested by the user.",
          );

        expect(
          record,
        ).toMatchObject({
          backgroundEvent:
            "cancelled",

          taskStatus:
            "cancelled",

          cancellationReason:
            "Cancellation requested by the user.",
        });
      },
    );
  },
);
