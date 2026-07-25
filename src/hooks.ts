import {
  realpath,
} from "node:fs/promises";

import {
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";

import {
  pathToFileURL,
} from "node:url";

import type {
  LoadedPlugin,
} from "./plugins.js";

import {
  executeSkyToolRequest,
  type SkyToolRequest,
  type ToolExecutionResult,
  type ToolHandlers,
} from "./tools.js";

export const HOOK_NAMES = [
  "PreToolUse",
  "PostToolUse",
  "PreCompact",
  "PostCompact",
  "Notification",
] as const;

export type HookName =
  (typeof HOOK_NAMES)[number];

export type HookMetadata =
  Record<string, unknown>;

export interface PreToolUseHookEvent {
  request: SkyToolRequest;
  cancelled: boolean;
  cancellationReason?: string;
  metadata: HookMetadata;
}

export interface PostToolUseHookEvent {
  request: SkyToolRequest;
  result: ToolExecutionResult;
  metadata: HookMetadata;
}

export interface PreCompactHookEvent {
  messageCount: number;
  reason: string;
  estimatedTokens?: number;
  metadata: HookMetadata;
}

export interface PostCompactHookEvent {
  beforeMessageCount: number;
  afterMessageCount: number;
  summary?: string;
  metadata: HookMetadata;
}

export type NotificationLevel =
  | "info"
  | "warning"
  | "error";

export interface NotificationHookEvent {
  level: NotificationLevel;
  message: string;
  metadata: HookMetadata;
}

export interface HookEventMap {
  PreToolUse:
    PreToolUseHookEvent;

  PostToolUse:
    PostToolUseHookEvent;

  PreCompact:
    PreCompactHookEvent;

  PostCompact:
    PostCompactHookEvent;

  Notification:
    NotificationHookEvent;
}

export type HookHandler<
  Name extends HookName,
> = (
  event: HookEventMap[Name],
) => void | Promise<void>;

export interface HookRegistrationOptions {
  source?: string;
}

export interface RegisteredHook {
  name: HookName;
  source: string;
}

export interface ResolvedPluginHook {
  name: HookName;
  moduleSpecifier: string;
  modulePath: string;
  exportName: string;
  pluginName: string;
  pluginDirectory: string;
  source: string;
}

interface StoredHookRegistration<
  Name extends HookName =
    HookName,
> {
  name: Name;
  source: string;
  handler: HookHandler<Name>;
}

export function isHookName(
  value: unknown,
): value is HookName {
  return (
    typeof value ===
      "string" &&
    HOOK_NAMES.includes(
      value as HookName,
    )
  );
}

export class HookRegistry {
  private readonly registrations:
    StoredHookRegistration[] = [];

  public register<
    Name extends HookName,
  >(
    name: Name,
    handler: HookHandler<Name>,
    options:
      HookRegistrationOptions = {},
  ): () => void {
    const source =
      options.source?.trim() ||
      "anonymous";

    const registration:
      StoredHookRegistration<Name> = {
        name,
        source,
        handler,
      };

    this.registrations.push(
      registration as
        unknown as
        StoredHookRegistration,
    );

    let active = true;

    return () => {
      if (!active) {
        return;
      }

      active = false;

      const index =
        this.registrations
          .indexOf(
            registration as
              unknown as
              StoredHookRegistration,
          );

      if (index >= 0) {
        this.registrations.splice(
          index,
          1,
        );
      }
    };
  }

  public async run<
    Name extends HookName,
  >(
    name: Name,
    event: HookEventMap[Name],
  ): Promise<void> {
    const matchingRegistrations =
      this.registrations.filter(
        (
          registration,
        ) =>
          registration.name ===
          name,
      );

    for (
      const registration of
      matchingRegistrations
    ) {
      try {
        const handler =
          registration.handler as
            HookHandler<Name>;

        await handler(event);
      } catch (error) {
        throw new Error(
          `Hook ${name} from ${registration.source} failed: ${
            error instanceof Error
              ? error.message
              : String(error)
          }`,
        );
      }
    }
  }

  public count(
    name?: HookName,
  ): number {
    if (name === undefined) {
      return this.registrations
        .length;
    }

    return this.registrations.filter(
      (
        registration,
      ) =>
        registration.name ===
        name,
    ).length;
  }

  public list():
    RegisteredHook[] {
    return this.registrations.map(
      (
        registration,
      ) => ({
        name:
          registration.name,
        source:
          registration.source,
      }),
    );
  }

  public clear():
    void {
    this.registrations.splice(
      0,
      this.registrations.length,
    );
  }
}


export async function executeSkyToolRequestWithHooks(
  request: SkyToolRequest,
  handlers: ToolHandlers,
  registry: HookRegistry,
): Promise<ToolExecutionResult> {
  const metadata:
    HookMetadata = {};

  const preToolEvent:
    PreToolUseHookEvent = {
      request,
      cancelled:
        false,
      metadata,
    };

  await registry.run(
    "PreToolUse",
    preToolEvent,
  );

  if (
    preToolEvent.cancelled
  ) {
    const cancellationReason =
      preToolEvent
        .cancellationReason
        ?.trim();

    return {
      success:
        false,
      output:
        cancellationReason
          ? `Tool ${request.tool} cancelled by PreToolUse hook: ${cancellationReason}`
          : `Tool ${request.tool} cancelled by PreToolUse hook.`,
    };
  }

  const result =
    await executeSkyToolRequest(
      request,
      handlers,
    );

  const postToolEvent:
    PostToolUseHookEvent = {
      request,
      result,
      metadata,
    };

  await registry.run(
    "PostToolUse",
    postToolEvent,
  );

  return postToolEvent.result;
}


function isPluginHookRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value ===
      "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function requirePluginHookText(
  value: unknown,
  fieldName: string,
  manifestPath: string,
): string {
  if (
    typeof value !==
      "string" ||
    value.trim() ===
      ""
  ) {
    throw new Error(
      `Plugin manifest ${manifestPath}: ${fieldName} must be a non-empty string`,
    );
  }

  return value.trim();
}

