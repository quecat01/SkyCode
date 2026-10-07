/**
 * Assembles one streamed OpenAI-compatible chat-completion response into
 * complete native tool calls.
 *
 * A streamed native tool call does not arrive whole. Each SSE chunk may
 * carry a `choices[0].delta.tool_calls` array whose entries hold only a
 * fragment of one call: the call ID, the function name, and the JSON
 * arguments string can each be split across many chunks, matched to their
 * call by `index`. This module accumulates those fragments and only
 * produces calls once the whole stream has been consumed (finish()), so
 * nothing downstream can ever act on a partially received call.
 *
 * Deliberately wire-level and pure: no network access, no parsing or
 * validation of the arguments JSON itself (that is
 * agent/strategies/native.ts's job, after assembly), and no dependency on
 * agent/ code. chat.ts's streamNativeToolCompletion() feeds it parsed SSE
 * chunks; tests feed it scripted chunks directly.
 *
 * Provider tolerance, from real gateway behavior this has to survive:
 * - The call ID and function name normally arrive once, in the first
 *   fragment of a call; some providers repeat the full value on every
 *   fragment, and some split it. All three are handled (see
 *   mergeIdentifierFragment()).
 * - Some providers omit `index` when only one call is streamed; a fragment
 *   with no index is matched by ID, or else appended to the most recent
 *   call.
 * - A gateway may drop the call ID entirely (a known LiteLLM issue). The
 *   ID is only a correlation handle between the assistant tool-call record
 *   and its role:"tool" result, so a locally generated ID is substituted
 *   and reported as a non-fatal protocol note rather than discarding an
 *   otherwise complete call.
 * - A call with no function name, or a stream cut off by the token limit
 *   (`finish_reason: "length"`) while a call was open, is incomplete and
 *   reported as a fatal protocol issue: the caller must not execute it.
 */

/**
 * One fully assembled native tool call, in the same shape chat.ts's
 * ChatToolCall uses for a non-streamed response.
 */
export interface AssembledToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

/**
 * Everything assembled from one complete stream.
 *
 * `protocolIssues` lists reasons the response is unusable as-is (for
 * example, a call with no function name); a caller must treat a non-empty
 * list as a non-compliant response and never execute any of `toolCalls`.
 * `protocolNotes` lists non-fatal irregularities that were corrected
 * locally (for example, a synthesized call ID), for diagnostics only.
 */
export interface NativeStreamAssembly {
  content: string | null;
  toolCalls: AssembledToolCall[];
  finishReason: string | null;
  protocolIssues: string[];
  protocolNotes: string[];
}

/**
 * Optional dependencies, injectable so tests are deterministic.
 */
export interface NativeToolCallStreamAssemblerOptions {
  /**
   * Generates a replacement call ID when the provider never supplied one.
   * Defaults to a random UUID-based ID.
   */
  createId?: () => string;
}

/**
 * Mutable accumulation state for one tool call, keyed by stream index.
 */
interface ToolCallSlot {
  index: number;
  id: string;
  name: string;
  arguments: string;
}

/**
 * Narrows an unknown value to a plain (non-array) object record.
 *
 * @param {unknown} value - Value to check.
 * @returns {boolean} True when value is a non-null, non-array object.
 */
function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

/**
 * Merges one streamed fragment of an identifier (call ID or function name)
 * into what has been accumulated so far.
 *
 * Providers differ: most send the value once, some repeat the complete
 * value on every fragment, and some split it into pieces. Repeating the
 * same value must not double it ("callcall"), and a cumulative value (each
 * fragment a longer prefix of the final value) must replace rather than
 * append; anything else is a genuine piece and is appended.
 *
 * @param {string} current - Accumulated value so far ("" if none yet).
 * @param {string} fragment - Newly received fragment.
 * @returns {string} The merged value.
 */
function mergeIdentifierFragment(
  current: string,
  fragment: string,
): string {
  if (
    fragment === "" ||
    fragment === current
  ) {
    return current;
  }

  if (
    current === "" ||
    fragment.startsWith(current)
  ) {
    return fragment;
  }

  return current + fragment;
}

/**
 * Default replacement-ID generator.
 *
 * @returns {string} A locally unique call ID.
 */
function defaultCreateId(): string {
  return `sky_call_${globalThis.crypto.randomUUID()}`;
}

/**
 * Accumulates streamed chat-completion chunks into complete content and
 * native tool calls.
 */
export class NativeToolCallStreamAssembler {
  private content = "";

  private slots: ToolCallSlot[] = [];

  private finishReason: string | null = null;

  private createId: () => string;

  /**
   * @param {NativeToolCallStreamAssemblerOptions} [options] - Optional
   * injectable dependencies.
   */
  constructor(
    options: NativeToolCallStreamAssemblerOptions = {},
  ) {
    this.createId =
      options.createId ??
      defaultCreateId;
  }

