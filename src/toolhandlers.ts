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

function succeeded(
  output: string,
): ToolExecutionResult {
  return {
    success: true,
    output,
  };
}

function failed(
  output: string,
): ToolExecutionResult {
  return {
    success: false,
    output,
  };
}

export interface ToolPermissionRuntime {
  getMode():
    PermissionMode;

  approvalPrompt?:
    ApprovalPrompt;
}

const DEFAULT_PERMISSION_RUNTIME:
  ToolPermissionRuntime = {
  getMode:
    () =>
      "default",
};

export interface SubAgentToolRuntime {
  agents:
    readonly ActiveSubAgentDefinition[];

  apiUrl: string;
  apiKey: string;

  getActiveModel():
    string;

  hookRegistry?:
    HookRegistry;

  timeoutMs?:
    number;

  workerPath?:
    string;
}

export function createPhase1ToolHandlers(
  workingDirectory: string =
    process.cwd(),
  permissionRuntime:
    ToolPermissionRuntime =
      DEFAULT_PERMISSION_RUNTIME,
): ToolHandlers {
  const getMode =
    (): PermissionMode =>
      permissionRuntime
        .getMode();

  const approvalPrompt =
    permissionRuntime
      .approvalPrompt ??
    confirmAction;

  return {
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
        return failed(
          formatError(
            error,
          ),
        );
      }
    },

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
): ToolHandlers {
  const phase1Handlers =
    createPhase1ToolHandlers(
      workingDirectory,
      permissionRuntime,
    );

  return {
    ...phase1Handlers,

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
              defaultModel:
                subAgentRuntime
                  .getActiveModel(),
            },
            {
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
        return failed(
          `Sub-agent "${args.agent}" could not complete the delegated task: ${formatError(error)}`,
        );
      }
    },
  };
}
