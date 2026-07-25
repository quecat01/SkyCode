import {
  access,
  mkdtemp,
  readFile,
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

import type {
  PermissionMode,
} from "../src/config.ts";

import {
  createSkyCodeToolHandlers,
} from "../src/toolhandlers.ts";

describe(
  "permission-aware tool handlers",
  () => {
    let testDirectory:
      string;

    let activeMode:
      PermissionMode;

    let promptCount:
      number;

    beforeEach(
      async () => {
        testDirectory =
          await mkdtemp(
            join(
              tmpdir(),
              "sky-code-permission-handlers-",
            ),
          );

        activeMode =
          "default";

        promptCount = 0;
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

    function createHandlers(
      approvalResult:
        boolean = false,
    ) {
      return createSkyCodeToolHandlers(
        testDirectory,
        [],
        undefined,
        {
          getMode:
            () =>
              activeMode,

          approvalPrompt:
            async () => {
              promptCount += 1;

              return approvalResult;
            },
        },
      );
    }

    it(
      "preserves prompts for file changes and shell commands in default mode",
      async () => {
        const handlers =
          createHandlers(
            false,
          );

        const writeResult =
          await handlers
            .write_file({
              path:
                "default.txt",
              content:
                "blocked",
            });

        const shellResult =
          await handlers
            .run_shell_command({
              command:
                "touch default-shell.txt",
            });

        expect(
          promptCount,
        ).toBe(2);

        expect(
          writeResult.success,
        ).toBe(false);

        expect(
          shellResult.success,
        ).toBe(false);

        await expect(
          access(
            join(
              testDirectory,
              "default.txt",
            ),
          ),
        ).rejects.toThrow();

        await expect(
          access(
            join(
              testDirectory,
              "default-shell.txt",
            ),
          ),
        ).rejects.toThrow();
      },
    );

    it(
      "auto-accepts file changes but still prompts for shell commands",
      async () => {
        activeMode =
          "auto-accept-edits";

        const handlers =
          createHandlers(
            false,
          );

        const writeResult =
          await handlers
            .write_file({
              path:
                "auto.txt",
              content:
                "old",
            });

        const editResult =
          await handlers
            .edit_file({
              path:
                "auto.txt",
              old_str:
                "old",
              new_str:
                "new",
            });

        const shellResult =
          await handlers
            .run_shell_command({
              command:
                "touch auto-shell.txt",
            });

        expect(
          writeResult.success,
        ).toBe(true);

        expect(
          editResult.success,
        ).toBe(true);

        expect(
          await readFile(
            join(
              testDirectory,
              "auto.txt",
            ),
            "utf8",
          ),
        ).toBe(
          "new",
        );

        expect(
          promptCount,
        ).toBe(1);

        expect(
          shellResult.success,
        ).toBe(false);
      },
    );

    it(
      "describes every tool without executing anything in plan mode",
      async () => {
        activeMode =
          "plan";

        const handlers =
          createHandlers();

        const markerPath =
          join(
            testDirectory,
            "plan-marker.txt",
          );

        const results =
          await Promise.all([
            handlers.read_file({
              path:
                "missing.txt",
            }),

            handlers.write_file({
              path:
                "write.txt",
              content:
                "content",
            }),

            handlers.edit_file({
              path:
                "missing-edit.txt",
              old_str:
                "old",
              new_str:
                "new",
            }),

            handlers.run_shell_command({
              command:
                `touch ${JSON.stringify(markerPath)}`,
            }),

            handlers.mcp_call?.({
              server:
                "missing-server",
              name:
                "missing-tool",
              arguments: {},
            }),

            handlers.delegate_to_agent?.({
              agent:
                "missing-agent",
              task:
                "Do not start.",
            }),
          ]);

        expect(
          promptCount,
        ).toBe(0);

        for (
          const result of
          results
        ) {
          expect(
            result?.success,
          ).toBe(true);

          expect(
            result?.output,
          ).toContain(
            "Plan mode:",
          );
        }

        await expect(
          access(
            markerPath,
          ),
        ).rejects.toThrow();

        await expect(
          access(
            join(
              testDirectory,
              "write.txt",
            ),
          ),
        ).rejects.toThrow();
      },
    );

    it(
      "executes file changes and shell commands without prompting in bypass mode",
      async () => {
        activeMode =
          "bypass";

        const handlers =
          createHandlers();

        await handlers
          .write_file({
            path:
              "bypass.txt",
            content:
              "old",
          });

        await handlers
          .edit_file({
            path:
              "bypass.txt",
            old_str:
              "old",
            new_str:
              "new",
          });

        const shellResult =
          await handlers
            .run_shell_command({
              command:
                "printf shell-ok > bypass-shell.txt",
            });

        expect(
          promptCount,
        ).toBe(0);

        expect(
          shellResult.success,
        ).toBe(true);

        expect(
          await readFile(
            join(
              testDirectory,
              "bypass.txt",
            ),
            "utf8",
          ),
        ).toBe(
          "new",
        );

        expect(
          await readFile(
            join(
              testDirectory,
              "bypass-shell.txt",
            ),
            "utf8",
          ),
        ).toBe(
          "shell-ok",
        );
      },
    );

    it(
      "uses a changed permission mode immediately without recreating handlers",
      async () => {
        const handlers =
          createHandlers();

        const targetPath =
          join(
            testDirectory,
            "dynamic.txt",
          );

        activeMode =
          "plan";

        const planned =
          await handlers
            .write_file({
              path:
                "dynamic.txt",
              content:
                "created",
            });

        expect(
          planned.output,
        ).toContain(
          "Plan mode:",
        );

        await expect(
          access(
            targetPath,
          ),
        ).rejects.toThrow();

        activeMode =
          "bypass";

        const executed =
          await handlers
            .write_file({
              path:
                "dynamic.txt",
              content:
                "created",
            });

        expect(
          executed.success,
        ).toBe(true);

        expect(
          await readFile(
            targetPath,
            "utf8",
          ),
        ).toBe(
          "created",
        );

        expect(
          promptCount,
        ).toBe(0);
      },
    );
  },
);