async function resolvePluginHook(
  plugin: LoadedPlugin,
  entry: unknown,
  index: number,
): Promise<ResolvedPluginHook> {
  const fieldName =
    `hooks[${index}]`;

  if (
    !isPluginHookRecord(
      entry,
    )
  ) {
    throw new Error(
      `Plugin manifest ${plugin.manifestPath}: ${fieldName} must be a JSON object`,
    );
  }

  const hookNameValue =
    requirePluginHookText(
      entry.name,
      `${fieldName}.name`,
      plugin.manifestPath,
    );

  if (
    !isHookName(
      hookNameValue,
    )
  ) {
    throw new Error(
      `Plugin manifest ${plugin.manifestPath}: ${fieldName}.name must be one of ${HOOK_NAMES.join(", ")}`,
    );
  }

  const moduleSpecifier =
    requirePluginHookText(
      entry.module,
      `${fieldName}.module`,
      plugin.manifestPath,
    );

  if (
    isAbsolute(
      moduleSpecifier,
    )
  ) {
    throw new Error(
      `Plugin manifest ${plugin.manifestPath}: ${fieldName}.module must be a relative path inside the plugin directory`,
    );
  }

  const exportName =
    entry.export ===
      undefined
      ? "default"
      : requirePluginHookText(
          entry.export,
          `${fieldName}.export`,
          plugin.manifestPath,
        );

  let pluginDirectory:
    string;

  try {
    pluginDirectory =
      await realpath(
        plugin.directory,
      );
  } catch (error) {
    throw new Error(
      `Unable to resolve plugin directory ${plugin.directory}: ${
        error instanceof Error
          ? error.message
          : String(error)
      }`,
    );
  }

  const requestedModulePath =
    resolve(
      pluginDirectory,
      moduleSpecifier,
    );

  let modulePath:
    string;

  try {
    modulePath =
      await realpath(
        requestedModulePath,
      );
  } catch (error) {
    throw new Error(
      `Plugin manifest ${plugin.manifestPath}: unable to resolve hook module ${moduleSpecifier}: ${
        error instanceof Error
          ? error.message
          : String(error)
      }`,
    );
  }

  const relativeModulePath =
    relative(
      pluginDirectory,
      modulePath,
    );

  if (
    relativeModulePath ===
      ".." ||
    relativeModulePath.startsWith(
      `..${sep}`,
    ) ||
    isAbsolute(
      relativeModulePath,
    )
  ) {
    throw new Error(
      `Plugin manifest ${plugin.manifestPath}: ${fieldName}.module resolves outside the plugin directory`,
    );
  }

  return {
    name:
      hookNameValue,
    moduleSpecifier,
    modulePath,
    exportName,
    pluginName:
      plugin.name,
    pluginDirectory,
    source:
      `plugin "${plugin.name}" hook ${hookNameValue} (${moduleSpecifier}#${exportName})`,
  };
}

export async function registerPluginHooks(
  plugins:
    readonly LoadedPlugin[],
  registry:
    HookRegistry,
): Promise<ResolvedPluginHook[]> {
  const resolvedHooks:
    ResolvedPluginHook[] = [];

  const unregisterCallbacks:
    Array<() => void> = [];

  try {
    for (
      const plugin of plugins
    ) {
      for (
        let index = 0;
        index <
        plugin.hooks.length;
        index += 1
      ) {
        const resolvedHook =
          await resolvePluginHook(
            plugin,
            plugin.hooks[index],
            index,
          );

        let moduleNamespace:
          Record<string, unknown>;

        try {
          moduleNamespace =
            await import(
              pathToFileURL(
                resolvedHook
                  .modulePath,
              ).href
            ) as
              Record<string, unknown>;
        } catch (error) {
          throw new Error(
            `Unable to import ${resolvedHook.source}: ${
              error instanceof Error
                ? error.message
                : String(error)
            }`,
          );
        }

        const exportedHandler =
          moduleNamespace[
            resolvedHook
              .exportName
          ];

        if (
          typeof exportedHandler !==
            "function"
        ) {
          throw new Error(
            `${resolvedHook.source} must export a function`,
          );
        }

        const unregister =
          registry.register(
            resolvedHook.name,
            exportedHandler as
              unknown as
              HookHandler<
                typeof resolvedHook.name
              >,
            {
              source:
                resolvedHook.source,
            },
          );

        unregisterCallbacks.push(
          unregister,
        );

        resolvedHooks.push(
          resolvedHook,
        );
      }
    }
  } catch (error) {
    for (
      const unregister of
      unregisterCallbacks
        .reverse()
    ) {
      unregister();
    }

    throw error;
  }

  return resolvedHooks;
}
