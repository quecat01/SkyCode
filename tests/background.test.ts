import {
  describe,
  expect,
  it,
} from "vitest";

import {
  BackgroundTaskRegistry,
  type BackgroundTaskLifecycleEvent,
} from "../src/background.ts";

import {
  HookRegistry,
  type NotificationHookEvent,
} from "../src/hooks.ts";

describe(
  "background task registry",
  () => {
    it(
      "tracks a task from start through progress and completion",
      async () => {
        const hookRegistry =
          new HookRegistry();

        const notifications:
          NotificationHookEvent[] = [];

        const events:
          BackgroundTaskLifecycleEvent[] = [];

        const lines:
          string[] = [];

        hookRegistry.register(
          "Notification",
          (
            event,
          ) => {
            notifications.push({
              ...event,
              metadata: {
                ...event.metadata,
              },
            });
          },
          {
            source:
              "background test",
          },
        );

        const registry =
          new BackgroundTaskRegistry({
            hookRegistry,
            createId:
              () =>
                "task-complete",
            reporter:
              (
                line,
                _task,
                event,
              ) => {
                lines.push(
                  line,
                );

                events.push(
                  event,
                );
              },
          });

        const handle =
          registry.start(
            "Complete example",
            async (
              context,
            ) => {
              await context
                .reportProgress(
                  "Halfway complete.",
                );

              return {
                value:
                  42,
              };
            },
          );

        expect(
          registry.countRunning(),
        ).toBe(
          1,
        );

        const result =
          await handle.done;

        expect(
          result.status,
        ).toBe(
          "completed",
        );

        expect(
          result.result,
        ).toEqual({
          value:
            42,
        });

        expect(
          registry.countRunning(),
        ).toBe(
          0,
        );

        expect(
          events,
        ).toEqual([
          "started",
          "progress",
          "completed",
        ]);

        expect(
          lines,
        ).toEqual([
          "[Task task-complete] Started: Complete example",
          "[Task task-complete] Progress: Halfway complete.",
          "[Task task-complete] Completed: Complete example",
        ]);

        expect(
          notifications.map(
            (
              event,
            ) =>
              event.metadata
                .event,
          ),
        ).toEqual([
          "background_task_started",
          "background_task_progress",
          "background_task_completed",
        ]);
      },
    );

    it(
      "records task failures without rejecting the completion promise",
      async () => {
        const registry =
          new BackgroundTaskRegistry({
            createId:
              () =>
                "task-failed",
          });

        const handle =
          registry.start(
            "Failing example",
            async () => {
              throw new Error(
                "Example failure.",
              );
            },
          );

        const result =
          await handle.done;

        expect(
          result.status,
        ).toBe(
          "failed",
        );

        expect(
          result.error,
        ).toBe(
          "Example failure.",
        );
      },
    );

    it(
      "cancels a running task through AbortSignal",
      async () => {
        let markRunnerStarted:
          (() => void) |
          undefined;

        const runnerStarted =
          new Promise<void>(
            (
              resolve,
            ) => {
              markRunnerStarted =
                resolve;
            },
          );

        const registry =
          new BackgroundTaskRegistry({
            createId:
              () =>
                "task-cancelled",
          });

        const handle =
          registry.start(
            "Cancellable example",
            async (
              context,
            ) => {
              markRunnerStarted?.();

              await new Promise<void>(
                (
                  _resolve,
                  reject,
                ) => {
                  context.signal
                    .addEventListener(
                      "abort",
                      () => {
                        reject(
                          new DOMException(
                            "Aborted",
                            "AbortError",
                          ),
                        );
                      },
                      {
                        once:
                          true,
                      },
                    );
                },
              );
            },
          );

        await runnerStarted;

        expect(
          handle.cancel(
            "Cancelled by test.",
          ),
        ).toBe(
          true,
        );

        const result =
          await handle.done;

        expect(
          result.status,
        ).toBe(
          "cancelled",
        );

        expect(
          result
            .cancellationReason,
        ).toBe(
          "Cancelled by test.",
        );

        expect(
          registry.countRunning(),
        ).toBe(
          0,
        );
      },
    );

    it(
      "lists running tasks and cancels all of them",
      async () => {
        let nextId =
          0;

        const registry =
          new BackgroundTaskRegistry({
            createId:
              () =>
                `task-${nextId += 1}`,
          });

        const createWaitingRunner =
          () =>
            async (
              context: {
                signal:
                  AbortSignal;
              },
            ): Promise<void> => {
              await new Promise<void>(
                (
                  _resolve,
                  reject,
                ) => {
                  context.signal
                    .addEventListener(
                      "abort",
                      () => {
                        reject(
                          new DOMException(
                            "Aborted",
                            "AbortError",
                          ),
                        );
                      },
                      {
                        once:
                          true,
                      },
                    );
                },
              );
            };

        registry.start(
          "First task",
          createWaitingRunner(),
        );

        registry.start(
          "Second task",
          createWaitingRunner(),
        );

        expect(
          registry.list(
            false,
          ).map(
            (
              task,
            ) =>
              task.label,
          ),
        ).toEqual([
          "First task",
          "Second task",
        ]);

        const cancelledTasks =
          await registry.cancelAll(
            "Test shutdown.",
          );

        expect(
          cancelledTasks.map(
            (
              task,
            ) =>
              task.status,
          ),
        ).toEqual([
          "cancelled",
          "cancelled",
        ]);

        expect(
          registry.countRunning(),
        ).toBe(
          0,
        );
      },
    );
  },
);
