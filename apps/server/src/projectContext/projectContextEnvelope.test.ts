import { describe, expect, it } from "vitest";

import { mergeProjectContextIntoPrompt } from "./projectContextEnvelope";

describe("mergeProjectContextIntoPrompt", () => {
  it("returns the user prompt unchanged when no context is provided", () => {
    expect(mergeProjectContextIntoPrompt("Fix the add-project flow", undefined)).toBe(
      "Fix the add-project flow",
    );
  });

  it("wraps retrieved project context and the user request when both are present", () => {
    const result = mergeProjectContextIntoPrompt(
      "Fix the add-project flow",
      "Repo outline:\n- apps/ (327)",
    );

    expect(result).toContain("<workspace_context>");
    expect(result).toContain("Repo outline:");
    expect(result).toContain("<user_request>");
    expect(result).toContain("Fix the add-project flow");
  });
});
