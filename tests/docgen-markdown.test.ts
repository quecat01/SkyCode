import {
  describe,
  expect,
  it,
} from "vitest";

import {
  parseMarkdownContent,
  type BulletListBlock,
  type HeadingBlock,
  type NumberedListBlock,
  type ParagraphBlock,
  type TableBlock,
} from "../src/docgen/markdown.ts";

describe(
  "docgen/markdown.ts parseMarkdownContent",
  () => {
    it(
      "parses a level-1 heading",
      () => {
        const blocks =
          parseMarkdownContent(
            "# Electrical Service Upgrade",
          );

        expect(
          blocks,
        ).toHaveLength(
          1,
        );

        const heading =
          blocks[0] as HeadingBlock;

        expect(
          heading.type,
        ).toBe(
          "heading",
        );

        expect(
          heading.level,
        ).toBe(
          1,
        );

        expect(
          heading.runs,
        ).toEqual([
          {
            text: "Electrical Service Upgrade",
          },
        ]);
      },
    );

    it(
      "parses heading levels 1 through 6",
      () => {
        const markdown = [
          "# H1",
          "## H2",
          "### H3",
          "#### H4",
          "##### H5",
          "###### H6",
        ].join("\n\n");

        const blocks =
          parseMarkdownContent(
            markdown,
          ) as HeadingBlock[];

        expect(
          blocks.map(
            (block) =>
              block.level,
          ),
        ).toEqual([
          1, 2, 3, 4, 5, 6,
        ]);
      },
    );

    it(
      "parses a plain paragraph",
      () => {
        const blocks =
          parseMarkdownContent(
            "This project upgrades the existing service.",
          );

        const paragraph =
          blocks[0] as ParagraphBlock;

        expect(
          paragraph.type,
        ).toBe(
          "paragraph",
        );

        expect(
          paragraph.runs,
        ).toEqual([
          {
            text: "This project upgrades the existing service.",
          },
        ]);
      },
    );

    it(
      "marks bold text with the bold flag",
      () => {
        const blocks =
          parseMarkdownContent(
            "**Property Owner:** Daniel Mercer",
          );

        const paragraph =
          blocks[0] as ParagraphBlock;

        expect(
          paragraph.runs,
        ).toEqual([
          {
            text: "Property Owner:",
            bold: true,
          },
          {
            text: " Daniel Mercer",
          },
        ]);
      },
    );

    it(
      "marks italic text with the italic flag",
      () => {
        const blocks =
          parseMarkdownContent(
            "*draft copy*",
          );

        const paragraph =
          blocks[0] as ParagraphBlock;

        expect(
          paragraph.runs,
        ).toEqual([
          {
            text: "draft copy",
            italic: true,
          },
        ]);
      },
    );

    it(
      "marks nested bold+italic text with both flags on one run",
      () => {
        const blocks =
          parseMarkdownContent(
            "***critical***",
          );

        const paragraph =
          blocks[0] as ParagraphBlock;

        expect(
          paragraph.runs,
        ).toEqual([
          {
            text: "critical",
            bold: true,
            italic: true,
          },
        ]);
      },
    );

    it(
      "marks inline code spans with the code flag",
      () => {
        const blocks =
          parseMarkdownContent(
            "Run `npm test` before committing.",
          );

        const paragraph =
          blocks[0] as ParagraphBlock;

        expect(
          paragraph.runs,
        ).toContainEqual({
          text: "npm test",
          code: true,
        });
      },
    );

    it(
      "parses a bullet list",
      () => {
        const markdown = [
          "- Remove 100A panel",
          "- Install 200A panel",
          "- Duration: 2 days",
        ].join("\n");

        const blocks =
          parseMarkdownContent(
            markdown,
          );

        const list =
          blocks[0] as BulletListBlock;

        expect(
          list.type,
        ).toBe(
          "bulletList",
        );

        expect(
          list.items,
        ).toEqual([
          [
            {
              text: "Remove 100A panel",
            },
          ],
          [
            {
              text: "Install 200A panel",
            },
          ],
          [
            {
              text: "Duration: 2 days",
            },
          ],
        ]);
      },
    );

    it(
      "parses a numbered list",
      () => {
        const markdown = [
          "1. First step",
          "2. Second step",
        ].join("\n");

        const blocks =
          parseMarkdownContent(
            markdown,
          );

        const list =
          blocks[0] as NumberedListBlock;

        expect(
          list.type,
        ).toBe(
          "numberedList",
        );

        expect(
          list.items,
        ).toEqual([
          [
            {
              text: "First step",
            },
          ],
          [
            {
              text: "Second step",
            },
          ],
        ]);
      },
    );

    it(
      "flattens a nested list to its outer items",
      () => {
        const markdown = [
          "- Outer one",
          "  - Inner one",
          "- Outer two",
        ].join("\n");

        const blocks =
          parseMarkdownContent(
            markdown,
          );

        const list =
          blocks[0] as BulletListBlock;

        expect(
          list.type,
        ).toBe(
          "bulletList",
        );

        expect(
          list.items,
        ).toHaveLength(
          2,
        );
      },
    );

    it(
      "parses a table with header and rows as plain-text cells",
      () => {
        const markdown = [
          "| Field | Value |",
          "| --- | --- |",
          "| Existing | 100A |",
          "| **Proposed** | 200A |",
        ].join("\n");

        const blocks =
          parseMarkdownContent(
            markdown,
          );

        const table =
          blocks[0] as TableBlock;

        expect(
          table.type,
        ).toBe(
          "table",
        );

        expect(
          table.header,
        ).toEqual([
          "Field",
          "Value",
        ]);

        expect(
          table.rows,
        ).toEqual([
          [
            "Existing",
            "100A",
          ],
          [
            "Proposed",
            "200A",
          ],
        ]);
      },
    );

    it(
      "skips unsupported block types (blockquote, code block) without throwing",
      () => {
        const markdown = [
          "# Title",
          "",
          "> a quoted aside",
          "",
          "```",
          "code block content",
          "```",
          "",
          "A real paragraph.",
        ].join("\n");

        const blocks =
          parseMarkdownContent(
            markdown,
          );

        expect(
          blocks.map(
            (block) =>
              block.type,
          ),
        ).toEqual([
          "heading",
          "paragraph",
        ]);
      },
    );

    it(
      "returns an empty array for empty input",
      () => {
        expect(
          parseMarkdownContent(
            "",
          ),
        ).toEqual(
          [],
        );
      },
    );

    it(
      "parses multiple blocks in document order",
      () => {
        const markdown = [
          "# Electrical Service Upgrade",
          "",
          "**Property Owner:** Daniel Mercer",
          "",
          "## Scope",
          "",
          "- Remove 100A panel",
          "- Install 200A panel",
        ].join("\n");

        const blocks =
          parseMarkdownContent(
            markdown,
          );

        expect(
          blocks.map(
            (block) =>
              block.type,
          ),
        ).toEqual([
          "heading",
          "paragraph",
          "heading",
          "bulletList",
        ]);
      },
    );
  },
);
