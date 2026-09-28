/**
 * DOCX generation for Sky Code's create_docx tool.
 *
 * Converts the shared Markdown document structure (markdown.ts) into a real
 * Word document using the `docx` package and writes it through the shared
 * document-generation utility (shared.ts). The `docx` package is a
 * single-maintainer dependency (see the project's standing single-maintainer
 * library policy), so every use of it is confined to this file; nothing
 * outside src/docgen/docx.ts imports from "docx" directly.
 *
 * Page margins, the title style applied to the document's first level-1
 * heading, and the page-number footer are fixed defaults rather than
 * arguments (see the create_docx tool schema in tools.ts), keeping the
 * model-facing schema to just a destination path and Markdown content.
 */

import {
  AlignmentType,
  Document,
  Footer,
  HeadingLevel,
  LevelFormat,
  PageNumber,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun as DocxTextRun,
  convertInchesToTwip,
  type IStylesOptions,
} from "docx";

import {
  createDocumentFile,
  type CreateDocumentFileResult,
} from "./shared.js";

import {
  parseMarkdownContent,
  type DocBlock,
  type TextRun,
} from "./markdown.js";

import type {
  CreateDocxArgs,
} from "../tools.js";

/** Numbering reference name used for every numbered list in a document. */
const NUMBERED_LIST_REFERENCE =
  "sky-code-numbered-list";

/**
 * Converts our format-agnostic TextRun list into docx TextRun instances.
 *
 * @param {TextRun[]} runs - Formatted inline content from markdown.ts.
 * @returns {DocxTextRun[]} Equivalent docx run objects.
 */
function toDocxRuns(
  runs: TextRun[],
): DocxTextRun[] {
  return runs.map(
    (run) =>
      new DocxTextRun({
        text: run.text,
        ...(run.bold
          ? { bold: true }
          : {}),
        ...(run.italic
          ? { italics: true }
          : {}),
        ...(run.code
          ? {
              font: "Courier New",
            }
          : {}),
      }),
  );
}

/**
 * Maps a Markdown heading level (1-6) to a docx heading style.
 *
 * Level 1 is handled specially by the caller (the document's first level-1
 * heading becomes the styled document title); this mapping covers every
 * level for headings that are not treated as the title.
 *
 * @param {number} level - Markdown heading level.
 * @returns {(typeof HeadingLevel)[keyof typeof HeadingLevel]} Matching docx
 * heading style, clamped to HEADING_6 for any out-of-range level.
 */
function headingLevelToDocxHeading(
  level: number,
) {
  switch (level) {
    case 1:
      return HeadingLevel.HEADING_1;
    case 2:
      return HeadingLevel.HEADING_2;
    case 3:
      return HeadingLevel.HEADING_3;
    case 4:
      return HeadingLevel.HEADING_4;
    case 5:
      return HeadingLevel.HEADING_5;
    default:
      return HeadingLevel.HEADING_6;
  }
}

/**
 * Converts one parsed Markdown block into its docx element(s).
 *
 * @param {DocBlock} block - Parsed block from markdown.ts.
 * @param {boolean} isDocumentTitle - True when this block is the document's
 * first level-1 heading, which renders with the docx Title style instead of
 * Heading1.
 * @returns {(Paragraph | Table)[]} One or more docx elements for this block.
 */
function blockToDocxElements(
  block: DocBlock,
  isDocumentTitle: boolean,
): (Paragraph | Table)[] {
  switch (block.type) {
    case "heading":
      return [
        new Paragraph({
          heading: isDocumentTitle
            ? HeadingLevel.TITLE
            : headingLevelToDocxHeading(
                block.level,
              ),
          children: toDocxRuns(
            block.runs,
          ),
        }),
      ];

    case "paragraph":
      return [
        new Paragraph({
          children: toDocxRuns(
            block.runs,
          ),
        }),
      ];

    case "bulletList":
      return block.items.map(
        (itemRuns) =>
          new Paragraph({
            bullet: {
              level: 0,
            },
            children:
              toDocxRuns(itemRuns),
          }),
      );

    case "numberedList":
      return block.items.map(
        (itemRuns) =>
          new Paragraph({
            numbering: {
              reference:
                NUMBERED_LIST_REFERENCE,
              level: 0,
            },
            children:
              toDocxRuns(itemRuns),
          }),
      );

    case "table": {
      const headerRow = new TableRow({
        children: block.header.map(
          (cellText) =>
            new TableCell({
              shading: {
                fill: "D9D9D9",
              },
              children: [
                new Paragraph({
                  children: [
                    new DocxTextRun({
                      text: cellText,
                      bold: true,
                    }),
                  ],
                }),
              ],
            }),
        ),
      });

      const dataRows =
        block.rows.map(
          (row) =>
            new TableRow({
              children: row.map(
                (cellText) =>
                  new TableCell({
                    children: [
                      new Paragraph({
                        children: [
                          new DocxTextRun(
                            {
                              text: cellText,
                            },
                          ),
                        ],
                      }),
                    ],
                  }),
              ),
            }),
        );

      return [
        new Table({
          rows: [
            headerRow,
            ...dataRows,
          ],
        }),
      ];
    }
  }
}

