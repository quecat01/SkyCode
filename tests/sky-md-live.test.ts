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
  "live sky.md wiring",
  () => {
    it(
      "imports loadSkyMd alongside loadConfig",
      async () => {
        const source =
          await readIndexSource();

        expect(
          source,
        ).toContain(
          "loadSkyMd,",
        );
      },
    );

    it(
      "loads sky.md content once and passes it to every prompt-construction call site",
      async () => {
        const source =
          await readIndexSource();

        const declarationOccurrences =
          (
            source.match(
              /const skyMdContent =/g,
            ) ??
            []
          ).length;

        // Exactly one true source of truth: `const skyMdContent = await
        // loadSkyMd();`.
        expect(
          declarationOccurrences,
        ).toBe(
          1,
        );

        // Every real call-site usage passes the bare identifier as its own
        // trailing-comma argument line (this codebase's one-argument-per-line
        // style). Matching that exact line shape - rather than counting every
        // textual mention of the identifier - excludes both this test's own
        // false positives (a JSDoc @param line, or a `skyMdContent: string,`
        // parameter declaration) from the count, so it only breaks when a
        // real call site is added or removed, not when a doc comment changes.
        //
        // Three regeneration points (startup, /model switch, catalog-skill
        // change) each rebuild three things from skyMdContent: the legacy
        // system prompt (createSkyCodeSystemPrompt), the active
        // ToolCallStrategy (buildToolCallStrategy), and the
        // FinalAnswerProducer (buildFinalAnswerProducer) - 3 x 3 = 9. Plus
        // buildToolCallStrategy's own body passes it through twice (once on
        // its native-strategy branch, once on its legacy-strategy branch) and
        // buildFinalAnswerProducer's body passes it through once - 9 + 2 + 1
        // = 12. This count should shrink back down once streamModelTurn and
        // the old systemPrompt-only path are removed in a later cleanup step,
        // since createSkyCodeSystemPrompt's own direct calls (3 of the 12)
        // will go with them.
        const callSiteOccurrences =
          (
            source.match(
              /^\s*skyMdContent,\s*$/gm,
            ) ??
            []
          ).length;

        expect(
          callSiteOccurrences,
        ).toBe(
          12,
        );

        expect(
          source,
        ).toContain(
          [
            "  const skyMdContent =",
            "    await loadSkyMd();",
          ].join(
            "\n",
          ),
        );
      },
    );

    it(
      "does not load sky.md between configuration loading and the startup health check",
      async () => {
        const source =
          await readIndexSource();

        // Guards against reintroducing code between loadConfig and
        // runStartupHealthCheck, which startup-health-live.test.ts requires
        // to run back-to-back.
        expect(
          source,
        ).toContain(
          [
            "  const config =",
            "    await loadConfig(",
            "      workingDirectory,",
            "    );",
            "",
            "  await runStartupHealthCheck(",
            "    config,",
            "  );",
          ].join(
            "\n",
          ),
        );
      },
    );
  },
);
