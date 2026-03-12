import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BackendSelection,
  EDITORS,
  TERMINAL_APPS,
  type DiscoveredBackend,
  type BackendProtocol,
  type FolderOpenTargetId,
  type ProviderKind,
  type RemoteBackendProfile,
} from "@t3tools/contracts";
import { getModelOptions, normalizeModelSlug } from "@t3tools/shared/model";
import { PlusIcon, Trash2Icon, ZapIcon } from "lucide-react";

import {
  APP_FONT_SCALE_OPTIONS,
  APP_SERVICE_TIER_OPTIONS,
  DEFAULT_SUPERVISOR_MAX_CONCURRENT_CHILDREN,
  MAX_SUPERVISOR_MAX_CONCURRENT_CHILDREN,
  MIN_SUPERVISOR_MAX_CONCURRENT_CHILDREN,
  getAppModelOptions,
  resolveAppFontScale,
  resolveAppModelSelection,
  type AppSettings,
  normalizeBackendSelection,
  normalizeRemoteBackendProfiles,
  MAX_CUSTOM_MODEL_LENGTH,
  shouldShowFastTierIcon,
  useAppSettings,
} from "../appSettings";
import { discoverBackends, supportsBackendDiscovery } from "../backendDiscovery";
import { buildRemoteBackendWsUrl, resolveBackendConnection } from "../backendConnection";
import { isCapacitorShell, isElectron } from "../env";
import { useTheme } from "../hooks/useTheme";
import { providerCatalogQueryOptions } from "../lib/providerCatalogReactQuery";
import {
  getProviderConnectionLabel,
  getProviderStatus,
  isProviderConnected,
} from "../lib/providerStatus";
import { serverConfigQueryOptions } from "../lib/serverReactQuery";
import { isMacPlatform, isWindowsPlatform } from "../lib/utils";
import { ensureNativeApi, resetNativeApi } from "../nativeApi";
import { preferredPathOpenInput } from "../terminal-links";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Switch } from "../components/ui/switch";
import { SidebarInset, SidebarTrigger } from "~/components/ui/sidebar";

const THEME_OPTIONS = [
  {
    value: "system",
    label: "System",
    description: "Match your OS appearance setting.",
  },
  {
    value: "light",
    label: "Light",
    description: "Always use the light theme.",
  },
  {
    value: "dark",
    label: "Dark",
    description: "Always use the dark theme.",
  },
] as const;
const AUTO_OPEN_TOOL_VALUE = "__auto__";
const EMPTY_PROVIDER_STATUSES = [] as const;
const SUPERVISOR_MODEL_INHERIT_VALUE = "__inherit__";
const SETTINGS_TABS = [
  {
    value: "connection",
    label: "Connection",
    description: "Backend discovery and remote shell setup.",
  },
  {
    value: "codex",
    label: "Codex",
    description: "Codex runtime, models, and supervisor defaults.",
  },
  {
    value: "interface",
    label: "Interface",
    description: "Theme, output, open tools, and safety.",
  },
] as const;
type SettingsTabId = (typeof SETTINGS_TABS)[number]["value"];
const APPEARANCE_FONT_CONTEXT_OPTIONS: Array<{
  key: "uiFontScale" | "contentFontScale" | "monoFontScale";
  label: string;
  description: string;
}> = [
  {
    key: "uiFontScale",
    label: "Interface text",
    description: "Sidebar, settings, controls, and general chrome.",
  },
  {
    key: "contentFontScale",
    label: "Conversation text",
    description: "Messages, plans, and long-form reading surfaces.",
  },
  {
    key: "monoFontScale",
    label: "Monospace text",
    description: "Composer, code, diffs, and terminal-style surfaces.",
  },
];

function fileManagerLabelForPlatform(platform: string): string {
  return isMacPlatform(platform)
    ? "Finder"
    : isWindowsPlatform(platform)
      ? "Explorer"
      : "Files";
}

function resolveOpenToolLabel(target: FolderOpenTargetId, platform: string): string {
  if (target === "file-manager") {
    return fileManagerLabelForPlatform(platform);
  }
  return (
    EDITORS.find((editor) => editor.id === target)?.label ??
    TERMINAL_APPS.find((terminal) => terminal.id === target)?.label ??
    target
  );
}

function createBackendProfileId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `backend-${crypto.randomUUID().slice(0, 8).toLowerCase()}`;
  }
  return `backend-${Date.now().toString(36)}`;
}

function resolveBackendSelectionLabel(
  selection: AppSettings["backendSelection"],
  profiles: readonly RemoteBackendProfile[],
): string {
  if (selection.mode !== "remote") {
    return "Local backend";
  }

  if (selection.discoveredBackend) {
    return selection.discoveredBackend.name;
  }

  return profiles.find((profile) => profile.id === selection.profileId)?.name ?? "Remote backend";
}

async function syncDesktopBackendSelection(
  selection: AppSettings["backendSelection"],
  profiles: readonly RemoteBackendProfile[],
): Promise<void> {
  if (!window.desktopBridge?.setBackendConnection) {
    return;
  }

  const activeProfile =
    selection.mode === "remote" && selection.discoveredBackend === null
      ? (profiles.find((profile) => profile.id === selection.profileId) ?? null)
      : null;
  const activeRemoteEndpoint = selection.discoveredBackend ?? activeProfile;
  await window.desktopBridge.setBackendConnection(
    activeRemoteEndpoint
      ? {
          mode: "remote",
          remoteWsUrl: buildRemoteBackendWsUrl(activeRemoteEndpoint),
        }
      : {
          mode: "local",
          remoteWsUrl: null,
        },
  );
}

function isDiscoveredBackendSelected(
  selection: AppSettings["backendSelection"],
  backend: DiscoveredBackend,
): boolean {
  return (
    selection.mode === "remote" &&
    selection.discoveredBackend !== null &&
    selection.discoveredBackend.host === backend.host &&
    selection.discoveredBackend.port === backend.port &&
    selection.discoveredBackend.protocol === backend.protocol
  );
}

const MODEL_PROVIDER_SETTINGS: Array<{
  provider: ProviderKind;
  title: string;
  description: string;
  placeholder: string;
  example: string;
}> = [
  {
    provider: "codex",
    title: "Codex",
    description: "Save additional Codex model slugs for the picker and `/model` command.",
    placeholder: "your-codex-model-slug",
    example: "gpt-6.7-codex-ultra-preview",
  },
] as const;

function getCustomModelsForProvider(
  settings: ReturnType<typeof useAppSettings>["settings"],
  provider: ProviderKind,
) {
  switch (provider) {
    case "codex":
      return settings.customCodexModels;
    case "opencode":
      return settings.customOpenCodeModels;
    default:
      return settings.customCodexModels;
  }
}

function getDefaultCustomModelsForProvider(
  defaults: ReturnType<typeof useAppSettings>["defaults"],
  provider: ProviderKind,
) {
  switch (provider) {
    case "codex":
      return defaults.customCodexModels;
    case "opencode":
      return defaults.customOpenCodeModels;
    default:
      return defaults.customCodexModels;
  }
}

function patchCustomModels(provider: ProviderKind, models: string[]) {
  switch (provider) {
    case "codex":
      return { customCodexModels: models };
    case "opencode":
      return { customOpenCodeModels: models };
    default:
      return { customCodexModels: models };
  }
}

const OPENROUTER_MODEL_PREFIX = "openrouter:";

function formatOpenRouterModelInput(rawSlug: string): string {
  const trimmed = rawSlug.trim();
  if (!trimmed) {
    return trimmed;
  }
  const withoutProviderPrefix =
    trimmed.startsWith(OPENROUTER_MODEL_PREFIX)
      ? trimmed.slice(OPENROUTER_MODEL_PREFIX.length)
      : trimmed.startsWith("openrouter/")
        ? trimmed.slice("openrouter/".length)
        : trimmed;
  const providerSeparatorIndex = withoutProviderPrefix.indexOf(":");
  const normalizedBareSlug =
    providerSeparatorIndex > 0 && providerSeparatorIndex < withoutProviderPrefix.length - 1
      ? `${withoutProviderPrefix.slice(0, providerSeparatorIndex)}/${withoutProviderPrefix.slice(
          providerSeparatorIndex + 1,
        )}`
      : withoutProviderPrefix;
  return `${OPENROUTER_MODEL_PREFIX}${normalizedBareSlug}`;
}

function stripOpenRouterModelPrefix(slug: string): string {
  const withoutPrefix = slug.startsWith(OPENROUTER_MODEL_PREFIX)
    ? slug.slice(OPENROUTER_MODEL_PREFIX.length)
    : slug;
  const providerSeparatorIndex = withoutPrefix.indexOf("/");
  return providerSeparatorIndex > 0 && providerSeparatorIndex < withoutPrefix.length - 1
    ? `${withoutPrefix.slice(0, providerSeparatorIndex)}:${withoutPrefix.slice(
        providerSeparatorIndex + 1,
      )}`
    : withoutPrefix;
}

