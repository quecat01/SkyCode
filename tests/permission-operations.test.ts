import {
  access,
  mkdtemp,
  readFile,
  rm,
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
  describeEditFilePlan,
  describeReadFilePlan,
  describeWriteFilePlan,
} from "../src/fileops.ts";

import {
  runShellCommandForPermissionMode,
} from "../src/shell.ts";

describe(
  "permission-aware file and shell operations",
  () => {
    let testDirectory:
      string;

    beforeEach(
      async () => {
        testDirectory =
          await mkdtemp(
            join(
              tmpdir(),
              "sky-code-permission-operations-",
            ),
          );
      },
    );

    afterEach(
      async () => {
        await rm(
          testDirectory,
          {
            recursive:
              true,
            force:
              true,
          },
        );
      },
    );

    it(
      "describes file operations without accessing or changing files",
      () => {
        expect(
          describeReadFilePlan(
            "missing.txt",
            testDirectory,
          ),
        ).toBe(
          `Plan mode: Sky Code would read ${join(testDirectory, "missing.txt")}, but no file was read.`,
        );

        expect(
          describeWriteFilePlan(
            "write.txt",
            "hello",
            testDirectory,
          ),
        ).toBe(
          `Plan mode: Sky Code would write 5 bytes to ${join(testDirectory, "write.txt")}, but no file was changed.`,
        );

        expect(
          describeEditFilePlan(
            "edit.txt",
            testDirectory,
          ),
        ).toBe(
          `Plan mode: Sky Code would edit ${join(testDirectory, "edit.txt")} by replacing the requested text, but no file was changed.`,
        );
      },
    );

    it(
      "does not execute a shell command in plan mode",
      async () => {
        const markerPath =
          join(
            testDirectory,
            "plan-marker.txt",
          );

        const result =
          await runShellCommandForPermissionMode(
            `touch ${JSON.stringify(markerPath)}`,
            "plan",
            testDirectory,
            async () => {
              throw new Error(
                "Plan mode must not request approval.",
              );
            },
          );

        expect(
          result.success,
        ).toBe(true);

        expect(
          result.output,
        ).toContain(
          "but no command was executed",
        );

        await expect(
          access(
            markerPath,
          ),
        ).rejects.toThrow();
      },
    );

    it(
      "executes without prompting in bypass mode",
      async () => {
        const markerPath =
          join(
            testDirectory,
            "bypass-marker.txt",
          );

        const result =
          await runShellCommandForPermissionMode(
            `printf bypass > ${JSON.stringify(markerPath)}`,
            "bypass",
            testDirectory,
            async () => {
              throw new Error(
                "Bypass mode must not request approval.",
              );
            },
          );

        expect(
          result.success,
        ).toBe(true);

        expect(
          await readFile(
            markerPath,
            "utf8",
          ),
        ).toBe(
          "bypass",
        );
      },
    );

    it(
      "still requests approval for shell commands in auto-accept-edits mode",
      async () => {
        const markerPath =
          join(
            testDirectory,
            "auto-marker.txt",
          );

        let promptCount = 0;

        const result =
          await runShellCommandForPermissionMode(
            `touch ${JSON.stringify(markerPath)}`,
            "auto-accept-edits",
            testDirectory,
            async (
              message,
            ) => {
              promptCount += 1;

              expect(
                message,
              ).toContain(
                "Allow Sky Code to run this command?",
              );

              return false;
            },
          );

        expect(
          promptCount,
        ).toBe(1);

        expect(
          result,
        ).toEqual({
          success:
            false,
          output:
            "Permission denied. Sky Code did not run the command.",
        });

        await expect(
          access(
            markerPath,
          ),
        ).rejects.toThrow();
      },
    );

    it(
      "preserves approval behavior in default mode",
      async () => {
        let promptCount = 0;

        const result =
          await runShellCommandForPermissionMode(
            "printf approved",
            "default",
            testDirectory,
            async () => {
              promptCount += 1;
              return true;
            },
          );

        expect(
          promptCount,
        ).toBe(1);

        expect(
          result.success,
        ).toBe(true);

        expect(
          result.output,
        ).toContain(
          "Standard output:\napproved",
        );
      },
    );
  },
);
