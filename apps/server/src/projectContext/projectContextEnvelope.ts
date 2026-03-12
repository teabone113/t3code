const PROJECT_CONTEXT_PREAMBLE =
  "Use the retrieved workspace context below only if it is relevant. If it is insufficient, say so instead of guessing.";

export function mergeProjectContextIntoPrompt(
  prompt: string | undefined,
  projectContext: string | undefined,
): string | undefined {
  const normalizedPrompt = prompt?.trim();
  const normalizedContext = projectContext?.trim();

  if (!normalizedContext) {
    return normalizedPrompt && normalizedPrompt.length > 0 ? normalizedPrompt : undefined;
  }

  if (!normalizedPrompt || normalizedPrompt.length === 0) {
    return `${PROJECT_CONTEXT_PREAMBLE}\n\n<workspace_context>\n${normalizedContext}\n</workspace_context>`;
  }

  return [
    PROJECT_CONTEXT_PREAMBLE,
    "",
    "<workspace_context>",
    normalizedContext,
    "</workspace_context>",
    "",
    "<user_request>",
    normalizedPrompt,
    "</user_request>",
  ].join("\n");
}
