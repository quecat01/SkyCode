import {
  describe,
  expect,
  it,
} from "vitest";

import {
  createLiveToolExecutor,
} from "../src/agent/adapters/tool-executor.ts";

import {
  HookRegistry,
} from "../src/hooks.ts";

import type {
  PausableReadline,
} from "../src/agent/adapters/tool-executor.ts";

import type {
  ToolExecutionResult,
  ToolHandlers,
} from "../src/tools.ts";

/**
 * A minimal ToolHandlers fake covering every required method. Each required
 * method throws unless overridden, so a test only needs to supply the
 * handler it actually exercises.
 */
function fakeToolHandlers(
  overrides: Partial<ToolHandlers>,
): ToolHandlers {
  const notUsed = (
    name: string,
  ) => {
    return async (): Promise<ToolExecutionResult> => {
      throw new Error(
        `fakeToolHandlers.${name} was not expected to be called in this test`,
      );
    };
  };

  return {
    read_file: notUsed("read_file"),
    write_file: notUsed("write_file"),
    edit_file: notUsed("edit_file"),
    run_shell_command: notUsed("run_shell_command"),
    create_docx: notUsed("create_docx"),
    create_xlsx: notUsed("create_xlsx"),
    create_pdf: notUsed("create_pdf"),
    create_pptx: notUsed("create_pptx"),
    ...overrides,
  };
}

/** A PausableReadline fake recording every pause()/resume() call in order. */
function fakeReadline(): PausableReadline & {
  calls: string[];
} {
  const calls: string[] = [];

  return {
    calls,
    pause() {
      calls.push(
        "pause",
      );
    },
    resume() {
      calls.push(
        "resume",
      );
    },
  };
}

