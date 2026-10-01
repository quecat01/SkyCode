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
      "creates exactly one streamer per completion, not shared across turns, across every implementation that renders one",
      async () => {
        const source =
          await readIndexSource();

        const occurrences =
          source.split(
            "createSkyCodeMarkdownStreamer()",
          ).length -
          1;

        // Three call sites during this transitional dual-implementation
        // window: createVisibleTextCompletionClient's per-call streamer (the
        // live wiring path's streaming render), streamModelTurn's own
        // per-turn streamer (the old path, kept alongside it per the
        // approved incremental rollout), and completeConversationTurn's own
        // final-answer streamer (the live wiring path's one-shot render for
        // a completion that was not already streamed, e.g. NativeStrategy's
        // non-streaming answer - see AgentTurnOutcome.alreadyDisplayed,
        // agent/types.ts). None of these is a shared module-level instance,
        // so none leaks buffering state (an open code fence) across
        // unrelated assistant responses. This count should shrink back down
        // to 2 once streamModelTurn is removed in the later cleanup step.
        expect(
          occurrences,
        ).toBe(
          3,
        );
      },
    );

    it(
      "routes every normal-display write site through a streamer's push(), not directly to output",
      async () => {
        const source =
          await readIndexSource();

        const pushOccurrences =
          source.split(
            "markdownStreamer.push(",
          ).length -
          1;

        // 3 inside streamModelTurn's own chunk callback (the old path) + 1
        // inside createVisibleTextCompletionClient's chunk callback (the
        // live wiring path's streaming render) + 1 inside
        // completeConversationTurn's own final-answer one-shot render = 5.
        // Shrinks back down to 4 once streamModelTurn is removed.
        expect(
          pushOccurrences,
        ).toBe(
          5,
        );
      },
    );

    it(
      "flushes every streamer with finish() only when its own turn actually needs the buffered text rendered",
      async () => {
        const source =
          await readIndexSource();

        const finishMatches =
          [
            ...source.matchAll(
              /markdownStreamer\.finish\(\)/g,
            ),
          ];

        // One finish() call site per streamer-creating implementation (see
        // the "creates exactly one streamer" test above): today,
        // createVisibleTextCompletionClient, streamModelTurn, and
        // completeConversationTurn's own final-answer renderer.
        expect(
          finishMatches.length,
        ).toBe(
          3,
        );

        // Every implementation guards its own finish() call so an
        // unconditional flush is never reintroduced, but not all three use
        // the same guard shape: createVisibleTextCompletionClient and
        // streamModelTurn both classify a streamed chunk and check
        // `<their own mode variable> === "normal"` (formatted differently
        // between the two - this codebase's one-token-per-line style breaks
        // the newer `finalClassification.mode ===` / `"normal"` across two
        // lines, while the older streamModelTurn code keeps
        // `displayMode === "normal"` on one line - hence the whitespace-
        // tolerant pattern below), while completeConversationTurn's
        // final-answer renderer instead branches on
        // `outcome.alreadyDisplayed` (see AgentTurnOutcome, agent/types.ts)
        // inside an if/empty-response/else-if/alreadyDisplayed/else chain,
        // so its own finish() call sits in the final `else` branch. Each
        // finish() call site's preceding text must match at least one of
        // these known guard shapes.
        const guardPatterns = [
          /===\s*"normal"/,
          /outcome\.alreadyDisplayed/,
        ];

        for (
          const match of finishMatches
        ) {
          const finishIndex =
            match.index ??
            0;

          const precedingSource =
            source.slice(
              Math.max(
                0,
                finishIndex -
                  400,
              ),
              finishIndex,
            );

          const matchesKnownGuard =
            guardPatterns.some(
              (pattern) =>
                pattern.test(
                  precedingSource,
                ),
            );

          expect(
            matchesKnownGuard,
          ).toBe(
            true,
          );
        }
      },
    );
  },
);
