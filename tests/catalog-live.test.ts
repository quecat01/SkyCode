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

import {
  createSkyCodeSystemPrompt,
} from "../src/tools.ts";

describe(
  "live catalog integration",
  () => {
    it(
      "adds active catalog skills to the system prompt",
      () => {
        const prompt =
          createSkyCodeSystemPrompt(
            [],
            [],
            [],
            [
              {
                type:
                  "skill",

                name:
                  "python-style",

                description:
                  "Apply Python style",

                systemPromptAddition:
                  "Always follow PEP 8.",

                source:
                  "catalog",

                filePath:
                  "/tmp/python-style.json",
              },
            ],
          );

        expect(
          prompt,
        ).toContain(
          "Active custom catalog skills:",
        );

        expect(
          prompt,
        ).toContain(
          "- python-style: Apply Python style",
        );

        expect(
          prompt,
        ).toContain(
          "Instructions: Always follow PEP 8.",
        );
      },
    );

    it(
      "contains the live catalog startup and dispatcher wiring",
      async () => {
        const source =
          await readFile(
            join(
              process.cwd(),
              "src",
              "index.ts",
            ),
            "utf8",
          );

        expect(
          source,
        ).toContain(
          "await loadCatalog({",
        );

        expect(
          source,
        ).toContain(
          "validateCatalogPluginConflicts(",
        );

        expect(
          source,
        ).toContain(
          "resolveCatalogCommand(",
        );

        expect(
          source,
        ).toContain(
          "await executeCatalogShellCommand(",
        );

        expect(
          source,
        ).toContain(
          "activeCatalogSkills,",
        );
      },
    );
  },
);
