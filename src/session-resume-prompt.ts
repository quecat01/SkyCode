import type {
  ResumableSession,
} from "./session-resume.js";

export type SessionResumeDecision =
  | "resume"
  | "fresh";

export interface SessionResumePromptIO {
  question(
    prompt:
      string,
  ): Promise<string>;

  write(
    line:
      string,
  ): void;
}

export function formatResumableSessionSummary(
  session:
    ResumableSession,
): string[] {
  return [
    "Previous Sky Code session found for this directory.",
    `Last updated: ${session.updatedAt}`,
    `Stored conversation messages: ${session.messages.length}`,
    `Previous model: ${session.model ?? "unknown"}`,
    "",
    "1. Resume the previous session",
    "2. Start fresh",
  ];
}

export function parseSessionResumeSelection(
  value:
    string,
): SessionResumeDecision | null {
  const normalizedValue =
    value
      .trim()
      .toLowerCase();

  if (
    normalizedValue ===
      "1" ||
    normalizedValue ===
      "r" ||
    normalizedValue ===
      "resume"
  ) {
    return "resume";
  }

  if (
    normalizedValue ===
      "" ||
    normalizedValue ===
      "2" ||
    normalizedValue ===
      "f" ||
    normalizedValue ===
      "fresh"
  ) {
    return "fresh";
  }

  return null;
}

export async function promptForSessionResume(
  session:
    ResumableSession,

  io:
    SessionResumePromptIO,
): Promise<SessionResumeDecision> {
  io.write(
    "",
  );

  for (
    const line of
    formatResumableSessionSummary(
      session,
    )
  ) {
    io.write(
      line,
    );
  }

  io.write(
    "",
  );

  while (
    true
  ) {
    const answer =
      await io.question(
        "Enter 1 to resume, or 2 to start fresh [2]: ",
      );

    const decision =
      parseSessionResumeSelection(
        answer,
      );

    if (
      decision !==
        null
    ) {
      return decision;
    }

    io.write(
      "Invalid selection. Enter 1 to resume or 2 to start fresh.",
    );
  }
}