function ProviderConnectionBadge(props: { connected: boolean; label: string }) {
  return (
    <span
      className={
        props.connected
          ? "inline-flex items-center gap-2 rounded-full bg-emerald-500/10 px-2.5 py-1 text-[11px] font-medium text-emerald-600"
          : "inline-flex items-center gap-2 rounded-full bg-red-500/10 px-2.5 py-1 text-[11px] font-medium text-red-600"
      }
    >
      <span
        aria-hidden="true"
        className={props.connected ? "size-2 rounded-full bg-emerald-500" : "size-2 rounded-full bg-red-500"}
      />
      {props.label}
    </span>
  );
}

function SettingsRouteView() {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const { settings, defaults, updateSettings } = useAppSettings();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<SettingsTabId>("connection");
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const openCodeCatalogQuery = useQuery(
    providerCatalogQueryOptions({
      provider: "opencode",
      cwd: serverConfigQuery.data?.cwd ?? null,
      binaryPath: settings.opencodeBinaryPath || null,
      enabled: !!serverConfigQuery.data,
    }),
  );
  const [isOpeningKeybindings, setIsOpeningKeybindings] = useState(false);
  const [openKeybindingsError, setOpenKeybindingsError] = useState<string | null>(null);
  const [customModelInputByProvider, setCustomModelInputByProvider] = useState<
    Record<ProviderKind, string>
  >({
    codex: "",
    opencode: "",
  });
  const [openRouterModelInput, setOpenRouterModelInput] = useState("");
  const [customModelErrorByProvider, setCustomModelErrorByProvider] = useState<
    Partial<Record<ProviderKind, string | null>>
  >({});
  const [openRouterModelError, setOpenRouterModelError] = useState<string | null>(null);
  const [isAddOpenCodeDelegateDialogOpen, setIsAddOpenCodeDelegateDialogOpen] = useState(false);
  const [openCodeDelegateSearchQuery, setOpenCodeDelegateSearchQuery] = useState("");
  const [remoteProfileName, setRemoteProfileName] = useState("");
  const [remoteProfileHost, setRemoteProfileHost] = useState("");
  const [remoteProfilePort, setRemoteProfilePort] = useState("3773");
  const [remoteProfileProtocol, setRemoteProfileProtocol] = useState<BackendProtocol>("ws");
  const [remoteProfileError, setRemoteProfileError] = useState<string | null>(null);
  const [isApplyingBackendConnection, setIsApplyingBackendConnection] = useState(false);
  const [discoveredBackends, setDiscoveredBackends] = useState<DiscoveredBackend[]>([]);
  const [isDiscoveringBackends, setIsDiscoveringBackends] = useState(false);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const [openCodeApiKeysByProvider, setOpenCodeApiKeysByProvider] = useState<Record<string, string>>(
    {},
  );
  const [openCodeOauthCodesByProvider, setOpenCodeOauthCodesByProvider] = useState<
    Record<string, string>
  >({});
  const [openCodeConnectedOverrideByProvider, setOpenCodeConnectedOverrideByProvider] = useState<
    Record<string, boolean>
  >({});
  const [openCodeAuthErrorByProvider, setOpenCodeAuthErrorByProvider] = useState<
    Record<string, string | null>
  >({});
  const [openCodeAuthBusyByProvider, setOpenCodeAuthBusyByProvider] = useState<
    Record<string, boolean>
  >({});

  const codexBinaryPath = settings.codexBinaryPath;
  const codexHomePath = settings.codexHomePath;
  const codexServiceTier = settings.codexServiceTier;
  const openCodeBinaryPath = settings.opencodeBinaryPath;
  const jcodemunchEnabled = settings.jcodemunchEnabled;
  const jcodemunchBinaryPath = settings.jcodemunchBinaryPath;
  const keybindingsConfigPath = serverConfigQuery.data?.keybindingsConfigPath ?? null;
  const availableEditors = serverConfigQuery.data?.availableEditors ?? [];
  const availableTerminalApps = serverConfigQuery.data?.availableTerminalApps ?? [];
  const providerStatuses = serverConfigQuery.data?.providers ?? EMPTY_PROVIDER_STATUSES;
  const platform = typeof navigator === "undefined" ? "" : navigator.platform;
  const codexProviderStatus = getProviderStatus(providerStatuses, "codex");
  const openCodeProviderStatus = getProviderStatus(providerStatuses, "opencode");
  const openCodeDelegatedProviders = useMemo(
    () =>
      (openCodeCatalogQuery.data?.delegatedProviders ?? []).map((provider) =>
        Object.assign({}, provider, {
          connected: provider.connected || Boolean(openCodeConnectedOverrideByProvider[provider.id]),
        }),
      ),
    [openCodeCatalogQuery.data?.delegatedProviders, openCodeConnectedOverrideByProvider],
  );
  const visibleOpenCodeDelegateIds = settings.visibleOpenCodeDelegateIds;
  const visibleOpenCodeDelegatedProviders = useMemo(
    () =>
      openCodeDelegatedProviders.filter((provider) =>
        visibleOpenCodeDelegateIds.includes(provider.id),
      ),
    [openCodeDelegatedProviders, visibleOpenCodeDelegateIds],
  );
  const availableOpenCodeDelegatedProviders = useMemo(
    () =>
      openCodeDelegatedProviders.filter(
        (provider) => !visibleOpenCodeDelegateIds.includes(provider.id),
      ),
    [openCodeDelegatedProviders, visibleOpenCodeDelegateIds],
  );
  const filteredAvailableOpenCodeDelegatedProviders = useMemo(() => {
    const normalizedQuery = openCodeDelegateSearchQuery.trim().toLowerCase();
    if (!normalizedQuery) {
      return availableOpenCodeDelegatedProviders;
    }
    return availableOpenCodeDelegatedProviders.filter((provider) => {
      const searchHaystack = `${provider.name} ${provider.id}`.toLowerCase();
      return searchHaystack.includes(normalizedQuery);
    });
  }, [availableOpenCodeDelegatedProviders, openCodeDelegateSearchQuery]);
  const openCodeModelCount = openCodeCatalogQuery.data?.models.length ?? 0;
  const openRouterCustomModels = settings.customOpenCodeModels.filter((slug) =>
    slug.startsWith(OPENROUTER_MODEL_PREFIX),
  );
  const openRouterProviderConnected = openCodeDelegatedProviders.some(
    (provider) => provider.id === "openrouter" && provider.connected,
  );
  const availableFileToolOptions = availableEditors
    .filter((editor) => editor !== "file-manager")
    .map((editor) => ({
      value: editor,
      label: resolveOpenToolLabel(editor, platform),
    }));
  const availableFolderToolOptions = [
    ...availableEditors.map((editor) => ({
      value: editor as FolderOpenTargetId,
      label: resolveOpenToolLabel(editor, platform),
    })),
    ...availableTerminalApps.map((terminal) => ({
      value: terminal as FolderOpenTargetId,
      label: resolveOpenToolLabel(terminal, platform),
    })),
  ];

  const refreshOpenCodeCatalog = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ["providerCatalog"] });
    await openCodeCatalogQuery.refetch();
  }, [openCodeCatalogQuery, queryClient]);

  const withOpenCodeAuthBusy = useCallback(
    async (providerId: string, action: () => Promise<void>): Promise<boolean> => {
      setOpenCodeAuthBusyByProvider((existing) => ({ ...existing, [providerId]: true }));
      setOpenCodeAuthErrorByProvider((existing) => ({ ...existing, [providerId]: null }));
      try {
        await action();
        await refreshOpenCodeCatalog();
        return true;
      } catch (error) {
        setOpenCodeAuthErrorByProvider((existing) => ({
          ...existing,
          [providerId]: error instanceof Error ? error.message : "OpenCode auth request failed.",
        }));
        return false;
      } finally {
        setOpenCodeAuthBusyByProvider((existing) => ({ ...existing, [providerId]: false }));
      }
    },
    [refreshOpenCodeCatalog],
  );

  const saveOpenCodeApiKey = useCallback(
    async (providerId: string) => {
      const apiKey = openCodeApiKeysByProvider[providerId]?.trim() ?? "";
      if (!apiKey) {
        setOpenCodeAuthErrorByProvider((existing) => ({
          ...existing,
          [providerId]: "Enter an API key.",
        }));
        return;
      }
      const api = ensureNativeApi();
      const connected = await withOpenCodeAuthBusy(providerId, async () => {
        await api.provider.setApiKeyAuth({
          provider: "opencode",
          delegatedProviderId: providerId,
          ...(serverConfigQuery.data?.cwd ? { cwd: serverConfigQuery.data.cwd } : {}),
          ...(openCodeBinaryPath ? { binaryPath: openCodeBinaryPath } : {}),
          apiKey,
        });
      });
      if (connected) {
        setOpenCodeConnectedOverrideByProvider((existing) => ({ ...existing, [providerId]: true }));
      }
    },
    [openCodeApiKeysByProvider, openCodeBinaryPath, serverConfigQuery.data?.cwd, withOpenCodeAuthBusy],
  );

  const startOpenCodeOauth = useCallback(
    async (providerId: string, methodIndex: number) => {
      const api = ensureNativeApi();
      await withOpenCodeAuthBusy(providerId, async () => {
        const result = await api.provider.startOauth({
          provider: "opencode",
          delegatedProviderId: providerId,
          methodIndex,
          ...(serverConfigQuery.data?.cwd ? { cwd: serverConfigQuery.data.cwd } : {}),
          ...(openCodeBinaryPath ? { binaryPath: openCodeBinaryPath } : {}),
        });
        await api.shell.openExternal(result.url);
        if (result.method === "code") {
          setOpenCodeAuthErrorByProvider((existing) => ({
            ...existing,
            [providerId]: result.instructions,
          }));
        }
      });
    },
    [openCodeBinaryPath, serverConfigQuery.data?.cwd, withOpenCodeAuthBusy],
  );

  const completeOpenCodeOauth = useCallback(
    async (providerId: string, methodIndex: number) => {
      const code = openCodeOauthCodesByProvider[providerId]?.trim() ?? "";
      if (!code) {
        setOpenCodeAuthErrorByProvider((existing) => ({
          ...existing,
          [providerId]: "Enter the OAuth code returned by the provider.",
        }));
        return;
      }
      const api = ensureNativeApi();
      const connected = await withOpenCodeAuthBusy(providerId, async () => {
        await api.provider.completeOauth({
          provider: "opencode",
          delegatedProviderId: providerId,
          methodIndex,
          code,
          ...(serverConfigQuery.data?.cwd ? { cwd: serverConfigQuery.data.cwd } : {}),
          ...(openCodeBinaryPath ? { binaryPath: openCodeBinaryPath } : {}),
        });
      });
      if (connected) {
        setOpenCodeConnectedOverrideByProvider((existing) => ({ ...existing, [providerId]: true }));
      }
    },
    [openCodeBinaryPath, openCodeOauthCodesByProvider, serverConfigQuery.data?.cwd, withOpenCodeAuthBusy],
  );
  const remoteBackendProfiles = settings.remoteBackendProfiles;
  const activeBackendConnection = resolveBackendConnection();
  const startupRole = window.desktopBridge?.getStartupRole?.() ?? null;
  const isFrontendOnlyShell = isCapacitorShell() || startupRole === "frontend-only";
  const discoverySupported = supportsBackendDiscovery();
  const activeBackendLabel = resolveBackendSelectionLabel(
    settings.backendSelection,
    remoteBackendProfiles,
  );
  const supervisorChildModelOptions = getAppModelOptions(
    "codex",
    settings.customCodexModels,
    settings.defaultSupervisorChildModel,
  );

  const openKeybindingsFile = useCallback(() => {
    if (!keybindingsConfigPath) return;
    setOpenKeybindingsError(null);
    setIsOpeningKeybindings(true);
    const api = ensureNativeApi();
    void api.shell
      .openPathWithPreferences(preferredPathOpenInput(keybindingsConfigPath))
      .catch((error) => {
        setOpenKeybindingsError(
          error instanceof Error ? error.message : "Unable to open keybindings file.",
        );
      })
      .finally(() => {
        setIsOpeningKeybindings(false);
      });
  }, [keybindingsConfigPath]);

  const applyBackendConnection = useCallback(
    async (
      backendSelection: typeof settings.backendSelection,
      profiles: readonly RemoteBackendProfile[],
    ) => {
      const normalizedProfiles = normalizeRemoteBackendProfiles(profiles);
      const normalizedSelection = normalizeBackendSelection(backendSelection, normalizedProfiles);
      setIsApplyingBackendConnection(true);
      updateSettings({
        remoteBackendProfiles: normalizedProfiles,
        backendSelection: normalizedSelection,
      });
      try {
        await syncDesktopBackendSelection(normalizedSelection, normalizedProfiles);
      } finally {
        resetNativeApi();
        window.location.reload();
      }
    },
    [updateSettings],
  );

  const saveRemoteBackendProfile = useCallback(() => {
    const name = remoteProfileName.trim();
    const host = remoteProfileHost.trim();
    const portNumber = Number.parseInt(remoteProfilePort.trim(), 10);

    if (!name) {
      setRemoteProfileError("Enter a profile name.");
      return;
    }
    if (!host) {
      setRemoteProfileError("Enter a backend host or IP address.");
      return;
    }
    if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65_535) {
      setRemoteProfileError("Enter a valid backend port between 1 and 65535.");
      return;
    }

    const nextProfiles = normalizeRemoteBackendProfiles([
      ...remoteBackendProfiles,
      {
        id: createBackendProfileId(),
        name,
        host,
        port: portNumber,
        protocol: remoteProfileProtocol,
      },
    ]);

    updateSettings({ remoteBackendProfiles: nextProfiles });
    setRemoteProfileName("");
    setRemoteProfileHost("");
    setRemoteProfilePort("3773");
    setRemoteProfileProtocol("ws");
    setRemoteProfileError(null);
  }, [
    remoteBackendProfiles,
    remoteProfileHost,
    remoteProfileName,
    remoteProfilePort,
    remoteProfileProtocol,
    updateSettings,
  ]);

  const activateLocalBackend = useCallback(() => {
    void applyBackendConnection(BackendSelection.makeUnsafe({}), remoteBackendProfiles);
  }, [applyBackendConnection, remoteBackendProfiles]);

  const activateRemoteBackend = useCallback(
    (profileId: string) => {
      void applyBackendConnection(
        {
          mode: "remote",
          profileId,
          discoveredBackend: null,
        },
        remoteBackendProfiles,
      );
    },
    [applyBackendConnection, remoteBackendProfiles],
  );

  const removeRemoteBackendProfile = useCallback(
    (profileId: string) => {
      const nextProfiles = remoteBackendProfiles.filter((profile) => profile.id !== profileId);
      if (
        settings.backendSelection.mode === "remote" &&
        settings.backendSelection.profileId === profileId
      ) {
        void applyBackendConnection(BackendSelection.makeUnsafe({}), nextProfiles);
        return;
      }

      updateSettings({ remoteBackendProfiles: nextProfiles });
    },
    [applyBackendConnection, remoteBackendProfiles, settings.backendSelection, updateSettings],
  );

  const refreshDiscoveredBackends = useCallback(async () => {
    if (!discoverySupported) {
      setDiscoveredBackends([]);
      setDiscoveryError(null);
      return;
    }

    setIsDiscoveringBackends(true);
    setDiscoveryError(null);
    try {
      setDiscoveredBackends(await discoverBackends());
    } catch (error) {
      setDiscoveryError(
        error instanceof Error ? error.message : "Unable to browse Bonjour backends.",
      );
      setDiscoveredBackends([]);
    } finally {
      setIsDiscoveringBackends(false);
    }
  }, [discoverySupported]);

  const activateDiscoveredBackend = useCallback(
    (backend: DiscoveredBackend) => {
      void applyBackendConnection(
        {
          mode: "remote",
          profileId: null,
          discoveredBackend: backend,
        },
        remoteBackendProfiles,
      );
    },
    [applyBackendConnection, remoteBackendProfiles],
  );

  useEffect(() => {
    if (!discoverySupported) {
      return;
    }
    void refreshDiscoveredBackends();
  }, [discoverySupported, refreshDiscoveredBackends]);

  const saveCustomModelSlug = useCallback(
    (provider: ProviderKind, rawSlug: string): { ok: true; slug: string } | { ok: false; message: string } => {
      const customModels = getCustomModelsForProvider(settings, provider);
      const normalized = normalizeModelSlug(rawSlug, provider);
      if (!normalized) {
        return { ok: false, message: "Enter a model slug." };
      }
      if (getModelOptions(provider).some((option) => option.slug === normalized)) {
        return { ok: false, message: "That model is already built in." };
      }
      if (normalized.length > MAX_CUSTOM_MODEL_LENGTH) {
        return {
          ok: false,
          message: `Model slugs must be ${MAX_CUSTOM_MODEL_LENGTH} characters or less.`,
        };
      }
      if (customModels.includes(normalized)) {
        return { ok: false, message: "That custom model is already saved." };
      }

      updateSettings(patchCustomModels(provider, [...customModels, normalized]));
      return { ok: true, slug: normalized };
    },
    [settings, updateSettings],
  );

  const addCustomModel = useCallback(
    (provider: ProviderKind) => {
      const customModelInput = customModelInputByProvider[provider];
      const result = saveCustomModelSlug(provider, customModelInput);
      if (!result.ok) {
        setCustomModelErrorByProvider((existing) => ({
          ...existing,
          [provider]: result.message,
        }));
        return;
      }
      setCustomModelInputByProvider((existing) => ({
        ...existing,
        [provider]: "",
      }));
      setCustomModelErrorByProvider((existing) => ({
        ...existing,
        [provider]: null,
      }));
    },
    [customModelInputByProvider, saveCustomModelSlug],
  );

  const addOpenRouterModel = useCallback(() => {
    const result = saveCustomModelSlug("opencode", formatOpenRouterModelInput(openRouterModelInput));
    if (!result.ok) {
      setOpenRouterModelError(result.message);
      return;
    }
    setOpenRouterModelInput("");
    setOpenRouterModelError(null);
  }, [openRouterModelInput, saveCustomModelSlug]);

  const removeCustomModel = useCallback(
    (provider: ProviderKind, slug: string) => {
      const customModels = getCustomModelsForProvider(settings, provider);
      updateSettings(
        patchCustomModels(
          provider,
          customModels.filter((model) => model !== slug),
        ),
      );
      setCustomModelErrorByProvider((existing) => ({
        ...existing,
        [provider]: null,
      }));
    },
    [settings, updateSettings],
  );

  const addOpenCodeDelegate = useCallback(
    (providerId: string) => {
      const normalizedProviderId = providerId.trim();
      if (!normalizedProviderId || settings.visibleOpenCodeDelegateIds.includes(normalizedProviderId)) {
        return;
      }
      updateSettings({
        visibleOpenCodeDelegateIds: [...settings.visibleOpenCodeDelegateIds, normalizedProviderId],
      });
      setIsAddOpenCodeDelegateDialogOpen(false);
      setOpenCodeDelegateSearchQuery("");
    },
    [settings.visibleOpenCodeDelegateIds, updateSettings],
  );

  const removeOpenCodeDelegate = useCallback(
    (providerId: string) => {
      updateSettings({
        visibleOpenCodeDelegateIds: settings.visibleOpenCodeDelegateIds.filter(
          (candidateId) => candidateId !== providerId,
        ),
      });
    },
    [settings.visibleOpenCodeDelegateIds, updateSettings],
  );

  const removeOpenRouterModel = useCallback(
    (slug: string) => {
      removeCustomModel("opencode", slug);
      setOpenRouterModelError(null);
    },
    [removeCustomModel],
  );

  return (
    <SidebarInset className="safe-area-shell app-shell-frame app-font-context-ui min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="app-font-context-ui flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        {isElectron && (
          <div className="drag-region flex h-[52px] shrink-0 items-center border-b border-border px-5">
            <span className="text-xs font-medium tracking-wide text-muted-foreground/70">
              Settings
            </span>
          </div>
        )}

        {!isElectron && (
          <div className="border-b border-border px-3 pt-4 pb-2 md:hidden">
            <div className="flex items-center gap-2">
              <SidebarTrigger className="size-7 shrink-0" />
              <span className="text-sm font-medium text-foreground">Settings</span>
            </div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-6">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
            <header className="space-y-1">
              <h1 className="text-2xl font-semibold tracking-tight text-foreground">Settings</h1>
              <p className="text-sm text-muted-foreground">
                Configure app-level preferences for this device.
              </p>
            </header>

            <div className="flex flex-wrap gap-2">
              {SETTINGS_TABS.map((tab) => {
                const selected = activeTab === tab.value;
                return (
                  <button
                    key={tab.value}
                    type="button"
                    className={`rounded-xl border px-3 py-2 text-left transition-colors ${
                      selected
                        ? "border-primary/60 bg-primary/8 text-foreground"
                        : "border-border bg-card text-muted-foreground hover:bg-accent"
                    }`}
                    onClick={() => setActiveTab(tab.value)}
                  >
                    <div className="text-sm font-medium">{tab.label}</div>
                    <div className="text-[11px]">{tab.description}</div>
                  </button>
                );
              })}
            </div>

            {activeTab === "connection" ? (
              <section className="rounded-2xl border border-border bg-card p-5">
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Backend Connection</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Choose whether this shell talks to its default local backend or a saved remote
                  backend. Remote profiles are intended for trusted LAN, VPN, or Tailnet access in
                  this v1.
                </p>
                {isFrontendOnlyShell ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    This shell is running in frontend-only mode. It does not start a local backend,
                    so connect it to a saved remote backend profile.
                  </p>
                ) : null}
              </div>

              <div className="space-y-4">
                <div className="rounded-xl border border-border bg-background/60 p-4">
                  <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                    <div className="space-y-1">
                      <p className="text-sm font-medium text-foreground">{activeBackendLabel}</p>
                      <p className="text-xs text-muted-foreground">
                        Active endpoint:{" "}
                        <code className="text-foreground">{activeBackendConnection.wsUrl}</code>
                      </p>
                    </div>
                    {!isFrontendOnlyShell ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={
                          isApplyingBackendConnection || settings.backendSelection.mode === "local"
                        }
                        onClick={activateLocalBackend}
                      >
                        {isApplyingBackendConnection && settings.backendSelection.mode === "remote"
                          ? "Switching..."
                          : "Use local backend"}
                      </Button>
                    ) : null}
                  </div>
                </div>

                <div className="rounded-xl border border-border bg-background/50 p-4">
                  <div className="mb-4 flex items-start justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-medium text-foreground">Discovered backends</h3>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Browse Bonjour-advertised backends on your local network and connect
                        without typing host or port details.
                      </p>
                    </div>
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={!discoverySupported || isDiscoveringBackends}
                      onClick={() => void refreshDiscoveredBackends()}
                    >
                      {isDiscoveringBackends ? "Refreshing..." : "Refresh"}
                    </Button>
                  </div>

                  {discoverySupported ? (
                    <div className="space-y-3">
                      {discoveryError ? (
                        <p className="text-xs text-destructive">{discoveryError}</p>
                      ) : null}

                      {discoveredBackends.length > 0 ? (
                        <div className="space-y-2">
                          {discoveredBackends.map((backend) => {
                            const isActiveDiscoveredBackend = isDiscoveredBackendSelected(
                              settings.backendSelection,
                              backend,
                            );
                            return (
                              <div
                                key={`${backend.protocol}:${backend.host}:${backend.port}`}
                                className="flex flex-col gap-3 rounded-lg border border-border bg-background px-3 py-3 md:flex-row md:items-center md:justify-between"
                              >
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center gap-2">
                                    <p className="truncate text-sm font-medium text-foreground">
                                      {backend.name}
                                    </p>
                                    {isActiveDiscoveredBackend ? (
                                      <span className="rounded bg-primary/12 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">
                                        Active
                                      </span>
                                    ) : null}
                                  </div>
                                  <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">
                                    {buildRemoteBackendWsUrl(backend)}
                                  </p>
                                </div>

                                <Button
                                  size="xs"
                                  variant={isActiveDiscoveredBackend ? "secondary" : "outline"}
                                  disabled={isApplyingBackendConnection || isActiveDiscoveredBackend}
                                  onClick={() => activateDiscoveredBackend(backend)}
                                >
                                  {isApplyingBackendConnection && !isActiveDiscoveredBackend
                                    ? "Connecting..."
                                    : isActiveDiscoveredBackend
                                      ? "Connected"
                                      : "Connect"}
                                </Button>
                              </div>
                            );
                          })}
                        </div>
                      ) : (
                        <div className="rounded-lg border border-dashed border-border bg-background px-3 py-4 text-xs text-muted-foreground">
                          {isDiscoveringBackends
                            ? "Looking for Bonjour backends on your network..."
                            : "No Bonjour backends found right now."}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="rounded-lg border border-dashed border-border bg-background px-3 py-4 text-xs text-muted-foreground">
                      Bonjour discovery is available in the desktop and iOS shells. Browser-only
                      sessions can still connect with manual backend profiles below.
                    </div>
                  )}
                </div>

                <div className="rounded-xl border border-border bg-background/50 p-4">
                  <div className="mb-4">
                    <h3 className="text-sm font-medium text-foreground">Saved remote profiles</h3>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Enter a backend host and port manually if you do not want to rely on local
                      network discovery.
                    </p>
                  </div>

                  <div className="space-y-3">
                    <div className="grid gap-3 md:grid-cols-2">
                      <label htmlFor="remote-backend-name" className="block space-y-1">
                        <span className="text-xs font-medium text-foreground">Profile name</span>
                        <Input
                          id="remote-backend-name"
                          value={remoteProfileName}
                          onChange={(event) => {
                            setRemoteProfileName(event.target.value);
                            if (remoteProfileError) {
                              setRemoteProfileError(null);
                            }
                          }}
                          placeholder="Studio Mac mini"
                          spellCheck={false}
                        />
                      </label>

                      <label htmlFor="remote-backend-host" className="block space-y-1">
                        <span className="text-xs font-medium text-foreground">Host or IP</span>
                        <Input
                          id="remote-backend-host"
                          value={remoteProfileHost}
                          onChange={(event) => {
                            setRemoteProfileHost(event.target.value);
                            if (remoteProfileError) {
                              setRemoteProfileError(null);
                            }
                          }}
                          placeholder="192.168.1.42"
                          spellCheck={false}
                        />
                      </label>
                    </div>

                    <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,160px)_auto] md:items-end">
                      <label htmlFor="remote-backend-port" className="block space-y-1">
                        <span className="text-xs font-medium text-foreground">Port</span>
                        <Input
                          id="remote-backend-port"
                          inputMode="numeric"
                          value={remoteProfilePort}
                          onChange={(event) => {
                            setRemoteProfilePort(event.target.value);
                            if (remoteProfileError) {
                              setRemoteProfileError(null);
                            }
                          }}
                          placeholder="3773"
                          spellCheck={false}
                        />
                      </label>

                      <label className="block space-y-1">
                        <span className="text-xs font-medium text-foreground">Protocol</span>
                        <Select
                          items={[
                            { label: "ws://", value: "ws" },
                            { label: "wss://", value: "wss" },
                          ]}
                          value={remoteProfileProtocol}
                          onValueChange={(value) => {
                            if (value !== "ws" && value !== "wss") return;
                            setRemoteProfileProtocol(value);
                          }}
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectPopup alignItemWithTrigger={false}>
                            <SelectItem value="ws">ws://</SelectItem>
                            <SelectItem value="wss">wss://</SelectItem>
                          </SelectPopup>
                        </Select>
                      </label>

                      <Button type="button" onClick={saveRemoteBackendProfile}>
                        Save profile
                      </Button>
                    </div>

                    {remoteProfileError ? (
                      <p className="text-xs text-destructive">{remoteProfileError}</p>
                    ) : null}

                    {remoteBackendProfiles.length > 0 ? (
                      <div className="space-y-2">
                        {remoteBackendProfiles.map((profile) => {
                          const isActiveRemote =
                            settings.backendSelection.mode === "remote" &&
                            settings.backendSelection.profileId === profile.id;
                          return (
                            <div
                              key={profile.id}
                              className="flex flex-col gap-3 rounded-lg border border-border bg-background px-3 py-3 md:flex-row md:items-center md:justify-between"
                            >
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2">
                                  <p className="truncate text-sm font-medium text-foreground">
                                    {profile.name}
                                  </p>
                                  {isActiveRemote ? (
                                    <span className="rounded bg-primary/12 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">
                                      Active
                                    </span>
                                  ) : null}
                                </div>
                                <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">
                                  {buildRemoteBackendWsUrl(profile)}
                                </p>
                              </div>

                              <div className="flex items-center gap-2">
                                <Button
                                  size="xs"
                                  variant={isActiveRemote ? "secondary" : "outline"}
                                  disabled={isApplyingBackendConnection || isActiveRemote}
                                  onClick={() => activateRemoteBackend(profile.id)}
                                >
                                  {isApplyingBackendConnection && !isActiveRemote
                                    ? "Connecting..."
                                    : isActiveRemote
                                      ? "Connected"
                                      : "Connect"}
                                </Button>
                                <Button
                                  size="xs"
                                  variant="ghost"
                                  disabled={isApplyingBackendConnection}
                                  onClick={() => removeRemoteBackendProfile(profile.id)}
                                >
                                  Remove
                                </Button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="rounded-lg border border-dashed border-border bg-background px-3 py-4 text-xs text-muted-foreground">
                        No remote backend profiles saved yet.
                      </div>
                    )}
                  </div>
                </div>
              </div>
              </section>
            ) : null}

            <Dialog
              open={isAddOpenCodeDelegateDialogOpen}
              onOpenChange={(open) => {
                setIsAddOpenCodeDelegateDialogOpen(open);
                if (!open) {
                  setOpenCodeDelegateSearchQuery("");
                }
              }}
            >
              <DialogPopup>
                <DialogHeader>
                  <DialogTitle>Add OpenCode Delegate</DialogTitle>
                  <DialogDescription>
                    Search the OpenCode provider catalog and add only the delegates you want to manage in Preferences.
                  </DialogDescription>
                </DialogHeader>
                <DialogPanel className="space-y-4">
                  <label htmlFor="opencode-delegate-search" className="block space-y-1">
                    <span className="text-xs font-medium text-foreground">Search delegates</span>
                    <Input
                      id="opencode-delegate-search"
                      value={openCodeDelegateSearchQuery}
                      onChange={(event) => setOpenCodeDelegateSearchQuery(event.target.value)}
                      placeholder="Search by provider name or ID"
                      spellCheck={false}
                    />
                  </label>

                  <div className="max-h-96 space-y-2 overflow-y-auto">
                    {filteredAvailableOpenCodeDelegatedProviders.map((provider) => (
                      <button
                        key={provider.id}
                        type="button"
                        className="flex w-full items-center justify-between gap-3 rounded-xl border border-border bg-background/60 px-4 py-3 text-left transition hover:bg-accent"
                        onClick={() => addOpenCodeDelegate(provider.id)}
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-sm font-medium text-foreground">
                              {provider.name}
                            </span>
                            {provider.connected ? (
                              <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-600">
                                Connected
                              </span>
                            ) : null}
                          </div>
                          <p className="mt-1 truncate text-xs text-muted-foreground">
                            Provider ID: <code>{provider.id}</code>
                          </p>
                        </div>
                        <span className="shrink-0 text-xs font-medium text-foreground">Add</span>
                      </button>
                    ))}

                    {filteredAvailableOpenCodeDelegatedProviders.length === 0 ? (
                      <div className="rounded-lg border border-dashed border-border px-3 py-4 text-xs text-muted-foreground">
                        No matching delegates found.
                      </div>
                    ) : null}
                  </div>
                </DialogPanel>
              </DialogPopup>
            </Dialog>

            {activeTab === "interface" ? (
              <section className="rounded-2xl border border-border bg-card p-5">
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Appearance</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Choose how T3 Code handles theme and font sizing across the shell.
                </p>
              </div>

              <div className="space-y-2" role="radiogroup" aria-label="Theme preference">
                {THEME_OPTIONS.map((option) => {
                  const selected = theme === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      className={`flex w-full items-start justify-between rounded-lg border px-3 py-2 text-left transition-colors ${
                        selected
                          ? "border-primary/60 bg-primary/8 text-foreground"
                          : "border-border bg-background text-muted-foreground hover:bg-accent"
                      }`}
                      onClick={() => setTheme(option.value)}
                    >
                      <span className="flex flex-col">
                        <span className="text-sm font-medium">{option.label}</span>
                        <span className="text-xs">{option.description}</span>
                      </span>
                      {selected ? (
                        <span className="rounded bg-primary/14 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">
                          Selected
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>

              <p className="mt-4 text-xs text-muted-foreground">
                Active theme: <span className="font-medium text-foreground">{resolvedTheme}</span>
              </p>

              <div className="mt-5 grid gap-4 md:grid-cols-3">
                {APPEARANCE_FONT_CONTEXT_OPTIONS.map((option) => (
                  <label key={option.key} className="block space-y-1">
                    <span className="text-xs font-medium text-foreground">{option.label}</span>
                    <Select
                      value={settings[option.key]}
                      onValueChange={(value) => {
                        updateSettings({
                          [option.key]: value,
                        } as Pick<AppSettings, typeof option.key>);
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectPopup>
                        {APP_FONT_SCALE_OPTIONS.map((scaleOption) => (
                          <SelectItem key={scaleOption.value} value={scaleOption.value}>
                            {scaleOption.label}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                    <span className="text-xs text-muted-foreground">
                      {option.description}{" "}
                      <span className="font-medium text-foreground/80">
                        {Math.round(resolveAppFontScale(settings[option.key]) * 100)}%
                      </span>
                    </span>
                  </label>
                ))}
              </div>
              </section>
            ) : null}

            {activeTab === "codex" ? (
              <section className="rounded-2xl border border-border bg-card p-5">
                <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="text-sm font-medium text-foreground">Codex App Server</h2>
                    <p className="mt-1 text-xs text-muted-foreground">
                      These overrides apply to new sessions and let you use a non-default Codex install.
                    </p>
                  </div>
                  <ProviderConnectionBadge
                    connected={isProviderConnected(codexProviderStatus)}
                    label={getProviderConnectionLabel(codexProviderStatus)}
                  />
                </div>

              <div className="space-y-4">
                <label htmlFor="codex-binary-path" className="block space-y-1">
                  <span className="text-xs font-medium text-foreground">Codex binary path</span>
                  <Input
                    id="codex-binary-path"
                    value={codexBinaryPath}
                    onChange={(event) => updateSettings({ codexBinaryPath: event.target.value })}
                    placeholder="codex"
                    spellCheck={false}
                  />
                  <span className="text-xs text-muted-foreground">
                    Leave blank to use <code>codex</code> from your PATH.
                  </span>
                </label>

                <label htmlFor="codex-home-path" className="block space-y-1">
                  <span className="text-xs font-medium text-foreground">CODEX_HOME path</span>
                  <Input
                    id="codex-home-path"
                    value={codexHomePath}
                    onChange={(event) => updateSettings({ codexHomePath: event.target.value })}
                    placeholder="/Users/you/.codex"
                    spellCheck={false}
                  />
                  <span className="text-xs text-muted-foreground">
                    Optional custom Codex home/config directory.
                  </span>
                </label>

                <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                  <p>
                    Binary source:{" "}
                    <span className="font-medium text-foreground">{codexBinaryPath || "PATH"}</span>
                  </p>
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() =>
                      updateSettings({
                        codexBinaryPath: defaults.codexBinaryPath,
                        codexHomePath: defaults.codexHomePath,
                      })
                    }
                  >
                    Reset codex overrides
                  </Button>
                </div>
              </div>
              </section>
            ) : null}

            {activeTab === "codex" ? (
              <div className="space-y-5">
              <section className="rounded-2xl border border-border bg-card p-5">
                <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="text-sm font-medium text-foreground">OpenCode</h2>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Configure the OpenCode binary and delegated provider auth, including OpenRouter.
                    </p>
                  </div>
                  <ProviderConnectionBadge
                    connected={isProviderConnected(openCodeProviderStatus)}
                    label={getProviderConnectionLabel(openCodeProviderStatus)}
                  />
                </div>

                <div className="space-y-5">
                <label htmlFor="opencode-binary-path" className="block space-y-1">
                  <span className="text-xs font-medium text-foreground">OpenCode binary path</span>
                  <Input
                    id="opencode-binary-path"
                    value={openCodeBinaryPath}
                    onChange={(event) => updateSettings({ opencodeBinaryPath: event.target.value })}
                    placeholder="opencode"
                    spellCheck={false}
                  />
                  <span className="text-xs text-muted-foreground">
                    Leave blank to use <code>opencode</code> from your PATH.
                  </span>
                </label>

                <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                  <p>
                    Visible delegated providers:{" "}
                    <span className="font-medium text-foreground">
                      {openCodeCatalogQuery.isLoading ? "Loading..." : visibleOpenCodeDelegatedProviders.length}
                    </span>
                    {" / "}
                    <span className="font-medium text-foreground">
                      {openCodeCatalogQuery.isLoading ? "..." : openCodeDelegatedProviders.length}
                    </span>
                    {" · "}Models:{" "}
                    <span className="font-medium text-foreground">{openCodeModelCount}</span>
                  </p>
                  <div className="flex items-center gap-2">
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => setIsAddOpenCodeDelegateDialogOpen(true)}
                    >
                      <PlusIcon className="size-3.5" />
                      Add Delegate
                    </Button>
                    <Button size="xs" variant="outline" onClick={() => void refreshOpenCodeCatalog()}>
                      Refresh OpenCode catalog
                    </Button>
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => updateSettings({ opencodeBinaryPath: defaults.opencodeBinaryPath })}
                    >
                      Reset OpenCode path
                    </Button>
                  </div>
                </div>

                {openCodeCatalogQuery.error ? (
                  <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-3 text-xs text-destructive">
                    {openCodeCatalogQuery.error instanceof Error
                      ? openCodeCatalogQuery.error.message
                      : "Failed to load the OpenCode catalog."}
                  </div>
                ) : null}

                <div className="space-y-3">
                  {visibleOpenCodeDelegatedProviders.map((provider) => {
                    const authError = openCodeAuthErrorByProvider[provider.id];
                    const isBusy = openCodeAuthBusyByProvider[provider.id] ?? false;
                    return (
                      <div
                        key={provider.id}
                        className="rounded-xl border border-border bg-background/50 p-4"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <div>
                            <div className="flex items-center gap-2">
                              <h3 className="text-sm font-medium text-foreground">{provider.name}</h3>
                              <span
                                className={
                                  provider.connected
                                    ? "rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-600"
                                    : "rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
                                }
                              >
                                {provider.connected ? "Connected" : "Not connected"}
                              </span>
                            </div>
                            <p className="mt-1 text-xs text-muted-foreground">
                              Provider ID: <code>{provider.id}</code>
                              {provider.defaultModelSlug ? (
                                <>
                                  {" · "}Default model: <code>{provider.defaultModelSlug}</code>
                                </>
                              ) : null}
                            </p>
                          </div>
                          <Button
                            size="xs"
                            variant="ghost"
                            onClick={() => removeOpenCodeDelegate(provider.id)}
                          >
                            <Trash2Icon className="size-3.5" />
                            Remove delegate
                          </Button>
                        </div>

                        <div className="mt-4 space-y-3">
                          {provider.authMethods.map((method, methodIndex) =>
                            method.type === "api" ? (
                              <div
                                key={`${provider.id}:${method.type}:${method.label}`}
                                className="space-y-2"
                              >
                                <label className="block space-y-1">
                                  <span className="text-xs font-medium text-foreground">{method.label}</span>
                                  <Input
                                    type="password"
                                    value={openCodeApiKeysByProvider[provider.id] ?? ""}
                                    onChange={(event) =>
                                      setOpenCodeApiKeysByProvider((existing) => ({
                                        ...existing,
                                        [provider.id]: event.target.value,
                                      }))
                                    }
                                    placeholder="Paste provider API key"
                                    spellCheck={false}
                                  />
                                </label>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={isBusy}
                                  onClick={() => void saveOpenCodeApiKey(provider.id)}
                                >
                                  Save API key
                                </Button>
                              </div>
                            ) : (
                              <div
                                key={`${provider.id}:${method.type}:${method.label}`}
                                className="space-y-2"
                              >
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className="text-xs font-medium text-foreground">{method.label}</span>
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    disabled={isBusy}
                                    onClick={() => void startOpenCodeOauth(provider.id, methodIndex)}
                                  >
                                    Start OAuth
                                  </Button>
                                </div>
                                <div className="flex flex-col gap-2 sm:flex-row">
                                  <Input
                                    value={openCodeOauthCodesByProvider[provider.id] ?? ""}
                                    onChange={(event) =>
                                      setOpenCodeOauthCodesByProvider((existing) => ({
                                        ...existing,
                                        [provider.id]: event.target.value,
                                      }))
                                    }
                                    placeholder="Paste OAuth code if required"
                                    spellCheck={false}
                                  />
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    disabled={isBusy}
                                    onClick={() => void completeOpenCodeOauth(provider.id, methodIndex)}
                                  >
                                    Complete OAuth
                                  </Button>
                                </div>
                              </div>
                            ),
                          )}

                          {provider.authMethods.length === 0 ? (
                            <div className="rounded-lg border border-dashed border-border px-3 py-3 text-xs text-muted-foreground">
                              No explicit auth methods reported for this delegated provider.
                            </div>
                          ) : null}

                          {authError ? (
                            <p className="text-xs text-destructive">{authError}</p>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}

                  {visibleOpenCodeDelegatedProviders.length === 0 && !openCodeCatalogQuery.isLoading ? (
                    <div className="rounded-lg border border-dashed border-border px-3 py-4 text-xs text-muted-foreground">
                      No delegates are currently shown in Preferences. Use <span className="font-medium text-foreground">Add Delegate</span> to configure one.
                    </div>
                  ) : null}
                </div>

              </div>
              </section>

              <section className="rounded-2xl border border-border bg-card p-5">
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">JCodeMunch</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Optional project context retrieval. When enabled, T3 asks JCodeMunch for a compact
                  semantic code context before sending a turn, so models can stay more token efficient.
                </p>
              </div>

              <div className="space-y-4">
                <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-background/50 px-4 py-3">
                  <div className="space-y-1">
                    <p className="text-sm font-medium text-foreground">Enable JCodeMunch retrieval</p>
                    <p className="text-xs text-muted-foreground">
                      Turns continue to work normally when this is off or unavailable.
                    </p>
                  </div>
                  <Switch
                    checked={jcodemunchEnabled}
                    onCheckedChange={(checked) => updateSettings({ jcodemunchEnabled: checked })}
                  />
                </div>

                <label htmlFor="jcodemunch-binary-path" className="block space-y-1">
                  <span className="text-xs font-medium text-foreground">JCodeMunch executable path</span>
                  <Input
                    id="jcodemunch-binary-path"
                    value={jcodemunchBinaryPath}
                    onChange={(event) =>
                      updateSettings({ jcodemunchBinaryPath: event.target.value })
                    }
                    placeholder="/absolute/path/to/jcodemunch-mcp"
                    spellCheck={false}
                  />
                  <span className="text-xs text-muted-foreground">
                    Point this at the JCodeMunch MCP server executable or wrapper script. T3 only
                    uses it when the integration is enabled.
                  </span>
                </label>

                <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                  <p>
                    Status:{" "}
                    <span className="font-medium text-foreground">
                      {jcodemunchEnabled
                        ? jcodemunchBinaryPath.trim()
                          ? "Enabled"
                          : "Enabled, but binary path missing"
                        : "Disabled"}
                    </span>
                  </p>
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() =>
                      updateSettings({
                        jcodemunchEnabled: defaults.jcodemunchEnabled,
                        jcodemunchBinaryPath: defaults.jcodemunchBinaryPath,
                      })
                    }
                  >
                    Reset JCodeMunch settings
                  </Button>
                </div>
              </div>
              </section>

              <section className="rounded-2xl border border-border bg-card p-5">
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Models</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Save additional provider model slugs so they appear in the chat model picker and
                  `/model` command suggestions. OpenCode delegate models are managed here by
                  delegate instead of through the generic OpenCode settings.
                </p>
              </div>

              <div className="space-y-5">
                <label className="block space-y-1">
                  <span className="text-xs font-medium text-foreground">Default service tier</span>
                  <Select
                    items={APP_SERVICE_TIER_OPTIONS.map((option) => ({
                      label: option.label,
                      value: option.value,
                    }))}
                    value={codexServiceTier}
                    onValueChange={(value) => {
                      if (!value) return;
                      updateSettings({ codexServiceTier: value });
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectPopup alignItemWithTrigger={false}>
                      {APP_SERVICE_TIER_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          <div className="flex min-w-0 items-center gap-2">
                            {option.value === "fast" ? (
                              <ZapIcon className="size-3.5 text-amber-500" />
                            ) : (
                              <span className="size-3.5 shrink-0" aria-hidden="true" />
                            )}
                            <span className="truncate">{option.label}</span>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                  <span className="text-xs text-muted-foreground">
                    {APP_SERVICE_TIER_OPTIONS.find((option) => option.value === codexServiceTier)
                      ?.description ?? "Use Codex defaults without forcing a service tier."}
                  </span>
                </label>

                {MODEL_PROVIDER_SETTINGS.map((providerSettings) => {
                  const provider = providerSettings.provider;
                  const customModels = getCustomModelsForProvider(settings, provider);
                  const customModelInput = customModelInputByProvider[provider];
                  const customModelError = customModelErrorByProvider[provider] ?? null;
                  return (
                    <div
                      key={provider}
                      className="rounded-xl border border-border bg-background/50 p-4"
                    >
                      <div className="mb-4">
                        <h3 className="text-sm font-medium text-foreground">
                          {providerSettings.title}
                        </h3>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {providerSettings.description}
                        </p>
                      </div>

                      <div className="space-y-4">
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
                          <label
                            htmlFor={`custom-model-slug-${provider}`}
                            className="block flex-1 space-y-1"
                          >
                            <span className="text-xs font-medium text-foreground">
                              Custom model slug
                            </span>
                            <Input
                              id={`custom-model-slug-${provider}`}
                              value={customModelInput}
                              onChange={(event) => {
                                const value = event.target.value;
                                setCustomModelInputByProvider((existing) => ({
                                  ...existing,
                                  [provider]: value,
                                }));
                                if (customModelError) {
                                  setCustomModelErrorByProvider((existing) => ({
                                    ...existing,
                                    [provider]: null,
                                  }));
                                }
                              }}
                              onKeyDown={(event) => {
                                if (event.key !== "Enter") return;
                                event.preventDefault();
                                addCustomModel(provider);
                              }}
                              placeholder={providerSettings.placeholder}
                              spellCheck={false}
                            />
                            <span className="text-xs text-muted-foreground">
                              Example: <code>{providerSettings.example}</code>
                            </span>
                          </label>

                          <Button
                            className="sm:mt-6"
                            type="button"
                            onClick={() => addCustomModel(provider)}
                          >
                            Add model
                          </Button>
                        </div>

                        {customModelError ? (
                          <p className="text-xs text-destructive">{customModelError}</p>
                        ) : null}

                        <div className="space-y-2">
                          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                            <p>Saved custom models: {customModels.length}</p>
                            {customModels.length > 0 ? (
                              <Button
                                size="xs"
                                variant="outline"
                                onClick={() =>
                                  updateSettings(
                                    patchCustomModels(provider, [
                                      ...getDefaultCustomModelsForProvider(defaults, provider),
                                    ]),
                                  )
                                }
                              >
                                Reset custom models
                              </Button>
                            ) : null}
                          </div>

                          {customModels.length > 0 ? (
                            <div className="space-y-2">
                              {customModels.map((slug) => (
                                <div
                                  key={`${provider}:${slug}`}
                                  className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background px-3 py-2"
                                >
                                  <div className="flex min-w-0 flex-1 items-center gap-2">
                                    {provider === "codex" &&
                                    shouldShowFastTierIcon(slug, codexServiceTier) ? (
                                      <ZapIcon className="size-3.5 shrink-0 text-amber-500" />
                                    ) : null}
                                    <code className="min-w-0 flex-1 truncate text-xs text-foreground">
                                      {slug}
                                    </code>
                                  </div>
                                  <Button
                                    size="xs"
                                    variant="ghost"
                                    onClick={() => removeCustomModel(provider, slug)}
                                  >
                                    Remove
                                  </Button>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <div className="rounded-lg border border-dashed border-border bg-background px-3 py-4 text-xs text-muted-foreground">
                              No custom models saved yet.
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}

                <div className="rounded-xl border border-border bg-background/50 p-4">
                  <div className="mb-4">
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-medium text-foreground">OpenRouter</h3>
                      <span
                        className={
                          openRouterProviderConnected
                            ? "rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-600"
                            : "rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
                        }
                      >
                        {openRouterProviderConnected ? "Connected" : "API key not verified"}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Add the OpenRouter model slugs you want T3 to expose through OpenCode. Use
                      the OpenRouter website format <code>provider:model</code>. T3 adds the
                      OpenRouter prefix internally.
                    </p>
                  </div>

                  <div className="space-y-4">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
                      <label htmlFor="openrouter-model-slug" className="block flex-1 space-y-1">
                        <span className="text-xs font-medium text-foreground">
                          OpenRouter model slug
                        </span>
                        <Input
                          id="openrouter-model-slug"
                          value={openRouterModelInput}
                          onChange={(event) => {
                            setOpenRouterModelInput(event.target.value);
                            if (openRouterModelError) {
                              setOpenRouterModelError(null);
                            }
                          }}
                          onKeyDown={(event) => {
                            if (event.key !== "Enter") return;
                            event.preventDefault();
                            addOpenRouterModel();
                          }}
                          placeholder="openai:gpt-4.1-mini"
                          spellCheck={false}
                        />
                        <span className="text-xs text-muted-foreground">
                          Example: <code>anthropic:claude-3.7-sonnet</code>
                        </span>
                      </label>

                      <Button className="sm:mt-6" type="button" onClick={addOpenRouterModel}>
                        Add OpenRouter model
                      </Button>
                    </div>

                    {openRouterModelError ? (
                      <p className="text-xs text-destructive">{openRouterModelError}</p>
                    ) : null}

                    <div className="space-y-2">
                      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                        <p>Saved OpenRouter models: {openRouterCustomModels.length}</p>
                        {openRouterCustomModels.length > 0 ? (
                          <Button
                            size="xs"
                            variant="outline"
                            onClick={() =>
                              updateSettings({
                                customOpenCodeModels: settings.customOpenCodeModels.filter(
                                  (slug) => !slug.startsWith(OPENROUTER_MODEL_PREFIX),
                                ),
                              })
                            }
                          >
                            Reset OpenRouter models
                          </Button>
                        ) : null}
                      </div>

                      {openRouterCustomModels.length > 0 ? (
                        <div className="space-y-2">
                          {openRouterCustomModels.map((slug) => (
                            <div
                              key={slug}
                              className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background px-3 py-2"
                            >
                              <code className="min-w-0 flex-1 truncate text-xs text-foreground">
                                {stripOpenRouterModelPrefix(slug)}
                              </code>
                              <Button
                                size="xs"
                                variant="ghost"
                                onClick={() => removeOpenRouterModel(slug)}
                              >
                                Remove
                              </Button>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="rounded-lg border border-dashed border-border bg-background px-3 py-4 text-xs text-muted-foreground">
                          No OpenRouter models are currently exposed in T3. Add the ones you want
                          to use here.
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
              </section>
              </div>
            ) : null}

            {activeTab === "codex" ? (
              <section className="rounded-2xl border border-border bg-card p-5">
                <div className="mb-4">
                  <h2 className="text-sm font-medium text-foreground">Supervisor defaults</h2>
                  <p className="mt-1 text-xs text-muted-foreground">
                    New supervisor threads inherit these defaults for sub-agent model selection and
                    maximum concurrent child agents.
                  </p>
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  <label className="block space-y-1">
                    <span className="text-xs font-medium text-foreground">
                      Default sub-agent model
                    </span>
                    <Select
                      value={settings.defaultSupervisorChildModel ?? SUPERVISOR_MODEL_INHERIT_VALUE}
                      onValueChange={(value) => {
                        if (!value) return;
                        updateSettings({
                          defaultSupervisorChildModel:
                            value === SUPERVISOR_MODEL_INHERIT_VALUE
                              ? null
                              : resolveAppModelSelection(
                                  "codex",
                                  settings.customCodexModels,
                                  value,
                                ),
                        });
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectPopup alignItemWithTrigger={false}>
                        <SelectItem value={SUPERVISOR_MODEL_INHERIT_VALUE}>
                          Inherit supervisor model
                        </SelectItem>
                        {supervisorChildModelOptions.map((option) => (
                          <SelectItem key={option.slug} value={option.slug}>
                            {option.name}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                    <span className="text-xs text-muted-foreground">
                      If unset, child threads follow the supervisor thread&apos;s model.
                    </span>
                  </label>

                  <label className="block space-y-1">
                    <span className="text-xs font-medium text-foreground">
                      Max concurrent sub-agents
                    </span>
                    <Select
                      value={String(settings.defaultSupervisorMaxConcurrentChildren)}
                      onValueChange={(value) => {
                        if (!value) return;
                        const parsed = Number.parseInt(value, 10);
                        if (!Number.isFinite(parsed)) return;
                        updateSettings({
                          defaultSupervisorMaxConcurrentChildren: Math.min(
                            MAX_SUPERVISOR_MAX_CONCURRENT_CHILDREN,
                            Math.max(MIN_SUPERVISOR_MAX_CONCURRENT_CHILDREN, parsed),
                          ),
                        });
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectPopup alignItemWithTrigger={false}>
                        {Array.from(
                          {
                            length:
                              MAX_SUPERVISOR_MAX_CONCURRENT_CHILDREN -
                              MIN_SUPERVISOR_MAX_CONCURRENT_CHILDREN +
                              1,
                          },
                          (_, index) => {
                            const value = index + MIN_SUPERVISOR_MAX_CONCURRENT_CHILDREN;
                            return (
                              <SelectItem key={value} value={String(value)}>
                                {value}
                              </SelectItem>
                            );
                          },
                        )}
                      </SelectPopup>
                    </Select>
                    <span className="text-xs text-muted-foreground">
                      Default:{" "}
                      <span className="font-medium text-foreground">
                        {defaults.defaultSupervisorMaxConcurrentChildren ??
                          DEFAULT_SUPERVISOR_MAX_CONCURRENT_CHILDREN}
                      </span>
                    </span>
                  </label>
                </div>
              </section>
            ) : null}

            {activeTab === "interface" ? (
              <section className="rounded-2xl border border-border bg-card p-5">
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Responses</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Control how assistant output is rendered during a turn.
                </p>
              </div>

              <div className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2">
                <div>
                  <p className="text-sm font-medium text-foreground">Stream assistant messages</p>
                  <p className="text-xs text-muted-foreground">
                    Show token-by-token output while a response is in progress.
                  </p>
                </div>
                <Switch
                  checked={settings.enableAssistantStreaming}
                  onCheckedChange={(checked) =>
                    updateSettings({
                      enableAssistantStreaming: Boolean(checked),
                    })
                  }
                  aria-label="Stream assistant messages"
                />
              </div>

              {settings.enableAssistantStreaming !== defaults.enableAssistantStreaming ? (
                <div className="mt-3 flex justify-end">
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() =>
                      updateSettings({
                        enableAssistantStreaming: defaults.enableAssistantStreaming,
                      })
                    }
                  >
                    Restore default
                  </Button>
                </div>
              ) : null}
              </section>
            ) : null}

            {activeTab === "interface" ? (
              <section className="rounded-2xl border border-border bg-card p-5">
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Keybindings</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Open the persisted <code>keybindings.json</code> file to edit advanced bindings
                  directly.
                </p>
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium text-foreground">Config file path</p>
                    <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">
                      {keybindingsConfigPath ?? "Resolving keybindings path..."}
                    </p>
                  </div>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={!keybindingsConfigPath || isOpeningKeybindings}
                    onClick={openKeybindingsFile}
                  >
                    {isOpeningKeybindings ? "Opening..." : "Open keybindings.json"}
                  </Button>
                </div>

                <p className="text-xs text-muted-foreground">
                  Opens in your preferred editor selection.
                </p>
                {openKeybindingsError ? (
                  <p className="text-xs text-destructive">{openKeybindingsError}</p>
                ) : null}
              </div>
              </section>
            ) : null}

            {activeTab === "interface" ? (
              <section className="rounded-2xl border border-border bg-card p-5">
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Open tools</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Choose which installed tool should open file links and folder links from thread
                  output. The top-bar <code>Open</code> button still controls project-level opens
                  separately.
                </p>
              </div>

              <div className="space-y-4">
                <label className="block space-y-1">
                  <span className="text-xs font-medium text-foreground">Open file links with</span>
                  <Select
                    items={[
                      { value: AUTO_OPEN_TOOL_VALUE, label: "Automatic" },
                      ...availableFileToolOptions,
                    ]}
                    value={settings.defaultFileOpenTool ?? AUTO_OPEN_TOOL_VALUE}
                    onValueChange={(value) => {
                      if (!value) return;
                      updateSettings({
                        defaultFileOpenTool:
                          value === AUTO_OPEN_TOOL_VALUE ? null : (value as typeof settings.defaultFileOpenTool),
                      });
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectPopup alignItemWithTrigger={false}>
                      <SelectItem value={AUTO_OPEN_TOOL_VALUE}>Automatic</SelectItem>
                      {availableFileToolOptions.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                  <span className="text-xs text-muted-foreground">
                    Automatic uses your preferred editor if no explicit tool is selected.
                  </span>
                </label>

                <label className="block space-y-1">
                  <span className="text-xs font-medium text-foreground">
                    Open folder links with
                  </span>
                  <Select
                    items={[
                      { value: AUTO_OPEN_TOOL_VALUE, label: "Automatic" },
                      ...availableFolderToolOptions,
                    ]}
                    value={settings.defaultFolderOpenTool ?? AUTO_OPEN_TOOL_VALUE}
                    onValueChange={(value) => {
                      if (!value) return;
                      updateSettings({
                        defaultFolderOpenTool:
                          value === AUTO_OPEN_TOOL_VALUE ? null : (value as typeof settings.defaultFolderOpenTool),
                      });
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectPopup alignItemWithTrigger={false}>
                      <SelectItem value={AUTO_OPEN_TOOL_VALUE}>Automatic</SelectItem>
                      {availableFolderToolOptions.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                  <span className="text-xs text-muted-foreground">
                    Folder links can open in an editor, Finder/Files, or a terminal app such as
                    Warp.
                  </span>
                </label>
              </div>
              </section>
            ) : null}

            {activeTab === "interface" ? (
              <section className="rounded-2xl border border-border bg-card p-5">
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Safety</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Additional guardrails for destructive local actions.
                </p>
              </div>

              <div className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2">
                <div>
                  <p className="text-sm font-medium text-foreground">Confirm thread deletion</p>
                  <p className="text-xs text-muted-foreground">
                    Ask for confirmation before deleting a thread and its chat history.
                  </p>
                </div>
                <Switch
                  checked={settings.confirmThreadDelete}
                  onCheckedChange={(checked) =>
                    updateSettings({
                      confirmThreadDelete: Boolean(checked),
                    })
                  }
                  aria-label="Confirm thread deletion"
                />
              </div>

              {settings.confirmThreadDelete !== defaults.confirmThreadDelete ? (
                <div className="mt-3 flex justify-end">
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() =>
                      updateSettings({
                        confirmThreadDelete: defaults.confirmThreadDelete,
                      })
                    }
                  >
                    Restore default
                  </Button>
                </div>
              ) : null}
              </section>
            ) : null}
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/settings")({
  component: SettingsRouteView,
});
