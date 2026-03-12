import { useCallback, useSyncExternalStore } from "react";
import { Option, Schema } from "effect";
import {
  BackendSelection,
  DiscoveredBackend,
  FolderOpenTargetId,
  MAX_REMOTE_BACKEND_PROFILES,
  RemoteBackendProfile,
  EditorId,
  type BackendSelection as BackendSelectionValue,
  type DiscoveredBackend as DiscoveredBackendValue,
  type FolderOpenTargetId as FolderOpenTargetIdValue,
  type EditorId as EditorIdValue,
  type ProviderKind,
  type ProviderSessionStartInput,
  type ProviderServiceTier,
  type RemoteBackendProfile as RemoteBackendProfileValue,
} from "@t3tools/contracts";
import {
  getDefaultModel,
  getModelOptions,
  getOpenCodeModelDisplayName,
  normalizeModelSlug,
} from "@t3tools/shared/model";

const APP_SETTINGS_STORAGE_KEY = "t3code:app-settings:v1";
const MAX_CUSTOM_MODEL_COUNT = 32;
const MAX_VISIBLE_OPENCODE_DELEGATE_COUNT = 64;
export const MAX_CUSTOM_MODEL_LENGTH = 256;
export const DEFAULT_SUPERVISOR_MAX_CONCURRENT_CHILDREN = 2;
export const MIN_SUPERVISOR_MAX_CONCURRENT_CHILDREN = 1;
export const MAX_SUPERVISOR_MAX_CONCURRENT_CHILDREN = 8;
export const APP_FONT_SCALE_OPTIONS = [
  {
    value: "compact",
    label: "Compact",
    description: "Tighter sizing for denser layouts.",
    scale: 0.92,
  },
  {
    value: "default",
    label: "Default",
    description: "Balanced sizing for everyday use.",
    scale: 1,
  },
  {
    value: "large",
    label: "Large",
    description: "Slightly larger text for easier scanning.",
    scale: 1.08,
  },
  {
    value: "x-large",
    label: "Extra large",
    description: "Maximum readable size across the app.",
    scale: 1.16,
  },
] as const;
export type AppFontScale = (typeof APP_FONT_SCALE_OPTIONS)[number]["value"];
export const APP_SERVICE_TIER_OPTIONS = [
  {
    value: "auto",
    label: "Automatic",
    description: "Use Codex defaults without forcing a service tier.",
  },
  {
    value: "fast",
    label: "Fast",
    description: "Request the fast service tier when the model supports it.",
  },
  {
    value: "flex",
    label: "Flex",
    description: "Request the flex service tier when the model supports it.",
  },
] as const;
export type AppServiceTier = (typeof APP_SERVICE_TIER_OPTIONS)[number]["value"];
const AppFontScaleSchema = Schema.Literals(["compact", "default", "large", "x-large"]);
const AppServiceTierSchema = Schema.Literals(["auto", "fast", "flex"]);
const MODELS_WITH_FAST_SUPPORT = new Set(["gpt-5.4"]);
const BUILT_IN_MODEL_SLUGS_BY_PROVIDER: Record<ProviderKind, ReadonlySet<string>> = {
  codex: new Set(getModelOptions("codex").map((option) => option.slug)),
  opencode: new Set(getModelOptions("opencode").map((option) => option.slug)),
};

