import {
  describe,
  expect,
  it,
} from "vitest";

import {
  shouldReturnToPromptAfterBackgroundTool,
} from "../src/background-turn.ts";

import type {
  SkyToolRequest,
  ToolExecutionResult,
} from "../src/tools.ts";

function successfulResult():
  ToolExecutionResult {
  return {
    success:
      true,
    output:
      "Background task started.",
  };
}

describe(
  "background tool prompt return",
  () => {
    it(
      "returns to the prompt after a successful background shell task starts",
      () => {
        const request:
          SkyToolRequest = {
          tool:
            "run_shell_command",
          args: {
            command:
              "sleep 8",
            background:
              true,
          },
        };

        expect(
          shouldReturnToPromptAfterBackgroundTool(
            request,
            successfulResult(),
          ),
        ).toBe(
          true,
        );
      },
    );

    it(
      "does not short-circuit a foreground shell command",
      () => {
        const request:
          SkyToolRequest = {
          tool:
            "run_shell_command",
          args: {
            command:
              "printf test",
          },
        };

        expect(
          shouldReturnToPromptAfterBackgroundTool(
            request,
            successfulResult(),
          ),
        ).toBe(
          false,
        );
      },
    );

    it(
      "does not short-circuit a failed background command",
      () => {
        const request:
          SkyToolRequest = {
          tool:
            "run_shell_command",
          args: {
            command:
              "sleep 8",
            background:
              true,
          },
        };

        expect(
          shouldReturnToPromptAfterBackgroundTool(
            request,
            {
              success:
                false,
              output:
                "Permission denied.",
            },
          ),
        ).toBe(
          false,
        );
      },
    );

    it(
      "does not short-circuit another successful tool",
      () => {
        const request:
          SkyToolRequest = {
          tool:
            "read_file",
          args: {
            path:
              "README.md",
          },
        };

        expect(
          shouldReturnToPromptAfterBackgroundTool(
            request,
            successfulResult(),
          ),
        ).toBe(
          false,
        );
      },
    );
  },
);
