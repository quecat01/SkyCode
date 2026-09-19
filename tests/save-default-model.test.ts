import {
  mkdir,
  mkdtemp,
  readFile,
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
  saveDefaultModel,
} from "../src/config.ts";

// saveDefaultModel() resolves its path from homedir(), which node:os derives
// from process.env.HOME on POSIX. Overriding HOME per test isolates these
// cases from whatever config.json (if any) exists on the machine actually
// running the suite, matching the isolation approach used for loadSkyMd() in
// sky-md.test.ts.
describe(
  "saveDefaultModel",
  () => {
    let testHomeDirectory:
      string;

    let originalHome:
      string | undefined;

    let configPath: string;

    beforeEach(
      async () => {
        testHomeDirectory =
          await mkdtemp(
            join(
              tmpdir(),
              "sky-code-save-default-model-",
            ),
          );

        originalHome =
          process.env.HOME;

        process.env.HOME =
          testHomeDirectory;

        configPath =
          join(
            testHomeDirectory,
            ".sky-code",
            "config.json",
          );
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
      "creates config.json with the selected model when none exists yet",
      async () => {
        await saveDefaultModel(
          "chatgpt-gpt-5.5",
        );

        const contents =
          JSON.parse(
            await readFile(
              configPath,
              "utf8",
            ),
          );

        expect(
          contents,
        ).toEqual({
          defaultModel:
            "chatgpt-gpt-5.5",
        });
      },
    );

    it(
      "overwrites only defaultModel, preserving every other stored setting",
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
          configPath,
          JSON.stringify(
            {
              apiUrl:
                "http://litellm.test:4000/v1",
              defaultModel:
                "old-model",
              defaultPermissionMode:
                "default",
            },
            null,
            2,
          ),
          "utf8",
        );

        await saveDefaultModel(
          "new-model",
        );

        const contents =
          JSON.parse(
            await readFile(
              configPath,
              "utf8",
            ),
          );

        expect(
          contents,
        ).toEqual({
          apiUrl:
            "http://litellm.test:4000/v1",
          defaultModel:
            "new-model",
          defaultPermissionMode:
            "default",
        });
      },
    );

    it(
      "rejects when the existing config.json is not valid JSON",
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
          configPath,
          "{ not valid json",
          "utf8",
        );

        await expect(
          saveDefaultModel(
            "new-model",
          ),
        ).rejects.toThrow();
      },
    );

    it(
      "leaves no temporary file behind after a successful save",
      async () => {
        await saveDefaultModel(
          "chatgpt-gpt-5.5",
        );

        const { readdir } =
          await import(
            "node:fs/promises"
          );

        const entries =
          await readdir(
            join(
              testHomeDirectory,
              ".sky-code",
            ),
          );

        expect(
          entries,
        ).toEqual([
          "config.json",
        ]);
      },
    );
  },
);
