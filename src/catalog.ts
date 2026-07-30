import {
  mkdir,
  readFile,
  readdir,
} from "node:fs/promises";

import {
  homedir,
} from "node:os";

import {
  extname,
  join,
} from "node:path";

export type CatalogItemType =
  | "command"
  | "skill";

export type CatalogItemSource =
  | "catalog"
  | "plugin";

export interface CatalogItemBase {
  type:
    CatalogItemType;

  name:
    string;

  description:
    string;

  source:
    CatalogItemSource;

  filePath:
    string;
}

export interface CatalogPromptCommand
  extends CatalogItemBase {
  type:
    "command";

  prompt:
    string;

  shell?:
    never;
}

export interface CatalogShellCommand
  extends CatalogItemBase {
  type:
    "command";

  shell:
    string;

  prompt?:
    never;
}

export type CatalogCommand =
  | CatalogPromptCommand
  | CatalogShellCommand;

export interface CatalogSkill
  extends CatalogItemBase {
  type:
    "skill";

  systemPromptAddition:
    string;
}

export type CatalogItem =
  | CatalogCommand
  | CatalogSkill;

export interface CatalogSnapshot {
  directory:
    string;

  commands:
    CatalogCommand[];

  skills:
    CatalogSkill[];

  items:
    CatalogItem[];
}

export interface LoadCatalogOptions {
  homeDirectory?:
    string;

  catalogDirectory?:
    string;
}

export const RESERVED_CATALOG_COMMANDS =
  new Set<string>([
    "/model",
    "/permissions",
    "/compact",
    "/tasks",
    "/catalog",
    "/history",
  ]);

function isRecord(
  value:
    unknown,
): value is Record<
  string,
  unknown
> {
  return (
    typeof value ===
      "object" &&
    value !==
      null &&
    !Array.isArray(
      value,
    )
  );
}

function requireNonEmptyString(
  value:
    unknown,

  fieldName:
    string,

  filePath:
    string,
): string {
  if (
    typeof value !==
      "string" ||
    value.trim() ===
      ""
  ) {
    throw new Error(
      `Catalog file ${filePath}: ${fieldName} must be a non-empty string`,
    );
  }

  return value.trim();
}

function validateCommandName(
  value:
    unknown,

  filePath:
    string,
): string {
  const name =
    requireNonEmptyString(
      value,
      "name",
      filePath,
    );

  if (
    !/^\/[a-z0-9][a-z0-9_-]*$/.test(
      name,
    )
  ) {
    throw new Error(
      `Catalog file ${filePath}: command name must begin with "/" and use only lowercase letters, numbers, hyphens, and underscores`,
    );
  }

  if (
    RESERVED_CATALOG_COMMANDS.has(
      name,
    )
  ) {
    throw new Error(
      `Catalog file ${filePath}: command "${name}" conflicts with a built-in Sky Code command`,
    );
  }

  return name;
}

function validateSkillName(
  value:
    unknown,

  filePath:
    string,
): string {
  const name =
    requireNonEmptyString(
      value,
      "name",
      filePath,
    );

  if (
    !/^[a-z0-9][a-z0-9_-]*$/.test(
      name,
    )
  ) {
    throw new Error(
      `Catalog file ${filePath}: skill name must use only lowercase letters, numbers, hyphens, and underscores`,
    );
  }

  return name;
}

function parseCommand(
  value:
    Record<
      string,
      unknown
    >,

  filePath:
    string,

  source:
    CatalogItemSource,
): CatalogCommand {
  const name =
    validateCommandName(
      value.name,
      filePath,
    );

  const description =
    requireNonEmptyString(
      value.description,
      "description",
      filePath,
    );

  const prompt =
    value.prompt ===
      undefined
      ? undefined
      : requireNonEmptyString(
          value.prompt,
          "prompt",
          filePath,
        );

  const shell =
    value.shell ===
      undefined
      ? undefined
      : requireNonEmptyString(
          value.shell,
          "shell",
          filePath,
        );

  if (
    prompt !==
      undefined &&
    shell !==
      undefined
  ) {
    throw new Error(
      `Catalog file ${filePath}: command "${name}" must define either "prompt" or "shell", not both`,
    );
  }

  if (
    prompt ===
      undefined &&
    shell ===
      undefined
  ) {
    throw new Error(
      `Catalog file ${filePath}: command "${name}" must define either "prompt" or "shell"`,
    );
  }

  if (
    prompt !==
      undefined
  ) {
    return {
      type:
        "command",

      name,

      description,

      prompt,

      source,

      filePath,
    };
  }

  return {
    type:
      "command",

    name,

    description,

    shell:
      shell as string,

    source,

    filePath,
  };
}

