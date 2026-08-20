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
  "live thinking indicator integration",
  () => {
    it(
      "is a no-op when stdout is not a TTY, matching the SKYCODE_BANNER isTTY-fallback convention",
      async () => {
        const source =
          await readIndexSource();

        expect(
          source,
        ).toContain(
          [
            "function startThinkingIndicator(): () => void {",
            "  if (",
            "    !output.isTTY",
            "  ) {",
            "    return () => {};",
            "  }",
          ].join(
            "\n",
          ),
        );
      },
    );

    it(
      "starts before the model request and stops on the first content chunk",
      async () => {
        const source =
          await readIndexSource();

        expect(
          source,
        ).toContain(
          "const stopThinkingIndicator =\n    startThinkingIndicator();",
        );

        expect(
          source,
        ).toContain(
          "stopThinkingIndicator();\n\n          // Always preserve the entire response",
        );
      },
    );

    it(
      "stops the indicator in a finally block so an empty response or a thrown request error cannot leave it running",
      async () => {
        const source =
          await readIndexSource();

        expect(
          source,
        ).toContain(
          [
            "  } finally {",
            "    // Guards against a completely empty response (the callback above never",
            "    // ran) and against the request throwing before any content arrived;",
            "    // stopThinkingIndicator() is itself safe to call more than once.",
            "    stopThinkingIndicator();",
            "  }",
          ].join(
            "\n",
          ),
        );
      },
    );

    it(
      "the stop function clears its interval and erases the indicator line exactly once even if called twice",
      async () => {
        const source =
          await readIndexSource();

        expect(
          source,
        ).toContain(
          "if (\n      stopped\n    ) {\n      return;\n    }",
        );

        expect(
          source,
        ).toContain(
          'output.write(\n      "\\r\\x1b[2K",\n    );',
        );
      },
    );
  },
);
