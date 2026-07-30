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
  "live startup health check",
  () => {
    it(
      "imports and invokes the tested startup health checker",
      async () => {
        const source =
          await readIndexSource();

        expect(
          source,
        ).toContain(
          "runStartupHealthCheck,",
        );

        expect(
          source,
        ).toContain(
          [
            "  await runStartupHealthCheck(",
            "    config,",
            "  );",
          ].join(
            "\n",
          ),
        );
      },
    );

    it(
      "runs immediately after configuration loading",
      async () => {
        const source =
          await readIndexSource();

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
            "",
            "  const plugins =",
          ].join(
            "\n",
          ),
        );
      },
    );

    it(
      "runs before plugins, MCP connections, sessions, and readline startup",
      async () => {
        const source =
          await readIndexSource();

        const healthPosition =
          source.indexOf(
            "await runStartupHealthCheck(",
          );

        const pluginPosition =
          source.indexOf(
            "await loadPlugins({",
          );

        const mcpPosition =
          source.indexOf(
            "await connectConfiguredMcpServers(",
          );

        const readlinePosition =
          source.indexOf(
            "const readline =",
          );

        const resumePosition =
          source.indexOf(
            "await findLatestResumableSession(",
          );

        expect(
          healthPosition,
        ).toBeGreaterThan(
          -1,
        );

        for (
          const laterPosition of
          [
            pluginPosition,
            mcpPosition,
            readlinePosition,
            resumePosition,
          ]
        ) {
          expect(
            laterPosition,
          ).toBeGreaterThan(
            healthPosition,
          );
        }
      },
    );
  },
);