function parseSkill(
  value:
    Record<
      string,
      unknown
    >,

  filePath:
    string,

  source:
    CatalogItemSource,
): CatalogSkill {
  return {
    type:
      "skill",

    name:
      validateSkillName(
        value.name,
        filePath,
      ),

    description:
      requireNonEmptyString(
        value.description,
        "description",
        filePath,
      ),

    systemPromptAddition:
      requireNonEmptyString(
        value
          .systemPromptAddition,
        "systemPromptAddition",
        filePath,
      ),

    source,

    filePath,
  };
}

export function parseCatalogItem(
  value:
    unknown,

  filePath:
    string,

  source:
    CatalogItemSource =
      "catalog",
): CatalogItem {
  if (
    !isRecord(
      value,
    )
  ) {
    throw new Error(
      `Catalog file ${filePath} must contain a JSON object`,
    );
  }

  const type =
    requireNonEmptyString(
      value.type,
      "type",
      filePath,
    );

  switch (
    type
  ) {
    case "command":
      return parseCommand(
        value,
        filePath,
        source,
      );

    case "skill":
      return parseSkill(
        value,
        filePath,
        source,
      );

    default:
      throw new Error(
        `Catalog file ${filePath}: type must be either "command" or "skill"`,
      );
  }
}

export function getCatalogDirectory(
  homeDirectory:
    string =
      homedir(),
): string {
  return join(
    homeDirectory,
    ".sky-code",
    "catalog",
  );
}

async function loadCatalogFile(
  filePath:
    string,
): Promise<CatalogItem> {
  let contents:
    string;

  try {
    contents =
      await readFile(
        filePath,
        "utf8",
      );
  } catch (error) {
    throw new Error(
      `Unable to read catalog file ${filePath}: ${
        error instanceof
          Error
          ? error.message
          : String(
              error,
            )
      }`,
    );
  }

  let parsed:
    unknown;

  try {
    parsed =
      JSON.parse(
        contents,
      );
  } catch (error) {
    throw new Error(
      `Unable to parse catalog file ${filePath}: ${
        error instanceof
          Error
          ? error.message
          : String(
              error,
            )
      }`,
    );
  }

  return parseCatalogItem(
    parsed,
    filePath,
  );
}

function rejectDuplicateItems(
  commands:
    readonly CatalogCommand[],

  skills:
    readonly CatalogSkill[],
): void {
  const commandOrigins =
    new Map<
      string,
      string
    >();

  for (
    const command of
    commands
  ) {
    const existingOrigin =
      commandOrigins.get(
        command.name,
      );

    if (
      existingOrigin !==
        undefined
    ) {
      throw new Error(
        `Duplicate catalog command "${command.name}" in ${existingOrigin} and ${command.filePath}`,
      );
    }

    commandOrigins.set(
      command.name,
      command.filePath,
    );
  }

  const skillOrigins =
    new Map<
      string,
      string
    >();

  for (
    const skill of
    skills
  ) {
    const existingOrigin =
      skillOrigins.get(
        skill.name,
      );

    if (
      existingOrigin !==
        undefined
    ) {
      throw new Error(
        `Duplicate catalog skill "${skill.name}" in ${existingOrigin} and ${skill.filePath}`,
      );
    }

    skillOrigins.set(
      skill.name,
      skill.filePath,
    );
  }
}

export async function loadCatalog(
  options:
    LoadCatalogOptions = {},
): Promise<CatalogSnapshot> {
  const directory =
    options.catalogDirectory ??
    getCatalogDirectory(
      options.homeDirectory,
    );

  await mkdir(
    directory,
    {
      recursive:
        true,

      mode:
        0o700,
    },
  );

  const entries =
    await readdir(
      directory,
      {
        withFileTypes:
          true,
      },
    );

  const fileNames =
    entries
      .filter(
        (
          entry,
        ) =>
          entry.isFile() &&
          extname(
            entry.name,
          ).toLowerCase() ===
            ".json",
      )
      .map(
        (
          entry,
        ) =>
          entry.name,
      )
      .sort(
        (
          left,
          right,
        ) =>
          left.localeCompare(
            right,
          ),
      );

  const items:
    CatalogItem[] = [];

  for (
    const fileName of
    fileNames
  ) {
    items.push(
      await loadCatalogFile(
        join(
          directory,
          fileName,
        ),
      ),
    );
  }

  const commands =
    items
      .filter(
        (
          item,
        ): item is CatalogCommand =>
          item.type ===
            "command",
      )
      .sort(
        (
          left,
          right,
        ) =>
          left.name.localeCompare(
            right.name,
          ),
      );

  const skills =
    items
      .filter(
        (
          item,
        ): item is CatalogSkill =>
          item.type ===
            "skill",
      )
      .sort(
        (
          left,
          right,
        ) =>
          left.name.localeCompare(
            right.name,
          ),
      );

  rejectDuplicateItems(
    commands,
    skills,
  );

  return {
    directory,

    commands,

    skills,

    items: [
      ...commands,
      ...skills,
    ],
  };
}
