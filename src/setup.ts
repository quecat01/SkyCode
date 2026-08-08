import inquirer from "inquirer";

import {
  access,
  chmod,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";

import {
  homedir,
} from "node:os";

import {
  basename,
  dirname,
  join,
} from "node:path";

const DEFAULT_API_URL =
  "http://localhost:4000/v1";

const PERMISSION_MODES = [
  {
    value: "default",
    description:
      "Ask before every file edit and shell command (recommended)",
  },
  {
    value: "auto-accept-edits",
    description:
      "Auto-approve file edits; still ask for shell commands",
  },
  {
    value: "plan",
    description:
      "Describe actions but never execute them",
  },
  {
    value: "bypass",
    description:
      "Execute everything without asking (use with care)",
  },
] as const;

type PermissionMode =
  (typeof PERMISSION_MODES)[number]["value"];

function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

async function pathExists(
  filePath: string,
): Promise<boolean> {
  try {
    await access(
      filePath,
    );

    return true;
  } catch (error) {
    const nodeError =
      error as NodeJS.ErrnoException;

    if (
      nodeError.code ===
      "ENOENT"
    ) {
      return false;
    }

    throw error;
  }
}

function validateApiUrl(
  value: string,
): true | string {
  const trimmed =
    value.trim();

  if (
    trimmed ===
    ""
  ) {
    return true;
  }

  let parsed: URL;

  try {
    parsed =
      new URL(
        trimmed,
      );
  } catch {
    return "Enter a valid absolute URL.";
  }

  if (
    parsed.protocol !==
      "http:" &&
    parsed.protocol !==
      "https:"
  ) {
    return "The URL must use http:// or https://.";
  }

  return true;
}

function normalizeApiUrl(
  value: string,
): string {
  const trimmed =
    value.trim();

  const selected =
    trimmed === ""
      ? DEFAULT_API_URL
      : trimmed;

  return selected.replace(
    /\/+$/,
    "",
  );
}

function buildModelsUrl(
  apiUrl: string,
): string {
  const parsed =
    new URL(
      apiUrl,
    );

  const currentPath =
    parsed.pathname.replace(
      /\/+$/,
      "",
    );

  if (
    currentPath.endsWith(
      "/v1",
    )
  ) {
    parsed.pathname =
      `${currentPath}/models`;
  } else {
    parsed.pathname =
      `${currentPath}/v1/models`;
  }

  parsed.search = "";
  parsed.hash = "";

  return parsed.toString();
}

async function testConnection(
  apiUrl: string,
  apiKey: string,
  setupSignal: AbortSignal,
): Promise<string[]> {
  const timeoutSignal =
    AbortSignal.timeout(
      10_000,
    );

  const requestSignal =
    AbortSignal.any([
      setupSignal,
      timeoutSignal,
    ]);

  const response =
    await fetch(
      buildModelsUrl(
        apiUrl,
      ),
      {
        method: "GET",

        headers: {
          Accept:
            "application/json",

          Authorization:
            `Bearer ${apiKey}`,
        },

        signal:
          requestSignal,
      },
    );

  if (
    !response.ok
  ) {
    throw new Error(
      `Model endpoint returned HTTP ${response.status}.`,
    );
  }

  const body: unknown =
    await response.json();

  if (
    !isRecord(body) ||
    !Array.isArray(
      body.data,
    )
  ) {
    throw new Error(
      "Model endpoint returned an invalid response.",
    );
  }

  const models:
    string[] = [];

  for (
    const modelValue of
    body.data
  ) {
    if (
      !isRecord(
        modelValue,
      )
    ) {
      continue;
    }

    if (
      typeof modelValue.id !==
        "string" ||
      modelValue.id.trim() ===
        ""
    ) {
      continue;
    }

    models.push(
      modelValue.id.trim(),
    );
  }

  const uniqueModels =
    [...new Set(models)];

  if (
    uniqueModels.length ===
    0
  ) {
    throw new Error(
      "Model endpoint returned an empty model list.",
    );
  }

  return uniqueModels;
}

function validateNumberSelection(
  value: string,
  maximum: number,
): true | string {
  const trimmed =
    value.trim();

  if (
    trimmed ===
    ""
  ) {
    return true;
  }

  if (
    !/^[0-9]+$/.test(
      trimmed,
    )
  ) {
    return `Enter a number from 1 to ${maximum}.`;
  }

  const selection =
    Number(
      trimmed,
    );

  if (
    selection < 1 ||
    selection > maximum
  ) {
    return `Enter a number from 1 to ${maximum}.`;
  }

  return true;
}

async function promptForEndpoint():
  Promise<string> {
  console.log();
  console.log(
    "Step 1 of 6 — API Endpoint",
  );

  console.log(
    "Where is your AI endpoint? (LiteLLM, Ollama, OpenAI, or any OpenAI-compatible server)",
  );

  const answer =
    await inquirer.prompt<{
      apiUrl: string;
    }>([
      {
        type: "input",
        name: "apiUrl",
        message:
          `Base URL [${DEFAULT_API_URL}]`,
        validate:
          validateApiUrl,
      },
    ]);

  return normalizeApiUrl(
    answer.apiUrl,
  );
}

async function promptForApiKey():
  Promise<string> {
  console.log();
  console.log(
    "Step 2 of 6 — API Key",
  );

  const answer =
    await inquirer.prompt<{
      apiKey: string;
    }>([
      {
        type: "password",
        name: "apiKey",
        message:
          "Enter your API key (input is hidden)",
        mask: "*",

        validate:
          (
            value: string,
          ) => {
            if (
              value.trim() ===
              ""
            ) {
              return "API key cannot be empty.";
            }

            return true;
          },
      },
    ]);

  return answer.apiKey.trim();
}

async function promptForFailureAction():
  Promise<
    "retry" |
    "skip" |
    "exit"
  > {
  console.log(
    "  1. Try a different URL",
  );

  console.log(
    "  2. Skip this check and continue anyway",
  );

  console.log(
    "  3. Exit setup",
  );

  const answer =
    await inquirer.prompt<{
      action: string;
    }>([
      {
        type: "input",
        name: "action",
        message:
          "Select an option",

        validate:
          (
            value: string,
          ) =>
            validateNumberSelection(
              value,
              3,
            ),
      },
    ]);

  const selected =
    answer.action.trim() ===
      ""
      ? 1
      : Number(
          answer.action.trim(),
        );

  switch (
    selected
  ) {
    case 1:
      return "retry";

    case 2:
      return "skip";

    case 3:
      return "exit";

    default:
      throw new Error(
        "Invalid setup action.",
      );
  }
}

async function promptForModel(
  models: string[],
): Promise<string> {
  console.log();
  console.log(
    "Step 4 of 6 — Default Model",
  );

  if (
    models.length ===
    0
  ) {
    const answer =
      await inquirer.prompt<{
        model: string;
      }>([
        {
          type: "input",
          name: "model",
          message:
            "Enter the model name",

          validate:
            (
              value: string,
            ) => {
              if (
                value.trim() ===
                ""
              ) {
                return "Model name cannot be empty.";
              }

              return true;
            },
        },
      ]);

    return answer.model.trim();
  }

  models.forEach(
    (
      model,
      index,
    ) => {
      console.log(
        `  ${index + 1}. ${model}`,
      );
    },
  );

  const answer =
    await inquirer.prompt<{
      selection: string;
    }>([
      {
        type: "input",
        name: "selection",
        message:
          "Select a model [1]",

        validate:
          (
            value: string,
          ) =>
            validateNumberSelection(
              value,
              models.length,
            ),
      },
    ]);

  const selectedIndex =
    answer.selection.trim() ===
      ""
      ? 0
      : Number(
          answer.selection.trim(),
        ) - 1;

  const selectedModel =
    models[
      selectedIndex
    ];

  if (
    !selectedModel
  ) {
    throw new Error(
      "Invalid model selection.",
    );
  }

  return selectedModel;
}

async function promptForPermissionMode():
  Promise<PermissionMode> {
  console.log();
  console.log(
    "Step 5 of 6 — Permission Mode",
  );

  PERMISSION_MODES.forEach(
    (
      mode,
      index,
    ) => {
      console.log(
        `  ${index + 1}. ${mode.value.padEnd(17)} — ${mode.description}`,
      );
    },
  );

  const answer =
    await inquirer.prompt<{
      selection: string;
    }>([
      {
        type: "input",
        name: "selection",
        message:
          "Select a mode [1]",

        validate:
          (
            value: string,
          ) =>
            validateNumberSelection(
              value,
              PERMISSION_MODES.length,
            ),
      },
    ]);

  const selectedIndex =
    answer.selection.trim() ===
      ""
      ? 0
      : Number(
          answer.selection.trim(),
        ) - 1;

  const selectedMode =
    PERMISSION_MODES[
      selectedIndex
    ]?.value;

  if (
    !selectedMode
  ) {
    throw new Error(
      "Invalid permission mode selection.",
    );
  }

  return selectedMode;
}

async function readExistingConfig(
  configPath: string,
): Promise<
  Record<string, unknown>
> {
  const contents =
    await readFile(
      configPath,
      "utf8",
    );

  const parsed: unknown =
    JSON.parse(
      contents,
    );

  if (
    !isRecord(
      parsed,
    )
  ) {
    throw new Error(
      `Existing configuration ${configPath} must contain a JSON object.`,
    );
  }

  return parsed;
}

async function writeFileAtomically(
  filePath: string,
  contents: string,
  mode: number,
): Promise<void> {
  const directory =
    dirname(
      filePath,
    );

  const temporaryPath =
    join(
      directory,
      `.${basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
    );

  try {
    await writeFile(
      temporaryPath,
      contents,
      {
        encoding:
          "utf8",

        mode,
      },
    );

    await chmod(
      temporaryPath,
      mode,
    );

    await rename(
      temporaryPath,
      filePath,
    );

    await chmod(
      filePath,
      mode,
    );
  } catch (error) {
    try {
      await unlink(
        temporaryPath,
      );
    } catch {
      // Preserve the original write error.
    }

    throw error;
  }
}

function isPromptCancellation(
  error: unknown,
): boolean {
  return (
    error instanceof Error &&
    error.name ===
      "ExitPromptError"
  );
}

function printCancellationMessage():
  void {
  console.log();
  console.log(
    "Setup cancelled. Run 'sky setup' to try again.",
  );
}

async function runSetupWizard(
  setupSignal: AbortSignal,
): Promise<void> {
  const setupDirectory =
    join(
      homedir(),
      ".sky-code",
    );

  const configPath =
    join(
      setupDirectory,
      "config.json",
    );

  const environmentPath =
    join(
      setupDirectory,
      ".env",
    );

  const configAlreadyExists =
    await pathExists(
      configPath,
    );

  setupSignal
    .throwIfAborted();

  if (
    configAlreadyExists
  ) {
    const answer =
      await inquirer.prompt<{
        reconfigure: boolean;
      }>([
        {
          type: "confirm",
          name: "reconfigure",
          message:
            "Sky Code is already configured. Reconfigure?",
          default:
            false,
        },
      ]);

    if (
      !answer.reconfigure
    ) {
      return;
    }
  }

  console.log();
  console.log(
    "Welcome to Sky Code Setup",
  );

  console.log(
    "─────────────────────────────────────────────────────",
  );

  console.log(
    "This wizard will configure Sky Code for first use.",
  );

  console.log(
    "Press Ctrl+C at any time to exit. Run 'sky setup' again to resume.",
  );

  let apiUrl =
    DEFAULT_API_URL;

  let apiKey =
    "";

  let models:
    string[] = [];

  while (
    true
  ) {
    apiUrl =
      await promptForEndpoint();

    apiKey =
      await promptForApiKey();

    console.log();
    console.log(
      "Step 3 of 6 — Connection Test",
    );

    console.log(
      `Testing connection to ${apiUrl} ...`,
    );

    try {
      models =
        await testConnection(
          apiUrl,
          apiKey,
          setupSignal,
        );

      console.log(
        `✓ Connected. Found ${models.length} ${models.length === 1 ? "model" : "models"}.`,
      );

      break;
    } catch (error) {
      if (
        setupSignal.aborted
      ) {
        throw error;
      }

      console.log(
        `✗ Could not connect to ${apiUrl}`,
      );

      console.log(
        "  Check that your endpoint is running and the URL is correct.",
      );

      const action =
        await promptForFailureAction();

      if (
        action ===
        "retry"
      ) {
        continue;
      }

      if (
        action ===
        "skip"
      ) {
        models = [];
        break;
      }

      printCancellationMessage();
      return;
    }
  }

  const defaultModel =
    await promptForModel(
      models,
    );

  const defaultPermissionMode =
    await promptForPermissionMode();

  console.log();
  console.log(
    "Step 6 of 6 — Saving Configuration",
  );

  setupSignal
    .throwIfAborted();

  await mkdir(
    setupDirectory,
    {
      recursive:
        true,
    },
  );

  const existingConfig =
    configAlreadyExists
      ? await readExistingConfig(
          configPath,
        )
      : {};

  const storedConfig = {
    ...existingConfig,

    apiUrl,

    defaultModel,

    defaultPermissionMode,
  };

  const configContents =
    `${JSON.stringify(
      storedConfig,
      null,
      2,
    )}\n`;

  const environmentContents = [
    "# Sky Code environment variables",
    "# Generated by sky setup",
    "",
    `LITELLM_API_URL=${apiUrl}`,
    `LITELLM_API_KEY=${apiKey}`,
    "",
  ].join(
    "\n",
  );

  /*
   * Write credentials first and config second.
   * Each target is created through a temporary file
   * and renamed into place atomically.
   */
  await writeFileAtomically(
    environmentPath,
    environmentContents,
    0o600,
  );

  await writeFileAtomically(
    configPath,
    configContents,
    0o644,
  );

  console.log(
    "✓ Wrote ~/.sky-code/config.json",
  );

  console.log(
    "✓ Wrote ~/.sky-code/.env",
  );

  console.log();
  console.log(
    "Setup complete. Run 'sky' to start Sky Code.",
  );
}

export async function runSetup():
  Promise<void> {
  const setupAbortController =
    new AbortController();

  const handleSigint =
    (): void => {
      setupAbortController
        .abort();
    };

  process.on(
    "SIGINT",
    handleSigint,
  );

  try {
    await runSetupWizard(
      setupAbortController.signal,
    );
  } catch (error) {
    if (
      setupAbortController
        .signal
        .aborted ||
      isPromptCancellation(
        error,
      )
    ) {
      printCancellationMessage();
      return;
    }

    throw error;
  } finally {
    process.off(
      "SIGINT",
      handleSigint,
    );
  }
}
