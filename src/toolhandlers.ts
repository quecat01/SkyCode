/**
 * Runtime implementations for Sky Code tool requests.
 *
 * Connects the validated tool protocol from tools.ts to concrete operations:
 * filesystem access, shell execution, permission enforcement, background-task
 * management, MCP calls, and delegated sub-agent work.
 *
 * createPhase1ToolHandlers() provides the core local file and foreground-shell
 * tools. createSkyCodeToolHandlers() builds on those handlers by adding
 * background shell execution, MCP integration, and sub-agent delegation.
 */

import type {
  BackgroundTaskRegistry,
} from "./background.js";

import {
  runBackgroundShellCommand,
} from "./background-shell.js";

import {
  runSubAgentTask,
  type ActiveSubAgentDefinition,
} from "./agents.js";

import type {
  PermissionMode,
} from "./config.js";

import {
  editFileOnDisk,
  readFileFromDisk,
  resolveFilePath,
  writeFileToDisk,
} from "./fileops.js";

import type {
  HookRegistry,
} from "./hooks.js";

import type {
  McpConnection,
} from "./mcp.js";

import {
  describePlanModeToolRequest,
  getPermissionDecision,
} from "./permissions.js";

import type {
  DelegateToAgentArgs,
  EditFileArgs,
  McpCallArgs,
  ReadFileArgs,
  RunShellCommandArgs,
  ToolExecutionResult,
  ToolHandlers,
  WriteFileArgs,
} from "./tools.js";

import {
  confirmAction,
  formatError,
} from "./utils.js";

import {
  runShellCommandForPermissionMode,
  type ApprovalPrompt,
} from "./shell.js";

/**
 * Creates a successful ToolExecutionResult containing the supplied output.
 *
 * @param {string} output - Result text returned to the model and session log.
 * @returns {ToolExecutionResult} Standard successful tool result.
 */
function succeeded(
  output: string,
): ToolExecutionResult {
  return {
    success: true,
    output,
  };
}

/**
 * Creates a failed ToolExecutionResult containing the supplied explanation.
 *
 * Tool handlers generally convert expected operational failures into these
 * normal result objects instead of throwing into the conversation loop.
 *
 * @param {string} output - Failure explanation returned to the model.
 * @returns {ToolExecutionResult} Standard failed tool result.
 */
function failed(
  output: string,
): ToolExecutionResult {
  return {
    success: false,
    output,
  };
}

/**
 * Permission-related runtime dependencies used by tool handlers.
 */
export interface ToolPermissionRuntime {
  /**
   * Returns the permission mode that is active at the moment a tool executes.
   *
   * Reading the mode lazily allows `/permissions` changes made during a session
   * to affect later requests without rebuilding the handlers.
   *
   * @returns {PermissionMode} Currently active permission mode.
   */
  getMode():
    PermissionMode;

  /**
   * Optional approval function used when the current permission mode requires
   * explicit confirmation. Defaults to confirmAction when omitted.
   */
  approvalPrompt?:
    ApprovalPrompt;
}

/**
 * Runtime dependency required for background shell commands.
 */
export interface BackgroundToolRuntime {
  /** Registry that owns and tracks background task lifecycles. */
  registry:
    BackgroundTaskRegistry;
}

/**
 * Default permission runtime used when callers do not supply one.
 *
 * The default mode preserves Sky Code's normal interactive permission behavior.
 */
const DEFAULT_PERMISSION_RUNTIME:
  ToolPermissionRuntime = {
  getMode:
    () =>
      "default",
};

/**
 * Runtime configuration required to delegate work to sub-agents.
 */
export interface SubAgentToolRuntime {
  /** Active agent definitions that may be selected by name. */
  agents:
    readonly ActiveSubAgentDefinition[];

  /** OpenAI-compatible API endpoint supplied to the sub-agent worker. */
  apiUrl: string;
  /** API credential supplied to the sub-agent worker. */
  apiKey: string;

  /**
   * Returns the model currently active in the parent Sky Code session.
   *
   * @returns {string} Model identifier to use as the sub-agent default.
   */
  getActiveModel():
    string;

  /** Optional hook registry shared with delegated agent execution. */
  hookRegistry?:
    HookRegistry;

  /** Optional maximum delegated-task runtime in milliseconds. */
  timeoutMs?:
    number;

  /** Optional override for the sub-agent worker executable/module path. */
  workerPath?:
    string;
}