const AppSettingsSchema = Schema.Struct({
  codexBinaryPath: Schema.String.check(Schema.isMaxLength(4096)).pipe(
    Schema.withConstructorDefault(() => Option.some("")),
  ),
  codexHomePath: Schema.String.check(Schema.isMaxLength(4096)).pipe(
    Schema.withConstructorDefault(() => Option.some("")),
  ),
  opencodeBinaryPath: Schema.String.check(Schema.isMaxLength(4096)).pipe(
    Schema.withConstructorDefault(() => Option.some("")),
  ),
  jcodemunchEnabled: Schema.Boolean.pipe(Schema.withConstructorDefault(() => Option.some(false))),
  jcodemunchBinaryPath: Schema.String.check(Schema.isMaxLength(4096)).pipe(
    Schema.withConstructorDefault(() => Option.some("")),
  ),
  confirmThreadDelete: Schema.Boolean.pipe(Schema.withConstructorDefault(() => Option.some(true))),
  enableAssistantStreaming: Schema.Boolean.pipe(
    Schema.withConstructorDefault(() => Option.some(false)),
  ),
  uiFontScale: AppFontScaleSchema.pipe(
    Schema.withConstructorDefault(() => Option.some("default")),
  ),
  contentFontScale: AppFontScaleSchema.pipe(
    Schema.withConstructorDefault(() => Option.some("default")),
  ),
  monoFontScale: AppFontScaleSchema.pipe(
    Schema.withConstructorDefault(() => Option.some("default")),
  ),
  codexServiceTier: AppServiceTierSchema.pipe(
    Schema.withConstructorDefault(() => Option.some("auto")),
  ),
  customCodexModels: Schema.Array(Schema.String).pipe(
    Schema.withConstructorDefault(() => Option.some([])),
  ),
  customOpenCodeModels: Schema.Array(Schema.String).pipe(
    Schema.withConstructorDefault(() => Option.some([])),
  ),
  visibleOpenCodeDelegateIds: Schema.Array(Schema.String).pipe(
    Schema.withConstructorDefault(() => Option.some(["openrouter"])),
  ),
  remoteBackendProfiles: Schema.Array(RemoteBackendProfile).pipe(
    Schema.withConstructorDefault(() => Option.some([])),
  ),
  preferredGitRemotesByProjectCwd: Schema.Record(Schema.String, Schema.String).pipe(
    Schema.withConstructorDefault(() => Option.some({})),
  ),
  defaultFileOpenTool: Schema.NullOr(EditorId).pipe(
    Schema.withConstructorDefault(() => Option.some(null)),
  ),
  defaultFolderOpenTool: Schema.NullOr(FolderOpenTargetId).pipe(
    Schema.withConstructorDefault(() => Option.some(null)),
  ),
  defaultSupervisorChildModel: Schema.NullOr(Schema.String).pipe(
    Schema.withConstructorDefault(() => Option.some(null)),
  ),
  defaultSupervisorMaxConcurrentChildren: Schema.Number.pipe(
    Schema.withConstructorDefault(() => Option.some(DEFAULT_SUPERVISOR_MAX_CONCURRENT_CHILDREN)),
  ),
  backendSelection: BackendSelection.pipe(
    Schema.withConstructorDefault(() => Option.some(BackendSelection.makeUnsafe({}))),
  ),
});
export type AppSettings = typeof AppSettingsSchema.Type;
export interface AppModelOption {
  slug: string;
  name: string;
  isCustom: boolean;
}

export function resolveAppServiceTier(serviceTier: AppServiceTier): ProviderServiceTier | null {
  return serviceTier === "auto" ? null : serviceTier;
}

export function getProviderStartOptionsForProvider(
  settings: Pick<AppSettings, "codexBinaryPath" | "codexHomePath" | "opencodeBinaryPath">,
  provider: ProviderKind,
): ProviderSessionStartInput["providerOptions"] | undefined {
  if (provider === "codex") {
    const binaryPath = settings.codexBinaryPath.trim();
    const homePath = settings.codexHomePath.trim();
    if (!binaryPath && !homePath) {
      return undefined;
    }
    return {
      codex: {
        ...(binaryPath ? { binaryPath } : {}),
        ...(homePath ? { homePath } : {}),
      },
    };
  }

  const binaryPath = settings.opencodeBinaryPath.trim();
  if (!binaryPath) {
    return undefined;
  }
  return {
    opencode: {
      binaryPath,
    },
  };
}

export function getJCodeMunchSettings(
  settings: Pick<AppSettings, "jcodemunchEnabled" | "jcodemunchBinaryPath">,
) {
  const binaryPath = settings.jcodemunchBinaryPath.trim();
  return {
    enabled: settings.jcodemunchEnabled,
    binaryPath: binaryPath.length > 0 ? binaryPath : null,
  } as const;
}

export function resolveAppFontScale(scale: AppFontScale): number {
  return APP_FONT_SCALE_OPTIONS.find((option) => option.value === scale)?.scale ?? 1;
}

export function shouldShowFastTierIcon(
  model: string | null | undefined,
  serviceTier: AppServiceTier,
): boolean {
  const normalizedModel = normalizeModelSlug(model);
  return (
    resolveAppServiceTier(serviceTier) === "fast" &&
    normalizedModel !== null &&
    MODELS_WITH_FAST_SUPPORT.has(normalizedModel)
  );
}

