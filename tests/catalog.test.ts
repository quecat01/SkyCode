import {
  mkdir,
  mkdtemp,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";

import {
  tmpdir,
} from "node:os";

import {
  join,
} from "node:path";

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import {
  getCatalogDirectory,
  loadCatalog,
  parseCatalogItem,
} from "../src/catalog.ts";

describe(
  "custom command and skill catalog",
  () => {
    let rootDirectory:
      string;

    let catalogDirectory:
      string;

    beforeEach(
      async () => {
        rootDirectory =
          await mkdtemp(
            join(
              tmpdir(),
              "sky-code-catalog-",
            ),
          );

        catalogDirectory =
          join(
            rootDirectory,
            ".sky-code",
            "catalog",
          );
      },
    );

    afterEach(
      async () => {
        await rm(
          rootDirectory,
          {
            recursive:
              true,

            force:
              true,
          },
        );
      },
    );

    async function writeCatalogFile(
      fileName:
        string,

      value:
        unknown,
    ): Promise<void> {
      await mkdir(
        catalogDirectory,
        {
          recursive:
            true,
        },
      );

      await writeFile(
        join(
          catalogDirectory,
          fileName,
        ),
        JSON.stringify(
          value,
          null,
          2,
        ),
        "utf8",
      );
    }

    it(
      "uses the required catalog location under the home directory",
      () => {
        expect(
          getCatalogDirectory(
            "/home/example",
          ),
        ).toBe(
          "/home/example/.sky-code/catalog",
        );
      },
    );

    it(
      "creates a missing catalog directory and returns an empty snapshot",
      async () => {
        const snapshot =
          await loadCatalog({
            catalogDirectory,
          });

        expect(
          snapshot,
        ).toEqual({
          directory:
            catalogDirectory,

          commands: [],

          skills: [],

          items: [],
        });

        await expect(
          stat(
            catalogDirectory,
          ),
        ).resolves.toMatchObject({
          isDirectory:
            expect.any(
              Function,
            ),
        });
      },
    );

    it(
      "loads a prompt-template command",
      async () => {
        await writeCatalogFile(
          "summarise.json",
          {
            type:
              "command",

            name:
              "/summarise",

            description:
              "Summarise a file",

            prompt:
              "Summarise {{file}} in plain language.",
          },
        );

        const snapshot =
          await loadCatalog({
            catalogDirectory,
          });

        expect(
          snapshot.commands,
        ).toHaveLength(
          1,
        );

        expect(
          snapshot.commands[0],
        ).toMatchObject({
          type:
            "command",

          name:
            "/summarise",

          description:
            "Summarise a file",

          prompt:
            "Summarise {{file}} in plain language.",

          source:
            "catalog",
        });
      },
    );

    it(
      "loads a shell command",
      async () => {
        await writeCatalogFile(
          "test-project.json",
          {
            type:
              "command",

            name:
              "/test-project",

            description:
              "Run the project tests",

            shell:
              "npm test",
          },
        );

        const snapshot =
          await loadCatalog({
            catalogDirectory,
          });

        expect(
          snapshot.commands[0],
        ).toMatchObject({
          type:
            "command",

          name:
            "/test-project",

          shell:
            "npm test",
        });
      },
    );

    it(
      "loads a reusable skill",
      async () => {
        await writeCatalogFile(
          "python-style.json",
          {
            type:
              "skill",

            name:
              "python-style",

            description:
              "Apply Python style guidelines",

            systemPromptAddition:
              "Always follow PEP 8 when writing Python.",
          },
        );

        const snapshot =
          await loadCatalog({
            catalogDirectory,
          });

        expect(
          snapshot.skills,
        ).toEqual([
          expect.objectContaining({
            type:
              "skill",

            name:
              "python-style",

            systemPromptAddition:
              "Always follow PEP 8 when writing Python.",

            source:
              "catalog",
          }),
        ]);
      },
    );

    it(
      "requires exactly one prompt or shell field",
      async () => {
        await writeCatalogFile(
          "invalid.json",
          {
            type:
              "command",

            name:
              "/invalid",

            description:
              "Invalid command",

            prompt:
              "Prompt text",

            shell:
              "echo invalid",
          },
        );

        await expect(
          loadCatalog({
            catalogDirectory,
          }),
        ).rejects.toThrow(
          'must define either "prompt" or "shell", not both',
        );

        await writeCatalogFile(
          "invalid.json",
          {
            type:
              "command",

            name:
              "/invalid",

            description:
              "Invalid command",
          },
        );

        await expect(
          loadCatalog({
            catalogDirectory,
          }),
        ).rejects.toThrow(
          'must define either "prompt" or "shell"',
        );
      },
    );

    it(
      "rejects catalog commands that conflict with built-in commands",
      () => {
        expect(
          () =>
            parseCatalogItem(
              {
                type:
                  "command",

                name:
                  "/catalog",

                description:
                  "Conflict",

                prompt:
                  "Do something.",
              },
              "/tmp/conflict.json",
            ),
        ).toThrow(
          'command "/catalog" conflicts with a built-in Sky Code command',
        );
      },
    );

    it(
      "reports invalid JSON with the catalog file path",
      async () => {
        await mkdir(
          catalogDirectory,
          {
            recursive:
              true,
          },
        );

        const filePath =
          join(
            catalogDirectory,
            "broken.json",
          );

        await writeFile(
          filePath,
          "{broken-json",
          "utf8",
        );

        await expect(
          loadCatalog({
            catalogDirectory,
          }),
        ).rejects.toThrow(
          `Unable to parse catalog file ${filePath}`,
        );
      },
    );

    it(
      "rejects duplicate command names across catalog files",
      async () => {
        const command = {
          type:
            "command",

          name:
            "/review",

          description:
            "Review code",

          prompt:
            "Review the supplied code.",
        };

        await writeCatalogFile(
          "first.json",
          command,
        );

        await writeCatalogFile(
          "second.json",
          command,
        );

        await expect(
          loadCatalog({
            catalogDirectory,
          }),
        ).rejects.toThrow(
          'Duplicate catalog command "/review"',
        );
      },
    );

    it(
      "sorts items by name and ignores non-JSON files",
      async () => {
        await writeCatalogFile(
          "z-command.json",
          {
            type:
              "command",

            name:
              "/zebra",

            description:
              "Z command",

            prompt:
              "Run Z.",
          },
        );

        await writeCatalogFile(
          "a-command.json",
          {
            type:
              "command",

            name:
              "/alpha",

            description:
              "A command",

            shell:
              "echo alpha",
          },
        );

        await writeCatalogFile(
          "z-skill.json",
          {
            type:
              "skill",

            name:
              "z-style",

            description:
              "Z skill",

            systemPromptAddition:
              "Apply Z style.",
          },
        );

        await writeCatalogFile(
          "a-skill.json",
          {
            type:
              "skill",

            name:
              "a-style",

            description:
              "A skill",

            systemPromptAddition:
              "Apply A style.",
          },
        );

        await writeFile(
          join(
            catalogDirectory,
            "notes.txt",
          ),
          "This is not a catalog item.",
          "utf8",
        );

        const snapshot =
          await loadCatalog({
            catalogDirectory,
          });

        expect(
          snapshot.commands.map(
            (
              command,
            ) =>
              command.name,
          ),
        ).toEqual([
          "/alpha",
          "/zebra",
        ]);

        expect(
          snapshot.skills.map(
            (
              skill,
            ) =>
              skill.name,
          ),
        ).toEqual([
          "a-style",
          "z-style",
        ]);

        expect(
          snapshot.items,
        ).toHaveLength(
          4,
        );
      },
    );
  },
);
