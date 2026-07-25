import {
  describe,
  expect,
  it,
} from "vitest";

import {
  executeSkyToolRequestWithHooks,
  HOOK_NAMES,
  HookRegistry,
  isHookName,
  type PreToolUseHookEvent,
} from "../src/hooks.ts";

import type {
  ToolHandlers,
} from "../src/tools.ts";

describe(
  "hook registry",
  () => {
    it(
      "supports exactly the Phase 2 hook names",
      () => {
        expect(
          HOOK_NAMES,
        ).toEqual([
          "PreToolUse",
          "PostToolUse",
          "PreCompact",
          "PostCompact",
          "Notification",
        ]);

        for (
          const name of
          HOOK_NAMES
        ) {
          expect(
            isHookName(name),
          ).toBe(true);
        }

        expect(
          isHookName(
            "BeforeTool",
          ),
        ).toBe(false);
      },
    );

    it(
      "runs hooks sequentially in registration order",
      async () => {
        const registry =
          new HookRegistry();

        const executionOrder:
          string[] = [];

        registry.register(
          "Notification",
          async () => {
            executionOrder.push(
              "first-start",
            );

            await Promise.resolve();

            executionOrder.push(
              "first-end",
            );
          },
          {
            source:
              "first-hook",
          },
        );

        registry.register(
          "Notification",
          () => {
            executionOrder.push(
              "second",
            );
          },
          {
            source:
              "second-hook",
          },
        );

        await registry.run(
          "Notification",
          {
            level:
              "info",
            message:
              "Test notification",
            metadata: {},
          },
        );

        expect(
          executionOrder,
        ).toEqual([
          "first-start",
          "first-end",
          "second",
        ]);
      },
    );

    it(
      "allows pre-tool hooks to modify the shared event",
      async () => {
        const registry =
          new HookRegistry();

        registry.register(
          "PreToolUse",
          (
            event,
          ) => {
            event.cancelled =
              true;

            event.cancellationReason =
              "Blocked by test hook";

            event.metadata
              .reviewed =
              true;
          },
          {
            source:
              "blocking-hook",
          },
        );

        const event:
          PreToolUseHookEvent = {
            request: {
              tool:
                "read_file",
              args: {
                path:
                  "/tmp/example.txt",
              },
            },
            cancelled:
              false,
            metadata: {},
          };

        await registry.run(
          "PreToolUse",
          event,
        );

        expect(
          event.cancelled,
        ).toBe(true);

        expect(
          event.cancellationReason,
        ).toBe(
          "Blocked by test hook",
        );

        expect(
          event.metadata,
        ).toEqual({
          reviewed:
            true,
        });
      },
    );

    it(
      "unregisters an individual hook",
      async () => {
        const registry =
          new HookRegistry();

        let callCount = 0;

        const unregister =
          registry.register(
            "Notification",
            () => {
              callCount += 1;
            },
            {
              source:
                "temporary-hook",
            },
          );

        expect(
          registry.count(
            "Notification",
          ),
        ).toBe(1);

        unregister();

        expect(
          registry.count(
            "Notification",
          ),
        ).toBe(0);

        await registry.run(
          "Notification",
          {
            level:
              "info",
            message:
              "Ignored",
            metadata: {},
          },
        );

        expect(
          callCount,
        ).toBe(0);
      },
    );

    it(
      "reports hook failures with the hook name and source",
      async () => {
        const registry =
          new HookRegistry();

        registry.register(
          "PostToolUse",
          () => {
            throw new Error(
              "test failure",
            );
          },
          {
            source:
              "failing-plugin",
          },
        );

        await expect(
          registry.run(
            "PostToolUse",
            {
              request: {
                tool:
                  "read_file",
                args: {
                  path:
                    "/tmp/example.txt",
                },
              },
              result: {
                success:
                  true,
                output:
                  "example",
              },
              metadata: {},
            },
          ),
        ).rejects.toThrow(
          "Hook PostToolUse from failing-plugin failed: test failure",
        );
      },
    );

    it(
      "lists, counts, and clears registrations",
      () => {
        const registry =
          new HookRegistry();

        registry.register(
          "PreCompact",
          () => {},
          {
            source:
              "compact-plugin",
          },
        );

        registry.register(
          "Notification",
          () => {},
          {
            source:
              "notification-plugin",
          },
        );

        expect(
          registry.count(),
        ).toBe(2);

        expect(
          registry.list(),
        ).toEqual([
          {
            name:
              "PreCompact",
            source:
              "compact-plugin",
          },
          {
            name:
              "Notification",
            source:
              "notification-plugin",
          },
        ]);

        registry.clear();

        expect(
          registry.count(),
        ).toBe(0);

        expect(
          registry.list(),
        ).toEqual([]);
      },
    );
  },
);


