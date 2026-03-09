import type { BackendSelection, DiscoveredBackend, RemoteBackendProfile } from "@t3tools/contracts";

import { getAppSettingsSnapshot } from "./appSettings";
import { isCapacitorShell } from "./env";

export interface ResolvedBackendConnection {
  selection: BackendSelection;
  wsUrl: string;
  httpOrigin: string;
  activeProfile: RemoteBackendProfile | null;
  activeDiscoveredBackend: DiscoveredBackend | null;
}

interface RemoteBackendEndpoint {
  host: string;
  port: number;
  protocol: "ws" | "wss";
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

export function buildRemoteBackendWsUrl(profile: RemoteBackendEndpoint): string {
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
  const activeDiscoveredBackend =
    settings.backendSelection.mode === "remote"
      ? settings.backendSelection.discoveredBackend
      : null;
  const activeProfile =
    settings.backendSelection.mode === "remote" && activeDiscoveredBackend === null
      ? (settings.remoteBackendProfiles.find(
          (profile) => profile.id === settings.backendSelection.profileId,
        ) ?? null)
      : null;
  const activeRemoteEndpoint = activeDiscoveredBackend ?? activeProfile;
  const wsUrl = activeRemoteEndpoint
    ? buildRemoteBackendWsUrl(activeRemoteEndpoint)
    : resolveDefaultBackendWsUrl();

  return {
    selection:
      activeRemoteEndpoint !== null
        ? settings.backendSelection
        : { mode: "local", profileId: null, discoveredBackend: null },
    wsUrl,
    httpOrigin: resolveHttpOriginFromWsUrl(wsUrl),
    activeProfile,
    activeDiscoveredBackend,
  };
}

export function shouldBootToConnectionSettings(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  const settings = getAppSettingsSnapshot();
  const hasRemoteSelection =
    settings.backendSelection.mode === "remote" &&
    (settings.backendSelection.discoveredBackend !== null ||
      settings.remoteBackendProfiles.some(
        (profile) => profile.id === settings.backendSelection.profileId,
      ));
  if (hasRemoteSelection) {
    return false;
  }

  const startupRole = window.desktopBridge?.getStartupRole?.();
  if (startupRole === "frontend-only") {
    return true;
  }

  return isCapacitorShell();
}
