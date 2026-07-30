import {
  spawn,
  type ChildProcess,
} from "node:child_process";

import {
  BackgroundTaskCancelledError,
  type BackgroundTaskContext,
} from "./background.js";

export interface BackgroundShellOptions {
  progressIntervalMs?: number;
  maximumOutputBytes?: number;
}

export interface BackgroundShellResult {
  success: true;
  exitCode: 0;
  output: string;
  stdout: string;
  stderr: string;
}

export class BackgroundShellCommandError
  extends Error {
  public readonly exitCode:
    number | string;

  public readonly stdout:
    string;

  public readonly stderr:
    string;

  public constructor(
    exitCode:
      number | string,
    stdout: string,
    stderr: string,
  ) {
    const output =
      formatCommandOutput(
        exitCode,
        stdout,
        stderr,
      );

    super(
      `Shell command failed.\n\n${output}`,
    );

    this.name =
      "BackgroundShellCommandError";

    this.exitCode =
      exitCode;

    this.stdout =
      stdout;

    this.stderr =
      stderr;
  }
}

const DEFAULT_PROGRESS_INTERVAL_MS =
  1_000;

const DEFAULT_MAXIMUM_OUTPUT_BYTES =
  10 *
  1024 *
  1024;

function requireNonEmptyCommand(
  command: string,
): string {
  if (
    typeof command !==
      "string" ||
    command.trim() ===
      ""
  ) {
    throw new Error(
      "Background shell command must not be empty.",
    );
  }

  return command;
}

function requirePositiveInteger(
  value: number,
  fieldName: string,
): number {
  if (
    !Number.isInteger(
      value,
    ) ||
    value < 1
  ) {
    throw new Error(
      `${fieldName} must be a positive integer.`,
    );
  }

  return value;
}

function formatCommandOutput(
  exitCode:
    number | string,
  stdout: string,
  stderr: string,
): string {
  const sections = [
    `Exit code: ${exitCode}`,
  ];

  if (
    stdout !==
    ""
  ) {
    sections.push(
      `Standard output:\n${stdout}`,
    );
  }

  if (
    stderr !==
    ""
  ) {
    sections.push(
      `Standard error:\n${stderr}`,
    );
  }

  return sections.join(
    "\n\n",
  );
}

function describeError(
  error: unknown,
): string {
  return error instanceof
    Error
    ? error.message
    : String(
        error,
      );
}

function terminateProcessGroup(
  child: ChildProcess,
  signal:
    NodeJS.Signals,
): void {
  if (
    child.pid ===
      undefined ||
    child.killed
  ) {
    return;
  }

  if (
    process.platform !==
      "win32"
  ) {
    try {
      process.kill(
        -child.pid,
        signal,
      );

      return;
    } catch {
      // Fall back to terminating only the direct child.
    }
  }

  try {
    child.kill(
      signal,
    );
  } catch {
    // The process may already have exited.
  }
}