  /**
   * Finds or creates the accumulation slot one tool-call fragment belongs
   * to.
   *
   * @param {Record<string, unknown>} fragment - One entry of
   * delta.tool_calls.
   * @returns {ToolCallSlot} The slot to merge this fragment into.
   */
  private slotFor(
    fragment: Record<string, unknown>,
  ): ToolCallSlot {
    if (
      typeof fragment.index ===
        "number" &&
      Number.isInteger(
        fragment.index,
      )
    ) {
      const index =
        fragment.index;

      const existing =
        this.slots.find(
          (slot) => slot.index === index,
        );

      if (existing) {
        return existing;
      }

      const created: ToolCallSlot = {
        index,
        id: "",
        name: "",
        arguments: "",
      };

      this.slots.push(created);

      return created;
    }

    // No index: match by a known ID first, otherwise treat a fragment that
    // introduces a new ID as a new call, and anything else as a
    // continuation of the most recent call.
    const fragmentId =
      typeof fragment.id ===
        "string"
        ? fragment.id
        : "";

    if (fragmentId !== "") {
      const byId =
        this.slots.find(
          (slot) => slot.id === fragmentId,
        );

      if (byId) {
        return byId;
      }
    }

    const last =
      this.slots.at(-1);

    if (
      last &&
      (fragmentId === "" ||
        last.id === "")
    ) {
      return last;
    }

    const nextIndex =
      this.slots.reduce(
        (highest, slot) =>
          Math.max(
            highest,
            slot.index,
          ),
        -1,
      ) + 1;

    const created: ToolCallSlot = {
      index: nextIndex,
      id: "",
      name: "",
      arguments: "",
    };

    this.slots.push(created);

    return created;
  }

  /**
   * Merges one parsed SSE `data:` JSON chunk.
   *
   * Untrusted at every level: anything not shaped as expected is ignored,
   * matching chat.ts's defensive handling of streamed text.
   *
   * @param {unknown} chunk - One parsed chat-completion stream chunk.
   * @returns {void} Nothing.
   *
   * Side effects: mutates this assembler's accumulated state.
   */
  push(
    chunk: unknown,
  ): void {
    if (!isRecord(chunk)) {
      return;
    }

    const choices =
      chunk.choices;

    if (
      !Array.isArray(choices) ||
      choices.length === 0
    ) {
      return;
    }

    const choice =
      choices[0];

    if (!isRecord(choice)) {
      return;
    }

    if (
      typeof choice.finish_reason ===
      "string"
    ) {
      this.finishReason =
        choice.finish_reason;
    }

    const delta =
      choice.delta;

    if (!isRecord(delta)) {
      return;
    }

    if (
      typeof delta.content ===
      "string"
    ) {
      this.content +=
        delta.content;
    }

    const toolCalls =
      delta.tool_calls;

    if (!Array.isArray(toolCalls)) {
      return;
    }

    for (
      const rawFragment of toolCalls
    ) {
      if (!isRecord(rawFragment)) {
        continue;
      }

      const slot =
        this.slotFor(
          rawFragment,
        );

      if (
        typeof rawFragment.id ===
        "string"
      ) {
        slot.id =
          mergeIdentifierFragment(
            slot.id,
            rawFragment.id,
          );
      }

      const fn =
        rawFragment.function;

      if (!isRecord(fn)) {
        continue;
      }

      if (
        typeof fn.name ===
        "string"
      ) {
        slot.name =
          mergeIdentifierFragment(
            slot.name,
            fn.name,
          );
      }

      // Argument fragments are always plain pieces of one JSON string, so
      // they are concatenated in arrival order and never deduplicated: a
      // repeated fragment such as "}" is legitimate JSON content.
      if (
        typeof fn.arguments ===
        "string"
      ) {
        slot.arguments +=
          fn.arguments;
      }
    }
  }

  /**
   * Completes assembly once the stream has ended.
   *
   * @returns {NativeStreamAssembly} Assembled content, calls (ordered by
   * stream index), and any protocol issues/notes found.
   *
   * Side effects: may invoke the injected createId() for a call whose ID
   * never arrived.
   */
  finish(): NativeStreamAssembly {
    const protocolIssues: string[] = [];
    const protocolNotes: string[] = [];
    const toolCalls: AssembledToolCall[] = [];

    const ordered =
      [...this.slots].sort(
        (left, right) =>
          left.index - right.index,
      );

    if (
      this.finishReason ===
        "length" &&
      ordered.length > 0
    ) {
      protocolIssues.push(
        "The streamed response was cut off by the output token limit while a tool call was still being written, so the call is incomplete.",
      );
    }

    for (
      const slot of ordered
    ) {
      const name =
        slot.name.trim();

      if (name === "") {
        protocolIssues.push(
          `The streamed tool call at index ${slot.index} never received a function name.`,
        );
        continue;
      }

      let id =
        slot.id.trim();

      if (id === "") {
        id =
          this.createId();

        protocolNotes.push(
          `The provider streamed tool call "${name}" (index ${slot.index}) without a call ID; Sky Code assigned "${id}" so its result can be matched.`,
        );
      }

      // An empty arguments string is how some providers stream a call to a
      // function that takes no arguments. "{}" is its exact JSON meaning, and
      // keeps the call valid when echoed back in later native history.
      const argumentsJson =
        slot.arguments.trim() === ""
          ? "{}"
          : slot.arguments;

      toolCalls.push({
        id,
        type: "function",
        function: {
          name,
          arguments:
            argumentsJson,
        },
      });
    }

    return {
      content:
        this.content === ""
          ? null
          : this.content,
      toolCalls,
      finishReason:
        this.finishReason,
      protocolIssues,
      protocolNotes,
    };
  }
}
