/**
 * Shared Markdown-to-structure conversion for Sky Code's document tools.
 *
 * create_docx and create_pdf both accept a supported Markdown subset (see
 * tools.ts) and need to walk the same parsed structure to build their own
 * native document elements. This module owns that parsing so both formats
 * stay consistent: the same input produces the same logical structure,
 * whichever renderer consumes it.
 *
 * Parsing is done with `marked`'s lexer, which returns a block-token tree;
 * this module converts that into a small, format-agnostic block/run
 * structure (DocBlock/TextRun) that has no dependency on marked's own token
 * shapes, so docx.ts and pdf.ts never need to know about marked directly.
 *
 * Supported subset: headings, paragraphs, bold/italic (including nested
 * combinations), inline code, bullet lists, numbered lists, and tables.
 * Nested lists, images, links, blockquotes, and code blocks are not part of
 * the supported subset; nested lists are flattened to their outer level's
 * items and their nested content is dropped, and other unsupported block
 * types are skipped rather than causing the whole document to fail.
 *
 * By convention (documented in tools.ts's create_docx/create_pdf schema),
 * the first level-1 heading in a document is treated as its title by
 * consuming renderers; this module does not apply that styling itself, since
 * "title" presentation is a per-format concern.
 */

import {
  marked,
  type Token,
  type Tokens,
} from "marked";

/**
 * One run of text with optional inline formatting.
 *
 * Bold and italic may both be set (for `***text***` or nested emphasis).
 * `code` marks inline code spans; consuming renderers may render it as
 * monospace text or fall back to plain text.
 */
export interface TextRun {
  /** The run's literal text. */
  text: string;
  /** True when the run should render as bold. */
  bold?: boolean;
  /** True when the run should render as italic. */
  italic?: boolean;
  /** True when the run came from an inline code span. */
  code?: boolean;
}

/** A heading block, levels 1-6 as in standard Markdown. */
export interface HeadingBlock {
  type: "heading";
  /** Heading level, 1 (largest) through 6. */
  level: number;
  /** Formatted inline content of the heading. */
  runs: TextRun[];
}

/** A single paragraph of formatted text. */
export interface ParagraphBlock {
  type: "paragraph";
  /** Formatted inline content of the paragraph. */
  runs: TextRun[];
}

/** An unordered (bulleted) list. */
export interface BulletListBlock {
  type: "bulletList";
  /** Formatted inline content of each list item. */
  items: TextRun[][];
}

/** An ordered (numbered) list. */
export interface NumberedListBlock {
  type: "numberedList";
  /** Formatted inline content of each list item. */
  items: TextRun[][];
}

/**
 * A table with a header row and zero or more data rows.
 *
 * Cell content is plain text (inline formatting within a cell is not
 * preserved) because neither the create_docx/create_pdf schema nor any
 * acceptance test needs styled table cells, and keeping cells as plain
 * strings keeps both renderers simpler.
 */
export interface TableBlock {
  type: "table";
  /** Column header labels. */
  header: string[];
  /** Data rows; every row has the same length as header. */
  rows: string[][];
}

/** One parsed block of document content. */
export type DocBlock =
  | HeadingBlock
  | ParagraphBlock
  | BulletListBlock
  | NumberedListBlock
  | TableBlock;

/**
 * Flattens a plain-text-only representation of a run list.
 *
 * Used for table cells, where formatting is intentionally not preserved.
 *
 * @param {TextRun[]} runs - Runs to flatten.
 * @returns {string} Concatenated plain text.
 */
function runsToPlainText(
  runs: TextRun[],
): string {
  return runs
    .map((run) => run.text)
    .join("");
}

/**
 * Recursively converts marked inline tokens into TextRun objects, tracking
 * bold/italic state through nested emphasis so `***text***` and similar
 * combinations produce a single run with both flags set.
 *
 * Token types outside the supported subset (links, images, line breaks, raw
 * HTML, and anything else marked may produce) fall back to their raw source
 * text rendered as a plain run, rather than being dropped silently or
 * throwing, so unexpected input degrades gracefully instead of failing the
 * whole document.
 *
 * @param {Token[]} tokens - Inline tokens from a marked block token.
 * @param {{ bold: boolean; italic: boolean }} context - Formatting inherited
 * from an enclosing strong/em token.
 * @returns {TextRun[]} Flattened, formatted text runs.
 */
