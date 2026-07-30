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
  "live session resume startup",
  () => {
    it(
      "discovers a previous session before creating the new session logger",
      async () => {
        const source =
          await readIndexSource();

        const discoveryPosition =
          source.indexOf(
            "await findLatestResumableSession(",
          );

        const promptPosition =
          source.indexOf(
            "await promptForSessionResume(",
          );

        const loggerPosition =
          source.indexOf(
            "await createSessionLogger();",
          );

        expect(
          discoveryPosition,
        ).toBeGreaterThan(
          -1,
        );

        expect(
          promptPosition,
        ).toBeGreaterThan(
          discoveryPosition,
        );

        expect(
          loggerPosition,
        ).toBeGreaterThan(
          promptPosition,
        );
      },
    );

    it(
      "offers resume or start fresh using the tested prompt",
      async () => {
        const source =
          await readIndexSource();

        expect(
          source,
        ).toContain(
          "promptForSessionResume(",
        );

        expect(
          source,
        ).toContain(
          'resumeDecision ===\n          "resume"',
        );

        expect(
          source,
        ).toContain(
          '"Starting with a fresh conversation."',
        );
      },
    );

    it(
      "copies reconstructed messages into the active conversation",
      async () => {
        const source =
          await readIndexSource();

        expect(
          source,
        ).toContain(
          "const message of\n          resumableSession.messages",
        );

        expect(
          source,
        ).toContain(
          "messages.push({",
        );

        expect(
          source,
        ).toContain(
          "`Resumed ${messages.length} conversation messages from the previous session.`",
        );
      },
    );

    it(
      "records the current directory in the new session start",
      async () => {
        const source =
          await readIndexSource();

        expect(
          source,
        ).toContain(
          [
            '    type: "session_start",',
            "    workingDirectory,",
            "    model:",
            "      activeModel,",
          ].join(
            "\n",
          ),
        );
      },
    );
  },
);
