/**
 * Checks whether a native model's plain-text response is acceptable as the
 * turn's final answer.
 *
 * A native tool-calling model ends a turn by replying with text and no tool
 * call. That text is only a genuine final answer if it reports what
 * actually happened. Two kinds of reply look like an ending but are not:
 * - A tool request written as text instead of made through the native
 *   interface: a `sky-tool` block, Sky Code's own plain-history
 *   "Tool call: name(...)" form, a Gemma-style `tool_code` block, a
 *   Hermes-style <tool_call> tag, or a JSON object naming an offered tool
 *   with its arguments. Nothing in such a reply was executed, so showing
 *   it as the answer would present an unexecuted request as if it were the
 *   result.
 * - A promise of further work ("I will now create the XLSX", "Next I
 *   will..."). The turn ends when this reply is accepted, so any action it
 *   promises will never be carried out by this turn: accepting it would
 *   tell the user something will happen that will not.
 *
 * A rejected reply is never executed and never shown; NativeStrategy feeds
 * the reason back to the model, which can then make the real tool call or
 * write an honest answer (see native.ts). These checks are deliberately
 * generic: no rule names a specific tool except through the list of tools
 * actually offered this turn.
 *
 * The checks are pattern-based and deliberately narrow to limit false
 * positives on honest answers: past-tense reports ("I created...") and
 * offers that depend on the user ("If you'd like, I can...", "Let me
 * know...") are always accepted.
 */

/**
 * Outcome of checking one candidate final answer.
 */
export type FinalAnswerSafety =
  | {
      acceptable: true;
    }
  | {
      acceptable: false;
      reason: string;
    };

/**
 * Escapes a string for literal use inside a RegExp.
 *
 * @param {string} value - Text to escape.
 * @returns {string} Escaped text.
 */
function escapeForRegExp(
  value: string,
): string {
  return value.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&",
  );
}

/**
 * First-person phrasing that commits to doing something after this reply.
 */
const FUTURE_COMMITMENT =
  /\b(I will|I'll|I am going to|I'm going to|I shall|let me|I'm about to|I am about to|I'm now going to|next,? I(?: will|'ll)|now,? I(?: will|'ll))\b/i;

/**
 * Verbs naming an action a tool call would perform.
 */
const ACTION_VERB =
  /\b(create|generate|write|make|build|produce|save|add|run|execute|call|use|update|edit|modify|fix|delete|remove|fetch|search|download|convert|export|prepare|draft|compile|proceed|start|begin|continue|retry|try)\b/i;

/**
 * Phrasing that makes a sentence a conditional offer to the user, not a
 * promise of work this turn. A sentence containing any of these is never
 * treated as a promise.
 */
const USER_CONDITIONAL =
  /\b(if you|would you like|do you want|should I|shall I|let me know|once you|when you|after you|if needed|if necessary|if that helps|if you'd like|if you want|if you prefer|upon your|on your confirmation|your approval|your permission)\b/i;

/**
 * Splits text into rough sentences for the promise check.
 *
 * @param {string} text - Candidate answer.
 * @returns {string[]} Sentence-like fragments.
 */
function splitSentences(
  text: string,
): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map(
      (sentence) => sentence.trim(),
    )
    .filter(
      (sentence) => sentence !== "",
    );
}

/**
 * Checks one candidate native final answer.
 *
 * @param {string} text - The model's plain-text response (no native tool
 * call accompanied it).
 * @param {readonly string[]} offeredToolNames - Names of the tools offered
 * this turn, used to recognize a tool request written as text.
 * @returns {FinalAnswerSafety} Whether the text is acceptable, and if not,
 * why.
 *
 * Side effects: none.
 */
export function checkFinalAnswerSafety(
  text: string,
  offeredToolNames: readonly string[],
): FinalAnswerSafety {
  if (
    /```\s*sky-tool\b/i.test(text) ||
    /^\s*sky-tool\s*[{:]/im.test(text)
  ) {
    return {
      acceptable: false,
      reason:
        "it contains a sky-tool block, which is a tool request written as text. Nothing in it was executed.",
    };
  }

  if (
    /\bTool call:\s*[A-Za-z_][\w-]*\s*\(/.test(
      text,
    )
  ) {
    return {
      acceptable: false,
      reason:
        'it contains a "Tool call: name(...)" line, which is a tool request written as text. Nothing in it was executed.',
    };
  }

  if (
    /```\s*(tool_code|tool_call|tool_calls|function_call|function_calls)\b/i.test(
      text,
    ) ||
    /<\/?(tool_call|function_call)\b[^>]*>/i.test(
      text,
    )
  ) {
    return {
      acceptable: false,
      reason:
        "it contains a tool-call block written as text. Nothing in it was executed.",
    };
  }

  const toolNames =
    offeredToolNames.filter(
      (name) => name.trim() !== "",
    );

  if (toolNames.length > 0) {
    const namePattern =
      toolNames
        .map(escapeForRegExp)
        .join("|");

    const jsonNamesTool =
      new RegExp(
        `"(?:tool|name|function|tool_name)"\\s*:\\s*"(?:${namePattern})"`,
      );

    const jsonHasArguments =
      /"(?:args|arguments|parameters|input)"\s*:/;

    if (
      jsonNamesTool.test(text) &&
      jsonHasArguments.test(text)
    ) {
      return {
        acceptable: false,
        reason:
          "it contains a JSON tool request written as text. Nothing in it was executed.",
      };
    }

    // A fenced code block that is nothing but a call to an offered tool,
    // e.g. ```\ncreate_xlsx(path="a.xlsx", ...)\n```.
    const fencedToolInvocation =
      new RegExp(
        "```[\\w-]*\\s*\\n?\\s*(?:" +
          namePattern +
          ")\\s*\\(",
      );

    if (fencedToolInvocation.test(text)) {
      return {
        acceptable: false,
        reason:
          "it contains a tool invocation written inside a code block. Nothing in it was executed.",
      };
    }
  }

  for (
    const sentence of splitSentences(
      text,
    )
  ) {
    if (
      FUTURE_COMMITMENT.test(
        sentence,
      ) &&
      ACTION_VERB.test(
        sentence,
      ) &&
      !USER_CONDITIONAL.test(
        sentence,
      )
    ) {
      return {
        acceptable: false,
        reason: `it promises an action that has not been carried out ("${sentence.slice(0, 160)}"). This turn ends when a final answer is accepted, so nothing promised in it would ever be done.`,
      };
    }
  }

  return {
    acceptable: true,
  };
}
