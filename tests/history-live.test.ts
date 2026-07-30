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
  "live current-session history search",
  () => {
    it(
      "imports the tested history parser, searcher, and formatter",
      async () => {
        const source =
          await readIndexSource();

        expect(
          source,
        ).toContain(
          "formatHistorySearchResults,",
        );

        expect(
          source,
        ).toContain(
          "parseHistoryCommand,",
        );

        expect(
          source,
        ).toContain(
          "searchSessionHistory,",
        );
      },
    );

    it(
      "searches the active session JSONL file",
      async () => {
        const source =
          await readIndexSource();

        expect(
          source,
        ).toContain(
          "await searchSessionHistory(",
        );

        expect(
          source,
        ).toContain(
          "sessionLogger.filePath,",
        );

        expect(
          source,
        ).toContain(
          "formatHistorySearchResults(",
        );
      },
    );

    it(
      "routes history commands before catalog management and custom commands",
      async () => {
        const source =
          await readIndexSource();

        const historyPosition =
          source.indexOf(
            "parseHistoryCommand(",
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
          historyPosition,
        ).toBeGreaterThan(
          -1,
        );

        expect(
          managementPosition,
        ).toBeGreaterThan(
          historyPosition,
        );

        expect(
          customCommandPosition,
        ).toBeGreaterThan(
          managementPosition,
        );
      },
    );
  },
);
