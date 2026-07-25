import {
  describe,
  expect,
  it,
} from "vitest";

import {
  describePlanModeToolRequest,
  formatPermissionModeChoices,
  getPermissionDecision,
  getToolPermissionAction,
  parsePermissionModeSelection,
  PERMISSION_ACTIONS,
  PERMISSION_MODE_DESCRIPTIONS,
  PermissionController,
} from "../src/permissions.ts";

import type {
  SkyToolRequest,
} from "../src/tools.ts";

describe(
  "permission policy",
  () => {
    it(
      "defines actions for every current Sky Code tool category",
      () => {
        expect(
          PERMISSION_ACTIONS,
        ).toEqual([
          "read-file",
          "write-file",
          "edit-file",
          "shell-command",
          "mcp-call",
          "sub-agent",
        ]);
      },
    );

    it(
      "preserves the existing default behavior",
      () => {
        expect(
          getPermissionDecision(
            "default",
            "read-file",
          ),
        ).toBe(
          "allow",
        );

        expect(
          getPermissionDecision(
            "default",
            "write-file",
          ),
        ).toBe(
          "prompt",
        );

        expect(
          getPermissionDecision(
            "default",
            "edit-file",
          ),
        ).toBe(
          "prompt",
        );

        expect(
          getPermissionDecision(
            "default",
            "shell-command",
          ),
        ).toBe(
          "prompt",
        );

        expect(
          getPermissionDecision(
            "default",
            "mcp-call",
          ),
        ).toBe(
          "allow",
        );

        expect(
          getPermissionDecision(
            "default",
            "sub-agent",
          ),
        ).toBe(
          "allow",
        );
      },
    );

    it(
      "auto-accepts file changes while preserving shell approval",
      () => {
        expect(
          getPermissionDecision(
            "auto-accept-edits",
            "write-file",
          ),
        ).toBe(
          "allow",
        );

        expect(
          getPermissionDecision(
            "auto-accept-edits",
            "edit-file",
          ),
        ).toBe(
          "allow",
        );

        expect(
          getPermissionDecision(
            "auto-accept-edits",
            "shell-command",
          ),
        ).toBe(
          "prompt",
        );
      },
    );

    it(
      "plans every tool without execution in plan mode",
      () => {
        for (
          const action of
          PERMISSION_ACTIONS
        ) {
          expect(
            getPermissionDecision(
              "plan",
              action,
            ),
          ).toBe(
            "plan",
          );
        }
      },
    );

    it(
      "allows every tool without prompting in bypass mode",
      () => {
        for (
          const action of
          PERMISSION_ACTIONS
        ) {
          expect(
            getPermissionDecision(
              "bypass",
              action,
            ),
          ).toBe(
            "allow",
          );
        }
      },
    );

    it(
      "maps each tool request to the correct permission action",
      () => {
        const requests:
          Array<{
            request:
              SkyToolRequest;
            expected:
              string;
          }> = [
          {
            request: {
              tool:
                "read_file",
              args: {
                path:
                  "/tmp/read.txt",
              },
            },
            expected:
              "read-file",
          },
          {
            request: {
              tool:
                "write_file",
              args: {
                path:
                  "/tmp/write.txt",
                content:
                  "content",
              },
            },
            expected:
              "write-file",
          },
          {
            request: {
              tool:
                "edit_file",
              args: {
                path:
                  "/tmp/edit.txt",
                old_str:
                  "old",
                new_str:
                  "new",
              },
            },
            expected:
              "edit-file",
          },
          {
            request: {
              tool:
                "run_shell_command",
              args: {
                command:
                  "printf test",
              },
            },
            expected:
              "shell-command",
          },
          {
            request: {
              tool:
                "mcp_call",
              args: {
                server:
                  "test-server",
                name:
                  "test-tool",
                arguments: {},
              },
            },
            expected:
              "mcp-call",
          },
          {
            request: {
              tool:
                "delegate_to_agent",
              args: {
                agent:
                  "reviewer",
                task:
                  "Review the task.",
              },
            },
            expected:
              "sub-agent",
          },
        ];

        for (
          const item of
          requests
        ) {
          expect(
            getToolPermissionAction(
              item.request,
            ),
          ).toBe(
            item.expected,
          );
        }
      },
    );

    it(
      "creates clear plan-mode results and supports session switching",
      () => {
        const controller =
          new PermissionController(
            "default",
          );

        const request:
          SkyToolRequest = {
          tool:
            "write_file",
          args: {
            path:
              "/tmp/planned.txt",
            content:
              "hello",
          },
        };

        expect(
          controller.decide(
            request,
          ),
        ).toBe(
          "prompt",
        );

        expect(
          controller.setMode(
            "plan",
          ),
        ).toBe(
          "plan",
        );

        expect(
          controller.decide(
            request,
          ),
        ).toBe(
          "plan",
        );

        expect(
          describePlanModeToolRequest(
            request,
          ),
        ).toEqual({
          success:
            true,
          output:
            "Plan mode: Sky Code would write 5 bytes to /tmp/planned.txt, but no file was changed.",
        });

        expect(
          () =>
            controller.setMode(
              "unknown-mode",
            ),
        ).toThrow(
          'defaultPermissionMode must be one of "default", "auto-accept-edits", "plan", or "bypass"',
        );
      },
    );
    it(
      "provides a one-line description for every permission mode",
      () => {
        expect(
          PERMISSION_MODE_DESCRIPTIONS,
        ).toEqual({
          default:
            "Ask before file writes, file edits, and shell commands.",
          "auto-accept-edits":
            "Approve file writes and edits automatically; shell commands still ask.",
          plan:
            "Describe tool actions without executing any tool.",
          bypass:
            "Execute every tool without approval prompts. High risk.",
        });
      },
    );

    it(
      "formats all permission choices and marks the current mode",
      () => {
        expect(
          formatPermissionModeChoices(
            "plan",
          ),
        ).toEqual([
          "1. default - Ask before file writes, file edits, and shell commands.",
          "2. auto-accept-edits - Approve file writes and edits automatically; shell commands still ask.",
          "3. plan (current) - Describe tool actions without executing any tool.",
          "4. bypass - Execute every tool without approval prompts. High risk.",
        ]);
      },
    );

    it(
      "parses numbered permission selections",
      () => {
        expect(
          parsePermissionModeSelection(
            "1",
          ),
        ).toBe(
          "default",
        );

        expect(
          parsePermissionModeSelection(
            " 2 ",
          ),
        ).toBe(
          "auto-accept-edits",
        );

        expect(
          parsePermissionModeSelection(
            "3",
          ),
        ).toBe(
          "plan",
        );

        expect(
          parsePermissionModeSelection(
            "4",
          ),
        ).toBe(
          "bypass",
        );

        expect(
          parsePermissionModeSelection(
            "0",
          ),
        ).toBeNull();

        expect(
          parsePermissionModeSelection(
            "5",
          ),
        ).toBeNull();

        expect(
          parsePermissionModeSelection(
            "plan",
          ),
        ).toBeNull();
      },
    );

  },
);
