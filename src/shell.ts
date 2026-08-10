/**
 * Foreground shell-command execution and permission handling for Sky Code.
 *
 * Provides the direct shell runner used by local tool handlers, an
 * approval-gated wrapper, and a permission-mode-aware entry point that selects
 * between plan-only description, immediate execution, or interactive approval.
 *
 * Commands execute through /bin/bash in the requested working directory and
 * return their exit status, stdout, and stderr as ToolExecutionResult objects.
 */

import {
  exec,
} from "node:child_process";

import type {
  PermissionMode,
} from "./config.js";

import {
  describePlanModeToolRequest,
  getPermissionDecision,
} from "./permissions.js";

import type {
  ToolExecutionResult,
} from "./tools.js";

import {
  confirmAction,
} from "./utils.js";

/**
 * Additional child-process error fields used when an executed command exits
 * unsuccessfully.
 *
 * Node's exec callback error can include the command exit code and captured
 * stdout/stderr in addition to the standard Error properties.
 */
interface CommandError
  extends Error {
  /** Process exit code or other child-process error code when available. */
  code?: number | string;
  /** Captured standard output attached to the command error. */
  stdout?: string;
  /** Captured standard error attached to the command error. */
  stderr?: string;
}

/**
 * Function used to request approval before executing a shell command.
 *
 * @param {string} message - Prompt text describing the requested action.
 * @returns {Promise<boolean>} True when execution is approved; otherwise false.
 *
 * Side effect: implementations may interact with the user or another approval
 * mechanism.
 */
export type ApprovalPrompt = (
  message: string,
) => Promise<boolean>;

/**
 * Formats a shell command's exit status and captured output into the standard
 * text returned through Sky Code's tool-result channel.
 *
 * stdout and stderr sections are omitted when empty. The exit-code section is
 * always present.
 *
 * @param {number | string} exitCode - Numeric process exit status or fallback
 * error identifier.
 * @param {string} stdout - Captured standard output.
 * @param {string} stderr - Captured standard error.
 * @returns {string} Human-readable command-result text.
 */
function formatCommandOutput(
  exitCode:
    number | string,
  stdout: string,
  stderr: string,
): string {
  const sections = [
    `Exit code: ${exitCode}`,
  ];

  if (stdout !== "") {
    sections.push(
      `Standard output:\n${stdout}`,
    );
  }

  if (stderr !== "") {
    sections.push(
      `Standard error:\n${stderr}`,
    );
  }

  return sections.join(
    "\n\n",
  );
}

/**
 * Validates shell-command text before any permission prompt or process launch.
 *
 * Empty or whitespace-only commands are represented as a normal failed
 * ToolExecutionResult rather than throwing.
 *
 * @param {string} command - Shell command text to validate.
 * @returns {ToolExecutionResult | null} Failed result for an empty command, or
 * null when the command is eligible for further processing.
 */
function validateShellCommand(
  command: string,
): ToolExecutionResult | null {
  if (
    command.trim() ===
      ""
  ) {
    return {
      success:
        false,
      output:
        "Shell command must not be empty.",
    };
  }

  return null;
}

/**
 * Executes one foreground shell command through /bin/bash.
 *
 * Commands run in workingDirectory using UTF-8 output decoding. Node's exec()
 * buffers stdout and stderr in memory, with a 10 MiB maximum buffer configured
 * here for the combined command-output handling performed by the child-process
 * API.
 *
 * A non-zero exit or child-process error resolves to a failed
 * ToolExecutionResult rather than rejecting the returned promise. Successful
 * execution resolves with exit code 0 and any captured stdout/stderr.
 *
 * @param {string} command - Shell command to execute.
 * @param {string} workingDirectory - Directory used as the command's cwd.
 * Defaults to process.cwd().
 * @returns {Promise<ToolExecutionResult>} Structured success or failure result
 * containing exit status and available output.
 *
 * Side effects: starts a foreground child process and may perform any external
 * effects requested by the shell command.
 */
