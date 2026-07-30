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
  COMPACTION_STRATEGIES,
  isCompactionStrategy,
  loadConfig,
  validateCompactionStrategy,
} from "../src/config.ts";

describe(
  "compaction configuration",
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
              "sky-code-compaction-config-",
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
            recursive:
              true,
            force:
              true,
          },
        );
      },
    );

    async function writeProjectConfig(
      value:
        unknown,
    ): Promise<void> {
      const configDirectory =
        join(
          testDirectory,
          ".sky-code",
        );

      await mkdir(
        configDirectory,
        {
          recursive:
            true,
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
      "defines exactly the two supported strategies",
      () => {
        expect(
          COMPACTION_STRATEGIES,
        ).toEqual([
          "summarise",
          "sliding-window",
        ]);

        for (
          const strategy of
          COMPACTION_STRATEGIES
        ) {
          expect(
            isCompactionStrategy(
              strategy,
            ),
          ).toBe(
            true,
          );

          expect(
            validateCompactionStrategy(
              strategy,
            ),
          ).toBe(
            strategy,
          );
        }
      },
    );

    it(
      "defines the Phase 3 default compaction settings",
      async () => {
        const defaults =
          JSON.parse(
            await readFile(
              new URL(
                "../config/defaults.json",
                import.meta.url,
              ),
              "utf8",
            ),
          );

        expect(
          defaults,
        ).toMatchObject({
          compactionThreshold:
            6_000,

          compactionStrategy:
            "summarise",

          compactionWindowSize:
            20,
        });
      },
    );

    it(
      "loads project compaction overrides",
      async () => {
        await writeProjectConfig({
          compactionThreshold:
            12_000,

          compactionStrategy:
            "sliding-window",

          compactionWindowSize:
            10,
        });

        const config =
          await loadConfig(
            testDirectory,
          );

        expect(
          config.compactionThreshold,
        ).toBe(
          12_000,
        );

        expect(
          config.compactionStrategy,
        ).toBe(
          "sliding-window",
        );

        expect(
          config.compactionWindowSize,
        ).toBe(
          10,
        );
      },
    );

    it(
      "rejects an invalid compaction threshold",
      async () => {
        await writeProjectConfig({
          compactionThreshold:
            0,
        });

        await expect(
          loadConfig(
            testDirectory,
          ),
        ).rejects.toThrow(
          "compactionThreshold must be a positive whole number",
        );
      },
    );

    it(
      "rejects an unsupported compaction strategy",
      async () => {
        await writeProjectConfig({
          compactionStrategy:
            "truncate-everything",
        });

        await expect(
          loadConfig(
            testDirectory,
          ),
        ).rejects.toThrow(
          'compactionStrategy must be either "summarise" or "sliding-window"',
        );
      },
    );

    it(
      "rejects an invalid compaction window size",
      async () => {
        await writeProjectConfig({
          compactionWindowSize:
            1.5,
        });

        await expect(
          loadConfig(
            testDirectory,
          ),
        ).rejects.toThrow(
          "compactionWindowSize must be a positive whole number",
        );
      },
    );
  },
);