describe(
  "agent/adapters/tool-executor.ts createLiveToolExecutor",
  () => {
    it(
      "executes a valid tool call through the real handlers and hook registry, pausing and resuming readline around it",
      async () => {
        const handlers = fakeToolHandlers({
          async write_file(args) {
            expect(args).toEqual({
              path: "notes.md",
              content: "hello",
            });

            return {
              success: true,
              output: "Wrote notes.md",
            };
          },
        });

        const readline = fakeReadline();

        const executor = createLiveToolExecutor(
          handlers,
          new HookRegistry(),
          readline,
          {},
        );

        const result = await executor.execute(
          "write_file",
          {
            path: "notes.md",
            content: "hello",
          },
        );

        expect(result).toEqual({
          success: true,
          output: "Wrote notes.md",
        });

        expect(readline.calls).toEqual([
          "pause",
          "resume",
        ]);
      },
    );

    it(
      "returns a failed result without touching handlers or readline when the request fails validation",
      async () => {
        const handlers = fakeToolHandlers({});
        const readline = fakeReadline();

        const executor = createLiveToolExecutor(
          handlers,
          new HookRegistry(),
          readline,
          {},
        );

        // write_file requires "content"; omitting it must fail
        // validateSkyToolRequest before any handler or readline call.
        const result = await executor.execute(
          "write_file",
          {
            path: "notes.md",
          },
        );

        expect(result.success).toBe(
          false,
        );

        expect(result.output.length).toBeGreaterThan(
          0,
        );

        expect(readline.calls).toEqual(
          [],
        );
      },
    );

    it(
      "returns a failed result for an unknown tool name without touching handlers or readline",
      async () => {
        const handlers = fakeToolHandlers({});
        const readline = fakeReadline();

        const executor = createLiveToolExecutor(
          handlers,
          new HookRegistry(),
          readline,
          {},
        );

        const result = await executor.execute(
          "not_a_real_tool",
          {},
        );

        expect(result.success).toBe(
          false,
        );

        expect(readline.calls).toEqual(
          [],
        );
      },
    );

    it(
      "sets endsTurn on a successful background run_shell_command result",
      async () => {
        const handlers = fakeToolHandlers({
          async run_shell_command(args) {
            expect(args.background).toBe(
              true,
            );

            return {
              success: true,
              output: "Started in background (pid 1234)",
            };
          },
        });

        const executor = createLiveToolExecutor(
          handlers,
          new HookRegistry(),
          fakeReadline(),
          {},
        );

        const result = await executor.execute(
          "run_shell_command",
          {
            command: "long-task &",
            background: true,
          },
        );

        expect(result).toEqual({
          success: true,
          output: "Started in background (pid 1234)",
          endsTurn: true,
        });
      },
    );

    it(
      "omits endsTurn for a foreground shell command",
      async () => {
        const handlers = fakeToolHandlers({
          async run_shell_command() {
            return {
              success: true,
              output: "done",
            };
          },
        });

        const executor = createLiveToolExecutor(
          handlers,
          new HookRegistry(),
          fakeReadline(),
          {},
        );

        const result = await executor.execute(
          "run_shell_command",
          {
            command: "echo hi",
          },
        );

        expect(result).toEqual({
          success: true,
          output: "done",
        });

        expect(result.endsTurn).toBeUndefined();
      },
    );

    it(
      "omits endsTurn for a failed background run_shell_command result",
      async () => {
        const handlers = fakeToolHandlers({
          async run_shell_command() {
            return {
              success: false,
              output: "could not start background process",
            };
          },
        });

        const executor = createLiveToolExecutor(
          handlers,
          new HookRegistry(),
          fakeReadline(),
          {},
        );

        const result = await executor.execute(
          "run_shell_command",
          {
            command: "long-task &",
            background: true,
          },
        );

        expect(result).toEqual({
          success: false,
          output: "could not start background process",
        });

        expect(result.endsTurn).toBeUndefined();
      },
    );

    it(
      "omits verified when the handler itself does not report it",
      async () => {
        const handlers = fakeToolHandlers({
          async create_docx() {
            return {
              success: true,
              output: "Created report.docx",
            };
          },
        });

        const executor = createLiveToolExecutor(
          handlers,
          new HookRegistry(),
          fakeReadline(),
          {},
        );

        const result = await executor.execute(
          "create_docx",
          {
            path: "report.docx",
            content: "# Report",
          },
        );

        expect(result.verified).toBeUndefined();
      },
    );

    it(
      "passes verified: true through exactly when the handler itself reports it",
      async () => {
        const handlers = fakeToolHandlers({
          async create_docx() {
            return {
              success: true,
              output: "Created report.docx",
              verified: true,
            };
          },
        });

        const executor = createLiveToolExecutor(
          handlers,
          new HookRegistry(),
          fakeReadline(),
          {},
        );

        const result = await executor.execute(
          "create_docx",
          {
            path: "report.docx",
            content: "# Report",
          },
        );

        expect(result).toEqual({
          success: true,
          output: "Created report.docx",
          verified: true,
        });
      },
    );

    it(
      "never reports verified: true for a tool whose result doesn't set it, even when it succeeds",
      async () => {
        const handlers = fakeToolHandlers({
          async write_file() {
            return {
              success: true,
              output: "Wrote notes.md",
            };
          },
        });

        const executor = createLiveToolExecutor(
          handlers,
          new HookRegistry(),
          fakeReadline(),
          {},
        );

        const result = await executor.execute(
          "write_file",
          {
            path: "notes.md",
            content: "hello",
          },
        );

        expect(result.verified).toBeUndefined();
      },
    );

    it(
      "still resumes readline and restores raw mode when the hook registry throws",
      async () => {
        const handlers = fakeToolHandlers({
          async write_file() {
            throw new Error(
              "write_file should not be reached: PreToolUse throws first",
            );
          },
        });

        const registry = new HookRegistry();

        registry.register(
          "PreToolUse",
          async () => {
            throw new Error(
              "boom from a PreToolUse hook",
            );
          },
        );

        const readline = fakeReadline();

        const executor = createLiveToolExecutor(
          handlers,
          registry,
          readline,
          {},
        );

        await expect(
          executor.execute(
            "write_file",
            {
              path: "notes.md",
              content: "hello",
            },
          ),
        ).rejects.toThrow(
          /boom from a PreToolUse hook/,
        );

        // Even though execute() itself rejected, the readline pause/resume
        // pair must still have completed (runAgentLoop's own try/catch is
        // what turns this rejection into a recorded failed result; see
        // loop.ts).
        expect(readline.calls).toEqual([
          "pause",
          "resume",
        ]);
      },
    );
  },
);
