import os from "node:os";
import path from "node:path";

import type { ProjectBuildContextResult } from "@t3tools/contracts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Effect, Layer, Schema } from "effect";

import {
  JCodeMunchProjectContext,
  type JCodeMunchProjectContextShape,
} from "../Services/JCodeMunchProjectContext.ts";

const MAX_QUERY_CHARS = 256;
const MAX_SYMBOL_RESULTS = 6;
const MAX_SYMBOL_SOURCES = 3;
const MAX_TEXT_MATCHES = 4;
const MAX_SOURCE_CHARS = 700;
const MAX_CONTEXT_CHARS = 8_000;

interface JCodeMunchToolTextResult {
  readonly content?: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
}

interface IndexFolderResponse {
  readonly success?: boolean;
  readonly repo?: string;
}

interface RepoOutlineResponse {
  readonly file_count?: number;
  readonly symbol_count?: number;
  readonly display_name?: string;
  readonly source_root?: string;
  readonly directories?: Record<string, number>;
  readonly languages?: Record<string, number>;
}

interface SearchSymbolsResponse {
  readonly results?: ReadonlyArray<{
    readonly id: string;
    readonly kind?: string;
    readonly name?: string;
    readonly file?: string;
    readonly line?: number;
    readonly summary?: string;
  }>;
}

interface GetSymbolsResponse {
  readonly symbols?: ReadonlyArray<{
    readonly id: string;
    readonly kind?: string;
    readonly name?: string;
    readonly file?: string;
    readonly line?: number;
    readonly source?: string;
  }>;
}

interface SearchTextResponse {
  readonly results?: ReadonlyArray<{
    readonly file?: string;
    readonly matches?: ReadonlyArray<{
      readonly line?: number;
      readonly text?: string;
    }>;
  }>;
}

type ContextSource = ProjectBuildContextResult["sources"][number];

