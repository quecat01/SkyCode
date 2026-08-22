import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";

import {
  tmpdir,
} from "node:os";

import {
  join,
} from "node:path";

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import {
  loadSkyMd,
} from "../src/config.ts";

// loadSkyMd() resolves its path from homedir(), which node:os derives from
// process.env.HOME on POSIX. Overriding HOME per test isolates these cases
// from whatever sky.md (if any) exists on the machine actually running the
// suite, matching the isolation approach used for project-directory-based
// configuration tests elsewhere in this file set.
describe(
  "loadSkyMd",
  () => {
    let testHomeDirectory:
      string;

    let originalHome:
      string | undefined;

    beforeEach(
      async () => {
        testHomeDirectory =
          await mkdtemp(
            join(
              tmpdir(),
              "sky-code-sky-md-",
            ),
          );

        originalHome =
          process.env.HOME;

        process.env.HOME =
          testHomeDirectory;
      },
    );

    afterEach(
      async () => {
        if (
          originalHome ===
          undefined
        ) {
          delete process.env
            .HOME;
        } else {
          process.env.HOME =
            originalHome;
        }

        await rm(
          testHomeDirectory,
          {
            recursive: true,
            force: true,
          },
        );
      },
    );

    it(
      "returns an empty string when sky.md does not exist",
      async () => {
        await expect(
          loadSkyMd(),
        ).resolves.toBe(
          "",
        );
      },
    );

    it(
      "returns the trimmed file contents when sky.md exists",
      async () => {
        await mkdir(
          join(
            testHomeDirectory,
            ".sky-code",
          ),
          {
            recursive: true,
          },
        );

        await writeFile(
          join(
            testHomeDirectory,
            ".sky-code",
            "sky.md",
          ),
          "\n  Confirm before destructive actions.\n\n",
          "utf8",
        );

        await expect(
          loadSkyMd(),
        ).resolves.toBe(
          "Confirm before destructive actions.",
        );
      },
    );

    // Root bypasses file permission checks entirely, so this test cannot
    // exercise an EACCES failure when the suite runs as root (as it does in
    // some containers/CI, though not on the sky user this ships for).
    const runningAsRoot =
      typeof process.getuid ===
        "function" &&
      process.getuid() === 0;

    it.skipIf(
      runningAsRoot,
    )(
      "surfaces a non-ENOENT read failure instead of silently ignoring it",
      async () => {
        const skyCodeDirectory =
          join(
            testHomeDirectory,
            ".sky-code",
          );

        await mkdir(
          skyCodeDirectory,
          {
            recursive: true,
          },
        );

        const skyMdPath =
          join(
            skyCodeDirectory,
            "sky.md",
          );

        await writeFile(
          skyMdPath,
          "Confirm before destructive actions.",
          "utf8",
        );

        // Remove read permission to force a non-ENOENT error (EACCES) rather
        // than a missing file, so we can confirm such failures are surfaced
        // rather than treated the same as "no sky.md present".
        await chmod(
          skyMdPath,
          0o000,
        );

        try {
          await expect(
            loadSkyMd(),
          ).rejects.toThrow(
            "Unable to read",
          );
        } finally {
          // Restore permissions so the temp directory can be cleaned up.
          await chmod(
            skyMdPath,
            0o644,
          );
        }
      },
    );
  },
);
