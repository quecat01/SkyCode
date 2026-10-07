/**
 * Deterministic relevant-tool filtering for native tool-calling models.
 *
 * A native model receives its tools as real API tool definitions, and a
 * smaller model in particular chooses more reliably from a short list of
 * plausibly relevant tools than from every tool Sky Code has. This module
 * narrows the canonical ToolDefinition[] (the same definitions every
 * strategy and the executor use; no second schema set is ever built) down
 * to the categories a request plausibly needs.
 *
 * Filtering is deliberately conservative and never model-driven:
 * - Categories are matched by fixed keyword patterns against the user's
 *   goal text only; no extra model call chooses the subset.
 * - When the goal matches no category, or is too short or generic to judge
 *   ("yes", "continue", "do it again"), the full tool set is returned:
 *   when in doubt, never make a valid action impossible.
 * - A tool that belongs to no known category (for example, an individually
 *   exposed MCP tool) is always kept, since nothing here can judge it.
 * - Any tool already requested earlier in this same turn is always kept,
 *   so a turn's offered tools never shrink mid-turn.
 * - Read-only inspection (read_file) is kept alongside any category that
 *   creates or changes files, so a model can choose to check its own work.
 *
 * The result is the same for every step of one turn (it depends only on
 * the goal, which does not change mid-turn, plus tools already used), so
 * the model sees a stable tool list throughout its multi-step sequence.
 */
import type {
  AgentContext,
  ToolDefinition,
} from "./types.js";

/**
 * One named group of built-in tools and the goal-text patterns that make it
 * plausibly relevant.
 */
interface ToolCategory {
  name: string;
  tools: readonly string[];
  patterns: readonly RegExp[];
  /** Whether this category creates or changes files (see module doc). */
  changesFiles: boolean;
}

/**
 * Every built-in tool category. A tool name may appear in more than one
 * category; its inclusion is the union of every matched category.
 */
