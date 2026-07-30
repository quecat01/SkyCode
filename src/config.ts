import { config as loadDotEnv } from "dotenv";

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const PERMISSION_MODES = [
  "default",
  "auto-accept-edits",
  "plan",
  "bypass",
] as const;

export type PermissionMode =
  (typeof PERMISSION_MODES)[number];

export const COMPACTION_STRATEGIES = [
  "summarise",
  "sliding-window",
] as const;

export type CompactionStrategy =
  (typeof COMPACTION_STRATEGIES)[number];

export type McpTransport =
  | "stdio"
  | "sse"
  | "http";

export interface StdioMcpServerConfig {
  name: string;
  transport: "stdio";
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface SseMcpServerConfig {
  name: string;
  transport: "sse";
  url: string;
  headers?: Record<string, string>;
}

export interface HttpMcpServerConfig {
  name: string;
  transport: "http";
  url: string;
  headers?: Record<string, string>;
}

export type McpServerConfig =
  | StdioMcpServerConfig
  | SseMcpServerConfig
  | HttpMcpServerConfig;

export interface StoredConfig {
  apiUrl?: string;
  defaultModel?: string;
  defaultPermissionMode?: PermissionMode;
  compactionThreshold?: unknown;
  compactionStrategy?: unknown;
  compactionWindowSize?: unknown;
  mcpServers?: unknown;
  pluginDirs?: unknown;
}

export interface AppConfig {
  apiUrl: string;
  apiKey: string;
  defaultModel: string;
  defaultPermissionMode: PermissionMode;
  compactionThreshold: number;
  compactionStrategy: CompactionStrategy;
  compactionWindowSize: number;
  mcpServers: McpServerConfig[];
  pluginDirs: string[];
}

const environmentPath =
  fileURLToPath(
    new URL(
      "../.env",
      import.meta.url,
    ),
  );

loadDotEnv({
  path: environmentPath,
  quiet: true,
});

const defaultsPath =
  fileURLToPath(
    new URL(
      "../config/defaults.json",
      import.meta.url,
    ),
  );

function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

async function readConfigFile(
  path: string,
): Promise<StoredConfig> {
  try {
    const contents =
      await readFile(
        path,
        "utf8",
      );

    const parsed: unknown =
      JSON.parse(contents);

    if (!isRecord(parsed)) {
      throw new Error(
        "configuration must contain a JSON object",
      );
    }

    return parsed;
  } catch (error) {
    const nodeError =
      error as NodeJS.ErrnoException;

    if (
      nodeError.code ===
      "ENOENT"
    ) {
      return {};
    }

    throw new Error(
      `Unable to load configuration file ${path}: ${
        error instanceof Error
          ? error.message
          : String(error)
      }`,
    );
  }
}

function requireNonEmptyString(
  value: unknown,
  name: string,
): string {
  if (
    typeof value !== "string" ||
    value.trim() === ""
  ) {
    throw new Error(
      `${name} must be a non-empty string`,
    );
  }

  return value.trim();
}

function validateOptionalString(
  value: unknown,
  name: string,
): string | undefined {
  if (
    value === undefined
  ) {
    return undefined;
  }

  return requireNonEmptyString(
    value,
    name,
  );
}

function validateStringArray(
  value: unknown,
  name: string,
): string[] {
  if (
    value === undefined
  ) {
    return [];
  }

  if (
    !Array.isArray(value)
  ) {
    throw new Error(
      `${name} must be an array of strings`,
    );
  }

  return value.map(
    (
      item: unknown,
      index: number,
    ): string => {
      if (
        typeof item !==
        "string"
      ) {
        throw new Error(
          `${name}[${index}] must be a string`,
        );
      }

      return item;
    },
  );
}

function validateNonEmptyStringArray(
  value: unknown,
  name: string,
): string[] {
  if (
    value === undefined
  ) {
    return [];
  }

  if (
    !Array.isArray(value)
  ) {
    throw new Error(
      `${name} must be an array of non-empty strings`,
    );
  }

  return value.map(
    (
      item: unknown,
      index: number,
    ): string => {
      if (
        typeof item !==
          "string" ||
        item.trim() === ""
      ) {
        throw new Error(
          `${name}[${index}] must be a non-empty string`,
        );
      }

      return item.trim();
    },
  );
}

function validateStringRecord(
  value: unknown,
  name: string,
): Record<string, string> | undefined {
  if (
    value === undefined
  ) {
    return undefined;
  }

  if (!isRecord(value)) {
    throw new Error(
      `${name} must be an object containing string values`,
    );
  }

  const validatedEntries =
    Object.entries(value).map(
      (
        [
          key,
          entryValue,
        ],
      ) => {
        if (
          key.trim() === ""
        ) {
          throw new Error(
            `${name} contains an empty key`,
          );
        }

        if (
          typeof entryValue !==
          "string"
        ) {
          throw new Error(
            `${name}.${key} must be a string`,
          );
        }

        return [
          key,
          entryValue,
        ] as const;
      },
    );

  return Object.fromEntries(
    validatedEntries,
  );
}

function validateHttpUrl(
  value: unknown,
  name: string,
  transportLabel: string,
): string {
  const urlText =
    requireNonEmptyString(
      value,
      name,
    );

  let parsedUrl: URL;

  try {
    parsedUrl =
      new URL(urlText);
  } catch {
    throw new Error(
      `${name} must be a valid absolute URL`,
    );
  }

  if (
    parsedUrl.protocol ===
      "ws:" ||
    parsedUrl.protocol ===
      "wss:"
  ) {
    throw new Error(
      `${name} does not support WebSocket URLs. Use an http:// or https:// ${transportLabel} endpoint.`,
    );
  }

  if (
    parsedUrl.protocol !==
      "http:" &&
    parsedUrl.protocol !==
      "https:"
  ) {
    throw new Error(
      `${name} must use http:// or https://`,
    );
  }

  return urlText;
}

function validateStdioServer(
  serverValue:
    Record<string, unknown>,
  fieldName: string,
  name: string,
): StdioMcpServerConfig {
  const command =
    requireNonEmptyString(
      serverValue.command,
      `${fieldName}.command`,
    );

  const args =
    validateStringArray(
      serverValue.args,
      `${fieldName}.args`,
    );

  const cwd =
    validateOptionalString(
      serverValue.cwd,
      `${fieldName}.cwd`,
    );

  const env =
    validateStringRecord(
      serverValue.env,
      `${fieldName}.env`,
    );

  return {
    name,
    transport: "stdio",
    command,
    args,
    ...(cwd === undefined
      ? {}
      : {
          cwd,
        }),
    ...(env === undefined
      ? {}
      : {
          env,
        }),
  };
}

function validateSseServer(
  serverValue:
    Record<string, unknown>,
  fieldName: string,
  name: string,
): SseMcpServerConfig {
  const url =
    validateHttpUrl(
      serverValue.url,
      `${fieldName}.url`,
      "SSE",
    );

  const headers =
    validateStringRecord(
      serverValue.headers,
      `${fieldName}.headers`,
    );

  return {
    name,
    transport: "sse",
    url,
    ...(headers === undefined
      ? {}
      : {
          headers,
        }),
  };
}

function validateHttpServer(
  serverValue:
    Record<string, unknown>,
  fieldName: string,
  name: string,
): HttpMcpServerConfig {
  const url =
    validateHttpUrl(
      serverValue.url,
      `${fieldName}.url`,
      "Streamable HTTP",
    );

  const headers =
    validateStringRecord(
      serverValue.headers,
      `${fieldName}.headers`,
    );

  return {
    name,
    transport: "http",
    url,
    ...(headers === undefined
      ? {}
      : {
          headers,
        }),
  };
}

export function validateMcpServerConfigs(
  value: unknown,
): McpServerConfig[] {
  if (
    value === undefined
  ) {
    return [];
  }

  if (
    !Array.isArray(value)
  ) {
    throw new Error(
      "mcpServers must be an array",
    );
  }

  const serverNames =
    new Set<string>();

  return value.map(
    (
      serverValue: unknown,
      index: number,
    ): McpServerConfig => {
      const fieldName =
        `mcpServers[${index}]`;

      if (
        !isRecord(serverValue)
      ) {
        throw new Error(
          `${fieldName} must be a JSON object`,
        );
      }

      const name =
        requireNonEmptyString(
          serverValue.name,
          `${fieldName}.name`,
        );

      if (
        serverNames.has(name)
      ) {
        throw new Error(
          `mcpServers contains duplicate server name "${name}"`,
        );
      }

      serverNames.add(name);

      switch (
        serverValue.transport
      ) {
        case "stdio":
          return validateStdioServer(
            serverValue,
            fieldName,
            name,
          );

        case "sse":
          return validateSseServer(
            serverValue,
            fieldName,
            name,
          );

        case "http":
          return validateHttpServer(
            serverValue,
            fieldName,
            name,
          );

        default:
          throw new Error(
            `${fieldName}.transport must be "stdio", "sse", or "http" during MCP Sub-Step 2.3`,
          );
      }
    },
  );
}

export function isPermissionMode(
  value: unknown,
): value is PermissionMode {
  return (
    typeof value ===
      "string" &&
    PERMISSION_MODES.includes(
      value as PermissionMode,
    )
  );
}

export function validatePermissionMode(
  value: unknown,
): PermissionMode {
  if (
    !isPermissionMode(
      value,
    )
  ) {
    throw new Error(
      'defaultPermissionMode must be one of "default", "auto-accept-edits", "plan", or "bypass"',
    );
  }

  return value;
}

function validatePositiveWholeNumber(
  value: unknown,
  name: string,
): number {
  if (
    typeof value !==
      "number" ||
    !Number.isSafeInteger(
      value,
    ) ||
    value < 1
  ) {
    throw new Error(
      `${name} must be a positive whole number`,
    );
  }

  return value;
}

export function isCompactionStrategy(
  value: unknown,
): value is CompactionStrategy {
  return (
    typeof value ===
      "string" &&
    COMPACTION_STRATEGIES.includes(
      value as
        CompactionStrategy,
    )
  );
}

export function validateCompactionStrategy(
  value: unknown,
): CompactionStrategy {
  if (
    !isCompactionStrategy(
      value,
    )
  ) {
    throw new Error(
      'compactionStrategy must be either "summarise" or "sliding-window"',
    );
  }

  return value;
}

export async function loadConfig(
  projectDirectory: string =
    process.cwd(),
): Promise<AppConfig> {
  const defaults =
    await readConfigFile(
      defaultsPath,
    );

  const globalConfigPath =
    join(
      homedir(),
      ".sky-code",
      "config.json",
    );

  const projectConfigPath =
    join(
      projectDirectory,
      ".sky-code",
      "config.json",
    );

  const globalConfig =
    await readConfigFile(
      globalConfigPath,
    );

  const projectConfig =
    await readConfigFile(
      projectConfigPath,
    );

  const mergedConfig:
    StoredConfig = {
      ...defaults,
      ...globalConfig,
      ...projectConfig,
    };

  const apiUrl =
    process.env
      .LITELLM_API_URL ??
    mergedConfig.apiUrl;

  const apiKey =
    process.env
      .LITELLM_API_KEY;

  const defaultModel =
    mergedConfig
      .defaultModel;

  const defaultPermissionMode =
    mergedConfig
      .defaultPermissionMode;

  return {
    apiUrl:
      requireNonEmptyString(
        apiUrl,
        "LITELLM_API_URL or apiUrl",
      ),
    apiKey:
      requireNonEmptyString(
        apiKey,
        "LITELLM_API_KEY",
      ),
    defaultModel:
      requireNonEmptyString(
        defaultModel,
        "defaultModel",
      ),
    defaultPermissionMode:
      validatePermissionMode(
        defaultPermissionMode,
      ),
    compactionThreshold:
      validatePositiveWholeNumber(
        mergedConfig
          .compactionThreshold,
        "compactionThreshold",
      ),
    compactionStrategy:
      validateCompactionStrategy(
        mergedConfig
          .compactionStrategy,
      ),
    compactionWindowSize:
      validatePositiveWholeNumber(
        mergedConfig
          .compactionWindowSize,
        "compactionWindowSize",
      ),
    mcpServers:
      validateMcpServerConfigs(
        mergedConfig
          .mcpServers,
      ),
    pluginDirs:
      validateNonEmptyStringArray(
        mergedConfig
          .pluginDirs,
        "pluginDirs",
      ),
  };
}
