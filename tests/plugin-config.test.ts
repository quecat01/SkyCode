import {
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
  loadConfig,
} from "../src/config.ts";

describe(
  "plugin directory configuration",
  () => {
    let testDirectory:
      string;

    let originalApiUrl:
      string | undefined;

    let originalApiKey:
      string | undefined;

    beforeEach(
      async () => {
        testDirectory =
          await mkdtemp(
            join(
              tmpdir(),
              "sky-code-plugin-config-",
            ),
          );

        originalApiUrl =
          process.env
            .LITELLM_API_URL;

        originalApiKey =
          process.env
            .LITELLM_API_KEY;

        process.env
          .LITELLM_API_URL =
          "http://litellm.test/v1";

        process.env
          .LITELLM_API_KEY =
          "temporary-test-key";
      },
    );

    afterEach(
      async () => {
        if (
          originalApiUrl ===
          undefined
        ) {
          delete process.env
            .LITELLM_API_URL;
        } else {
          process.env
            .LITELLM_API_URL =
            originalApiUrl;
        }

        if (
          originalApiKey ===
          undefined
        ) {
          delete process.env
            .LITELLM_API_KEY;
        } else {
          process.env
            .LITELLM_API_KEY =
            originalApiKey;
        }

        await rm(
          testDirectory,
          {
            recursive: true,
            force: true,
          },
        );
      },
    );

    async function writeProjectConfig(
      value: unknown,
    ): Promise<void> {
      const configDirectory =
        join(
          testDirectory,
          ".sky-code",
        );

      await mkdir(
        configDirectory,
        {
          recursive: true,
        },
      );

      await writeFile(
        join(
          configDirectory,
          "config.json",
        ),
        JSON.stringify(
          value,
          null,
          2,
        ),
        "utf8",
      );
    }

    it(
      "loads additional plugin directories",
      async () => {
        await writeProjectConfig({
          pluginDirs: [
            "/opt/sky-code/plugins",
            "./local-plugins",
          ],
        });

        const config =
          await loadConfig(
            testDirectory,
          );

        expect(
          config.pluginDirs,
        ).toEqual([
          "/opt/sky-code/plugins",
          "./local-plugins",
        ]);
      },
    );

    it(
      "uses an empty plugin directory list by default",
      async () => {
        const config =
          await loadConfig(
            testDirectory,
          );

        expect(
          config.pluginDirs,
        ).toEqual([]);
      },
    );

    it(
      "rejects empty plugin directory entries",
      async () => {
        await writeProjectConfig({
          pluginDirs: [
            "",
          ],
        });

        await expect(
          loadConfig(
            testDirectory,
          ),
        ).rejects.toThrow(
          "pluginDirs[0] must be a non-empty string",
        );
      },
    );
  },
);
