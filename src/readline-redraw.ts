export interface ReadlinePromptRedrawTarget {
  prompt(
    preserveCursor?:
      boolean,
  ): void;
}

export type ReadlineRedrawMethod =
  | "refresh-symbol"
  | "prompt";

type RefreshLineMethod = (
  this:
    ReadlinePromptRedrawTarget,
) => void;

function findRefreshLineMethod(
  target:
    ReadlinePromptRedrawTarget,
): RefreshLineMethod | null {
  let current:
    object | null =
    target as object;

  while (
    current
  ) {
    for (
      const symbol of
      Object.getOwnPropertySymbols(
        current,
      )
    ) {
      if (
        symbol.description !==
          "_refreshLine"
      ) {
        continue;
      }

      const descriptor =
        Object.getOwnPropertyDescriptor(
          current,
          symbol,
        );

      if (
        typeof descriptor
          ?.value ===
        "function"
      ) {
        return descriptor.value as
          RefreshLineMethod;
      }
    }

    current =
      Object.getPrototypeOf(
        current,
      );
  }

  return null;
}

export function redrawReadlinePrompt(
  target:
    ReadlinePromptRedrawTarget,
): ReadlineRedrawMethod {
  const refreshLine =
    findRefreshLineMethod(
      target,
    );

  if (
    refreshLine
  ) {
    try {
      refreshLine.call(
        target,
      );

      return "refresh-symbol";
    } catch {
      // Fall back to the public API.
    }
  }

  target.prompt(
    true,
  );

  return "prompt";
}


interface RawModeInput {
  isTTY?:
    unknown;

  setRawMode?:
    unknown;
}

export function restoreReadlineRawMode(
  input:
    unknown,
): boolean {
  if (
    typeof input !==
      "object" ||
    input ===
      null
  ) {
    return false;
  }

  const candidate =
    input as
      RawModeInput;

  if (
    candidate.isTTY !==
      true ||
    typeof candidate
      .setRawMode !==
      "function"
  ) {
    return false;
  }

  candidate.setRawMode.call(
    input,
    true,
  );

  return true;
}
