import {
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

import JSZip from "jszip";

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import {
  DestinationExistsError,
} from "../src/docgen/shared.ts";

import {
  createDocxFile,
} from "../src/docgen/docx.ts";

/** Loads word/document.xml from a just-written .docx as a UTF-8 string. */
async function readDocumentXml(
  path: string,
): Promise<string> {
  const buffer = await readFile(
    path,
  );

  const zip = await JSZip.loadAsync(
    buffer,
  );

  const part = zip.file(
    "word/document.xml",
  );

  if (!part) {
    throw new Error(
      "word/document.xml missing from generated docx",
    );
  }

  return part.async(
    "string",
  );
}

describe(
  "docgen/docx.ts createDocxFile",
  () => {
    let testDirectory:
      string;

    beforeEach(
      async () => {
        testDirectory =
          await mkdtemp(
            join(
              tmpdir(),
              "sky-code-docgen-docx-",
            ),
          );
      },
    );

    afterEach(
      async () => {
        await rm(
          testDirectory,
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
      "creates a valid Office Open XML package containing the requested content",
      async () => {
        const markdown = [
          "# Electrical Service Upgrade",
          "",
          "**Property Owner:** Daniel Mercer",
          "",
          "**Contractor:** Rebecca Stone",
          "",
          "| Field | Value |",
          "| --- | --- |",
          "| Existing | 100A |",
          "| Proposed | 200A |",
        ].join("\n");

        const result =
          await createDocxFile(
            testDirectory,
            {
              path:
                "upgrade.docx",
              content:
                markdown,
            },
          );

        expect(
          result.resolvedPath,
        ).toBe(
          join(
            testDirectory,
            "upgrade.docx",
          ),
        );

        expect(
          result.sizeBytes,
        ).toBeGreaterThan(
          0,
        );

        const xml =
          await readDocumentXml(
            result.resolvedPath,
          );

        expect(
          xml,
        ).toContain(
          "Electrical Service Upgrade",
        );

        expect(
          xml,
        ).toContain(
          "Daniel Mercer",
        );

        expect(
          xml,
        ).toContain(
          "Rebecca Stone",
        );

        expect(
          xml,
        ).toContain(
          "100A",
        );

        expect(
          xml,
        ).toContain(
          "200A",
        );
      },
    );

    it(
      "renders the document's first level-1 heading using the Title style",
      async () => {
        const result =
          await createDocxFile(
            testDirectory,
            {
              path:
                "title-check.docx",
              content:
                "# Report Title\n\nBody text.",
            },
          );

        const xml =
          await readDocumentXml(
            result.resolvedPath,
          );

        expect(
          xml,
        ).toContain(
          'w:pStyle w:val="Title"',
        );
      },
    );

    it(
      "renders bold Markdown runs as bold docx runs",
      async () => {
        const result =
          await createDocxFile(
            testDirectory,
            {
              path:
                "bold-check.docx",
              content:
                "**Bold Owner Name**",
            },
          );

        const xml =
          await readDocumentXml(
            result.resolvedPath,
          );

        expect(
          xml,
        ).toContain(
          "Bold Owner Name",
        );

        expect(
          xml,
        ).toContain(
          "<w:b/>",
        );
      },
    );

    it(
      "rejects when the destination file already exists and does not overwrite it",
      async () => {
        const existingPath =
          join(
            testDirectory,
            "already-there.docx",
          );

        await writeFile(
          existingPath,
          "not a real docx",
        );

        await expect(
          createDocxFile(
            testDirectory,
            {
              path:
                "already-there.docx",
              content:
                "# New Content",
            },
          ),
        ).rejects.toThrow(
          DestinationExistsError,
        );

        expect(
          await readFile(
            existingPath,
            "utf8",
          ),
        ).toBe(
          "not a real docx",
        );
      },
    );

    it(
      "creates a minimal but valid docx from an empty content string",
      async () => {
        const result =
          await createDocxFile(
            testDirectory,
            {
              path:
                "empty.docx",
              content:
                "",
            },
          );

        expect(
          result.sizeBytes,
        ).toBeGreaterThan(
          0,
        );

        const xml =
          await readDocumentXml(
            result.resolvedPath,
          );

        expect(
          xml,
        ).toContain(
          "<w:document",
        );
      },
    );

    it(
      "skips unsupported Markdown constructs rather than failing the whole document",
      async () => {
        const markdown = [
          "# Title",
          "",
          "> a blockquote that is not part of the supported subset",
          "",
          "Body paragraph.",
        ].join("\n");

        const result =
          await createDocxFile(
            testDirectory,
            {
              path:
                "unsupported-blocks.docx",
              content:
                markdown,
            },
          );

        const xml =
          await readDocumentXml(
            result.resolvedPath,
          );

        expect(
          xml,
        ).toContain(
          "Title",
        );

        expect(
          xml,
        ).toContain(
          "Body paragraph.",
        );
      },
    );
  },
);