const TOOL_CATEGORIES: readonly ToolCategory[] = [
  {
    name: "documents",
    tools: [
      "create_docx",
      "create_xlsx",
      "create_pdf",
      "create_pptx",
    ],
    patterns: [
      /\b(docx|xlsx|pptx|pdfs?|xls|ppt)\b/i,
      /\b(word|excel|powerpoint)\b/i,
      /\b(spreadsheets?|workbooks?|presentations?|slides?|slide ?decks?|decks?)\b/i,
      /\b(documents?|reports?|memos?|brochures?|handouts?|invoices?)\b/i,
    ],
    changesFiles: true,
  },
  {
    name: "file_editing",
    tools: [
      "write_file",
      "edit_file",
    ],
    patterns: [
      /\b(write|edit|modify|change|update|fix|refactor|rename|replace|append|implement|patch)\b/i,
      /\b(create|make|add|save)\b[^.?!\n]{0,40}\b(file|files|script|config|readme|module|function|class|test)\b/i,
      /\b(code|bug|function|class|module)\b/i,
    ],
    changesFiles: true,
  },
  {
    name: "file_reading",
    tools: [
      "read_file",
    ],
    patterns: [
      /\b(read|open|show|view|look at|inspect|check|verify|review|summari[sz]e|explain|contents?)\b/i,
      /\b(file|files|readme|log|logs|config)\b/i,
      /[\w-]+\.[a-z0-9]{1,5}\b/i,
      /(^|\s)(~|\.{1,2})?\/[\w.-]/,
    ],
    changesFiles: false,
  },
  {
    name: "shell",
    tools: [
      "run_shell_command",
    ],
    // Common everyday verbs ("make", "build", "run") are only matched in a
    // command-like phrase: on their own they appear in ordinary requests
    // ("make a PDF", "build a presentation") that need no shell at all.
    patterns: [
      /\b(execute|command|commands|shell|terminal|bash|install|compile|npm|npx|pnpm|yarn|git|pip|docker|ls|grep|chmod|sudo)\b/i,
      /\brun\b[^.?!\n]{0,30}\b(tests?|build|script|command|server|app|it)\b/i,
      /\b(build|test|lint)\b[^.?!\n]{0,30}\b(project|repo|repository|code|suite|app|package)\b/i,
      /\btests? (suite|pass|fail|failing|passing)\b/i,
    ],
    changesFiles: false,
  },
  {
    name: "web",
    tools: [
      "web_search",
      "web_fetch",
    ],
    patterns: [
      /\b(search|google|look ?up|web|internet|online|website|webpage|url|link|browse|news|latest|current|today'?s?)\b/i,
      /https?:\/\//i,
    ],
    changesFiles: false,
  },
  {
    name: "mcp",
    tools: [
      "mcp_call",
    ],
    patterns: [
      /\bmcp\b/i,
      /\bservers?\b/i,
    ],
    changesFiles: false,
  },
  {
    name: "delegation",
    tools: [
      "delegate_to_agent",
    ],
    patterns: [
      /\b(delegate|sub-?agents?|agents?|reviewer)\b/i,
    ],
    changesFiles: false,
  },
];

/**
 * Tool kept alongside any matched file-changing category, so the model can
 * inspect what it produced if it chooses to.
 */
const INSPECTION_TOOL = "read_file";

/**
 * Goals shorter than this (in words) are treated as too generic to filter
 * on, since they usually depend on earlier conversation ("yes", "do it").
 */
const MINIMUM_FILTERABLE_WORDS = 4;

/**
 * Openings that make a request depend on earlier conversation ("yes, and
 * the PDF too", "try again with..."), never filtered on regardless of
 * length. Politeness words ("please", "thanks") are deliberately absent:
 * "Please make a PDF..." is a complete request, and a bare "thanks" is
 * already caught by MINIMUM_FILTERABLE_WORDS.
 */
const CONTINUATION_PATTERN =
  /^\s*(yes|yeah|yep|ok|okay|continue|go on|go ahead|proceed|do it|do that|try again|again|retry|same|next)\b/i;

/**
 * Outcome of relevant-tool selection, with the reason kept for
 * diagnostics.
 */
export interface ToolRelevanceSelection {
  tools: ToolDefinition[];
  /** Matched category names; empty when the full set was used. */
  matchedCategories: string[];
  /** Plain-language reason, suitable for a protocol_condition diagnostic. */
  reason: string;
}

/**
 * Narrows the offered tools to those plausibly relevant to this turn's
 * goal, falling back to every tool whenever relevance is uncertain.
 *
 * @param {AgentContext} context - The current turn's context; only `goal`
 * and the tools already requested in `history` are consulted.
 * @param {readonly ToolDefinition[]} tools - Every tool available this turn
 * (the canonical definitions).
 * @returns {ToolRelevanceSelection} The selected tools, in their original
 * order, plus why they were selected.
 *
 * Side effects: none.
 */
export function selectRelevantTools(
  context: AgentContext,
  tools: readonly ToolDefinition[],
): ToolRelevanceSelection {
  const goal =
    context.goal.trim();

  const wordCount =
    goal === ""
      ? 0
      : goal.split(/\s+/).length;

  if (
    wordCount <
      MINIMUM_FILTERABLE_WORDS ||
    CONTINUATION_PATTERN.test(
      goal,
    )
  ) {
    return {
      tools: [...tools],
      matchedCategories: [],
      reason:
        "Relevant-tool filtering skipped: the request is too short or generic to judge, so every tool was offered.",
    };
  }

  const matched =
    TOOL_CATEGORIES.filter(
      (category) =>
        category.patterns.some(
          (pattern) =>
            pattern.test(goal),
        ),
    );

  if (matched.length === 0) {
    return {
      tools: [...tools],
      matchedCategories: [],
      reason:
        "Relevant-tool filtering found no clearly matching tool category, so every tool was offered.",
    };
  }

  const keep =
    new Set<string>();

  for (
    const category of matched
  ) {
    for (
      const name of category.tools
    ) {
      keep.add(name);
    }

    if (category.changesFiles) {
      keep.add(
        INSPECTION_TOOL,
      );
    }
  }

  for (
    const event of context.history
  ) {
    if (
      event.type ===
      "tool_requested"
    ) {
      keep.add(event.tool);
    }
  }

  const categorized =
    new Set(
      TOOL_CATEGORIES.flatMap(
        (category) => category.tools,
      ),
    );

  const selected =
    tools.filter(
      (tool) =>
        keep.has(tool.name) ||
        !categorized.has(tool.name),
    );

  // Never hand a model an empty tool list because of a filtering mismatch
  // (for example, a test or a future build offering only tools outside
  // every matched category).
  if (selected.length === 0) {
    return {
      tools: [...tools],
      matchedCategories: [],
      reason:
        "Relevant-tool filtering would have offered no tools, so every tool was offered instead.",
    };
  }

  const matchedCategories =
    matched.map(
      (category) => category.name,
    );

  return {
    tools: selected,
    matchedCategories,
    reason:
      `Relevant-tool filtering matched ${matchedCategories.join(", ")}; offered ${selected.length} of ${tools.length} tools: ${selected
        .map((tool) => tool.name)
        .join(", ")}.`,
  };
}
