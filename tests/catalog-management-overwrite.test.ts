import {
  mkdir,
  mkdtemp,
  readFile,
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
} from "../src/catalog-management.ts";

import {
  loadCatalog,
} from "../src/catalog.ts";

describe(
  "catalog import overwrite protection",
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
              "sky-code-catalog-overwrite-",
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

        await mkdir(
          catalogDirectory,
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

    it(
      "preserves an existing same-named catalog file",
      async () => {
        const existingFilePath =
          join(
            catalogDirectory,
            "shared.json",
          );

        const existingContents =
          JSON.stringify(
            {
              type:
                "command",

              name:
                "/existing",

              description:
                "Existing command",

              prompt:
                "Keep this command.",
            },
            null,
            2,
          );

        await writeFile(
          existingFilePath,
          existingContents,
          "utf8",
        );

        await writeFile(
          join(
            workingDirectory,
            "shared.json",
          ),
          JSON.stringify(
            {
              type:
                "command",

              name:
                "/replacement",

              description:
                "Replacement command",

              prompt:
                "This must not replace the existing file.",
            },
            null,
            2,
          ),
          "utf8",
        );

        const catalog =
          await loadCatalog({
            catalogDirectory,
          });

        const manager =
          new CatalogManager({
            catalog,

            workingDirectory,
          });

        await expect(
          manager.execute({
            action:
              "add",

            file:
              "./shared.json",
          }),
        ).rejects.toThrow(
          'Catalog file "shared.json" already exists',
        );

        expect(
          await readFile(
            existingFilePath,
            "utf8",
          ),
        ).toBe(
          existingContents,
        );

        expect(
          manager
            .getSnapshot()
            .commands
            .map(
              (
                command,
              ) =>
                command.name,
            ),
        ).toEqual([
          "/existing",
        ]);
      },
    );
  },
);
