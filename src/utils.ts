/**
 * Small reusable CLI helpers for Sky Code.
 *
 * This module centralizes interactive confirmation prompts and conversion of
 * arbitrary thrown values into human-readable error text.
 */
import inquirer from "inquirer";

/**
 * Shape returned by the confirmation prompt.
 */
interface ConfirmationAnswer {
  /** Whether the user explicitly approved the requested action. */
  approved: boolean;
}

/**
 * Prompts the user to approve or reject an action.
 *
 * The confirmation defaults to false so pressing Enter without an affirmative
 * choice does not authorize the action.
 *
 * @param {string} message - Question displayed by the interactive prompt.
 * @returns {Promise<boolean>} True only when the user approves the prompt.
 * @throws {Error} If Inquirer cannot complete the interactive prompt.
 *
 * Side effects: reads from and writes to the interactive terminal through
 * Inquirer.
 */
export async function confirmAction(
  message: string,
): Promise<boolean> {
  const answer =
    await inquirer.prompt<ConfirmationAnswer>([
      {
        type: "confirm",
        name: "approved",
        message,
        default: false,
      },
    ]);

  return answer.approved;
}

/**
 * Converts an unknown error value into displayable text.
 *
 * @param {unknown} error - Error instance or arbitrary thrown value.
 * @returns {string} Error.message for Error instances, otherwise String(error).
 *
 * Side effects: none.
 */
export function formatError(
  error: unknown,
): string {
  return error instanceof Error
    ? error.message
    : String(error);
}