class JCodeMunchContextError extends Schema.TaggedErrorClass<JCodeMunchContextError>()(
  "JCodeMunchContextError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

function nonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function expandHomePath(input: string): string {
  if (input === "~") {
    return os.homedir();
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

function normalizeQuery(prompt: string): string {
  return prompt.replace(/\s+/g, " ").trim().slice(0, MAX_QUERY_CHARS);
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function topEntries(
  input: Record<string, number> | null | undefined,
  limit: number,
): ReadonlyArray<string> {
  return Object.entries(input ?? {})
    .toSorted((left, right) => right[1] - left[1])
    .slice(0, limit)
    .map(([label, count]) => `${label} (${count})`);
}

function parseToolJson<T>(result: JCodeMunchToolTextResult): T | null {
  const text = result.content?.find((entry) => entry.type === "text")?.text;
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function formatRepoOutlineSection(outline: RepoOutlineResponse): {
  readonly section: string | null;
  readonly source: ContextSource | null;
} {
  const counts = [
    typeof outline.file_count === "number" ? `${outline.file_count} files` : null,
    typeof outline.symbol_count === "number" ? `${outline.symbol_count} symbols` : null,
  ].filter((entry): entry is string => entry !== null);
  const dirs = topEntries(outline.directories, 3);
  const languages = topEntries(outline.languages, 3);
  const label = [
    nonEmpty(outline.display_name) ?? nonEmpty(outline.source_root),
    counts.length > 0 ? counts.join(", ") : null,
    dirs.length > 0 ? `dirs: ${dirs.join(", ")}` : null,
    languages.length > 0 ? `langs: ${languages.join(", ")}` : null,
  ]
    .filter((entry): entry is string => entry !== null)
    .join(" · ");

  if (!label) {
    return { section: null, source: null };
  }

  return {
    section: `Repo outline:\n- ${label}`,
    source: {
      kind: "repo-outline",
      label,
    },
  };
}

function formatSymbolMatches(
  response: SearchSymbolsResponse,
): { readonly section: string | null; readonly sources: ReadonlyArray<ContextSource> } {
  const results = response.results?.slice(0, MAX_SYMBOL_RESULTS) ?? [];
  if (results.length === 0) {
    return { section: null, sources: [] };
  }

  return {
    section: [
      "Relevant symbols:",
      ...results.map((result) => {
        const location =
          nonEmpty(result.file) && typeof result.line === "number"
            ? `${result.file}:${result.line}`
            : (nonEmpty(result.file) ?? "unknown");
        const detail = nonEmpty(result.summary) ?? (nonEmpty(result.kind) ? `${result.kind}` : "match");
        return `- ${nonEmpty(result.name) ?? "Unnamed"} (${location}) — ${detail}`;
      }),
    ].join("\n"),
    sources: results.flatMap((result) => {
      const label = nonEmpty(result.name);
      const filePath = nonEmpty(result.file);
      if (!label) {
        return [];
      }
      return [
        {
          kind: "symbol" as const,
          label,
          ...(filePath ? { filePath } : {}),
          ...(typeof result.line === "number" ? { line: result.line } : {}),
        },
      ];
    }),
  };
}

function formatSourceExcerpts(response: GetSymbolsResponse): string | null {
  const symbols = response.symbols?.slice(0, MAX_SYMBOL_SOURCES) ?? [];
  if (symbols.length === 0) {
    return null;
  }

  return [
    "Source excerpts:",
    ...symbols.map((symbol) => {
      const heading = `${nonEmpty(symbol.name) ?? "Unnamed"} (${nonEmpty(symbol.file) ?? "unknown"})`;
      const source = truncate(nonEmpty(symbol.source) ?? "", MAX_SOURCE_CHARS);
      return `- ${heading}\n${source}`;
    }),
  ].join("\n");
}

function formatTextMatches(
  response: SearchTextResponse,
): { readonly section: string | null; readonly sources: ReadonlyArray<ContextSource> } {
  const lines: string[] = [];
  const sources: ContextSource[] = [];

  for (const fileResult of response.results?.slice(0, MAX_TEXT_MATCHES) ?? []) {
    const filePath = nonEmpty(fileResult.file);
    for (const match of fileResult.matches?.slice(0, 2) ?? []) {
      const text = nonEmpty(match.text);
      if (!filePath || !text) {
        continue;
      }
      lines.push(`- ${filePath}:${match.line ?? 1} — ${truncate(text, 180)}`);
      sources.push({
        kind: "text-search",
        label: truncate(text, 80),
        filePath,
        ...(typeof match.line === "number" ? { line: match.line } : {}),
      });
      if (lines.length >= MAX_TEXT_MATCHES) {
        break;
      }
    }
    if (lines.length >= MAX_TEXT_MATCHES) {
      break;
    }
  }

  if (lines.length === 0) {
    return { section: null, sources: [] };
  }

  return {
    section: ["Relevant text matches:", ...lines].join("\n"),
    sources,
  };
}

export function buildJCodeMunchContextText(input: {
  readonly outline: RepoOutlineResponse | null;
  readonly symbolMatches: SearchSymbolsResponse | null;
  readonly symbolSources: GetSymbolsResponse | null;
  readonly textMatches: SearchTextResponse | null;
}): {
  readonly contextText: string | null;
  readonly sources: ReadonlyArray<ContextSource>;
} {
  const sections: string[] = [];
  const sources: ContextSource[] = [];

  const outline = input.outline ? formatRepoOutlineSection(input.outline) : null;
  if (outline?.section) {
    sections.push(outline.section);
  }
  if (outline?.source) {
    sources.push(outline.source);
  }

  const symbolMatches = input.symbolMatches ? formatSymbolMatches(input.symbolMatches) : null;
  if (symbolMatches?.section) {
    sections.push(symbolMatches.section);
    sources.push(...symbolMatches.sources);
  }

  const sourceExcerpts = input.symbolSources ? formatSourceExcerpts(input.symbolSources) : null;
  if (sourceExcerpts) {
    sections.push(sourceExcerpts);
  }

  const textMatches = input.textMatches ? formatTextMatches(input.textMatches) : null;
  if (textMatches?.section) {
    sections.push(textMatches.section);
    sources.push(...textMatches.sources);
  }

  if (sections.length === 0) {
    return { contextText: null, sources: [] };
  }

  return {
    contextText: truncate(sections.join("\n\n"), MAX_CONTEXT_CHARS),
    sources: sources.slice(0, 8),
  };
}

const makeJCodeMunchProjectContext = Effect.sync(() => {
  const repoIdByWorkspace = new Map<string, string>();

  const withClient = <T>(
    binaryPath: string,
    cwd: string,
    run: (client: Client, transport: StdioClientTransport) => Promise<T>,
  ) =>
    Effect.tryPromise({
        try: async () => {
        const transport = new StdioClientTransport({
          command: binaryPath,
          cwd,
          stderr: "pipe",
        });
        const client = new Client(
          {
            name: "t3code-jcodemunch",
            version: "0.1.0",
          },
          {
            capabilities: {},
          },
        );
        try {
          await client.connect(transport);
          return await run(client, transport);
        } finally {
          await transport.close().catch(() => undefined);
        }
        },
        catch: (cause) =>
          new JCodeMunchContextError({
            detail: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
      });

  const callToolJson = <T>(
    client: Client,
    name: string,
    args: Record<string, unknown>,
  ): Promise<T | null> =>
    client
      .callTool({
        name,
        arguments: args,
      })
      .then((result) => parseToolJson<T>(result as JCodeMunchToolTextResult));

  const buildContext: JCodeMunchProjectContextShape["buildContext"] = (input) =>
    Effect.gen(function* () {
      if (!input.enabled) {
        return { applied: false, sources: [] } satisfies ProjectBuildContextResult;
      }

      const binaryPath = nonEmpty(input.binaryPath);
      if (!binaryPath) {
        return {
          applied: false,
          message: "JCodeMunch is enabled but no binary path is configured.",
          sources: [],
        } satisfies ProjectBuildContextResult;
      }

      const normalizedPrompt = nonEmpty(input.prompt);
      if (!normalizedPrompt) {
        return { applied: false, sources: [] } satisfies ProjectBuildContextResult;
      }

        const normalizedCwd = path.resolve(expandHomePath(input.cwd));
        const resolvedBinaryPath = expandHomePath(binaryPath);
      const query = normalizeQuery(normalizedPrompt);
      if (!query) {
        return { applied: false, sources: [] } satisfies ProjectBuildContextResult;
      }

      const context = yield* withClient(resolvedBinaryPath, normalizedCwd, async (client) => {
        const indexed = await callToolJson<IndexFolderResponse>(client, "index_folder", {
          path: normalizedCwd,
          incremental: true,
          use_ai_summaries: false,
        });
        const repo =
          nonEmpty(indexed?.repo) ?? repoIdByWorkspace.get(normalizedCwd) ?? null;
        if (!repo || indexed?.success === false) {
          return {
            applied: false,
            message: "JCodeMunch did not return an index for this workspace.",
            sources: [],
          } satisfies ProjectBuildContextResult;
        }
        repoIdByWorkspace.set(normalizedCwd, repo);

        const [outline, symbolMatches, textMatches] = await Promise.all([
          callToolJson<RepoOutlineResponse>(client, "get_repo_outline", { repo }),
          callToolJson<SearchSymbolsResponse>(client, "search_symbols", {
            repo,
            query,
            max_results: MAX_SYMBOL_RESULTS,
          }),
          callToolJson<SearchTextResponse>(client, "search_text", {
            repo,
            query,
            max_results: MAX_TEXT_MATCHES,
            context_lines: 1,
          }),
        ]);

        const symbolIds = (symbolMatches?.results ?? [])
          .slice(0, MAX_SYMBOL_SOURCES)
          .map((result) => result.id)
          .filter((id): id is string => typeof id === "string" && id.length > 0);
        const symbolSources =
          symbolIds.length > 0
            ? await callToolJson<GetSymbolsResponse>(client, "get_symbols", {
                repo,
                symbol_ids: symbolIds,
              })
            : null;

        const built = buildJCodeMunchContextText({
          outline,
          symbolMatches,
          symbolSources,
          textMatches,
        });

        if (!built.contextText) {
          return {
            applied: false,
            message: "JCodeMunch did not find any compact context for this prompt.",
            sources: [],
          } satisfies ProjectBuildContextResult;
        }

        return {
          applied: true,
          contextText: built.contextText,
          sources: built.sources,
        } satisfies ProjectBuildContextResult;
        }).pipe(
          Effect.catch((cause) =>
            Effect.succeed({
              applied: false,
              message: `JCodeMunch context build failed: ${cause.detail}`,
              sources: [],
            } satisfies ProjectBuildContextResult),
          ),
        );

      return context;
    });

  return {
    buildContext,
  } satisfies JCodeMunchProjectContextShape;
});

export const JCodeMunchProjectContextLive = Layer.effect(
  JCodeMunchProjectContext,
  makeJCodeMunchProjectContext,
);
