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
  runBackgroundShellCommand,
} from "../src/background-shell.ts";

describe(
  "background shell execution",
  () => {
    it(
      "runs a shell command and captures its output",
      async () => {
        const events:
          BackgroundTaskLifecycleEvent[] = [];

        const registry =
          new BackgroundTaskRegistry({
            createId:
              () =>
                "shell-success",
            reporter:
              (
                _line,
                _task,
                event,
              ) => {
                events.push(
                  event,
                );
              },
          });

        const handle =
          registry.start(
            "Successful shell command",
            async (
              context,
            ) =>
              runBackgroundShellCommand(
                "printf 'hello'; printf 'warning' >&2",
                process.cwd(),
                context,
                {
                  progressIntervalMs:
                    10,
                },
              ),
          );

        const snapshot =
          await handle.done;

        expect(
          snapshot.status,
        ).toBe(
          "completed",
        );

        expect(
          snapshot.result,
        ).toMatchObject({
          success:
            true,
          exitCode:
            0,
          stdout:
            "hello",
          stderr:
            "warning",
        });

        expect(
          events,
        ).toContain(
          "progress",
        );

        expect(
          events.at(
            0,
          ),
        ).toBe(
          "started",
        );

        expect(
          events.at(
            -1,
          ),
        ).toBe(
          "completed",
        );
      },
    );

    it(
      "marks a nonzero shell exit as a failed background task",
      async () => {
        const registry =
          new BackgroundTaskRegistry({
            createId:
              () =>
                "shell-failed",
          });

        const handle =
          registry.start(
            "Failing shell command",
            async (
              context,
            ) =>
              runBackgroundShellCommand(
                "printf 'failure text' >&2; exit 7",
                process.cwd(),
                context,
              ),
          );

        const snapshot =
          await handle.done;

        expect(
          snapshot.status,
        ).toBe(
          "failed",
        );

        expect(
          snapshot.error,
        ).toContain(
          "Exit code: 7",
        );

        expect(
          snapshot.error,
        ).toContain(
          "failure text",
        );
      },
    );

    it(
      "cancels a running shell command",
      async () => {
        const registry =
          new BackgroundTaskRegistry({
            createId:
              () =>
                "shell-cancelled",
          });

        const handle =
          registry.start(
            "Long shell command",
            async (
              context,
            ) =>
              runBackgroundShellCommand(
                "sleep 10",
                process.cwd(),
                context,
                {
                  progressIntervalMs:
                    10,
                },
              ),
          );

        await new Promise<void>(
          (
            resolve,
          ) => {
            setTimeout(
              resolve,
              50,
            );
          },
        );

        expect(
          handle.cancel(
            "Cancelled by shell test.",
          ),
        ).toBe(
          true,
        );

        const snapshot =
          await handle.done;

        expect(
          snapshot.status,
        ).toBe(
          "cancelled",
        );

        expect(
          snapshot
            .cancellationReason,
        ).toBe(
          "Cancelled by shell test.",
        );
      },
    );

    it(
      "stops commands that exceed the output limit",
      async () => {
        const registry =
          new BackgroundTaskRegistry({
            createId:
              () =>
                "shell-output-limit",
          });

        const handle =
          registry.start(
            "Large output command",
            async (
              context,
            ) =>
              runBackgroundShellCommand(
                "printf '1234567890'",
                process.cwd(),
                context,
                {
                  maximumOutputBytes:
                    5,
                },
              ),
          );

        const snapshot =
          await handle.done;

        expect(
          snapshot.status,
        ).toBe(
          "failed",
        );

        expect(
          snapshot.error,
        ).toContain(
          "output exceeded 5 bytes",
        );
      },
    );
  },
);
