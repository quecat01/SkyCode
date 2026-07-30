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

function countOperation(
  source:
    string,

  operation:
    string,
): number {
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

  return (
    source.match(
      pattern,
    ) ??
    []
  ).length;
}

describe(
  "live shutdown error reporting",
  () => {
    it(
      "formats both background cancellation failures",
      async () => {
        const source =
          await readIndexSource();

        expect(
          countOperation(
            source,
            "Background task cancellation",
          ),
        ).toBe(
          2,
        );
      },
    );

    it(
      "formats both session and MCP cleanup failures",
      async () => {
        const source =
          await readIndexSource();

        expect(
          countOperation(
            source,
            "Session log finalization",
          ),
        ).toBe(
          2,
        );

        expect(
          countOperation(
            source,
            "MCP connection cleanup",
          ),
        ).toBe(
          2,
        );
      },
    );

    it(
      "removes all six legacy shutdown error prefixes",
      async () => {
        const source =
          await readIndexSource();

        for (
          const prefix of
          [
            "Unable to cancel background tasks:",
            "Unable to save session end:",
            "Unable to close MCP connections:",
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
