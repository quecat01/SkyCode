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

// selectModel()'s interactive "save as persistent default" behavior lives in
// index.ts, which is exercised through source inspection rather than direct
// unit tests, matching the *-live.test.ts convention used for index.ts
// internals elsewhere in this test suite (selectModel() itself is not
// exported and drives an interactive CLI prompt loop).
describe(
  "selectModel persistent-default wiring",
  () => {
    it(
      "imports confirmAction and saveDefaultModel",
      async () => {
        const source =
          await readIndexSource();

        expect(
          source,
        ).toContain(
          "confirmAction,",
        );

        expect(
          source,
        ).toContain(
          "saveDefaultModel,",
        );
      },
    );

    it(
      "asks to persist only after a model has actually been selected",
      async () => {
        const source =
          await readIndexSource();

        const activeModelLogIndex =
          source.indexOf(
            "`Active model: ${selectedModel}`",
          );

        const confirmIndex =
          source.indexOf(
            "Also make this the persistent default?",
          );

        expect(
          activeModelLogIndex,
        ).toBeGreaterThan(
          -1,
        );

        expect(
          confirmIndex,
        ).toBeGreaterThan(
          activeModelLogIndex,
        );
      },
    );

    it(
      "pauses readline and restores raw mode around the persist prompt",
      async () => {
        const source =
          await readIndexSource();

        const confirmIndex =
          source.indexOf(
            "Also make this the persistent default?",
          );

        // confirmPersist (Inquirer by default) manages terminal raw mode
        // itself, competing with the main readline interface exactly like
        // tool-execution approval prompts do elsewhere in this file -
        // omitting this pause/resume/restore around it breaks every
        // readline.question() call for the rest of the session (regression
        // caught live: /model exited the whole CLI immediately after the
        // persist prompt).
        const pauseIndex =
          source.lastIndexOf(
            "readline.pause();",
            confirmIndex,
          );

        const resumeIndex =
          source.indexOf(
            "readline.resume();",
            confirmIndex,
          );

        const restoreIndex =
          source.indexOf(
            "restoreReadlineRawMode(",
            confirmIndex,
          );

        expect(
          pauseIndex,
        ).toBeGreaterThan(
          -1,
        );

        expect(
          resumeIndex,
        ).toBeGreaterThan(
          confirmIndex,
        );

        expect(
          restoreIndex,
        ).toBeGreaterThan(
          resumeIndex,
        );
      },
    );

    it(
      "saves through the injectable saveModel parameter and reports success",
      async () => {
        const source =
          await readIndexSource();

        expect(
          source,
        ).toContain(
          "await saveModel(",
        );

        expect(
          source,
        ).toContain(
          "✓ Saved as persistent default in ~/.sky-code/config.json",
        );
      },
    );

    it(
      "reports a save failure without discarding the session's model switch",
      async () => {
        const source =
          await readIndexSource();

        const catchIndex =
          source.indexOf(
            "\"Saving persistent default model\",",
          );

        const returnSelectedModelIndex =
          source.lastIndexOf(
            "return selectedModel;",
          );

        expect(
          catchIndex,
        ).toBeGreaterThan(
          -1,
        );

        // The function's only return of selectedModel must come after the
        // save attempt, so neither declining nor failing to persist changes
        // what selectModel() hands back to the caller.
        expect(
          returnSelectedModelIndex,
        ).toBeGreaterThan(
          catchIndex,
        );
      },
    );

    it(
      "defaults confirmPersist and saveModel to the real implementations",
      async () => {
        const source =
          await readIndexSource();

        expect(
          source,
        ).toContain(
          "confirmPersist:",
        );

        expect(
          source,
        ).toContain(
          "saveModel:",
        );

        // Defaulted directly to the imported functions, so callers that do
        // not override them (the real /model command) always persist for
        // real rather than silently no-op-ing.
        const confirmPersistDefaultIndex =
          source.indexOf(
            "confirmAction,",
            source.indexOf(
              "confirmPersist:",
            ),
          );

        const saveModelDefaultIndex =
          source.indexOf(
            "saveDefaultModel,",
            source.indexOf(
              "saveModel:",
            ),
          );

        expect(
          confirmPersistDefaultIndex,
        ).toBeGreaterThan(
          -1,
        );

        expect(
          saveModelDefaultIndex,
        ).toBeGreaterThan(
          -1,
        );
      },
    );
  },
);
