/**
 * `sky update` - updates an existing Sky Code installation in place.
 *
 * Pulls the latest committed code from GitHub, reinstalls dependencies,
 * rebuilds, and runs the test suite as a final safety check, refusing to
 * proceed at the first sign of anything that could put local state at risk
 * (uncommitted changes, a non-main branch, or diverged history).
 *
 * Deliberately never touches ~/.sky-code/ (config, .env, sky.md, sessions):
 * every step here operates only on the git-tracked installation directory
 * itself, matching the standing project rule that ~/.sky-code/sky.md in
 * particular must never be written to without explicit user action.
 */

import {
  execFile,
} from "node:child_process";

import {
  dirname,
} from "node:path";

import {
  fileURLToPath,
} from "node:url";

import {
  promisify,
} from "node:util";

import {
  formatCliErrorReport,
} from "./error-reporting.js";

const execFileAsync =
  promisify(
    execFile,
  );

/**
 * Resolves the Sky Code installation directory (the git repository root)
 * from this module's own compiled location on disk, not the caller's
 * current working directory.
 *
 * This matters because `sky` is installed as a global command (see
 * install.sh's `npm link` step) and can be invoked from any directory;
 * `sky update` must always operate on the actual installation, wherever it
 * lives, not wherever the person happened to run the command from.
 *
 * @returns {string} Absolute path to the installation's repository root.
 *
 * Side effects: none.
 */
function resolveInstallDirectory():
  string {
  // Compiled to <install>/dist/update.js (see tsconfig's rootDir/outDir),
  // so the repository root is exactly one directory above this file.
  const distDirectory =
    dirname(
      fileURLToPath(
        import.meta.url,
      ),
    );

  return dirname(
    distDirectory,
  );
}

/**
 * Runs a command to completion in the given directory and returns its
 * captured output.
 *
 * @param {string} command - Executable to run (for example "git" or "npm").
 * @param {string[]} args - Argument vector, never shell-interpreted.
 * @param {string} cwd - Working directory the command runs in.
 * @returns {Promise<{stdout: string, stderr: string}>} Captured output.
 * @throws {Error} If the command exits with a non-zero status or cannot be
 * spawned at all.
 *
 * Side effects: spawns a child process.
 */
async function runCommand(
  command: string,
  args: string[],
  cwd: string,
): Promise<{
  stdout: string;
  stderr: string;
}> {
  const result =
    await execFileAsync(
      command,
      args,
      {
        cwd,
      },
    );

  return {
    stdout:
      result.stdout.toString(),
    stderr:
      result.stderr.toString(),
  };
}

/**
 * Prints a failure in Sky Code's standard CLI error-report format.
 *
 * A local counterpart to the same-shaped helper in index.ts: duplicated
 * rather than imported to avoid update.ts depending back on index.ts,
 * since index.ts is what imports and routes to update.ts, not the reverse.
 *
 * @param {unknown} error - Failure value to report.
 * @param {string} operation - Short label for what was being attempted.
 * @returns {void}
 *
 * Side effects: writes error-report lines to stderr.
 */
function printUpdateError(
  error: unknown,
  operation: string,
): void {
  for (const line of formatCliErrorReport(
    error,
    {
      operation,
    },
  )) {
    console.error(
      line,
    );
  }
}

/**
 * Runs `sky update`: pulls the latest release, reinstalls dependencies,
 * rebuilds, and runs the test suite.
 *
 * Refuses to proceed, with a clear explanation and no changes made, when:
 * - the installation directory has uncommitted changes
 * - the current branch is not `main`
 * - local `main` has diverged from `origin/main` (local commits that are
 *   not upstream, which would require a merge or rebase to resolve)
 *
 * @param {string} [installDirectoryOverride] - Installation directory to
 * operate on instead of the real resolved location. Exists so tests can
 * exercise this function against a disposable temporary git repository
 * rather than this module's own real installation directory.
 * @returns {Promise<void>} Resolves once the update completes, is skipped
 * as already up to date, or is refused for one of the reasons above.
 *
 * Side effects: runs git, npm install, npm run build, and npm test as
 * child processes in the installation directory; may modify files there.
 */
