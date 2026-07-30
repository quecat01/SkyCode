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

function expectOperation(
  source:
    string,

  operation:
    string,

  expectedCount:
    number = 1,
): void {
  const escapedOperation =
    operation.replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&",
    );

  const pattern =
    new RegExp(
      [
        "printCliError\\(",
        "\\s*error,",
        `\\s*"${escapedOperation}",`,
        "\\s*\\);",
      ].join(
        "",
      ),
      "g",
    );

  const matches =
    source.match(
      pattern,
    ) ??
    [];

  expect(
    matches,
  ).toHaveLength(
    expectedCount,
  );
}

describe(
  "live command error reporting",
  () => {
    it(
      "uses cleaner reporting for compaction and history errors",
      async () => {
        const source =
          await readIndexSource();

        expectOperation(
          source,
          "Context compaction",
        );

        expectOperation(
          source,
          "History command",
        );

        expectOperation(
          source,
          "History search",
        );
      },
    );

    it(
      "uses cleaner reporting for every catalog error",
      async () => {
        const source =
          await readIndexSource();

        expectOperation(
          source,
          "Catalog management command",
          2,
        );

        expectOperation(
          source,
          "Catalog command",
        );

        expectOperation(
          source,
          "Catalog shell command",
        );
      },
    );

    it(
      "removes all seven legacy command-error prefixes",
      async () => {
        const source =
          await readIndexSource();

        for (
          const prefix of
          [
            "Context compaction failed:",
            "History command failed:",
            "History search failed:",
            "Catalog management command failed:",
            "Catalog command failed:",
            "Catalog shell command failed:",
          ]
        ) {
          expect(
            source,
          ).not.toContain(
            prefix,
          );
        }
      },
    );
  },
);
