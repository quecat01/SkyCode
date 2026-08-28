import {
  execFileSync,
} from "node:child_process";

import {
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
  vi,
} from "vitest";

import {
  runUpdate,
} from "../src/update.ts";

/**
 * Runs a git/npm-style setup command synchronously, for test fixture setup
 * only. Real runUpdate() calls always go through the async, promisified
 * path in update.ts itself.
 */
function run(
  command: string,
  args: string[],
  cwd: string,
): void {
  execFileSync(
    command,
    args,
    {
      cwd,
    },
  );
}

/**
 * Creates a disposable origin (bare) repository and a local clone of it,
 * both containing a minimal package.json with no-op build/test scripts so
 * runUpdate()'s npm install/build/test steps complete instantly without a
 * real TypeScript or vitest setup.
 *
 * @returns {Promise<{originPath: string, localPath: string, tempRoot: string}>}
 */
async function createRepoFixture():
  Promise<{
    originPath: string;
    localPath: string;
    tempRoot: string;
  }> {
  const tempRoot =
    await mkdtemp(
      join(
        tmpdir(),
        "sky-update-test-",
      ),
    );

  const originPath =
    join(
      tempRoot,
      "origin.git",
    );

  const seedPath =
    join(
      tempRoot,
      "seed",
    );

  const localPath =
    join(
      tempRoot,
      "local",
    );

  run(
    "git",
    [
      "init",
      "--bare",
      "--initial-branch=main",
      originPath,
    ],
    tempRoot,
  );

  run(
    "git",
    [
      "init",
      "--initial-branch=main",
      seedPath,
    ],
    tempRoot,
  );

  run(
    "git",
    [
      "config",
      "user.email",
      "test@example.com",
    ],
    seedPath,
  );

  run(
    "git",
    [
      "config",
      "user.name",
      "Test",
    ],
    seedPath,
  );

  await writeFile(
    join(
      seedPath,
      "package.json",
    ),
    JSON.stringify(
      {
        name: "fixture",
        version: "1.0.0",
        scripts: {
          build: "true",
          test: "true",
        },
      },
    ),
    "utf8",
  );

  run(
    "git",
    [
      "add",
      "package.json",
    ],
    seedPath,
  );

  run(
    "git",
    [
      "commit",
      "-q",
      "-m",
      "initial",
    ],
    seedPath,
  );

  run(
    "git",
    [
      "branch",
      "-M",
      "main",
    ],
    seedPath,
  );

  run(
    "git",
    [
      "remote",
      "add",
      "origin",
      originPath,
    ],
    seedPath,
  );

  run(
    "git",
    [
      "push",
      "-q",
      "origin",
      "main",
    ],
    seedPath,
  );

  // A bare repo's HEAD does not automatically follow "main" unless set
  // explicitly; without this, cloning it produces a detached, unusable
  // checkout.
  run(
    "git",
    [
      "symbolic-ref",
      "HEAD",
      "refs/heads/main",
    ],
    originPath,
  );

  run(
    "git",
    [
      "clone",
      "-q",
      originPath,
      localPath,
    ],
    tempRoot,
  );

  run(
    "git",
    [
      "config",
      "user.email",
      "test@example.com",
    ],
    localPath,
  );

  run(
    "git",
    [
      "config",
      "user.name",
      "Test",
    ],
    localPath,
  );

  return {
    originPath,
    localPath,
    tempRoot,
  };
}

/**
 * Pushes one additional commit to the fixture's origin, simulating another
 * machine publishing an update, without touching the local clone under
 * test. Uses a separate throwaway clone so the local fixture clone's own
 * working tree and index are never touched by this setup step.
 */
async function pushAdditionalCommitToOrigin(
  originPath: string,
  tempRoot: string,
): Promise<void> {
  const pusherPath =
    join(
      tempRoot,
      "pusher",
    );

  run(
    "git",
    [
      "clone",
      "-q",
      originPath,
      pusherPath,
    ],
    tempRoot,
  );

  run(
    "git",
    [
      "config",
      "user.email",
      "test@example.com",
    ],
    pusherPath,
  );

  run(
    "git",
    [
      "config",
      "user.name",
      "Test",
    ],
    pusherPath,
  );

  await writeFile(
    join(
      pusherPath,
      "NEW_FILE.txt",
    ),
    "new content\n",
    "utf8",
  );

  run(
    "git",
    [
      "add",
      "NEW_FILE.txt",
    ],
    pusherPath,
  );

  run(
    "git",
    [
      "commit",
      "-q",
      "-m",
      "an update",
    ],
    pusherPath,
  );

  run(
    "git",
    [
      "push",
      "-q",
      "origin",
      "main",
    ],
    pusherPath,
  );
}