/**
 * Builds a complete, finished DOCX file from Markdown content.
 *
 * @param {string} markdown - Markdown source (see the supported subset
 * documented in markdown.ts and the create_docx schema in tools.ts).
 * @returns {Promise<Buffer>} Finished Word document bytes.
 * @throws {Error} If the Markdown cannot be parsed or the docx package
 * cannot pack the resulting document.
 */
async function buildDocxBuffer(
  markdown: string,
): Promise<Buffer> {
  const blocks = parseMarkdownContent(
    markdown,
  );

  let sawDocumentTitle = false;
  const elements: (
    | Paragraph
    | Table
  )[] = [];

  for (const block of blocks) {
    const isDocumentTitle =
      block.type === "heading" &&
      block.level === 1 &&
      !sawDocumentTitle;

    if (isDocumentTitle) {
      sawDocumentTitle = true;
    }

    elements.push(
      ...blockToDocxElements(
        block,
        isDocumentTitle,
      ),
    );
  }

  // Registering the numbering config unconditionally is harmless even when
  // no numbered list is present, and avoids inspecting blocks a second time
  // just to decide whether to include it.
  const numbering = {
    config: [
      {
        reference:
          NUMBERED_LIST_REFERENCE,
        levels: [
          {
            level: 0,
            format:
              LevelFormat.DECIMAL,
            text: "%1.",
            alignment:
              AlignmentType.START,
          },
        ],
      },
    ],
  };

  // A minimal Title style keeps the document's title visually distinct
  // (larger, bold) without requiring the model to specify any styling.
  const styles: IStylesOptions = {
    paragraphStyles: [
      {
        id: "Title",
        name: "Title",
        basedOn: "Normal",
        next: "Normal",
        run: {
          size: 56,
          bold: true,
        },
        paragraph: {
          spacing: {
            after: 240,
          },
        },
      },
    ],
  };

  const document = new Document({
    numbering,
    styles,
    sections: [
      {
        properties: {
          page: {
            margin: {
              top: convertInchesToTwip(
                1,
              ),
              bottom:
                convertInchesToTwip(
                  1,
                ),
              left: convertInchesToTwip(
                1,
              ),
              right:
                convertInchesToTwip(
                  1,
                ),
            },
          },
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment:
                  AlignmentType.CENTER,
                children: [
                  new DocxTextRun({
                    children: [
                      PageNumber.CURRENT,
                    ],
                  }),
                ],
              }),
            ],
          }),
        },
        children: elements,
      },
    ],
  });

  return Packer.toBuffer(document);
}

/**
 * Structural validation for a just-written DOCX file: confirms it is a
 * genuine Office Open XML package by opening it as a zip and checking for
 * the required `word/document.xml` part, rather than trusting file
 * existence and size alone.
 *
 * @param {string} resolvedPath - Path of the file to validate.
 * @returns {Promise<void>} Resolves if validation passes.
 * @throws {Error} If the file is not a valid zip, or is missing
 * `word/document.xml`.
 */
async function validateDocxStructure(
  resolvedPath: string,
): Promise<void> {
  const { readFile } = await import(
    "node:fs/promises"
  );
  const JSZip = (
    await import("jszip")
  ).default;

  const buffer = await readFile(
    resolvedPath,
  );

  let zip;

  try {
    zip = await JSZip.loadAsync(
      buffer,
    );
  } catch (error) {
    throw new Error(
      `The generated DOCX file is not a valid zip package: ${
        error instanceof Error
          ? error.message
          : String(error)
      }`,
    );
  }

  if (
    !zip.file("word/document.xml")
  ) {
    throw new Error(
      "The generated DOCX file is missing word/document.xml and is not a valid Word document.",
    );
  }
}

/**
 * Creates a DOCX file at the requested path from Markdown content.
 *
 * @param {string} workingDirectory - Base directory for a relative
 * args.path.
 * @param {CreateDocxArgs} args - Validated create_docx arguments (path and
 * Markdown content).
 * @returns {Promise<CreateDocumentFileResult>} Resolved path and size of the
 * finished document.
 * @throws {Error} If the destination already exists, the Markdown cannot be
 * converted, the file cannot be written, or structural validation fails.
 *
 * Side effects: creates a new file on disk (and removes it again if
 * structural validation fails).
 */
export async function createDocxFile(
  workingDirectory: string,
  args: CreateDocxArgs,
): Promise<CreateDocumentFileResult> {
  return createDocumentFile({
    inputPath: args.path,
    workingDirectory,
    build: () =>
      buildDocxBuffer(args.content),
    validate: validateDocxStructure,
  });
}
