import { describe, expect, it } from "vitest";

import { buildJCodeMunchContextText } from "./JCodeMunchProjectContext";

describe("buildJCodeMunchContextText", () => {
  it("builds a compact context packet from outline, symbols, and text matches", () => {
    const result = buildJCodeMunchContextText({
      outline: {
        display_name: "t3code",
        file_count: 365,
        symbol_count: 2761,
        directories: {
          "apps/": 327,
          "packages/": 32,
        },
        languages: {
          typescript: 308,
          tsx: 55,
        },
      },
      symbolMatches: {
        results: [
          {
            id: "symbol-1",
            name: "ProviderCommandReactor",
            file: "apps/server/src/orchestration/Layers/ProviderCommandReactor.ts",
            line: 120,
            summary: "Coordinates thread turn starts and provider session lifecycle.",
          },
        ],
      },
      symbolSources: {
        symbols: [
          {
            id: "symbol-1",
            name: "ProviderCommandReactor",
            file: "apps/server/src/orchestration/Layers/ProviderCommandReactor.ts",
            line: 120,
            source: "const processTurnStartRequested = Effect.fnUntraced(function* (...) { ... })",
          },
        ],
      },
      textMatches: {
        results: [
          {
            file: "apps/web/src/components/ChatView.tsx",
            matches: [
              {
                line: 2794,
                text: 'type: "thread.turn.start",',
              },
            ],
          },
        ],
      },
    });

    expect(result.contextText).toContain("Repo outline:");
    expect(result.contextText).toContain("Relevant symbols:");
    expect(result.contextText).toContain("Source excerpts:");
    expect(result.contextText).toContain("Relevant text matches:");
    expect(result.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "repo-outline",
        }),
        expect.objectContaining({
          kind: "symbol",
          label: "ProviderCommandReactor",
        }),
        expect.objectContaining({
          kind: "text-search",
          filePath: "apps/web/src/components/ChatView.tsx",
          line: 2794,
        }),
      ]),
    );
  });

  it("returns no context when nothing relevant is present", () => {
    const result = buildJCodeMunchContextText({
      outline: null,
      symbolMatches: null,
      symbolSources: null,
      textMatches: null,
    });

    expect(result).toEqual({
      contextText: null,
      sources: [],
    });
  });
});