describe(
  "runUpdate",
  () => {
    let fixture:
      {
        originPath: string;
        localPath: string;
        tempRoot: string;
      };

    let logSpy:
      ReturnType<
        typeof vi.spyOn
      >;

    let errorSpy:
      ReturnType<
        typeof vi.spyOn
      >;

    beforeEach(
      async () => {
        fixture =
          await createRepoFixture();

        logSpy = vi
          .spyOn(
            console,
            "log",
          )
          .mockImplementation(
            () => {},
          );

        errorSpy = vi
          .spyOn(
            console,
            "error",
          )
          .mockImplementation(
            () => {},
          );
      },
    );

    afterEach(
      async () => {
        logSpy.mockRestore();
        errorSpy.mockRestore();

        await rm(
          fixture.tempRoot,
          {
            recursive: true,
            force: true,
          },
        );
      },
    );

    it(
      "refuses to update when the installation has uncommitted changes",
      async () => {
        await writeFile(
          join(
            fixture.localPath,
            "package.json",
          ),
          JSON.stringify(
            {
              name: "fixture",
              version: "1.0.1",
            },
          ),
          "utf8",
        );

        await runUpdate(
          fixture.localPath,
        );

        expect(
          errorSpy.mock
            .calls.flat()
            .join(
              "\n",
            ),
        ).toContain(
          "uncommitted changes",
        );

        // Confirms nothing was pulled: the file is still modified exactly
        // as this test left it, not reset or merged over.
        const status =
          execFileSync(
            "git",
            [
              "status",
              "--porcelain",
            ],
            {
              cwd: fixture.localPath,
            },
          ).toString();

        expect(
          status.trim(),
        ).not.toBe(
          "",
        );
      },
    );

    it(
      "refuses to update when not on the main branch",
      async () => {
        run(
          "git",
          [
            "checkout",
            "-q",
            "-b",
            "some-feature-branch",
          ],
          fixture.localPath,
        );

        await runUpdate(
          fixture.localPath,
        );

        expect(
          errorSpy.mock
            .calls.flat()
            .join(
              "\n",
            ),
        ).toContain(
          "not 'main'",
        );
      },
    );

    it(
      "reports already up to date and makes no changes when nothing new exists upstream",
      async () => {
        await runUpdate(
          fixture.localPath,
        );

        expect(
          logSpy.mock
            .calls.flat()
            .join(
              "\n",
            ),
        ).toContain(
          "Already up to date.",
        );

        expect(
          errorSpy,
        ).not.toHaveBeenCalled();
      },
    );

    it(
      "refuses to update when local main has diverged from origin/main",
      async () => {
        await writeFile(
          join(
            fixture.localPath,
            "LOCAL_ONLY.txt",
          ),
          "local-only change\n",
          "utf8",
        );

        run(
          "git",
          [
            "add",
            "LOCAL_ONLY.txt",
          ],
          fixture.localPath,
        );

        run(
          "git",
          [
            "commit",
            "-q",
            "-m",
            "local commit not on origin",
          ],
          fixture.localPath,
        );

        await runUpdate(
          fixture.localPath,
        );

        expect(
          errorSpy.mock
            .calls.flat()
            .join(
              "\n",
            ),
        ).toContain(
          "diverged",
        );
      },
    );

    it(
      "pulls, installs, builds, and tests successfully when a fast-forward update is available",
      async () => {
        await pushAdditionalCommitToOrigin(
          fixture.originPath,
          fixture.tempRoot,
        );

        await runUpdate(
          fixture.localPath,
        );

        const loggedText =
          logSpy.mock
            .calls.flat()
            .join(
              "\n",
            );

        expect(
          loggedText,
        ).toContain(
          "Update complete.",
        );

        expect(
          errorSpy,
        ).not.toHaveBeenCalled();

        // Confirms the pull actually happened: the file pushed to origin
        // by the "other machine" is now present locally.
        const files =
          execFileSync(
            "ls",
            [
              fixture.localPath,
            ],
          ).toString();

        expect(
          files,
        ).toContain(
          "NEW_FILE.txt",
        );
      },
    );
  },
);