describe(
  "hooked tool execution",
  () => {
    function createHandlers(
      readFileHandler:
        ToolHandlers["read_file"],
    ): ToolHandlers {
      return {
        read_file:
          readFileHandler,

        async write_file() {
          return {
            success:
              false,
            output:
              "write_file was not expected",
          };
        },

        async edit_file() {
          return {
            success:
              false,
            output:
              "edit_file was not expected",
          };
        },

        async run_shell_command() {
          return {
            success:
              false,
            output:
              "run_shell_command was not expected",
          };
        },

        async mcp_call() {
          return {
            success:
              false,
            output:
              "mcp_call was not expected",
          };
        },
      };
    }

    it(
      "fires PreToolUse before the tool and PostToolUse afterward",
      async () => {
        const registry =
          new HookRegistry();

        const executionOrder:
          string[] = [];

        registry.register(
          "PreToolUse",
          (
            event,
          ) => {
            executionOrder.push(
              "pre",
            );

            event.metadata
              .reviewed =
              true;
          },
          {
            source:
              "pre-test",
          },
        );

        registry.register(
          "PostToolUse",
          (
            event,
          ) => {
            executionOrder.push(
              "post",
            );

            expect(
              event.metadata,
            ).toEqual({
              reviewed:
                true,
            });

            event.result = {
              ...event.result,
              output:
                `${event.result.output} PostToolUse fired.`,
            };
          },
          {
            source:
              "post-test",
          },
        );

        const handlers =
          createHandlers(
            async () => {
              executionOrder.push(
                "tool",
              );

              return {
                success:
                  true,
                output:
                  "Tool completed.",
              };
            },
          );

        const result =
          await executeSkyToolRequestWithHooks(
            {
              tool:
                "read_file",
              args: {
                path:
                  "/tmp/example.txt",
              },
            },
            handlers,
            registry,
          );

        expect(
          executionOrder,
        ).toEqual([
          "pre",
          "tool",
          "post",
        ]);

        expect(
          result,
        ).toEqual({
          success:
            true,
          output:
            "Tool completed. PostToolUse fired.",
        });
      },
    );

    it(
      "prevents execution when PreToolUse cancels the request",
      async () => {
        const registry =
          new HookRegistry();

        let toolCalls = 0;
        let postHookCalls = 0;

        registry.register(
          "PreToolUse",
          (
            event,
          ) => {
            event.cancelled =
              true;

            event.cancellationReason =
              "Blocked by test policy";
          },
          {
            source:
              "blocking-hook",
          },
        );

        registry.register(
          "PostToolUse",
          () => {
            postHookCalls += 1;
          },
          {
            source:
              "post-hook",
          },
        );

        const handlers =
          createHandlers(
            async () => {
              toolCalls += 1;

              return {
                success:
                  true,
                output:
                  "This must not run.",
              };
            },
          );

        const result =
          await executeSkyToolRequestWithHooks(
            {
              tool:
                "read_file",
              args: {
                path:
                  "/tmp/blocked.txt",
              },
            },
            handlers,
            registry,
          );

        expect(
          toolCalls,
        ).toBe(0);

        expect(
          postHookCalls,
        ).toBe(0);

        expect(
          result,
        ).toEqual({
          success:
            false,
          output:
            "Tool read_file cancelled by PreToolUse hook: Blocked by test policy",
        });
      },
    );

    it(
      "fires PostToolUse after a tool returns an unsuccessful result",
      async () => {
        const registry =
          new HookRegistry();

        let postHookCalls = 0;

        registry.register(
          "PostToolUse",
          (
            event,
          ) => {
            postHookCalls += 1;

            expect(
              event.result.success,
            ).toBe(false);
          },
          {
            source:
              "failure-observer",
          },
        );

        const handlers =
          createHandlers(
            async () => ({
              success:
                false,
              output:
                "File could not be read.",
            }),
          );

        const result =
          await executeSkyToolRequestWithHooks(
            {
              tool:
                "read_file",
              args: {
                path:
                  "/tmp/missing.txt",
              },
            },
            handlers,
            registry,
          );

        expect(
          postHookCalls,
        ).toBe(1);

        expect(
          result,
        ).toEqual({
          success:
            false,
          output:
            "File could not be read.",
        });
      },
    );

    it(
      "preserves normal tool behaviour when no hooks are registered",
      async () => {
        const registry =
          new HookRegistry();

        const handlers =
          createHandlers(
            async (
              args,
            ) => ({
              success:
                true,
              output:
                `Read ${args.path}`,
            }),
          );

        const result =
          await executeSkyToolRequestWithHooks(
            {
              tool:
                "read_file",
              args: {
                path:
                  "/tmp/plain.txt",
              },
            },
            handlers,
            registry,
          );

        expect(
          result,
        ).toEqual({
          success:
            true,
          output:
            "Read /tmp/plain.txt",
        });
      },
    );
  },
);
