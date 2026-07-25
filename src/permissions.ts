import {
  PERMISSION_MODES,
  validatePermissionMode,
  type PermissionMode,
} from "./config.js";

import {
  describeEditFilePlan,
  describeReadFilePlan,
  describeWriteFilePlan,
} from "./fileops.js";

import type {
  SkyToolRequest,
  ToolExecutionResult,
} from "./tools.js";

export const PERMISSION_ACTIONS = [
  "read-file",
  "write-file",
  "edit-file",
  "shell-command",
  "mcp-call",
  "sub-agent",
] as const;

export type PermissionAction =
  (typeof PERMISSION_ACTIONS)[number];

export type PermissionDecision =
  | "allow"
  | "prompt"
  | "plan";

export const PERMISSION_MODE_DESCRIPTIONS:
  Record<
    PermissionMode,
    string
  > = {
  default:
    "Ask before file writes, file edits, and shell commands.",

  "auto-accept-edits":
    "Approve file writes and edits automatically; shell commands still ask.",

  plan:
    "Describe tool actions without executing any tool.",

  bypass:
    "Execute every tool without approval prompts. High risk.",
};

export function formatPermissionModeChoices(
  currentMode:
    PermissionMode,
): string[] {
  return PERMISSION_MODES.map(
    (
      mode,
      index,
    ) => {
      const currentMarker =
        mode ===
          currentMode
          ? " (current)"
          : "";

      return `${index + 1}. ${mode}${currentMarker} - ${PERMISSION_MODE_DESCRIPTIONS[mode]}`;
    },
  );
}

export function parsePermissionModeSelection(
  value: string,
): PermissionMode | null {
  const trimmedValue =
    value.trim();

  if (
    !/^[0-9]+$/.test(
      trimmedValue,
    )
  ) {
    return null;
  }

  const selectedIndex =
    Number(
      trimmedValue,
    ) - 1;

  return (
    PERMISSION_MODES[
      selectedIndex
    ] ??
    null
  );
}

const PERMISSION_POLICY:
  Record<
    PermissionMode,
    Record<
      PermissionAction,
      PermissionDecision
    >
  > = {
  default: {
    "read-file":
      "allow",
    "write-file":
      "prompt",
    "edit-file":
      "prompt",
    "shell-command":
      "prompt",
    "mcp-call":
      "allow",
    "sub-agent":
      "allow",
  },

  "auto-accept-edits": {
    "read-file":
      "allow",
    "write-file":
      "allow",
    "edit-file":
      "allow",
    "shell-command":
      "prompt",
    "mcp-call":
      "allow",
    "sub-agent":
      "allow",
  },

  plan: {
    "read-file":
      "plan",
    "write-file":
      "plan",
    "edit-file":
      "plan",
    "shell-command":
      "plan",
    "mcp-call":
      "plan",
    "sub-agent":
      "plan",
  },

  bypass: {
    "read-file":
      "allow",
    "write-file":
      "allow",
    "edit-file":
      "allow",
    "shell-command":
      "allow",
    "mcp-call":
      "allow",
    "sub-agent":
      "allow",
  },
};

export function getPermissionDecision(
  mode: PermissionMode,
  action: PermissionAction,
): PermissionDecision {
  return PERMISSION_POLICY[
    mode
  ][
    action
  ];
}

export function getToolPermissionAction(
  request: SkyToolRequest,
): PermissionAction {
  switch (request.tool) {
    case "read_file":
      return "read-file";

    case "write_file":
      return "write-file";

    case "edit_file":
      return "edit-file";

    case "run_shell_command":
      return "shell-command";

    case "mcp_call":
      return "mcp-call";

    case "delegate_to_agent":
      return "sub-agent";
  }
}

export function describePlanModeToolRequest(
  request: SkyToolRequest,
  workingDirectory: string =
    process.cwd(),
): ToolExecutionResult {
  switch (request.tool) {
    case "read_file":
      return {
        success:
          true,
        output:
          describeReadFilePlan(
            request.args.path,
            workingDirectory,
          ),
      };

    case "write_file":
      return {
        success:
          true,
        output:
          describeWriteFilePlan(
            request.args.path,
            request.args.content,
            workingDirectory,
          ),
      };

    case "edit_file":
      return {
        success:
          true,
        output:
          describeEditFilePlan(
            request.args.path,
            workingDirectory,
          ),
      };

    case "run_shell_command":
      return {
        success:
          true,
        output:
          [
            "Plan mode: Sky Code would run this shell command, but no command was executed:",
            request.args.command,
          ].join("\n"),
      };

    case "mcp_call":
      return {
        success:
          true,
        output:
          `Plan mode: Sky Code would call MCP tool "${request.args.server}/${request.args.name}", but no MCP request was sent.`,
      };

    case "delegate_to_agent":
      return {
        success:
          true,
        output:
          `Plan mode: Sky Code would delegate the task to sub-agent "${request.args.agent}", but no worker process was started.`,
      };
  }
}

export class PermissionController {
  private activeMode:
    PermissionMode;

  constructor(
    initialMode:
      PermissionMode,
  ) {
    this.activeMode =
      validatePermissionMode(
        initialMode,
      );
  }

  getMode():
    PermissionMode {
    return this.activeMode;
  }

  setMode(
    value: unknown,
  ): PermissionMode {
    this.activeMode =
      validatePermissionMode(
        value,
      );

    return this.activeMode;
  }

  decide(
    request:
      SkyToolRequest,
  ): PermissionDecision {
    return getPermissionDecision(
      this.activeMode,
      getToolPermissionAction(
        request,
      ),
    );
  }
}
