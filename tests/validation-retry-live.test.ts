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
  "live sky-tool validation retry-with-feedback",
  () => {
    it(
      "defines a small, dedicated retry cap separate from MAX_TOOL_ROUNDS",
      async () => {
        const source =
          await readIndexSource();

        expect(
          source,
        ).toContain(
          "const MAX_VALIDATION_RETRIES = 2;",
        );
      },
    );

    it(
      "wraps parseSkyToolRequest in try/catch instead of letting validation errors propagate uncaught",
      async () => {
        const source =
          await readIndexSource();

        expect(
          source,
        ).toContain(
          "try {\n      toolRequest =\n        parseSkyToolRequest(",
        );
      },
    );

    it(
      "records the malformed assistant response instead of discarding it",
      async () => {
        const source =
          await readIndexSource();

        const catchBlockIndex =
          source.indexOf(
            "} catch (error) {\n      // Record the malformed response",
          );

        expect(
          catchBlockIndex,
        ).toBeGreaterThan(
          -1,
        );

        const nearbySource =
          source.slice(
            catchBlockIndex,
            catchBlockIndex +
              400,
          );

        expect(
          nearbySource,
        ).toContain(
          "messages.push({\n        role: \"assistant\",",
        );
      },
    );

    it(
      "sends a role:user feedback message describing the validation error and continues the loop",
      async () => {
        const source =
          await readIndexSource();

        const callSiteIndex =
          source.indexOf(
            "const feedbackMessage =\n        createValidationErrorFeedbackMessage(",
          );

        expect(
          callSiteIndex,
        ).toBeGreaterThan(
          -1,
        );

        expect(
          source,
        ).toContain(
          "messages.push({\n        role: \"user\",\n        content:\n          feedbackMessage,\n      });",
        );

        const nearbySource =
          source.slice(
            callSiteIndex,
            callSiteIndex +
              1200,
          );

        expect(
          nearbySource,
        ).toContain(
          "continue;",
        );
      },
    );

    it(
      "gives up gracefully (returns) rather than throwing once retries are exhausted",
      async () => {
        const source =
          await readIndexSource();

        expect(
          source,
        ).toContain(
          "consecutiveValidationFailures >\n        MAX_VALIDATION_RETRIES",
        );

        const capCheckIndex =
          source.indexOf(
            "consecutiveValidationFailures >\n        MAX_VALIDATION_RETRIES",
          );

        const nearbySource =
          source.slice(
            capCheckIndex,
            capCheckIndex +
              400,
          );

        expect(
          nearbySource,
        ).toContain(
          "return;",
        );

        expect(
          nearbySource,
        ).not.toContain(
          "throw",
        );
      },
    );

    it(
      "resets the failure counter after any valid response",
      async () => {
        const source =
          await readIndexSource();

        expect(
          source,
        ).toContain(
          "consecutiveValidationFailures = 0;",
        );
      },
    );

    it(
      "still lets genuinely unrelated errors (for example streamModelTurn failures) propagate normally",
      async () => {
        const source =
          await readIndexSource();

        // streamModelTurn is called before the try/catch this test suite
        // covers, so its own errors are unaffected by the retry logic and
        // continue to surface through completeConversationTurn's caller.
        const streamCallIndex =
          source.indexOf(
            "const streamedTurn =\n",
          );

        const tryBlockIndex =
          source.indexOf(
            "try {\n      toolRequest =\n        parseSkyToolRequest(",
          );

        expect(
          streamCallIndex,
        ).toBeGreaterThan(
          -1,
        );

        expect(
          tryBlockIndex,
        ).toBeGreaterThan(
          streamCallIndex,
        );
      },
    );
  },
);
