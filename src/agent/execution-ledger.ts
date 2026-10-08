/**
 * The execution ledger: an authoritative summary of what actually happened
 * in one agent turn, built only from recorded AgentEvent history, and the
 * check that keeps a final answer from contradicting it.
 *
 * A model can misremember its own turn. In the gemma4-e2b-sky live run, one
 * DOCX was created and verified, yet the final answer said every DOCX
 * attempt had failed. The recorded events are the ground truth, so before a
 * native final answer is accepted, it is compared against them:
 *
 * - buildExecutionLedger() lists every tool call this turn with its real
 *   outcome (succeeded, failed, not executed, interrupted), whether the
 *   tool's own post-condition check passed, its output, and its target
 *   (the `path` or `url` argument, when it has one).
 * - checkAnswerAgainstLedger() rejects an answer that directly contradicts
 *   the ledger. It is deliberately narrow, to avoid rejecting honest
 *   answers. It works clause by clause and flags only three kinds of claim:
 *   a failure claimed for a specific file whose every recorded attempt
 *   succeeded; a sweeping failure claim ("all/every/none") about a kind of
 *   file, or about the turn's attempts in general, when at least one such
 *   attempt succeeded; and success claimed for a specific file that no
 *   recorded call ever produced. Anything subtler is not detected; this is
 *   pattern matching on text, not understanding.
 * - renderExecutionLedger() is shown to the model whenever an answer is
 *   rejected, and to the final-answer producer, so the model writes from the
 *   record rather than from memory.
 * - buildLedgerFallbackAnswer() is the deterministic last resort when the
 *   model cannot produce a consistent answer within its correction budget.
 *
 * Nothing here is specific to any tool: file kinds are recognized from the
 * target's extension, and every rule applies to every tool equally.
 */
import type {
  AgentEvent,
} from "./types.js";

import {
  describeSuggestedChanges,
  extractSafeRecovery,
  type SafeRecovery,
} from "./recovery.js";

/**
 * The real outcome of one tool call this turn.
 */
export interface LedgerEntry {
  callId: string;
  tool: string;
  /** The call's `path` or `url` argument, when it has one. */
  target?: string;
  /**
   * - succeeded / failed: the tool ran (an execution failure is "failed").
   * - rejected: its arguments were refused before running (a validation
   *   failure: the tool never ran).
   * - not_executed: the repeated-action breaker did not run it again.
   * - interrupted: it never completed (cancelled, or no result recorded).
   */
  status:
    | "succeeded"
    | "failed"
    | "rejected"
    | "not_executed"
    | "interrupted";
  /** The tool's own post-condition check passed (never "goal met"). */
  verified: boolean;
  output: string;
  /** A safe recovery the tool attached to this failure, if any. */
  recovery?: SafeRecovery;
}

/**
 * Builds the ledger from recorded history, in call order.
 *
 * @param {readonly AgentEvent[]} history - This turn's recorded events.
 * @returns {LedgerEntry[]} One entry per requested tool call.
 *
 * Side effects: none.
 */
export function buildExecutionLedger(
  history: readonly AgentEvent[],
): LedgerEntry[] {
  const entries: LedgerEntry[] = [];
  const byCallId =
    new Map<string, LedgerEntry>();

  for (
    const event of history
  ) {
    if (event.type === "tool_requested") {
      const args =
        typeof event.arguments === "object" &&
        event.arguments !== null
          ? (event.arguments as Record<string, unknown>)
          : {};

      const target =
        typeof args.path === "string"
          ? args.path
          : typeof args.url === "string"
            ? args.url
            : undefined;

      const entry: LedgerEntry = {
        callId: event.callId,
        tool: event.tool,
        ...(target !== undefined
          ? {
              target,
            }
          : {}),
        // Until a result arrives, a requested call has not completed.
        status: "interrupted",
        verified: false,
        output: "",
      };

      entries.push(entry);
      byCallId.set(
        event.callId,
        entry,
      );
      continue;
    }

    if (event.type === "tool_result") {
      const entry =
        byCallId.get(
          event.callId,
        );

      if (!entry) {
        continue;
      }

      entry.status =
        event.notExecuted
          ? event.notExecutedReason ===
            "invalid_arguments"
            ? "rejected"
            : "not_executed"
          : event.success
            ? "succeeded"
            : "failed";
      entry.verified =
        event.success &&
        event.verified;
      // A rejected call's own result text is long correction guidance; the
      // ledger keeps just the validation error, which is what happened.
      entry.output =
        event.notExecutedReason ===
          "invalid_arguments" &&
        event.validationError !== undefined
          ? event.validationError
          : event.output;

      const recovery =
        event.notExecuted
          ? undefined
          : extractSafeRecovery(
              event,
            );

      if (recovery) {
        entry.recovery = recovery;
      }
    }
  }

  return entries;
}