/**
 * Creates the core local Sky Code tool handlers.
 *
 * These handlers implement file reads, file writes, targeted file edits, and
 * foreground shell commands. Permission behavior is evaluated at execution
 * time so runtime mode changes take effect immediately.
 *
 * Plan mode returns a description of the requested action without performing
 * it. Operations requiring confirmation use the supplied approvalPrompt or the
 * default confirmAction implementation.
 *
 * @param {string} workingDirectory - Base directory used to resolve relative
 * filesystem paths and execute shell commands. Defaults to process.cwd().
 * @param {ToolPermissionRuntime} permissionRuntime - Runtime source for the
 * active permission mode and optional approval callback.
 * @returns {ToolHandlers} Core tool-handler collection.
 *
 * Side effects: returned handlers may read, create, overwrite, or edit files,
 * prompt the user for permission, and execute foreground shell commands.
 */
export function createPhase1ToolHandlers(
  workingDirectory: string =
    process.cwd(),
  permissionRuntime:
    ToolPermissionRuntime =
      DEFAULT_PERMISSION_RUNTIME,
): ToolHandlers {
  // Resolve the active mode for every request rather than capturing one fixed
  // value when handlers are created.
  const getMode =
    (): PermissionMode =>
      permissionRuntime
        .getMode();

  const approvalPrompt =
    permissionRuntime
      .approvalPrompt ??
    confirmAction;

  return {
    // Read requests do not require an approval prompt in the non-plan modes
    // represented by the permission-decision layer.
    async read_file(
      args: ReadFileArgs,
    ): Promise<ToolExecutionResult> {
      if (
        getPermissionDecision(
          getMode(),
          "read-file",
        ) ===
          "plan"
      ) {
        return describePlanModeToolRequest(
          {
            tool:
              "read_file",
            args,
          },
          workingDirectory,
        );
      }

      try {
        const contents =
          await readFileFromDisk(
            args.path,
            workingDirectory,
          );

        return succeeded(
          contents,
        );
      } catch (error) {
        // Filesystem exceptions become normal failed tool results so the model
        // can receive the failure and decide how to continue.
        return failed(
          formatError(
            error,
          ),
        );
      }
    },

    // File writes can be executed, described only, or gated behind an
    // interactive approval depending on the current permission mode.
    async write_file(
      args: WriteFileArgs,
    ): Promise<ToolExecutionResult> {
      const decision =
        getPermissionDecision(
          getMode(),
          "write-file",
        );

      if (
        decision ===
          "plan"
      ) {
        return describePlanModeToolRequest(
          {
            tool:
              "write_file",
            args,
          },
          workingDirectory,
        );
      }

      // Resolve the same path shown in the approval prompt so the user sees
      // the actual destination rather than only the model-supplied path text.
      const resolvedPath =
        resolveFilePath(
          args.path,
          workingDirectory,
        );

      if (
        decision ===
          "prompt"
      ) {
        const approved =
          await approvalPrompt(
            `Allow Sky Code to write ${resolvedPath}?`,
          );

        if (!approved) {
          return failed(
            `Permission denied. Sky Code did not write ${resolvedPath}.`,
          );
        }
      }

      try {
        const result =
          await writeFileToDisk(
            args.path,
            args.content,
            workingDirectory,
          );

        return succeeded(
          result,
        );
      } catch (error) {
        return failed(
          formatError(
            error,
          ),
        );
      }
    },

    // Targeted edits follow the same plan/prompt/execute permission sequence as
    // whole-file writes.
    async edit_file(
      args: EditFileArgs,
    ): Promise<ToolExecutionResult> {
      const decision =
        getPermissionDecision(
          getMode(),
          "edit-file",
        );

      if (
        decision ===
          "plan"
      ) {
        return describePlanModeToolRequest(
          {
            tool:
              "edit_file",
            args,
          },
          workingDirectory,
        );
      }

      const resolvedPath =
        resolveFilePath(
          args.path,
          workingDirectory,
        );

      if (
        decision ===
          "prompt"
      ) {
        const approved =
          await approvalPrompt(
            `Allow Sky Code to edit ${resolvedPath}?`,
          );

        if (!approved) {
          return failed(
            `Permission denied. Sky Code did not edit ${resolvedPath}.`,
          );
        }
      }

      try {
        const result =
          await editFileOnDisk(
            args.path,
            args.old_str,
            args.new_str,
            workingDirectory,
          );

        return succeeded(
          result,
        );
      } catch (error) {
        return failed(
          formatError(
            error,
          ),
        );
      }
    },

    // Foreground shell execution delegates permission interpretation to
    // shell.ts so command approval policy remains centralized there.
    async run_shell_command(
      args: RunShellCommandArgs,
    ): Promise<ToolExecutionResult> {
      return runShellCommandForPermissionMode(
        args.command,
        getMode(),
        workingDirectory,
        approvalPrompt,
      );
    },
  };
}