const DEFAULT_APP_SETTINGS = AppSettingsSchema.makeUnsafe({});

let listeners: Array<() => void> = [];
let cachedRawSettings: string | null | undefined;
let cachedSnapshot: AppSettings = DEFAULT_APP_SETTINGS;

export function normalizeCustomModelSlugs(
  models: Iterable<string | null | undefined>,
  provider: ProviderKind = "codex",
): string[] {
  const normalizedModels: string[] = [];
  const seen = new Set<string>();
  const builtInModelSlugs = BUILT_IN_MODEL_SLUGS_BY_PROVIDER[provider];

  for (const candidate of models) {
    const normalized = normalizeModelSlug(candidate, provider);
    if (
      !normalized ||
      normalized.length > MAX_CUSTOM_MODEL_LENGTH ||
      builtInModelSlugs.has(normalized) ||
      seen.has(normalized)
    ) {
      continue;
    }

    seen.add(normalized);
    normalizedModels.push(normalized);
    if (normalizedModels.length >= MAX_CUSTOM_MODEL_COUNT) {
      break;
    }
  }

  return normalizedModels;
}

function normalizeAppSettings(settings: AppSettings): AppSettings {
  const remoteBackendProfiles = normalizeRemoteBackendProfiles(settings.remoteBackendProfiles);
  const backendSelection = normalizeBackendSelection(
    settings.backendSelection,
    remoteBackendProfiles,
  );
  return {
    ...settings,
    customCodexModels: normalizeCustomModelSlugs(settings.customCodexModels, "codex"),
    customOpenCodeModels: normalizeCustomModelSlugs(settings.customOpenCodeModels, "opencode"),
    visibleOpenCodeDelegateIds: normalizeOpenCodeDelegateIds(settings.visibleOpenCodeDelegateIds),
    remoteBackendProfiles,
    preferredGitRemotesByProjectCwd: normalizePreferredGitRemotesByProjectCwd(
      settings.preferredGitRemotesByProjectCwd,
    ),
    defaultFileOpenTool: normalizeOptionalFileOpenTool(settings.defaultFileOpenTool),
    defaultFolderOpenTool: normalizeOptionalFolderOpenTool(settings.defaultFolderOpenTool),
    defaultSupervisorChildModel: normalizeOptionalSupervisorChildModel(
      settings.defaultSupervisorChildModel,
      settings.customCodexModels,
    ),
    defaultSupervisorMaxConcurrentChildren: normalizeSupervisorMaxConcurrentChildren(
      settings.defaultSupervisorMaxConcurrentChildren,
    ),
    backendSelection,
  };
}

function normalizeOpenCodeDelegateIds(
  input: Iterable<string | null | undefined> | null | undefined,
): string[] {
  const normalizedIds: string[] = [];
  const seen = new Set<string>();

  for (const candidate of input ?? []) {
    const normalized = candidate?.trim() ?? "";
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    normalizedIds.push(normalized);
    if (normalizedIds.length >= MAX_VISIBLE_OPENCODE_DELEGATE_COUNT) {
      break;
    }
  }

  return normalizedIds;
}

function normalizePreferredGitRemotesByProjectCwd(
  input: Record<string, string | null | undefined> | null | undefined,
): Record<string, string> {
  const normalized: Record<string, string> = {};
  if (!input) {
    return normalized;
  }

  for (const [cwd, remoteName] of Object.entries(input)) {
    const normalizedCwd = cwd.trim();
    const normalizedRemoteName = remoteName?.trim() ?? "";
    if (!normalizedCwd || !normalizedRemoteName) {
      continue;
    }
    normalized[normalizedCwd] = normalizedRemoteName;
  }

  return normalized;
}

function normalizeOptionalFileOpenTool(
  tool: EditorIdValue | null | undefined,
): EditorIdValue | null {
  if (tool == null) {
    return null;
  }
  const decoded = Schema.decodeUnknownOption(EditorId)(tool);
  return decoded._tag === "Some" ? decoded.value : null;
}