export async function runUpdate(
  installDirectoryOverride?: string,
): Promise<void> {
  const installDirectory =
    installDirectoryOverride ??
    resolveInstallDirectory();

  console.log(
    `Checking for updates in ${installDirectory} ...`,
  );

  let status:
    {
      stdout: string;
      stderr: string;
    };

  try {
    status =
      await runCommand(
        "git",
        [
          "status",
          "--porcelain",
        ],
        installDirectory,
      );
  } catch (error) {
    printUpdateError(
      error,
      "Checking installation status",
    );

    return;
  }

  if (
    status.stdout.trim() !==
    ""
  ) {
    console.error(
      `Refusing to update: ${installDirectory} has uncommitted changes.`,
    );

    console.error(
      "Commit, stash, or discard them first, then run 'sky update' again.",
    );

    return;
  }

  let currentBranch:
    string;

  try {
    currentBranch = (
      await runCommand(
        "git",
        [
          "rev-parse",
          "--abbrev-ref",
          "HEAD",
        ],
        installDirectory,
      )
    ).stdout.trim();
  } catch (error) {
    printUpdateError(
      error,
      "Checking current branch",
    );

    return;
  }

  if (
    currentBranch !==
    "main"
  ) {
    console.error(
      `Refusing to update: currently on branch '${currentBranch}', not 'main'.`,
    );

    console.error(
      "Switch to main yourself first, then run 'sky update' again.",
    );

    return;
  }

  try {
    await runCommand(
      "git",
      [
        "fetch",
        "origin",
      ],
      installDirectory,
    );
  } catch (error) {
    printUpdateError(
      error,
      "Fetching latest changes",
    );

    return;
  }

  let localHead:
    string;

  let remoteHead:
    string;

  try {
    localHead = (
      await runCommand(
        "git",
        [
          "rev-parse",
          "HEAD",
        ],
        installDirectory,
      )
    ).stdout.trim();

    remoteHead = (
      await runCommand(
        "git",
        [
          "rev-parse",
          "origin/main",
        ],
        installDirectory,
      )
    ).stdout.trim();
  } catch (error) {
    printUpdateError(
      error,
      "Comparing local and remote commits",
    );

    return;
  }

  if (
    localHead ===
    remoteHead
  ) {
    console.log(
      "Already up to date.",
    );

    return;
  }

  try {
    await runCommand(
      "git",
      [
        "merge-base",
        "--is-ancestor",
        localHead,
        remoteHead,
      ],
      installDirectory,
    );
  } catch {
    // A non-zero exit here means localHead is not an ancestor of
    // remoteHead: local main has its own commits that origin does not,
    // and a fast-forward is not possible.
    console.error(
      "Refusing to update: local main has diverged from origin/main (local commits that are not upstream).",
    );

    console.error(
      "Resolve this manually (for example, rebase or reset), then run 'sky update' again.",
    );

    return;
  }

  try {
    console.log(
      "Pulling latest changes...",
    );

    await runCommand(
      "git",
      [
        "merge",
        "--ff-only",
        "origin/main",
      ],
      installDirectory,
    );

    console.log(
      "Installing dependencies...",
    );

    await runCommand(
      "npm",
      [
        "install",
      ],
      installDirectory,
    );

    console.log(
      "Building...",
    );

    await runCommand(
      "npm",
      [
        "run",
        "build",
      ],
      installDirectory,
    );

    console.log(
      "Running tests...",
    );

    await runCommand(
      "npm",
      [
        "test",
      ],
      installDirectory,
    );
  } catch (error) {
    printUpdateError(
      error,
      "Update",
    );

    console.error(
      `The installation may be in a partially updated state. Inspect ${installDirectory} before running 'sky' again.`,
    );

    return;
  }

  console.log(
    `Update complete. Now at ${remoteHead.slice(0, 7)}.`,
  );
}
