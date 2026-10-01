/**
 * Incremental classifier for streamed assistant text: decides, chunk by
 * chunk, whether a completion is an ordinary conversational reply or an
 * internal `sky-tool` fenced block, so a caller can withhold the latter from
 * terminal display while it streams in.
 *
 * This is the exact decision logic that used to live inline inside
 * index.ts's streamModelTurn() chunk callback, extracted unchanged so it has
 * direct unit test coverage instead of only ever being exercised indirectly
 * through a live streaming terminal session. It knows nothing about I/O,
 * markdown rendering, or the thinking indicator: it only decides what raw
 * text (if any) a caller should now display, leaving actually writing and
 * rendering that text to the caller (in production,
 * index.ts's createVisibleTextCompletionClient()).
 */

/**
 * The three states a streamed completion can be in with respect to whether
 * it contains a `sky-tool` fenced block:
 * - "undetermined": not enough text has arrived yet to tell.
 * - "normal": confirmed to be ordinary conversational text.
 * - "tool": confirmed to open with a `sky-tool` fenced block; its raw text
 *   is never surfaced for display.
 */
export type SkyToolMarkerDisplayMode =
  | "undetermined"
  | "normal"
  | "tool";

/**
 * Result of feeding one chunk (push()) or ending the stream (finish()) into
 * a SkyToolMarkerBuffer.
 */
export interface SkyToolMarkerClassification {
  /** Display mode after processing this chunk or ending the stream. */
  mode: SkyToolMarkerDisplayMode;

  /**
   * Raw text that should now be written to the terminal (via the caller's
   * own markdown renderer), if any. Empty when nothing new is displayable
   * yet - either because the mode is still "undetermined" (text is being
   * held back until the marker decision can be made) or "tool" (text is
   * withheld permanently for this stream).
   */
  textToDisplay: string;
}

const SKY_TOOL_MARKER =
  "```sky-tool";

/**
 * Buffers streamed text until it can be classified as ordinary
 * conversational output or an internal `sky-tool` fenced block, then reports
 * what (if anything) should be displayed as each chunk arrives.
 *
 * One instance covers exactly one streamed completion: its buffering state
 * (held-back prefix text) has no meaning across separate completions, so a
 * caller must create a new instance per completion, mirroring the same
 * per-turn lifetime streamModelTurn() always gave its own markdown streamer
 * and buffering state.
 */
export class SkyToolMarkerBuffer {
  private mode:
    SkyToolMarkerDisplayMode =
      "undetermined";

  private pendingText =
    "";

  /**
   * Feeds one streamed chunk of raw completion text into the buffer.
   *
   * @param {string} content - The next raw chunk exactly as the model
   * streamed it.
   * @returns {SkyToolMarkerClassification} The mode after this chunk, and
   * any text that should now be displayed as a result of it.
   */
  push(
    content: string,
  ): SkyToolMarkerClassification {
    if (
      this.mode ===
      "normal"
    ) {
      return {
        mode:
          "normal",
        textToDisplay:
          content,
      };
    }

    if (
      this.mode ===
      "tool"
    ) {
      return {
        mode:
          "tool",
        textToDisplay:
          "",
      };
    }

    // Still "undetermined": accumulate until the marker decision can be
    // made.
    this.pendingText +=
      content;

    const trimmedStart =
      this.pendingText.trimStart();

    // If the text received so far is still only a prefix of the marker,
    // wait for another chunk before deciding whether to display it.
    if (
      SKY_TOOL_MARKER.startsWith(
        trimmedStart,
      )
    ) {
      return {
        mode:
          "undetermined",
        textToDisplay:
          "",
      };
    }

    // A completed marker identifies an internal tool request. Its textual
    // representation should never be surfaced as ordinary assistant prose.
    if (
      trimmedStart.startsWith(
        SKY_TOOL_MARKER,
      )
    ) {
      this.mode =
        "tool";

      return {
        mode:
          "tool",
        textToDisplay:
          "",
      };
    }

    // The accumulated prefix cannot be a tool marker, so all buffered text
    // belongs to the normal assistant response and can now be released.
    this.mode =
      "normal";

    const releasedText =
      this.pendingText;

    this.pendingText =
      "";

    return {
      mode:
        "normal",
      textToDisplay:
        releasedText,
    };
  }

  /**
   * Resolves the buffer once the stream has ended, for a response short
   * enough that push() never accumulated enough text to leave
   * "undetermined" on its own.
   *
   * @returns {SkyToolMarkerClassification} The final mode, and any
   * still-buffered text that should now be displayed as ordinary prose. Safe
   * to call when the mode already resolved to "normal" or "tool": it then
   * reports that mode with no further text to display.
   */
  finish():
    SkyToolMarkerClassification {
    if (
      this.mode !==
      "undetermined"
    ) {
      return {
        mode:
          this.mode,
        textToDisplay:
          "",
      };
    }

    const trimmedStart =
      this.pendingText.trimStart();

    if (
      trimmedStart.startsWith(
        SKY_TOOL_MARKER,
      )
    ) {
      this.mode =
        "tool";

      return {
        mode:
          "tool",
        textToDisplay:
          "",
      };
    }

    this.mode =
      "normal";

    const releasedText =
      this.pendingText;

    this.pendingText =
      "";

    return {
      mode:
        "normal",
      textToDisplay:
        releasedText,
    };
  }
}