function normalizeOptionalFolderOpenTool(
  tool: FolderOpenTargetIdValue | null | undefined,
): FolderOpenTargetIdValue | null {
  if (tool == null) {
    return null;
  }
  const decoded = Schema.decodeUnknownOption(FolderOpenTargetId)(tool);
  return decoded._tag === "Some" ? decoded.value : null;
}

function normalizeOptionalSupervisorChildModel(
  model: string | null | undefined,
  customModels: readonly string[],
): string | null {
  if (model == null) {
    return null;
  }
  const normalized = model.trim();
  if (!normalized) {
    return null;
  }
  return resolveAppModelSelection("codex", customModels, normalized);
}

function normalizeSupervisorMaxConcurrentChildren(value: number | null | undefined): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_SUPERVISOR_MAX_CONCURRENT_CHILDREN;
  }
  const finiteValue = value as number;
  return Math.min(
    MAX_SUPERVISOR_MAX_CONCURRENT_CHILDREN,
    Math.max(MIN_SUPERVISOR_MAX_CONCURRENT_CHILDREN, Math.round(finiteValue)),
  );
}

export function normalizeRemoteBackendProfiles(
  profiles: Iterable<RemoteBackendProfileValue | null | undefined>,
): RemoteBackendProfileValue[] {
  const normalizedProfiles: RemoteBackendProfileValue[] = [];
  const seenIds = new Set<string>();

  for (const candidate of profiles) {
    if (!candidate) {
      continue;
    }

    const decoded = Schema.decodeUnknownOption(RemoteBackendProfile)(candidate);
    if (decoded._tag === "None" || seenIds.has(decoded.value.id)) {
      continue;
    }

    seenIds.add(decoded.value.id);
    normalizedProfiles.push(decoded.value);
    if (normalizedProfiles.length >= MAX_REMOTE_BACKEND_PROFILES) {
      break;
    }
  }

  return normalizedProfiles;
}

function normalizeDiscoveredBackend(
  backend: DiscoveredBackendValue | null | undefined,
): DiscoveredBackendValue | null {
  if (!backend) {
    return null;
  }

  const decoded = Schema.decodeUnknownOption(DiscoveredBackend)(backend);
  return decoded._tag === "Some" ? decoded.value : null;
}

export function normalizeBackendSelection(
  selection: BackendSelectionValue,
  profiles: readonly RemoteBackendProfileValue[],
): BackendSelectionValue {
  const decoded = Schema.decodeUnknownOption(BackendSelection)(selection);
  if (decoded._tag === "None") {
    return BackendSelection.makeUnsafe({});
  }

  const discoveredBackend = normalizeDiscoveredBackend(decoded.value.discoveredBackend);
  if (decoded.value.mode === "remote" && discoveredBackend) {
    return {
      mode: "remote",
      profileId: null,
      discoveredBackend,
    };
  }

  if (decoded.value.mode === "remote") {
    const selectedProfile = profiles.find((profile) => profile.id === decoded.value.profileId);
    if (!selectedProfile) {
      return BackendSelection.makeUnsafe({});
    }

    return {
      mode: "remote",
      profileId: selectedProfile.id,
      discoveredBackend: null,
    };
  }

  return {
    mode: "local",
    profileId: null,
    discoveredBackend: null,
  };
}

export function getAppModelOptions(
  provider: ProviderKind,
  customModels: readonly string[],
  selectedModel?: string | null,
  additionalOptions: ReadonlyArray<{ slug: string; name: string }> = [],
): AppModelOption[] {
  const options: AppModelOption[] = [
    ...getModelOptions(provider).map(({ slug, name }) => ({
      slug,
      name,
      isCustom: false,
    })),
    ...additionalOptions.map(({ slug, name }) => ({
      slug,
      name,
      isCustom: false,
    })),
  ];
  const seen = new Set(options.map((option) => option.slug));

  for (const slug of normalizeCustomModelSlugs(customModels, provider)) {
    if (seen.has(slug)) {
      continue;
    }

    seen.add(slug);
    options.push({
      slug,
      name: provider === "opencode" ? getOpenCodeModelDisplayName(slug) : slug,
      isCustom: true,
    });
  }

  const normalizedSelectedModel = normalizeModelSlug(selectedModel, provider);
  if (normalizedSelectedModel && !seen.has(normalizedSelectedModel)) {
    options.push({
      slug: normalizedSelectedModel,
      name:
        provider === "opencode"
          ? getOpenCodeModelDisplayName(normalizedSelectedModel)
          : normalizedSelectedModel,
      isCustom: true,
    });
  }

  return options;
}