/**
 * Renders the ledger as plain, deterministic text.
 *
 * @param {readonly LedgerEntry[]} entries - The ledger.
 * @returns {string} One numbered line per call, or a single line saying no
 * tool was called.
 *
 * Side effects: none.
 */
export function renderExecutionLedger(
  entries: readonly LedgerEntry[],
): string {
  if (entries.length === 0) {
    return "No tool was called this turn.";
  }

  return entries
    .map(
      (entry, index) => {
        const subject =
          entry.target !== undefined
            ? `${entry.tool} (${entry.target})`
            : entry.tool;

        const outcome =
          entry.status === "succeeded"
            ? entry.verified
              ? "succeeded; the tool's own check of its output passed"
              : "succeeded"
            : entry.status === "failed"
              ? "failed"
              : entry.status === "rejected"
                ? "rejected before running (invalid arguments)"
                : entry.status === "not_executed"
                  ? "not executed (identical call had already failed)"
                  : "did not complete (interrupted)";

        const firstLine =
          entry.output
            .split("\n")[0]
            ?.trim() ?? "";

        const recoveryNote =
          entry.recovery
            ? ` (recoverable: retry with the same arguments, changing ${describeSuggestedChanges(entry.recovery.suggestedArguments)})`
            : "";

        return `${index + 1}. ${subject}: ${outcome}${recoveryNote}${
          firstLine !== ""
            ? `. Output: ${firstLine}`
            : ""
        }`;
      },
    )
    .join("\n");
}

/**
 * Words a file kind may be referred to by, keyed by extension. Unlisted
 * extensions are referred to by the extension itself.
 */
const KIND_WORDS: Readonly<Record<string, readonly string[]>> = {
  docx: ["docx", "doc", "word"],
  doc: ["docx", "doc", "word"],
  xlsx: ["xlsx", "xls", "excel", "spreadsheet", "workbook"],
  xls: ["xlsx", "xls", "excel", "spreadsheet", "workbook"],
  csv: ["csv", "spreadsheet"],
  pptx: ["pptx", "ppt", "powerpoint", "presentation", "deck", "slides", "slide"],
  ppt: ["pptx", "ppt", "powerpoint", "presentation", "deck", "slides", "slide"],
  pdf: ["pdf"],
  md: ["md", "markdown"],
};

/** General nouns a sweeping claim about the whole turn may use. */
const GENERAL_NOUNS =
  /\b(files?|documents?|attempts?|tries|tool calls?|calls|actions?|outputs?|deliverables?)\b/i;

/**
 * Phrases that claim an action failed. Deliberately limited to explicit
 * failure wording: "was not modified" or "has no errors" are not failure
 * claims.
 */
const FAILURE_CLAIM =
  /\b(failed|fails|failure|unsuccessful|could not (?:be )?(?:create|created|generate|generated|write|written|save|saved)|couldn't (?:be )?(?:create|created|generate|generated|write|written|save|saved)|unable to (?:create|generate|write|save)|(?:was|were) not (?:created|generated|written|saved)|(?:wasn't|weren't) (?:created|generated|written|saved)|(?:was|were) never (?:created|generated|written|saved)|not created|did not succeed|didn't succeed)\b/i;

/** Phrases that claim an action succeeded. */
const SUCCESS_CLAIM =
  /\b(created|generated|saved|written|wrote|produced|completed|succeeded|successfully|is ready|are ready)\b/i;

/**
 * Wording that places a claim outside this turn ("created earlier", "already
 * existed"), so it is not a claim about this turn's recorded calls.
 */
const NOT_THIS_TURN =
  /\b(earlier|previously|previous|before|already|existing|existed|last time)\b/i;

/** Any wording that negates or hedges an outcome. */
const NEGATION =
  /\b(not|no|never|n't|failed|unable|cannot|could not|couldn't)\b|n't\b/i;

