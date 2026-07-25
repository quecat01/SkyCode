import inquirer from "inquirer";

interface ConfirmationAnswer {
  approved: boolean;
}

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

export function formatError(
  error: unknown,
): string {
  return error instanceof Error
    ? error.message
    : String(error);
}