/**
 * Executes an MCP tool request against the named active connection.
 *
 * The configured connection is selected by serverName before the tool is
 * invoked. A missing server and MCP call failures are represented as normal
 * failed tool results rather than escaping as exceptions.
 *
 * @param {McpCallArgs} args - Validated server name, tool name, and MCP tool
 * arguments.
 * @param {readonly McpConnection[]} connections - MCP connections active in
 * the current Sky Code session.
 * @returns {Promise<ToolExecutionResult>} MCP result or a failed result
 * explaining why the call could not be completed.
 *
 * Side effect: may invoke a remote or local MCP server tool.
 */
async function executeMcpTool(
  args: McpCallArgs,
  connections:
    readonly McpConnection[],
): Promise<ToolExecutionResult> {
  const connection =
    connections.find(
      (candidate) =>
        candidate.serverName ===
        args.server,
    );

  if (!connection) {
    return failed(
      `MCP server "${args.server}" is not connected.`,
    );
  }

  try {
    const result =
      await connection.callTool(
        args.name,
        args.arguments,
      );

    // Preserve the MCP connection's success flag and output exactly rather
    // than translating successful/failed MCP results into exceptions.
    return {
      success: result.success,
      output: result.output,
    };
  } catch (error) {
    return failed(
      `MCP tool "${args.server}/${args.name}" failed: ${formatError(error)}`,
    );
  }
}

/**
 * Creates the complete Sky Code handler set for an interactive session.
 *
 * Starts with the local handlers from createPhase1ToolHandlers() and extends
 * them with:
 * - background shell-command execution through BackgroundTaskRegistry;
 * - MCP calls through the active connection collection;
 * - sub-agent delegation through the configured agent runtime.
 *
 * Foreground shell requests continue to use the Phase 1 handler unchanged.
 * Background requests are handled separately because they require task
 * registration, asynchronous lifecycle tracking, and their own approval flow.
 *
 * @param {string} workingDirectory - Base directory for filesystem and shell
 * operations. Defaults to process.cwd().
 * @param {readonly McpConnection[]} mcpConnections - Active MCP connections
 * available for model tool calls.
 * @param {SubAgentToolRuntime | undefined} subAgentRuntime - Optional runtime
 * required for delegated sub-agent work.
 * @param {ToolPermissionRuntime} permissionRuntime - Source of the current
 * permission mode and optional approval prompt.
 * @param {BackgroundToolRuntime | undefined} backgroundRuntime - Optional
 * background-task registry used for non-blocking shell commands.
 * @returns {ToolHandlers} Full handler collection used by Sky Code.
 *
 * Side effects: returned handlers may access files, execute foreground or
 * background shell commands, prompt for approval, invoke MCP tools, register
 * background tasks, execute hooks, and launch sub-agent worker processes.
 */
