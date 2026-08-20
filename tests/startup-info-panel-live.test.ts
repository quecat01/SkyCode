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
  "live startup info panel and prompt label integration",
  () => {
    it(
      "collects startup rows in the same order and with the same conditional inclusion as the original plain lines",
      async () => {
        const source =
          await readIndexSource();

        expect(
          source,
        ).toContain(
          "renderStartupInfoPanel(\n      startupInfoRows,\n    )",
        );

        const rowsBlockStart =
          source.indexOf(
            "const startupInfoRows:",
          );

        const rowsBlockEnd =
          source.indexOf(
            "console.log(\n    renderStartupInfoPanel(",
          );

        expect(
          rowsBlockStart,
        ).toBeGreaterThan(
          -1,
        );

        expect(
          rowsBlockEnd,
        ).toBeGreaterThan(
          rowsBlockStart,
        );

        const rowsBlock =
          source.slice(
            rowsBlockStart,
            rowsBlockEnd,
          );

        // Same fields, same order, as the original plain "Label: value" log
        // lines this panel replaced.
        const expectedOrder = [
          "\"LiteLLM\"",
          "\"Active model\"",
          "\"Permission mode\"",
          "\"Session log\"",
          "\"Plugins\"",
          "\"Plugin skills\"",
          "\"Sub-agents\"",
          "\"Sub-agent names\"",
          "\"Plugin commands\"",
          "\"Hooks\"",
          "\"Plugin hooks\"",
          "\"MCP servers\"",
          "\"MCP tools\"",
        ];

        let searchPosition =
          0;

        for (
          const label of
          expectedOrder
        ) {
          const foundPosition =
            rowsBlock.indexOf(
              label,
              searchPosition,
            );

          expect(
            foundPosition,
          ).toBeGreaterThan(
            -1,
          );

          searchPosition =
            foundPosition +
            label.length;
        }

        // Sub-agent names and Plugin commands remain conditional on their
        // respective counts, exactly as in the original implementation.
        expect(
          rowsBlock,
        ).toContain(
          "if (\n    subAgents.length > 0\n  ) {",
        );

        expect(
          rowsBlock,
        ).toContain(
          "if (\n    pluginSkills.length > 0\n  ) {",
        );
      },
    );

    it(
      "shortens the session log path using the home-directory convention already used by the setup wizard",
      async () => {
        const source =
          await readIndexSource();

        expect(
          source,
        ).toContain(
          "shortenHomePath(\n        sessionLogger.filePath,\n      )",
        );

        expect(
          source,
        ).toContain(
          "function shortenHomePath(",
        );

        expect(
          source,
        ).toContain(
          "`~${absolutePath.slice(home.length)}`",
        );
      },
    );

    it(
      "caps the info panel to the terminal width only on a TTY, truncating with an ellipsis, and keeps non-TTY output at its natural width",
      async () => {
        const source =
          await readIndexSource();

        expect(
          source,
        ).toContain(
          [
            "  const innerWidth =",
            "    output.isTTY",
            "      ? Math.min(",
            "          naturalWidth,",
            "          Math.max(",
            "            (output.columns ?? 80) - 4,",
            "            20,",
            "          ),",
            "        )",
            "      : naturalWidth;",
          ].join(
            "\n",
          ),
        );

        expect(
          source,
        ).toContain(
          "`${line.slice(0, innerWidth - 1)}…`",
        );
      },
    );

    it(
      "renders the panel border in bright magenta only on a TTY, matching SKYCODE_BANNER's colour",
      async () => {
        const source =
          await readIndexSource();

        expect(
          source,
        ).toContain(
          [
            "  const colorStart =",
            "    output.isTTY",
            "      ? \"\\x1b[95m\"",
            "      : \"\";",
          ].join(
            "\n",
          ),
        );
      },
    );

    it(
      "replaces the You: prompt with a magenta arrow, using identical wording on a TTY and non-TTY",
      async () => {
        const source =
          await readIndexSource();

        expect(
          source,
        ).toContain(
          [
            "const PROMPT_LABEL =",
            "  process.stdout.isTTY",
            "    ? \"You \\x1b[95m❯\\x1b[0m \"",
            "    : \"You ❯ \";",
          ].join(
            "\n",
          ),
        );

        expect(
          source,
        ).toContain(
          "readline.setPrompt(\n    PROMPT_LABEL,\n  );",
        );

        expect(
          source,
        ).toContain(
          "await readline.question(\n            PROMPT_LABEL,\n          )",
        );

        expect(
          source,
        ).not.toContain(
          "\"You: \"",
        );
      },
    );

    it(
      "colours the SkyCode: response label to match the banner, so the assistant's turn is as visually distinct as the user's prompt",
      async () => {
        const source =
          await readIndexSource();

        expect(
          source,
        ).toContain(
          [
            "const RESPONSE_LABEL =",
            "  process.stdout.isTTY",
            "    ? \"\\x1b[97mSky\\x1b[0m\\x1b[95mCode\\x1b[0m: \"",
            "    : \"SkyCode: \";",
          ].join(
            "\n",
          ),
        );

        expect(
          source,
        ).toContain(
          "output.write(\n        RESPONSE_LABEL,\n      );",
        );

        expect(
          source,
        ).not.toContain(
          "output.write(\n        \"SkyCode: \",\n      );",
        );
      },
    );

    it(
      "prints a blank line before the response label so it is not visually adjacent to the user's echoed input",
      async () => {
        const source =
          await readIndexSource();

        expect(
          source,
        ).toContain(
          [
            "      console.log();",
            "",
            "      output.write(",
            "        RESPONSE_LABEL,",
            "      );",
          ].join(
            "\n",
          ),
        );
      },
    );
  },
);