/**
 * Tests whether a clause makes a sweeping failure claim: every/each/all/both
 * of something failed, none of something was created, or "no X was created".
 *
 * @param {string} clause - Lower-cased clause.
 * @returns {boolean} True for a sweeping failure claim.
 */
function claimsSweepingFailure(
  clause: string,
): boolean {
  return (
    (/\b(all|every|each|both)\b/.test(clause) &&
      FAILURE_CLAIM.test(clause)) ||
    (/\bnone\b/.test(clause) &&
      SUCCESS_CLAIM.test(clause)) ||
    /\bno\s+(?:[a-z0-9.-]+\s+){0,3}(?:was|were)\s+(?:created|generated|written|saved|produced)\b/.test(
      clause,
    )
  );
}

/**
 * Lower-cased final path segment of a target.
 *
 * @param {string} target - A path or URL.
 * @returns {string} Its basename.
 */
function basenameOf(
  target: string,
): string {
  return (
    target
      .split(/[\\/]/)
      .filter(
        (part) => part !== "",
      )
      .at(-1) ?? target
  ).toLowerCase();
}

/**
 * Lower-cased extension of a target's basename, if any.
 *
 * @param {string} target - A path or URL.
 * @returns {string | undefined} The extension without the dot.
 */
function extensionOf(
  target: string,
): string | undefined {
  const base =
    basenameOf(target);

  const dot =
    base.lastIndexOf(".");

  return dot > 0
    ? base.slice(dot + 1)
    : undefined;
}

/**
 * Splits an answer into clauses, so "status.docx was created; the PDF
 * failed" is judged as two separate claims.
 *
 * @param {string} text - Candidate answer.
 * @returns {string[]} Lower-cased clauses.
 */
function splitClauses(
  text: string,
): string[] {
  return text
    .toLowerCase()
    // A period only ends a clause when followed by whitespace or the end of
    // the text, so a file name such as "report.docx" stays intact.
    .split(/[.;!?]+(?=\s|$)|\n+|,|\bbut\b|\bhowever\b|\bwhile\b|\balthough\b/)
    .map(
      (clause) => clause.trim(),
    )
    .filter(
      (clause) => clause !== "",
    );
}

/**
 * Tests whether a clause mentions a word as a whole word.
 *
 * @param {string} clause - Lower-cased clause.
 * @param {string} word - Lower-cased word.
 * @returns {boolean} True for a whole-word match.
 */
function mentions(
  clause: string,
  word: string,
): boolean {
  const escaped =
    word.replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&",
    );

  return new RegExp(
    `(^|[^a-z0-9_-])${escaped}($|[^a-z0-9_-])`,
  ).test(clause);
}

/**
 * Outcome of checking an answer against the ledger.
 */
export type LedgerConsistency =
  | {
      consistent: true;
    }
  | {
      consistent: false;
      reason: string;
    };

/**
 * Checks a candidate final answer for direct contradictions of the ledger.
 *
 * @param {string} text - The candidate final answer.
 * @param {readonly LedgerEntry[]} entries - This turn's ledger.
 * @returns {LedgerConsistency} Inconsistent only for one of the three
 * narrow claim types described in this module's doc comment.
 *
 * Side effects: none.
 */
