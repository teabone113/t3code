import type { BackendSelection, RemoteBackendProfile } from "@t3tools/contracts";

import { getAppSettingsSnapshot } from "./appSettings";

export interface ResolvedBackendConnection {
  selection: BackendSelection;
  wsUrl: string;
  httpOrigin: string;
  activeProfile: RemoteBackendProfile | null;
}

function parseDefaultWsCandidate(): string | null {
  const bridgeUrl = window.desktopBridge?.getWsUrl?.();
  const envWsUrl = import.meta.env.VITE_WS_URL as string | undefined;
  const wsCandidate =
    typeof bridgeUrl === "string" && bridgeUrl.length > 0
      ? bridgeUrl
      : typeof envWsUrl === "string" && envWsUrl.length > 0
        ? envWsUrl
        : null;
  return wsCandidate;
}

export function resolveDefaultBackendWsUrl(): string {
  if (typeof window === "undefined") {
    return "ws://127.0.0.1:3773";
  }

  const candidate = parseDefaultWsCandidate();
  if (candidate) {
    return candidate;
  }

  if (window.location.host && window.location.host.length > 0) {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${window.location.host}`;
  }

  return "ws://127.0.0.1:3773";
}

export function buildRemoteBackendWsUrl(profile: RemoteBackendProfile): string {
  return `${profile.protocol}://${profile.host}:${profile.port}`;
}

export function resolveHttpOriginFromWsUrl(wsUrl: string): string {
  if (typeof window === "undefined") {
    return "";
  }

  try {
    const parsed = new URL(wsUrl);
    const protocol =
      parsed.protocol === "wss:" ? "https:" : parsed.protocol === "ws:" ? "http:" : parsed.protocol;
    return `${protocol}//${parsed.host}`;
  } catch {
    return window.location.origin;
  }
}

export function resolveBackendConnection(): ResolvedBackendConnection {
  const settings = getAppSettingsSnapshot();
  const activeProfile =
    settings.backendSelection.mode === "remote"
      ? (settings.remoteBackendProfiles.find(
          (profile) => profile.id === settings.backendSelection.profileId,
        ) ?? null)
      : null;
  const wsUrl = activeProfile
    ? buildRemoteBackendWsUrl(activeProfile)
    : resolveDefaultBackendWsUrl();
  return {
    selection: activeProfile ? settings.backendSelection : { mode: "local", profileId: null },
    wsUrl,
    httpOrigin: resolveHttpOriginFromWsUrl(wsUrl),
    activeProfile,
  };
}

export function shouldBootToConnectionSettings(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  const settings = getAppSettingsSnapshot();
  const hasRemoteSelection =
    settings.backendSelection.mode === "remote" &&
    settings.remoteBackendProfiles.some(
      (profile) => profile.id === settings.backendSelection.profileId,
    );
  if (hasRemoteSelection) {
    return false;
  }

  const startupRole = window.desktopBridge?.getStartupRole?.();
  if (startupRole === "frontend-only") {
    return true;
  }

  const capacitor = window.Capacitor;
  return typeof capacitor?.isNativePlatform === "function" && capacitor.isNativePlatform();
}
