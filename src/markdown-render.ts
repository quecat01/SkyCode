import {
  createMarkdownStreamer,
  createRenderer,
  type Theme,
} from "markdansi";

/**
 * Sky Code's brand theme for rendering the assistant's own conversational
 * Markdown responses to the terminal.
 *
 * Colors are the exact values already used in the shipped SVG logos
 * (docs/logo/), not invented separately, so terminal output matches the
 * established brand rather than introducing a second, slightly different
 * palette:
 * - #CC00CC / #DD33DD: the brand's magenta accent (primary/lighter variant)
 * - #160d24: the brand's dark charcoal-purple
 * - #555555 / #E8E8E8: supporting grays
 *
 * No syntax highlighter is wired up; code blocks render as plain dim text
 * via blockCode. This is a deliberate v1 scope decision, not an oversight -
 * a real highlighter is a substantially bigger dependency and can be added
 * later without changing this theme's shape.
 */
export const SKY_CODE_MARKDOWN_THEME: Theme =
  {
    heading: {
      color: "#CC00CC",
      bold: true,
    },
    strong: {
      bold: true,
    },
    emph: {
      color: "#DD33DD",
      italic: true,
    },
    inlineCode: {
      color: "#DD33DD",
    },
    blockCode: {
      color: "#E8E8E8",
      dim: true,
    },
    link: {
      color: "#CC00CC",
      underline: true,
    },
    quote: {
      color: "#555555",
      italic: true,
    },
    hr: {
      color: "#555555",
    },
    listMarker: {
      color: "#CC00CC",
    },
    tableHeader: {
      color: "#CC00CC",
      bold: true,
    },
    tableCell: {},
  };

/**
 * Creates a fresh Markdown-to-ANSI streamer configured with Sky Code's
 * brand theme, for rendering exactly one assistant turn's conversational
 * response.
 *
 * Deliberately scoped to the assistant's own natural-language text only.
 * Raw tool/shell output and static CLI text (banner, prompts, diagnostics)
 * must never be passed through this: they are not Markdown, and can
 * contain characters (asterisks in a file listing, "#" in file contents)
 * that would be misinterpreted as Markdown syntax.
 *
 * A new instance must be created per turn rather than reused, since the
 * streamer holds buffering state (an open code fence or table) that has no
 * meaning across separate assistant responses.
 *
 * Color output follows markdansi's own default terminal detection (via
 * chalk), matching how the rest of Sky Code's CLI output already adapts to
 * TTY vs. non-TTY (see SKYCODE_BANNER in index.ts): explicitly forcing
 * color on would break piping Sky Code's output to a file or another
 * program.
 *
 * @returns {ReturnType<typeof createMarkdownStreamer>} A streamer whose
 * `push()`/`finish()` methods return ANSI text ready to write directly to
 * the terminal.
 */
export function createSkyCodeMarkdownStreamer(): ReturnType<
  typeof createMarkdownStreamer
> {
  const render =
    createRenderer({
      theme:
        SKY_CODE_MARKDOWN_THEME,
    });

  return createMarkdownStreamer(
    {
      render,
      mode: "hybrid",
    },
  );
}