export function checkAnswerAgainstLedger(
  text: string,
  entries: readonly LedgerEntry[],
): LedgerConsistency {
  if (entries.length === 0) {
    return {
      consistent: true,
    };
  }

  const clauses =
    splitClauses(text);

  // Outcomes per specific target (basename).
  const byTarget =
    new Map<
      string,
      {
        succeeded: boolean;
        failed: boolean;
      }
    >();

  for (
    const entry of entries
  ) {
    if (entry.target === undefined) {
      continue;
    }

    const key =
      basenameOf(
        entry.target,
      );

    const current =
      byTarget.get(key) ?? {
        succeeded: false,
        failed: false,
      };

    if (entry.status === "succeeded") {
      current.succeeded = true;
    } else {
      current.failed = true;
    }

    byTarget.set(
      key,
      current,
    );
  }

  // File kinds with at least one success.
  const succeededKinds =
    new Map<string, string>();

  for (
    const entry of entries
  ) {
    if (
      entry.status !== "succeeded" ||
      entry.target === undefined
    ) {
      continue;
    }

    const extension =
      extensionOf(
        entry.target,
      );

    if (extension === undefined) {
      continue;
    }

    for (
      const word of KIND_WORDS[extension] ?? [extension]
    ) {
      succeededKinds.set(
        word,
        basenameOf(
          entry.target,
        ),
      );
    }
  }

  const anySucceeded =
    entries.some(
      (entry) =>
        entry.status === "succeeded",
    );

  for (
    const clause of clauses
  ) {
    const claimsFailure =
      FAILURE_CLAIM.test(clause);

    for (
      const [target, outcome] of byTarget
    ) {
      if (!mentions(clause, target)) {
        continue;
      }

      if (
        claimsFailure &&
        outcome.succeeded &&
        !outcome.failed
      ) {
        return {
          consistent: false,
          reason: `it says ${target} failed or was not created, but every recorded attempt for ${target} succeeded.`,
        };
      }

      if (
        SUCCESS_CLAIM.test(clause) &&
        !NEGATION.test(clause) &&
        !NOT_THIS_TURN.test(clause) &&
        !outcome.succeeded
      ) {
        return {
          consistent: false,
          reason: `it says ${target} was created or completed, but no recorded call for ${target} succeeded.`,
        };
      }
    }

    if (
      claimsSweepingFailure(
        clause,
      )
    ) {
      for (
        const [word, example] of succeededKinds
      ) {
        if (mentions(clause, word)) {
          return {
            consistent: false,
            reason: `it says every or no "${word}" attempt failed, but ${example} was created successfully.`,
          };
        }
      }

      if (
        anySucceeded &&
        GENERAL_NOUNS.test(clause)
      ) {
        return {
          consistent: false,
          reason:
            "it says every or no attempt failed, but at least one tool call this turn succeeded.",
        };
      }
    }
  }

  return {
    consistent: true,
  };
}

/**
 * Builds the deterministic final answer used when the model cannot produce
 * one consistent with the ledger.
 *
 * @param {readonly LedgerEntry[]} entries - This turn's ledger.
 * @returns {string} A plain account of exactly what was recorded.
 *
 * Side effects: none.
 */
export function buildLedgerFallbackAnswer(
  entries: readonly LedgerEntry[],
): string {
  return [
    "I could not produce a summary consistent with what actually happened, so here is the recorded result of each step this turn:",
    "",
    renderExecutionLedger(
      entries,
    ),
  ].join("\n");
}

/**
 * Builds the deterministic final answer used when the model keeps
 * requesting a call that was already blocked as a failing repeat (see
 * MAX_BLOCKED_REPEATS, repeat-guard.ts).
 *
 * @param {readonly LedgerEntry[]} entries - This turn's ledger.
 * @param {string} tool - The repeatedly requested tool.
 * @param {SafeRecovery} [recovery] - The safe retry that was available, if
 * any; named explicitly so the user knows it was never used.
 * @returns {string} A plain account of what was recorded and why the turn
 * stopped.
 *
 * Side effects: none.
 */
export function buildRepeatStopAnswer(
  entries: readonly LedgerEntry[],
  tool: string,
  recovery?: SafeRecovery,
): string {
  const lines = [
    `I stopped because the same ${tool} call kept being requested after it had already failed with the same result. Here is the recorded result of each step this turn:`,
    "",
    renderExecutionLedger(
      entries,
    ),
  ];

  if (recovery) {
    lines.push(
      "",
      `A safe retry was available but was not used: ${tool} with the same arguments, changing ${describeSuggestedChanges(recovery.suggestedArguments)}.`,
    );
  }

  return lines.join("\n");
}

/**
 * Builds the deterministic final answer used when a turn has to stop before
 * the model produced a usable answer (for example, it kept supplying
 * invalid arguments, or its responses could not be used at all).
 *
 * Everything already done this turn is reported exactly as recorded, so
 * completed work is never lost behind a generic error.
 *
 * @param {readonly LedgerEntry[]} entries - This turn's ledger.
 * @param {string} reason - Why the turn stopped, completing the sentence
 * "I stopped because ...".
 * @returns {string} A plain account of what was recorded.
 *
 * Side effects: none.
 */
export function buildLedgerStopAnswer(
  entries: readonly LedgerEntry[],
  reason: string,
): string {
  return [
    `I stopped because ${reason}. Here is the recorded result of each step this turn:`,
    "",
    renderExecutionLedger(
      entries,
    ),
  ].join("\n");
}
