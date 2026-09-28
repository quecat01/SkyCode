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

import {
  getDocument,
} from "pdfjs-dist/legacy/build/pdf.mjs";

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
  createPdfFile,
} from "../src/docgen/pdf.ts";

/** Extracts every page's plain text from a PDF buffer, joined by newlines. */
async function extractPdfText(
  buffer: Buffer,
): Promise<{
  text: string;
  numPages: number;
}> {
  const document =
    await getDocument(
      {
        data: new Uint8Array(
          buffer,
        ),
      },
    ).promise;

  let text = "";

  for (
    let pageNumber = 1;
    pageNumber <=
      document.numPages;
    pageNumber++
  ) {
    const page =
      await document.getPage(
        pageNumber,
      );

    const content =
      await page.getTextContent();

    text +=
      content.items
        .map(
          (item) =>
            (
              item as {
                str: string;
              }
            ).str,
        )
        .join(" ") + "\n";
  }

  return {
    text,
    numPages:
      document.numPages,
  };
}

describe(
  "docgen/pdf.ts createPdfFile",
  () => {
    let testDirectory:
      string;

    beforeEach(
      async () => {
        testDirectory =
          await mkdtemp(
            join(
              tmpdir(),
              "sky-code-docgen-pdf-",
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
      "creates a structurally valid PDF with the %PDF- header and %%EOF trailer",
      async () => {
        const result =
          await createPdfFile(
            testDirectory,
            {
              path:
                "basic.pdf",
              content:
                "# Title\n\nBody text.",
            },
          );

        const buffer =
          await readFile(
            result.resolvedPath,
          );

        expect(
          buffer
            .subarray(
              0,
              5,
            )
            .toString(
              "latin1",
            ),
        ).toBe(
          "%PDF-",
        );

        expect(
          buffer
            .subarray(
              -1024,
            )
            .toString(
              "latin1",
            ),
        ).toContain(
          "%%EOF",
        );
      },
    );

    it(
      "renders the requested title, formatted text, list items, and table content",
      async () => {
        const markdown = [
          "# Electrical Service Upgrade",
          "",
          "**Property Owner:** Daniel Mercer",
          "",
          "**Contractor:** Rebecca Stone",
          "",
          "- Remove 100A panel",
          "- Install 200A panel",
          "",
          "| Item | Amount |",
          "| --- | --- |",
          "| Panel upgrade | CAD 3,250 |",
        ].join("\n");

        const result =
          await createPdfFile(
            testDirectory,
            {
              path:
                "content.pdf",
              content:
                markdown,
            },
          );

        const buffer =
          await readFile(
            result.resolvedPath,
          );

        const { text } =
          await extractPdfText(
            buffer,
          );

        expect(
          text,
        ).toContain(
          "Electrical Service Upgrade",
        );

        expect(
          text,
        ).toContain(
          "Daniel Mercer",
        );

        expect(
          text,
        ).toContain(
          "Rebecca Stone",
        );

        expect(
          text,
        ).toContain(
          "100A",
        );

        expect(
          text,
        ).toContain(
          "200A",
        );

        expect(
          text,
        ).toContain(
          "3,250",
        );
      },
    );

    it(
      "does not create a spurious blank page for short content, and prints a page number",
      async () => {
        const result =
          await createPdfFile(
            testDirectory,
            {
              path:
                "short.pdf",
              content:
                "# Title\n\nOne short line.",
            },
          );

        const buffer =
          await readFile(
            result.resolvedPath,
          );

        const { text, numPages } =
          await extractPdfText(
            buffer,
          );

        expect(
          numPages,
        ).toBe(
          1,
        );

        expect(
          text,
        ).toMatch(
          /\b1\b/,
        );
      },
    );

    it(
      "rejects when the destination file already exists and does not overwrite it",
      async () => {
        const existingPath =
          join(
            testDirectory,
            "already-there.pdf",
          );

        await writeFile(
          existingPath,
          "not a real pdf",
        );

        await expect(
          createPdfFile(
            testDirectory,
            {
              path:
                "already-there.pdf",
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
          "not a real pdf",
        );
      },
    );

    it(
      "creates a minimal but valid PDF from an empty content string",
      async () => {
        const result =
          await createPdfFile(
            testDirectory,
            {
              path:
                "empty.pdf",
              content:
                "",
            },
          );

        const buffer =
          await readFile(
            result.resolvedPath,
          );

        expect(
          buffer
            .subarray(
              0,
              5,
            )
            .toString(
              "latin1",
            ),
        ).toBe(
          "%PDF-",
        );
      },
    );
  },
);