export function createSkyCodeToolHandlers(
  workingDirectory: string =
    process.cwd(),
  mcpConnections:
    readonly McpConnection[] = [],
  subAgentRuntime?:
    SubAgentToolRuntime,
  permissionRuntime:
    ToolPermissionRuntime =
      DEFAULT_PERMISSION_RUNTIME,
  backgroundRuntime?:
    BackgroundToolRuntime,
): ToolHandlers {
  // Reuse the core handlers so file operations and ordinary foreground shell
  // behavior remain identical between the Phase 1 and full runtime.
  const phase1Handlers =
    createPhase1ToolHandlers(
      workingDirectory,
      permissionRuntime,
    );

  return {
    ...phase1Handlers,

    // Override only shell handling so requests explicitly marked background
    // can enter the task registry without changing foreground behavior.
    async run_shell_command(
      args:
        RunShellCommandArgs,
    ): Promise<ToolExecutionResult> {
      if (
        args.background !==
          true
      ) {
        return phase1Handlers
          .run_shell_command(
            args,
          );
      }

      const decision =
        getPermissionDecision(
          permissionRuntime
            .getMode(),
          "shell-command",
        );

      if (
        decision ===
          "plan"
      ) {
        return describePlanModeToolRequest(
          {
            tool:
              "run_shell_command",
            args,
          },
          workingDirectory,
        );
      }

      // Background behavior is optional because some consumers may construct
      // the complete handler set without activating task management.
      if (
        !backgroundRuntime
      ) {
        return failed(
          "Background task support is not active in this Sky Code session.",
        );
      }

      const approvalPrompt =
        permissionRuntime
          .approvalPrompt ??
        confirmAction;

      if (
        decision ===
          "prompt"
      ) {
        const approved =
          await approvalPrompt(
            [
              "Allow Sky Code to run this command in the background?",
              args.command,
            ].join(
              "\n",
            ),
          );

        if (
          !approved
        ) {
          return failed(
            "Permission denied. Sky Code did not start the background command.",
          );
        }
      }

      // Collapse whitespace only for the human-readable task label. The actual
      // command passed to the shell remains args.command unchanged.
      const normalizedCommand =
        args.command
          .trim()
          .replace(
            /\s+/g,
            " ",
          );

      // Keep background task names compact while retaining the beginning of the
      // command as an immediately recognizable preview.
      const commandPreview =
        normalizedCommand.length >
          80
          ? `${normalizedCommand.slice(
              0,
              77,
            )}...`
          : normalizedCommand;

      // Registry.start() returns immediately with a task handle while the
      // supplied asynchronous operation runs under registry lifecycle control.
      const handle =
        backgroundRuntime
          .registry
          .start(
            `Shell: ${commandPreview}`,
            async (
              context,
            ) =>
              runBackgroundShellCommand(
                args.command,
                workingDirectory,
                context,
              ),
          );

      return succeeded(
        [
          "Background task started.",
          `Task ID: ${handle.id}`,
          `Command: ${args.command}`,
        ].join(
          "\n",
        ),
      );
    },

    // Plan mode prevents the MCP call entirely; all other permission decisions
    // proceed through the already connected server set.
    async mcp_call(
      args: McpCallArgs,
    ): Promise<ToolExecutionResult> {
      if (
        getPermissionDecision(
          permissionRuntime
            .getMode(),
          "mcp-call",
        ) ===
          "plan"
      ) {
        return describePlanModeToolRequest(
          {
            tool:
              "mcp_call",
            args,
          },
          workingDirectory,
        );
      }

      return executeMcpTool(
        args,
        mcpConnections,
      );
    },

    // Delegation is permission-gated before validating the selected runtime or
    // agent so plan mode can describe requests without launching agent work.
    async delegate_to_agent(
      args:
        DelegateToAgentArgs,
    ): Promise<ToolExecutionResult> {
      if (
        getPermissionDecision(
          permissionRuntime
            .getMode(),
          "sub-agent",
        ) ===
          "plan"
      ) {
        return describePlanModeToolRequest(
          {
            tool:
              "delegate_to_agent",
            args,
          },
          workingDirectory,
        );
      }

      if (!subAgentRuntime) {
        return failed(
          "No sub-agent runtime is active in this Sky Code session.",
        );
      }

      const agent =
        subAgentRuntime
          .agents
          .find(
            (
              candidate,
            ) =>
              candidate.name ===
              args.agent,
          );

      if (!agent) {
        const availableNames =
          subAgentRuntime
            .agents
            .map(
              (
                candidate,
              ) =>
                candidate.name,
            );

        // Include active names when possible so the model can correct an
        // invalid delegation request on its next turn.
        return failed(
          availableNames.length ===
            0
            ? `Sub-agent "${args.agent}" is not active. No sub-agents are available.`
            : `Sub-agent "${args.agent}" is not active. Available sub-agents: ${availableNames.join(", ")}.`,
        );
      }

      try {
        const result =
          await runSubAgentTask(
            agent,
            {
              task:
                args.task,
              // Preserve optionality rather than adding context: undefined to
              // the delegated task request.
              ...(args.context ===
                undefined
                ? {}
                : {
                    context:
                      args.context,
                  }),
            },
            {
              apiUrl:
                subAgentRuntime
                  .apiUrl,
              apiKey:
                subAgentRuntime
                  .apiKey,
              // Resolve the model at execution time so session model changes
              // also affect later sub-agent delegations.
              defaultModel:
                subAgentRuntime
                  .getActiveModel(),
            },
            {
              // Optional worker settings are conditionally spread so omitted
              // runtime values remain genuinely absent from runSubAgentTask().
              ...(subAgentRuntime
                .hookRegistry ===
                undefined
                ? {}
                : {
                    hookRegistry:
                      subAgentRuntime
                        .hookRegistry,
                  }),
              ...(subAgentRuntime
                .timeoutMs ===
                undefined
                ? {}
                : {
                    timeoutMs:
                      subAgentRuntime
                        .timeoutMs,
                  }),
              ...(subAgentRuntime
                .workerPath ===
                undefined
                ? {}
                : {
                    workerPath:
                      subAgentRuntime
                        .workerPath,
                  }),
            },
          );

        return succeeded(
          result.output,
        );
      } catch (error) {
        // Worker startup, timeout, execution, and other delegation failures are
        // returned through the standard tool-result channel.
        return failed(
          `Sub-agent "${args.agent}" could not complete the delegated task: ${formatError(error)}`,
        );
      }
    },
  };
}
