/**
 * Permission-policy definitions and plan-mode descriptions for Sky Code.
 *
 * Maps tool requests onto permission actions, applies the active permission
 * mode to those actions, formats permission-mode choices for the CLI, and
 * produces safe descriptions of tool requests when plan mode prevents actual
 * execution.
 *
 * PermissionController provides the mutable runtime wrapper used to inspect,
 * change, and apply the currently active permission mode.
 */
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

/**
 * Canonical permission-controlled action categories understood by Sky Code.
 *
 * Tool names are mapped onto these categories before the permission policy is
 * consulted, allowing permission rules to remain independent of wire-level
 * tool request names.
 */
export const PERMISSION_ACTIONS = [
  "read-file",
  "write-file",
  "edit-file",
  "shell-command",
  "mcp-call",
  "sub-agent",
] as const;

/**
 * One permission-controlled action category.
 *
 * Derived from PERMISSION_ACTIONS so the runtime list and TypeScript union
 * remain synchronized.
 */
export type PermissionAction =
  (typeof PERMISSION_ACTIONS)[number];

/**
 * Result of applying a permission mode to an action.
 *
 * `allow` executes without prompting, `prompt` requires explicit approval,
 * and `plan` describes the action without executing it.
 */
export type PermissionDecision =
  | "allow"
  | "prompt"
  | "plan";

/**
 * User-facing explanation for every supported permission mode.
 *
 * The Record type requires a description for each PermissionMode exported by
 * config.ts.
 */
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

/**
 * Formats the supported permission modes as numbered CLI menu choices.
 *
 * The currently active mode receives a `(current)` marker so callers can show
 * both the available choices and present state in one list.
 *
 * @param {PermissionMode} currentMode - Permission mode currently in effect.
 * @returns {string[]} Numbered, human-readable permission-mode choices.
 */
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

/**
 * Parses a one-based numeric CLI selection into a PermissionMode.
 *
 * Only ASCII decimal digits are accepted. The displayed menu is one-based,
 * while PERMISSION_MODES is zero-based; selections outside the available range
 * return null.
 *
 * @param {string} value - Raw menu selection entered by the user.
 * @returns {PermissionMode | null} Selected mode, or null for invalid input.
 */
export function parsePermissionModeSelection(
  value: string,
): PermissionMode | null {
  const trimmedValue =
    value.trim();

  // Reject signs, decimals, whitespace-only input, and other non-menu
  // forms before converting the selection to a number.
  if (
    !/^[0-9]+$/.test(
      trimmedValue,
    )
  ) {
    return null;
  }

  // Menu entries are displayed starting at 1, while the modes array is
  // indexed starting at 0.
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

/**
 * Complete policy matrix from permission mode and action to runtime decision.
 *
 * Keeping this as a fully typed nested Record ensures every PermissionMode has
 * an explicit decision for every PermissionAction. Plan mode maps every action
 * to `plan`, while bypass maps every action to `allow`.
 */
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

/**
 * Looks up the policy decision for one permission mode and action.
 *
 * @param {PermissionMode} mode - Active permission mode.
 * @param {PermissionAction} action - Permission-controlled action being
 * considered.
 * @returns {PermissionDecision} Policy decision from PERMISSION_POLICY.
 */
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

/**
 * Maps a validated Sky Code tool request to its permission-policy category.
 *
 * File operations retain separate read/write/edit categories; shell, MCP, and
 * delegated-agent requests map to their corresponding higher-level actions.
 * The discriminated SkyToolRequest union makes the switch exhaustive at
 * compile time.
 *
 * @param {SkyToolRequest} request - Validated tool request to classify.
 * @returns {PermissionAction} Permission action used for policy lookup.
 */
export function getToolPermissionAction(
  request: SkyToolRequest,
): PermissionAction {
  // Permission policy uses stable action categories rather than exposing
  // the tool protocol's underscore-separated names directly.
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

/**
 * Produces the successful non-executing result returned for a tool in plan
 * mode.
 *
 * File operations delegate to the filesystem plan helpers so paths are
 * resolved consistently with real execution. Shell, MCP, and sub-agent
 * requests are described directly. No tool, command, MCP request, or worker
 * process is executed by this function.
 *
 * @param {SkyToolRequest} request - Tool request to describe without executing.
 * @param {string} workingDirectory - Base directory used when describing file
 * paths. Defaults to process.cwd().
 * @returns {ToolExecutionResult} Successful result explaining what would have
 * happened.
 * @throws {Error} If a file-operation request contains a path rejected by the
 * filesystem plan helpers.
 *
 * Side effect: none; this function deliberately describes actions only.
 */
export function describePlanModeToolRequest(
  request: SkyToolRequest,
  workingDirectory: string =
    process.cwd(),
): ToolExecutionResult {
  // Every branch returns success because plan mode successfully handled
  // the request by describing it; successful here does not mean it executed.
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

/**
 * Maintains and applies Sky Code's active runtime permission mode.
 *
 * The controller validates mode changes through config.ts and provides a
 * request-level decision helper so callers do not need to duplicate tool
 * classification and policy lookup.
 */
export class PermissionController {
  /** Currently validated permission mode used for subsequent decisions. */
  private activeMode:
    PermissionMode;

  /**
   * Creates a permission controller with a validated initial mode.
   *
   * @param {PermissionMode} initialMode - Initial permission mode.
   * @throws {Error} If validation rejects the supplied mode.
   */
  constructor(
    initialMode:
      PermissionMode,
  ) {
    this.activeMode =
      validatePermissionMode(
        initialMode,
      );
  }

  /**
   * Returns the permission mode currently in effect.
   *
   * @returns {PermissionMode} Active validated permission mode.
   */
  getMode():
    PermissionMode {
    return this.activeMode;
  }

  /**
   * Validates and activates a new permission mode.
   *
   * @param {unknown} value - Candidate permission-mode value.
   * @returns {PermissionMode} Newly active validated mode.
   * @throws {Error} If value is not a supported permission mode.
   *
   * Side effect: updates the controller's active permission mode.
   */
  setMode(
    value: unknown,
  ): PermissionMode {
    this.activeMode =
      validatePermissionMode(
        value,
      );

    return this.activeMode;
  }

  /**
   * Determines how the active mode should handle one tool request.
   *
   * The request is first mapped to a PermissionAction and then evaluated
   * against the central permission policy.
   *
   * @param {SkyToolRequest} request - Validated tool request to evaluate.
   * @returns {PermissionDecision} Whether to allow, prompt, or plan.
   */
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
