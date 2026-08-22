import {
  readFile,
} from "node:fs/promises";

import {
  join,
} from "node:path";

import {
  describe,
  expect,
  it,
} from "vitest";

async function readIndexSource():
  Promise<string> {
  return readFile(
    join(
      process.cwd(),
      "src",
      "index.ts",
    ),
    "utf8",
  );
}

describe(
  "live sky.md wiring",
  () => {
    it(
      "imports loadSkyMd alongside loadConfig",
      async () => {
        const source =
          await readIndexSource();

        expect(
          source,
        ).toContain(
          "loadSkyMd,",
        );
      },
    );

    it(
      "loads sky.md content once and passes it to both system prompt call sites",
      async () => {
        const source =
          await readIndexSource();

        const skyMdContentOccurrences =
          source.split(
            "skyMdContent",
          ).length -
          1;

        // One declaration (`const skyMdContent = await loadSkyMd();`) plus
        // one usage per createSkyCodeSystemPrompt call site (initial
        // generation and catalog-change regeneration).
        expect(
          skyMdContentOccurrences,
        ).toBe(
          3,
        );

        expect(
          source,
        ).toContain(
          [
            "  const skyMdContent =",
            "    await loadSkyMd();",
          ].join(
            "\n",
          ),
        );
      },
    );

    it(
      "does not load sky.md between configuration loading and the startup health check",
      async () => {
        const source =
          await readIndexSource();

        // Guards against reintroducing code between loadConfig and
        // runStartupHealthCheck, which startup-health-live.test.ts requires
        // to run back-to-back.
        expect(
          source,
        ).toContain(
          [
            "  const config =",
            "    await loadConfig(",
            "      workingDirectory,",
            "    );",
            "",
            "  await runStartupHealthCheck(",
            "    config,",
            "  );",
          ].join(
            "\n",
          ),
        );
      },
    );
  },
);