export function resolveAppModelSelection(
  provider: ProviderKind,
  customModels: readonly string[],
  selectedModel: string | null | undefined,
  additionalOptions: ReadonlyArray<{ slug: string; name: string }> = [],
): string {
  const options = getAppModelOptions(provider, customModels, selectedModel, additionalOptions);
  const trimmedSelectedModel = selectedModel?.trim();
  if (trimmedSelectedModel) {
    const direct = options.find((option) => option.slug === trimmedSelectedModel);
    if (direct) {
      return direct.slug;
    }

    const byName = options.find(
      (option) => option.name.toLowerCase() === trimmedSelectedModel.toLowerCase(),
    );
    if (byName) {
      return byName.slug;
    }
  }

  const normalizedSelectedModel = normalizeModelSlug(selectedModel, provider);
  if (!normalizedSelectedModel) {
    return getDefaultModel(provider);
  }

  return (
    options.find((option) => option.slug === normalizedSelectedModel)?.slug ??
    getDefaultModel(provider)
  );
}

export function getSlashModelOptions(
  provider: ProviderKind,
  customModels: readonly string[],
  query: string,
  selectedModel?: string | null,
  additionalOptions: ReadonlyArray<{ slug: string; name: string }> = [],
): AppModelOption[] {
  const normalizedQuery = query.trim().toLowerCase();
  const options = getAppModelOptions(provider, customModels, selectedModel, additionalOptions);
  if (!normalizedQuery) {
    return options;
  }

  return options.filter((option) => {
    const searchSlug = option.slug.toLowerCase();
    const searchName = option.name.toLowerCase();
    return searchSlug.includes(normalizedQuery) || searchName.includes(normalizedQuery);
  });
}

function emitChange(): void {
  for (const listener of listeners) {
    listener();
  }
}

function parsePersistedSettings(value: string | null): AppSettings {
  if (!value) {
    return DEFAULT_APP_SETTINGS;
  }

  try {
    return normalizeAppSettings(Schema.decodeSync(Schema.fromJsonString(AppSettingsSchema))(value));
  } catch {
    return DEFAULT_APP_SETTINGS;
  }
}

export function getAppSettingsSnapshot(): AppSettings {
  if (typeof window === "undefined") {
    return DEFAULT_APP_SETTINGS;
  }

  const raw = window.localStorage.getItem(APP_SETTINGS_STORAGE_KEY);
  if (raw === cachedRawSettings) {
    return cachedSnapshot;
  }

  cachedRawSettings = raw;
  cachedSnapshot = parsePersistedSettings(raw);
  return cachedSnapshot;
}

function persistSettings(next: AppSettings): void {
  if (typeof window === "undefined") return;

  const raw = JSON.stringify(next);
  try {
    if (raw !== cachedRawSettings) {
      window.localStorage.setItem(APP_SETTINGS_STORAGE_KEY, raw);
    }
  } catch {
    // Best-effort persistence only.
  }

  cachedRawSettings = raw;
  cachedSnapshot = next;
}

function subscribe(listener: () => void): () => void {
  listeners.push(listener);

  const onStorage = (event: StorageEvent) => {
    if (event.key === APP_SETTINGS_STORAGE_KEY) {
      emitChange();
    }
  };

  window.addEventListener("storage", onStorage);
  return () => {
    listeners = listeners.filter((entry) => entry !== listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function useAppSettings() {
  const settings = useSyncExternalStore(
    subscribe,
    getAppSettingsSnapshot,
    () => DEFAULT_APP_SETTINGS,
  );

  const updateSettings = useCallback((patch: Partial<AppSettings>) => {
    const next = normalizeAppSettings(
      Schema.decodeSync(AppSettingsSchema)({
        ...getAppSettingsSnapshot(),
        ...patch,
      }),
    );
    persistSettings(next);
    emitChange();
  }, []);

  const resetSettings = useCallback(() => {
    persistSettings(DEFAULT_APP_SETTINGS);
    emitChange();
  }, []);

  return {
    settings,
    updateSettings,
    resetSettings,
    defaults: DEFAULT_APP_SETTINGS,
  } as const;
}
