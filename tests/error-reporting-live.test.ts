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
  "live top-level error reporting",
  () => {
    it(
      "imports the tested cleaner error formatter",
      async () => {
        const source =
          await readIndexSource();

        expect(
          source,
        ).toContain(
          [
            "import {",
            "  formatCliErrorReport,",
            '} from "./error-reporting.js";',
          ].join(
            "\n",
          ),
        );

        expect(
          source,
        ).toContain(
          "function printCliError(",
        );
      },
    );

    it(
      "formats failed model requests consistently",
      async () => {
        const source =
          await readIndexSource();

        expect(
          source,
        ).toContain(
          [
            "        printCliError(",
            "          error,",
            '          "Model request",',
            "        );",
          ].join(
            "\n",
          ),
        );

        expect(
          source,
        ).not.toContain(
          "`Request failed: ${formatError(error)}`",
        );
      },
    );

    it(
      "formats fatal startup failures consistently",
      async () => {
        const source =
          await readIndexSource();

        expect(
          source,
        ).toContain(
          [
            "      printCliError(",
            "        error,",
            '        "SkyCode startup",',
            "      );",
          ].join(
            "\n",
          ),
        );

        expect(
          source,
        ).not.toContain(
          "`Sky Code could not start: ${formatError(error)}`",
        );
      },
    );
  },
);
