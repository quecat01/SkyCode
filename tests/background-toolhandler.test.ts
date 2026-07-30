import {
  describe,
  expect,
  it,
} from "vitest";

import {
  BackgroundTaskRegistry,
} from "../src/background.ts";

import {
  createSkyCodeToolHandlers,
} from "../src/toolhandlers.ts";

import {
  parseSkyToolRequest,
} from "../src/tools.ts";

async function waitForTaskToFinish(
  registry:
    BackgroundTaskRegistry,
  id: string,
): Promise<void> {
  for (
    let attempt = 0;
    attempt < 200;
    attempt += 1
  ) {
    const task =
      registry.get(
        id,
      );

    if (
      task &&
      task.status !==
        "running"
    ) {
      return;
    }

    await new Promise<void>(
      (
        resolve,
      ) => {
        setTimeout(
          resolve,
          10,
        );
      },
    );
  }

  throw new Error(
    `Background task ${id} did not finish during the test.`,
  );
}

describe(
  "background shell tool handling",
  () => {
    it(
      "parses the optional background setting",
      () => {
        const request =
          parseSkyToolRequest(
            [
              "```sky-tool",
              JSON.stringify({
                tool:
                  "run_shell_command",
                args: {
                  command:
                    "sleep 1",
                  background:
                    true,
                },
              }),
              "```",
            ].join(
              "\n",
            ),
          );

        expect(
          request,
        ).toEqual({
          tool:
            "run_shell_command",
          args: {
            command:
              "sleep 1",
            background:
              true,
          },
        });

        expect(
          () =>
            parseSkyToolRequest(
              [
                "```sky-tool",
                JSON.stringify({
                  tool:
                    "run_shell_command",
                  args: {
                    command:
                      "sleep 1",
                    background:
                      "yes",
                  },
                }),
                "```",
              ].join(
                "\n",
              ),
            ),
        ).toThrow(
          'Tool argument "background" must be a boolean',
        );
      },
    );

    it(
      "starts a background shell command and returns immediately",
      async () => {
        const registry =
          new BackgroundTaskRegistry({
            createId:
              () =>
                "handler-complete",
          });

        const handlers =
          createSkyCodeToolHandlers(
            process.cwd(),
            [],
            undefined,
            {
              getMode:
                () =>
                  "bypass",
            },
            {
              registry,
            },
          );

        const result =
          await handlers
            .run_shell_command({
              command:
                "sleep 0.2; printf 'background complete'",
              background:
                true,
            });

        expect(
          result.success,
        ).toBe(
          true,
        );

        expect(
          result.output,
        ).toContain(
          "Task ID: handler-complete",
        );

        expect(
          registry.get(
            "handler-complete",
          )?.status,
        ).toBe(
          "running",
        );

        await waitForTaskToFinish(
          registry,
          "handler-complete",
        );

        const finishedTask =
          registry.get(
            "handler-complete",
          );

        expect(
          finishedTask?.status,
        ).toBe(
          "completed",
        );

        expect(
          finishedTask?.result,
        ).toMatchObject({
          stdout:
            "background complete",
          exitCode:
            0,
        });
      },
    );

    it(
      "allows a background shell task to be cancelled",
      async () => {
        const registry =
          new BackgroundTaskRegistry({
            createId:
              () =>
                "handler-cancel",
          });

        const handlers =
          createSkyCodeToolHandlers(
            process.cwd(),
            [],
            undefined,
            {
              getMode:
                () =>
                  "bypass",
            },
            {
              registry,
            },
          );

        const result =
          await handlers
            .run_shell_command({
              command:
                "sleep 10",
              background:
                true,
            });

        expect(
          result.success,
        ).toBe(
          true,
        );

        expect(
          registry.cancel(
            "handler-cancel",
            "Cancelled by handler test.",
          ),
        ).toBe(
          true,
        );

        await waitForTaskToFinish(
          registry,
          "handler-cancel",
        );

        expect(
          registry.get(
            "handler-cancel",
          )?.status,
        ).toBe(
          "cancelled",
        );
      },
    );

    it(
      "does not start a denied background command",
      async () => {
        const registry =
          new BackgroundTaskRegistry({
            createId:
              () =>
                "handler-denied",
          });

        const handlers =
          createSkyCodeToolHandlers(
            process.cwd(),
            [],
            undefined,
            {
              getMode:
                () =>
                  "default",

              approvalPrompt:
                async () =>
                  false,
            },
            {
              registry,
            },
          );

        const result =
          await handlers
            .run_shell_command({
              command:
                "printf 'not run'",
              background:
                true,
            });

        expect(
          result,
        ).toEqual({
          success:
            false,
          output:
            "Permission denied. Sky Code did not start the background command.",
        });

        expect(
          registry.list(),
        ).toEqual([]);
      },
    );

    it(
      "keeps foreground shell execution unchanged",
      async () => {
        const registry =
          new BackgroundTaskRegistry();

        const handlers =
          createSkyCodeToolHandlers(
            process.cwd(),
            [],
            undefined,
            {
              getMode:
                () =>
                  "bypass",
            },
            {
              registry,
            },
          );

        const result =
          await handlers
            .run_shell_command({
              command:
                "printf 'foreground complete'",
            });

        expect(
          result.success,
        ).toBe(
          true,
        );

        expect(
          result.output,
        ).toContain(
          "foreground complete",
        );

        expect(
          registry.list(),
        ).toEqual([]);
      },
    );
  },
);