function walkInlineTokens(
  tokens: Token[],
  context: {
    bold: boolean;
    italic: boolean;
  } = {
    bold: false,
    italic: false,
  },
): TextRun[] {
  const runs: TextRun[] = [];

  for (const token of tokens) {
    switch (token.type) {
      case "text": {
        const textToken =
          token as Tokens.Text;

        // A text token may itself carry nested inline tokens (for example
        // inside a list item); prefer walking those when present so nested
        // formatting inside plain text nodes is not lost.
        if (
          textToken.tokens &&
          textToken.tokens.length > 0
        ) {
          runs.push(
            ...walkInlineTokens(
              textToken.tokens,
              context,
            ),
          );
        } else {
          runs.push({
            text: textToken.text,
            ...(context.bold
              ? { bold: true }
              : {}),
            ...(context.italic
              ? { italic: true }
              : {}),
          });
        }

        break;
      }

      case "strong": {
        const strongToken =
          token as Tokens.Strong;

        runs.push(
          ...walkInlineTokens(
            strongToken.tokens,
            {
              bold: true,
              italic: context.italic,
            },
          ),
        );

        break;
      }

      case "em": {
        const emToken =
          token as Tokens.Em;

        runs.push(
          ...walkInlineTokens(
            emToken.tokens,
            {
              bold: context.bold,
              italic: true,
            },
          ),
        );

        break;
      }

      case "codespan": {
        const codespanToken =
          token as Tokens.Codespan;

        runs.push({
          text: codespanToken.text,
          code: true,
        });

        break;
      }

      default: {
        // Unsupported inline token type (link, image, br, html, escape, ...):
        // fall back to its raw source text as plain content.
        const fallbackText =
          "raw" in token &&
          typeof token.raw === "string"
            ? token.raw
            : "text" in token &&
                typeof token.text ===
                  "string"
              ? token.text
              : "";

        if (fallbackText.length > 0) {
          runs.push({
            text: fallbackText,
          });
        }
      }
    }
  }

  return runs;
}

/**
 * Extracts the formatted runs for one list item.
 *
 * A tight list item's content normally arrives as a single wrapping "text"
 * token whose own .tokens array holds the real inline content; a loose item,
 * or one containing multiple lines, may instead hold several block-level
 * sub-tokens (paragraphs, more text tokens). Both shapes are flattened into
 * one run list per item, matching this module's decision not to support
 * nested block structure within a list item.
 *
 * @param {Tokens.ListItem} item - One marked list item token.
 * @returns {TextRun[]} Formatted content of the item.
 */
function extractListItemRuns(
  item: Tokens.ListItem,
): TextRun[] {
  const runs: TextRun[] = [];

  for (const subToken of item.tokens) {
    if (
      subToken.type === "text" &&
      "tokens" in subToken &&
      subToken.tokens &&
      subToken.tokens.length > 0
    ) {
      runs.push(
        ...walkInlineTokens(
          subToken.tokens,
        ),
      );
    } else if (
      subToken.type === "paragraph" &&
      "tokens" in subToken
    ) {
      runs.push(
        ...walkInlineTokens(
          (subToken as Tokens.Paragraph)
            .tokens,
        ),
      );
    } else if (
      "text" in subToken &&
      typeof subToken.text === "string"
    ) {
      runs.push({
        text: subToken.text,
      });
    }
  }

  return runs;
}

/**
 * Parses a supported Markdown subset into a sequence of format-agnostic
 * document blocks.
 *
 * @param {string} markdown - Markdown source text (the `content` argument of
 * create_docx/create_pdf).
 * @returns {DocBlock[]} Parsed blocks in document order.
 * @throws {Error} If `marked` itself cannot parse the input (malformed input
 * that fails lexing rather than simply falling outside the supported
 * subset).
 */
export function parseMarkdownContent(
  markdown: string,
): DocBlock[] {
  const tokens = marked.lexer(
    markdown,
  );

  const blocks: DocBlock[] = [];

  for (const token of tokens) {
    switch (token.type) {
      case "heading": {
        const headingToken =
          token as Tokens.Heading;

        blocks.push({
          type: "heading",
          level: headingToken.depth,
          runs: walkInlineTokens(
            headingToken.tokens,
          ),
        });

        break;
      }

      case "paragraph": {
        const paragraphToken =
          token as Tokens.Paragraph;

        blocks.push({
          type: "paragraph",
          runs: walkInlineTokens(
            paragraphToken.tokens,
          ),
        });

        break;
      }

      case "list": {
        const listToken =
          token as Tokens.List;

        const items = listToken.items.map(
          (item) =>
            extractListItemRuns(item),
        );

        blocks.push(
          listToken.ordered
            ? {
                type: "numberedList",
                items,
              }
            : {
                type: "bulletList",
                items,
              },
        );

        break;
      }

      case "table": {
        const tableToken =
          token as Tokens.Table;

        blocks.push({
          type: "table",
          header: tableToken.header.map(
            (cell) =>
              runsToPlainText(
                walkInlineTokens(
                  cell.tokens,
                ),
              ),
          ),
          rows: tableToken.rows.map(
            (row) =>
              row.map((cell) =>
                runsToPlainText(
                  walkInlineTokens(
                    cell.tokens,
                  ),
                ),
              ),
          ),
        });

        break;
      }

      default:
        // Block types outside the supported subset (blockquote, code block,
        // raw html, thematic break, etc.) are skipped rather than failing
        // the whole document; "space" tokens (blank lines) are also silently
        // skipped here since block spacing is a per-renderer styling concern.
        break;
    }
  }

  return blocks;
}
