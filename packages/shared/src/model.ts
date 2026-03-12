import {
  CODEX_REASONING_EFFORT_OPTIONS,
  DEFAULT_MODEL_BY_PROVIDER,
  MODEL_OPTIONS_BY_PROVIDER,
  MODEL_SLUG_ALIASES_BY_PROVIDER,
  type CodexReasoningEffort,
  type ModelSlug,
  type ProviderKind,
} from "@t3tools/contracts";

type CatalogProvider = keyof typeof MODEL_OPTIONS_BY_PROVIDER;

const MODEL_SLUG_SET_BY_PROVIDER: Record<CatalogProvider, ReadonlySet<ModelSlug>> = {
  codex: new Set(MODEL_OPTIONS_BY_PROVIDER.codex.map((option) => option.slug)),
  opencode: new Set<ModelSlug>(),
};

export function getModelOptions(provider: ProviderKind = "codex") {
  return MODEL_OPTIONS_BY_PROVIDER[provider];
}

export function getDefaultModel(provider: ProviderKind = "codex"): ModelSlug {
  return DEFAULT_MODEL_BY_PROVIDER[provider];
}

function normalizeOpenCodeModelSlug(model: string): string {
  const colonIndex = model.indexOf(":");
  if (colonIndex > 0 && colonIndex < model.length - 1) {
    return model;
  }

  const slashIndex = model.indexOf("/");
  if (slashIndex > 0 && slashIndex < model.length - 1) {
    return `${model.slice(0, slashIndex)}:${model.slice(slashIndex + 1)}`;
  }

  return model;
}

export function normalizeModelSlug(
  model: string | null | undefined,
  provider: ProviderKind = "codex",
): ModelSlug | null {
  if (typeof model !== "string") {
    return null;
  }

  const trimmed = model.trim();
  if (!trimmed) {
    return null;
  }

  const providerNormalized = provider === "opencode" ? normalizeOpenCodeModelSlug(trimmed) : trimmed;

  const aliases = MODEL_SLUG_ALIASES_BY_PROVIDER[provider] as Record<string, ModelSlug>;
  const aliased = aliases[providerNormalized];
  return typeof aliased === "string" ? aliased : (providerNormalized as ModelSlug);
}

export function resolveModelSlug(
  model: string | null | undefined,
  provider: ProviderKind = "codex",
): ModelSlug {
  const normalized = normalizeModelSlug(model, provider);
  if (!normalized) {
    return getDefaultModel(provider);
  }

  return MODEL_SLUG_SET_BY_PROVIDER[provider].has(normalized)
    ? normalized
    : getDefaultModel(provider);
}

export function resolveModelSlugForProvider(
  provider: ProviderKind,
  model: string | null | undefined,
): ModelSlug {
  return resolveModelSlug(model, provider);
}

export function isOpenCodeModelSlug(model: string | null | undefined): boolean {
  const normalized = normalizeModelSlug(model, "opencode");
  if (!normalized) {
    return false;
  }

  const separatorIndex = normalized.indexOf(":");
  return separatorIndex > 0 && separatorIndex < normalized.length - 1;
}

export function getOpenCodeModelDisplayName(model: string | null | undefined): string {
  const normalized = normalizeModelSlug(model, "opencode");
  if (!normalized) {
    return "";
  }

  const separatorIndex = normalized.indexOf(":");
  if (separatorIndex <= 0 || separatorIndex === normalized.length - 1) {
    return normalized;
  }

  return normalized.slice(separatorIndex + 1);
}

export function getReasoningEffortOptions(
  provider: ProviderKind = "codex",
): ReadonlyArray<CodexReasoningEffort> {
  return provider === "codex" ? CODEX_REASONING_EFFORT_OPTIONS : [];
}

export function getDefaultReasoningEffort(provider: "codex"): CodexReasoningEffort;
export function getDefaultReasoningEffort(provider: ProviderKind): CodexReasoningEffort | null;
export function getDefaultReasoningEffort(
  provider: ProviderKind = "codex",
): CodexReasoningEffort | null {
  return provider === "codex" ? "high" : null;
}

export { CODEX_REASONING_EFFORT_OPTIONS };
