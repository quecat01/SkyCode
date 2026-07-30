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
    1,
  );
}

describe(
  "live recoverable runtime error reporting",
  () => {
    it(
      "formats model-list retrieval failures consistently",
      async () => {
        const source =
          await readIndexSource();

        expectOperation(
          source,
          "Model list retrieval",
        );

        expect(
          source,
        ).toContain(
          "Continuing with current model:",
        );
      },
    );

    it(
      "formats both session resume failures consistently",
      async () => {
        const source =
          await readIndexSource();

        expectOperation(
          source,
          "Session history inspection",
        );

        expectOperation(
          source,
          "Session resume selection",
        );

        expect(
          source.match(
            /Starting with a fresh conversation\./g,
          )?.length,
        ).toBeGreaterThanOrEqual(
          2,
        );
      },
    );

    it(
      "formats automatic compaction failures consistently",
      async () => {
        const source =
          await readIndexSource();

        expectOperation(
          source,
          "Automatic context compaction",
        );

        expect(
          source,
        ).toContain(
          "The active conversation history was not changed.",
        );
      },
    );

    it(
      "removes all four legacy recoverable error prefixes",
      async () => {
        const source =
          await readIndexSource();

        for (
          const prefix of
          [
            "Unable to retrieve models:",
            "Unable to inspect previous sessions:",
            "Unable to select the previous session:",
            "Automatic context compaction failed:",
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
