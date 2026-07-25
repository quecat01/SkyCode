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

interface CommandError
  extends Error {
  code?: number | string;
  stdout?: string;
  stderr?: string;
}

export type ApprovalPrompt = (
  message: string,
) => Promise<boolean>;

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
          maxBuffer:
            10 *
            1024 *
            1024,
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

  return runShellCommandWithApproval(
    command,
    workingDirectory,
    approvalPrompt,
  );
}
