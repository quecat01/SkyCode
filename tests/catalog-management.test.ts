import {
  access,
  mkdir,
  mkdtemp,
  rm,
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
  CatalogManager,
  parseCatalogManagementCommand,
} from "../src/catalog-management.ts";

import {
  loadCatalog,
} from "../src/catalog.ts";

describe(
  "catalog management commands",
  () => {
    let rootDirectory:
      string;

    let workingDirectory:
      string;

    let catalogDirectory:
      string;

    beforeEach(
      async () => {
        rootDirectory =
          await mkdtemp(
            join(
              tmpdir(),
              "sky-code-catalog-management-",
            ),
          );

        workingDirectory =
          join(
            rootDirectory,
            "project",
          );

        catalogDirectory =
          join(
            rootDirectory,
            "catalog",
          );

        await mkdir(
          workingDirectory,
          {
            recursive:
              true,
          },
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

    async function createManager():
      Promise<CatalogManager> {
      const catalog =
        await loadCatalog({
          catalogDirectory,
        });

      return new CatalogManager({
        catalog,

        workingDirectory,
      });
    }

    async function writeImportFile(
      fileName:
        string,

      value:
        unknown,
    ): Promise<string> {
      const filePath =
        join(
          workingDirectory,
          fileName,
        );

      await writeFile(
        filePath,
        JSON.stringify(
          value,
          null,
          2,
        ),
        "utf8",
      );

      return filePath;
    }

    it(
      "parses all five catalog management commands",
      () => {
        expect(
          parseCatalogManagementCommand(
            "/catalog list",
          ),
        ).toEqual({
          action:
            "list",
        });

        expect(
          parseCatalogManagementCommand(
            "/catalog add ./review.json",
          ),
        ).toEqual({
          action:
            "add",

          file:
            "./review.json",
        });

        expect(
          parseCatalogManagementCommand(
            "/catalog remove /review",
          ),
        ).toEqual({
          action:
            "remove",

          name:
            "/review",
        });

        expect(
          parseCatalogManagementCommand(
            "/catalog enable python-style",
          ),
        ).toEqual({
          action:
            "enable",

          name:
            "python-style",
        });

        expect(
          parseCatalogManagementCommand(
            "/catalog disable python-style",
          ),
        ).toEqual({
          action:
            "disable",

          name:
            "python-style",
        });

        expect(
          parseCatalogManagementCommand(
            "/model",
          ),
        ).toBeNull();
      },
    );

    it(
      "rejects missing and unknown catalog actions",
      () => {
        expect(
          () =>
            parseCatalogManagementCommand(
              "/catalog",
            ),
        ).toThrow(
          "Usage: /catalog list",
        );

        expect(
          () =>
            parseCatalogManagementCommand(
              "/catalog add",
            ),
        ).toThrow(
          "Missing catalog command argument",
        );

        expect(
          () =>
            parseCatalogManagementCommand(
              "/catalog unknown",
            ),
        ).toThrow(
          'Unknown catalog action "unknown"',
        );
      },
    );

    it(
      "adds and immediately lists a prompt command",
      async () => {
        await writeImportFile(
          "review.json",
          {
            type:
              "command",

            name:
              "/review",

            description:
              "Review supplied code",

            prompt:
              "Review {{file}} carefully.",
          },
        );

        const manager =
          await createManager();

        const addResult =
          await manager.execute({
            action:
              "add",

            file:
              "./review.json",
          });

        expect(
          addResult.message,
        ).toBe(
          'Added catalog command "/review".',
        );

        expect(
          addResult.catalog.commands,
        ).toHaveLength(
          1,
        );

        const listResult =
          await manager.execute({
            action:
              "list",
          });

        expect(
          listResult.message,
        ).toContain(
          "/review: Review supplied code",
        );
      },
    );

    it(
      "enables and disables a skill for the current session",
      async () => {
        await writeImportFile(
          "python-style.json",
          {
            type:
              "skill",

            name:
              "python-style",

            description:
              "Apply Python style",

            systemPromptAddition:
              "Always follow PEP 8.",
          },
        );

        const manager =
          await createManager();

        await manager.execute({
          action:
            "add",

          file:
            "./python-style.json",
        });

        const enabled =
          await manager.execute({
            action:
              "enable",

            name:
              "python-style",
          });

        expect(
          enabled.activeSkills.map(
            (
              skill,
            ) =>
              skill.name,
          ),
        ).toEqual([
          "python-style",
        ]);

        expect(
          enabled.message,
        ).toContain(
          "for this session",
        );

        const listedEnabled =
          await manager.execute({
            action:
              "list",
          });

        expect(
          listedEnabled.message,
        ).toContain(
          "python-style (enabled)",
        );

        const disabled =
          await manager.execute({
            action:
              "disable",

            name:
              "python-style",
          });

        expect(
          disabled.activeSkills,
        ).toEqual([]);

        const listedDisabled =
          await manager.execute({
            action:
              "list",
          });

        expect(
          listedDisabled.message,
        ).toContain(
          "python-style (disabled)",
        );
      },
    );

    it(
      "removes a catalog item and reloads immediately",
      async () => {
        await writeImportFile(
          "remove-me.json",
          {
            type:
              "command",

            name:
              "/remove-me",

            description:
              "Temporary command",

            shell:
              "printf temporary",
          },
        );

        const manager =
          await createManager();

        await manager.execute({
          action:
            "add",

          file:
            "./remove-me.json",
        });

        const storedPath =
          manager
            .getSnapshot()
            .commands[0]
            ?.filePath;

        if (
          storedPath ===
            undefined
        ) {
          throw new Error(
            "Expected the imported command path.",
          );
        }

        const result =
          await manager.execute({
            action:
              "remove",

            name:
              "/remove-me",
          });

        expect(
          result.message,
        ).toBe(
          'Removed catalog command "/remove-me".',
        );

        expect(
          result.catalog.commands,
        ).toEqual([]);

        await expect(
          access(
            storedPath,
          ),
        ).rejects.toThrow();
      },
    );

    it(
      "rejects enabling a command as a skill",
      async () => {
        await writeImportFile(
          "command.json",
          {
            type:
              "command",

            name:
              "/command",

            description:
              "A command",

            prompt:
              "Run the command.",
          },
        );

        const manager =
          await createManager();

        await manager.execute({
          action:
            "add",

          file:
            "./command.json",
        });

        await expect(
          manager.execute({
            action:
              "enable",

            name:
              "/command",
          }),
        ).rejects.toThrow(
          'Catalog skill "/command" was not found.',
        );
      },
    );

    it(
      "rolls back an imported file when it creates a duplicate item",
      async () => {
        await writeImportFile(
          "first.json",
          {
            type:
              "command",

            name:
              "/duplicate",

            description:
              "First command",

            prompt:
              "First.",
          },
        );

        await writeImportFile(
          "second.json",
          {
            type:
              "command",

            name:
              "/duplicate",

            description:
              "Second command",

            prompt:
              "Second.",
          },
        );

        const manager =
          await createManager();

        await manager.execute({
          action:
            "add",

          file:
            "./first.json",
        });

        await expect(
          manager.execute({
            action:
              "add",

            file:
              "./second.json",
          }),
        ).rejects.toThrow(
          'Duplicate catalog command "/duplicate"',
        );

        expect(
          manager
            .getSnapshot()
            .commands,
        ).toHaveLength(
          1,
        );

        await expect(
          access(
            join(
              catalogDirectory,
              "second.json",
            ),
          ),
        ).rejects.toThrow();
      },
    );
  },
);