export async function runBackgroundShellCommand(
  commandValue: string,
  workingDirectory: string,
  context: BackgroundTaskContext,
  options:
    BackgroundShellOptions = {},
): Promise<BackgroundShellResult> {
  const command =
    requireNonEmptyCommand(
      commandValue,
    );

  const progressIntervalMs =
    requirePositiveInteger(
      options.progressIntervalMs ??
        DEFAULT_PROGRESS_INTERVAL_MS,
      "Background shell progress interval",
    );

  const maximumOutputBytes =
    requirePositiveInteger(
      options.maximumOutputBytes ??
        DEFAULT_MAXIMUM_OUTPUT_BYTES,
      "Background shell maximum output size",
    );

  if (
    context.signal
      .aborted
  ) {
    throw new BackgroundTaskCancelledError(
      "Background shell command was cancelled before it started.",
    );
  }

  await context.reportProgress(
    "Shell command is running.",
  );

  const startedAt =
    Date.now();

  return new Promise<
    BackgroundShellResult
  >(
    (
      resolve,
      reject,
    ) => {
      const child =
        spawn(
          "/bin/bash",
          [
            "-lc",
            command,
          ],
          {
            cwd:
              workingDirectory,
            detached:
              process.platform !==
              "win32",
            stdio: [
              "ignore",
              "pipe",
              "pipe",
            ],
          },
        );

      let stdout =
        "";

      let stderr =
        "";

      let outputBytes =
        0;

      let settled =
        false;

      let cancellationRequested =
        false;

      let progressFailure:
        Error | null =
        null;

      let forceKillTimer:
        NodeJS.Timeout |
        null =
        null;

      const progressTimer =
        setInterval(
          () => {
            const elapsedSeconds =
              Math.max(
                1,
                Math.floor(
                  (
                    Date.now() -
                    startedAt
                  ) /
                    1_000,
                ),
              );

            void context
              .reportProgress(
                `Shell command has been running for ${elapsedSeconds} second${elapsedSeconds === 1 ? "" : "s"}.`,
              )
              .catch(
                (
                  error,
                ) => {
                  if (
                    progressFailure
                  ) {
                    return;
                  }

                  progressFailure =
                    new Error(
                      `Unable to report background shell progress: ${describeError(error)}`,
                    );

                  terminateProcessGroup(
                    child,
                    "SIGTERM",
                  );
                },
              );
          },
          progressIntervalMs,
        );

      progressTimer.unref();

      const cleanup =
        (): void => {
          clearInterval(
            progressTimer,
          );

          if (
            forceKillTimer
          ) {
            clearTimeout(
              forceKillTimer,
            );

            forceKillTimer =
              null;
          }

          context.signal
            .removeEventListener(
              "abort",
              handleAbort,
            );

          child.removeListener(
            "error",
            handleError,
          );

          child.removeListener(
            "close",
            handleClose,
          );
        };

      const finishWithError =
        (
          error: Error,
        ): void => {
          if (
            settled
          ) {
            return;
          }

          settled =
            true;

          cleanup();

          reject(
            error,
          );
        };

      const finishSuccessfully =
        (
          result:
            BackgroundShellResult,
        ): void => {
          if (
            settled
          ) {
            return;
          }

          settled =
            true;

          cleanup();

          resolve(
            result,
          );
        };

      const appendOutput =
        (
          destination:
            "stdout" |
            "stderr",
          chunk:
            Buffer |
            string,
        ): void => {
          const text =
            typeof chunk ===
              "string"
              ? chunk
              : chunk.toString(
                  "utf8",
                );

          outputBytes +=
            Buffer.byteLength(
              text,
              "utf8",
            );

          if (
            outputBytes >
            maximumOutputBytes
          ) {
            progressFailure =
              new Error(
                `Background shell output exceeded ${maximumOutputBytes} bytes. The command was stopped to protect Sky Code.`,
              );

            terminateProcessGroup(
              child,
              "SIGTERM",
            );

            return;
          }

          if (
            destination ===
              "stdout"
          ) {
            stdout +=
              text;
          } else {
            stderr +=
              text;
          }
        };

      function handleAbort():
        void {
        if (
          settled ||
          cancellationRequested
        ) {
          return;
        }

        cancellationRequested =
          true;

        terminateProcessGroup(
          child,
          "SIGTERM",
        );

        forceKillTimer =
          setTimeout(
            () => {
              terminateProcessGroup(
                child,
                "SIGKILL",
              );
            },
            1_000,
          );

        forceKillTimer.unref();
      }

      function handleError(
        error: Error,
      ): void {
        finishWithError(
          new Error(
            `Unable to start the background shell command: ${error.message}`,
          ),
        );
      }

      function handleClose(
        code: number | null,
        signal:
          NodeJS.Signals | null,
      ): void {
        if (
          cancellationRequested ||
          context.signal
            .aborted
        ) {
          const reason =
            context.signal
              .reason;

          finishWithError(
            new BackgroundTaskCancelledError(
              reason instanceof
                Error
                ? reason.message
                : "Background shell command was cancelled.",
            ),
          );

          return;
        }

        if (
          progressFailure
        ) {
          finishWithError(
            progressFailure,
          );

          return;
        }

        if (
          signal !==
            null
        ) {
          finishWithError(
            new BackgroundShellCommandError(
              `signal ${signal}`,
              stdout,
              stderr,
            ),
          );

          return;
        }

        if (
          code !==
            0
        ) {
          finishWithError(
            new BackgroundShellCommandError(
              code ??
                "unknown",
              stdout,
              stderr,
            ),
          );

          return;
        }

        finishSuccessfully({
          success:
            true,
          exitCode:
            0,
          output:
            formatCommandOutput(
              0,
              stdout,
              stderr,
            ),
          stdout,
          stderr,
        });
      }

      child.stdout?.on(
        "data",
        (
          chunk:
            Buffer |
            string,
        ) => {
          appendOutput(
            "stdout",
            chunk,
          );
        },
      );

      child.stderr?.on(
        "data",
        (
          chunk:
            Buffer |
            string,
        ) => {
          appendOutput(
            "stderr",
            chunk,
          );
        },
      );

      context.signal
        .addEventListener(
          "abort",
          handleAbort,
          {
            once:
              true,
          },
        );

      child.once(
        "error",
        handleError,
      );

      child.once(
        "close",
        handleClose,
      );

      if (
        context.signal
          .aborted
      ) {
        handleAbort();
      }
    },
  );
}
