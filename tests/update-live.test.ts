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
  "live sky update routing",
  () => {
    it(
      "routes the update CLI argument to update.js before normal startup processing",
      async () => {
        const source =
          await readIndexSource();

        const diagnoseIndex =
          source.indexOf(
            '"diagnose"',
          );

        const updateIndex =
          source.indexOf(
            '"update"',
          );

        expect(
          diagnoseIndex,
        ).toBeGreaterThan(
          -1,
        );

        expect(
          updateIndex,
        ).toBeGreaterThan(
          -1,
        );

        // update routing must exist alongside diagnose's early routing,
        // both before the rest of runCli's normal startup processing.
        expect(
          updateIndex,
        ).toBeGreaterThan(
          diagnoseIndex,
        );

        const setupIndex =
          source.indexOf(
            '"setup"',
          );

        expect(
          setupIndex,
        ).toBeGreaterThan(
          updateIndex,
        );
      },
    );

    it(
      "imports runUpdate from update.js via dynamic import, matching diagnose's pattern",
      async () => {
        const source =
          await readIndexSource();

        expect(
          source,
        ).toContain(
          'await import(\n      "./update.js"\n    )',
        );

        expect(
          source,
        ).toContain(
          "runUpdate,",
        );
      },
    );
  },
);
