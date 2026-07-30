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

describe(
  "live catalog management integration",
  () => {
    it(
      "loads the live catalog through CatalogManager",
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
          "new CatalogManager({",
        );

        expect(
          source,
        ).toContain(
          "catalogManager\n      .getSnapshot();",
        );

        expect(
          source,
        ).toContain(
          "catalogManager\n      .getActiveSkills();",
        );
      },
    );

    it(
      "routes catalog management commands before custom catalog commands",
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

        const managementPosition =
          source.indexOf(
            "parseCatalogManagementCommand(",
          );

        const customCommandPosition =
          source.indexOf(
            "resolveCatalogCommand(",
          );

        expect(
          managementPosition,
        ).toBeGreaterThan(
          -1,
        );

        expect(
          customCommandPosition,
        ).toBeGreaterThan(
          managementPosition,
        );
      },
    );

    it(
      "refreshes the catalog snapshot, active skills, and system prompt immediately",
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
          "catalog =\n            result.catalog;",
        );

        expect(
          source,
        ).toContain(
          "activeCatalogSkills =\n            result.activeSkills;",
        );

        expect(
          source,
        ).toContain(
          "systemPrompt =\n            createSkyCodeSystemPrompt(",
        );

        expect(
          source,
        ).toContain(
          "await catalogManager\n              .execute(",
        );
      },
    );
  },
);
