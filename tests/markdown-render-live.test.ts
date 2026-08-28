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
  "live markdown rendering wiring",
  () => {
    it(
      "imports createSkyCodeMarkdownStreamer",
      async () => {
        const source =
          await readIndexSource();

        expect(
          source,
        ).toContain(
          "createSkyCodeMarkdownStreamer,",
        );
      },
    );

    it(
      "creates exactly one streamer per streamModelTurn call, not shared across turns",
      async () => {
        const source =
          await readIndexSource();

        const occurrences =
          source.split(
            "createSkyCodeMarkdownStreamer()",
          ).length -
          1;

        // Exactly one call site: inside streamModelTurn, per turn. A shared
        // module-level instance would leak buffering state (an open code
        // fence) across unrelated assistant responses.
        expect(
          occurrences,
        ).toBe(
          1,
        );
      },
    );

    it(
      "routes all three normal-display write sites through the streamer's push(), not directly to output",
      async () => {
        const source =
          await readIndexSource();

        const pushOccurrences =
          source.split(
            "markdownStreamer.push(",
          ).length -
          1;

        expect(
          pushOccurrences,
        ).toBe(
          3,
        );
      },
    );

    it(
      "flushes the streamer with finish() only when the turn was actually normal display text",
      async () => {
        const source =
          await readIndexSource();

        const finishIndex =
          source.indexOf(
            "markdownStreamer.finish()",
          );

        expect(
          finishIndex,
        ).toBeGreaterThan(
          -1,
        );

        const precedingSource =
          source.slice(
            Math.max(
              0,
              finishIndex -
                200,
            ),
            finishIndex,
          );

        expect(
          precedingSource,
        ).toContain(
          'displayMode === "normal"',
        );
      },
    );
  },
);
