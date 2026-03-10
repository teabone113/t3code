import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
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
import { ZapIcon } from "lucide-react";

import {
  APP_FONT_SCALE_OPTIONS,
  APP_SERVICE_TIER_OPTIONS,
  resolveAppFontScale,
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
import { serverConfigQueryOptions } from "../lib/serverReactQuery";
import { isMacPlatform, isWindowsPlatform } from "../lib/utils";
import { ensureNativeApi, resetNativeApi } from "../nativeApi";
import { preferredPathOpenInput } from "../terminal-links";
import { Button } from "../components/ui/button";
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
    default:
      return defaults.customCodexModels;
  }
}

function patchCustomModels(provider: ProviderKind, models: string[]) {
  switch (provider) {
    case "codex":
    default:
      return { customCodexModels: models };
  }
}

function SettingsRouteView() {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const { settings, defaults, updateSettings } = useAppSettings();
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const [isOpeningKeybindings, setIsOpeningKeybindings] = useState(false);
  const [openKeybindingsError, setOpenKeybindingsError] = useState<string | null>(null);
  const [customModelInputByProvider, setCustomModelInputByProvider] = useState<
    Record<ProviderKind, string>
  >({
    codex: "",
  });
  const [customModelErrorByProvider, setCustomModelErrorByProvider] = useState<
    Partial<Record<ProviderKind, string | null>>
  >({});
  const [remoteProfileName, setRemoteProfileName] = useState("");
  const [remoteProfileHost, setRemoteProfileHost] = useState("");
  const [remoteProfilePort, setRemoteProfilePort] = useState("3773");
  const [remoteProfileProtocol, setRemoteProfileProtocol] = useState<BackendProtocol>("ws");
  const [remoteProfileError, setRemoteProfileError] = useState<string | null>(null);
  const [isApplyingBackendConnection, setIsApplyingBackendConnection] = useState(false);
  const [discoveredBackends, setDiscoveredBackends] = useState<DiscoveredBackend[]>([]);
  const [isDiscoveringBackends, setIsDiscoveringBackends] = useState(false);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);

  const codexBinaryPath = settings.codexBinaryPath;
  const codexHomePath = settings.codexHomePath;
  const codexServiceTier = settings.codexServiceTier;
  const keybindingsConfigPath = serverConfigQuery.data?.keybindingsConfigPath ?? null;
  const availableEditors = serverConfigQuery.data?.availableEditors ?? [];
  const availableTerminalApps = serverConfigQuery.data?.availableTerminalApps ?? [];
  const platform = typeof navigator === "undefined" ? "" : navigator.platform;
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
  const remoteBackendProfiles = settings.remoteBackendProfiles;
  const activeBackendConnection = resolveBackendConnection();
  const startupRole = window.desktopBridge?.getStartupRole?.() ?? null;
  const isFrontendOnlyShell = isCapacitorShell() || startupRole === "frontend-only";
  const discoverySupported = supportsBackendDiscovery();
  const activeBackendLabel = resolveBackendSelectionLabel(
    settings.backendSelection,
    remoteBackendProfiles,
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

  const addCustomModel = useCallback(
    (provider: ProviderKind) => {
      const customModelInput = customModelInputByProvider[provider];
      const customModels = getCustomModelsForProvider(settings, provider);
      const normalized = normalizeModelSlug(customModelInput, provider);
      if (!normalized) {
        setCustomModelErrorByProvider((existing) => ({
          ...existing,
          [provider]: "Enter a model slug.",
        }));
        return;
      }
      if (getModelOptions(provider).some((option) => option.slug === normalized)) {
        setCustomModelErrorByProvider((existing) => ({
          ...existing,
          [provider]: "That model is already built in.",
        }));
        return;
      }
      if (normalized.length > MAX_CUSTOM_MODEL_LENGTH) {
        setCustomModelErrorByProvider((existing) => ({
          ...existing,
          [provider]: `Model slugs must be ${MAX_CUSTOM_MODEL_LENGTH} characters or less.`,
        }));
        return;
      }
      if (customModels.includes(normalized)) {
        setCustomModelErrorByProvider((existing) => ({
          ...existing,
          [provider]: "That custom model is already saved.",
        }));
        return;
      }

      updateSettings(patchCustomModels(provider, [...customModels, normalized]));
      setCustomModelInputByProvider((existing) => ({
        ...existing,
        [provider]: "",
      }));
      setCustomModelErrorByProvider((existing) => ({
        ...existing,
        [provider]: null,
      }));
    },
    [customModelInputByProvider, settings, updateSettings],
  );

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

            <section className="rounded-2xl border border-border bg-card p-5">
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Codex App Server</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  These overrides apply to new sessions and let you use a non-default Codex install.
                </p>
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

            <section className="rounded-2xl border border-border bg-card p-5">
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Models</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Save additional provider model slugs so they appear in the chat model picker and
                  `/model` command suggestions.
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
              </div>
            </section>

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
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/settings")({
  component: SettingsRouteView,
});