export async function runShellCommand(
  command: string,
  workingDirectory: string =
    process.cwd(),
): Promise<ToolExecutionResult> {
  const validationResult =
    validateShellCommand(
      command,
    );

  if (validationResult) {
    return validationResult;
  }

  // Wrap exec()'s callback API so callers can await one ToolExecutionResult.
  return new Promise<
    ToolExecutionResult
  >(
    (
      resolveResult,
    ) => {
      exec(
        command,
        {
          cwd:
            workingDirectory,
          encoding:
            "utf8",
          // Allow up to 10 MiB of buffered command output before exec() reports
          // a maxBuffer failure.
          maxBuffer:
            10 *
            1024 *
            1024,
          // Use Bash explicitly rather than relying on Node's platform-default
          // shell selection.
          shell:
            "/bin/bash",
        },
        (
          error,
          stdout,
          stderr,
        ) => {
          if (error) {
            const commandError =
              error as
                CommandError;

            // Prefer stdout/stderr attached to the error object when Node
            // provides them, while retaining callback values as fallbacks.
            resolveResult({
              success:
                false,
              output:
                formatCommandOutput(
                  commandError
                    .code ??
                    "unknown",
                  commandError
                    .stdout ??
                    stdout,
                  commandError
                    .stderr ??
                    stderr,
                ),
            });

            return;
          }

          resolveResult({
            success:
              true,
            output:
              formatCommandOutput(
                0,
                stdout,
                stderr,
              ),
          });
        },
      );
    },
  );
}

/**
 * Executes a foreground shell command only after explicit approval.
 *
 * Command validation happens before prompting so an empty command never
 * generates an unnecessary approval request. Rejected approval returns a
 * normal failed tool result without launching a child process.
 *
 * @param {string} command - Shell command proposed for execution.
 * @param {string} workingDirectory - Directory used as the command's cwd.
 * Defaults to process.cwd().
 * @param {ApprovalPrompt} approvalPrompt - Approval callback. Defaults to
 * confirmAction.
 * @returns {Promise<ToolExecutionResult>} Validation failure, permission
 * denial, or the result returned by runShellCommand().
 *
 * Side effects: may prompt for approval and, when approved, launch a shell
 * command.
 */
export async function runShellCommandWithApproval(
  command: string,
  workingDirectory: string =
    process.cwd(),
  approvalPrompt:
    ApprovalPrompt =
      confirmAction,
): Promise<ToolExecutionResult> {
  const validationResult =
    validateShellCommand(
      command,
    );

  if (validationResult) {
    return validationResult;
  }

  // Include the exact command in the prompt so the approver can evaluate the
  // action that would actually be passed to Bash.
  const approved =
    await approvalPrompt(
      [
        "Allow Sky Code to run this command?",
        command,
      ].join("\n"),
    );

  if (!approved) {
    return {
      success:
        false,
      output:
        "Permission denied. Sky Code did not run the command.",
    };
  }

  return runShellCommand(
    command,
    workingDirectory,
  );
}

/**
 * Routes a shell request according to Sky Code's active permission mode.
 *
 * The permission layer translates PermissionMode into one of three decisions:
 * - `plan`: describe the command without executing it;
 * - `allow`: execute immediately;
 * - otherwise: request approval before executing.
 *
 * Validation occurs before permission routing so invalid empty commands follow
 * the same failure behavior in every mode.
 *
 * @param {string} command - Shell command requested by the model.
 * @param {PermissionMode} permissionMode - Active Sky Code permission mode.
 * @param {string} workingDirectory - Directory used for command execution.
 * Defaults to process.cwd().
 * @param {ApprovalPrompt} approvalPrompt - Approval callback used when the
 * permission decision requires confirmation. Defaults to confirmAction.
 * @returns {Promise<ToolExecutionResult>} Plan description, direct execution
 * result, approval denial, or approved execution result.
 *
 * Side effects: depending on permissionMode, may prompt for approval and/or
 * execute a shell command.
 */
export async function runShellCommandForPermissionMode(
  command: string,
  permissionMode:
    PermissionMode,
  workingDirectory: string =
    process.cwd(),
  approvalPrompt:
    ApprovalPrompt =
      confirmAction,
): Promise<ToolExecutionResult> {
  const validationResult =
    validateShellCommand(
      command,
    );

  if (validationResult) {
    return validationResult;
  }

  const decision =
    getPermissionDecision(
      permissionMode,
      "shell-command",
    );

  if (
    decision ===
      "plan"
  ) {
    // Plan mode deliberately avoids both approval prompting and process
    // creation.
    return describePlanModeToolRequest({
      tool:
        "run_shell_command",
      args: {
        command,
      },
    });
  }

  if (
    decision ===
      "allow"
  ) {
    return runShellCommand(
      command,
      workingDirectory,
    );
  }

  // Any permission decision other than plan or allow follows the interactive
  // approval path.
  return runShellCommandWithApproval(
    command,
    workingDirectory,
    approvalPrompt,
  );
}
