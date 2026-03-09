import { Capacitor } from "@capacitor/core";

/**
 * True when running inside the Electron preload bridge, false in a regular browser.
 * The preload script sets window.nativeApi via contextBridge before any web-app
 * code executes, so this is reliable at module load time.
 */
function getWindow() {
  return typeof window !== "undefined" ? window : undefined;
}

export function isElectronShell(): boolean {
  const currentWindow = getWindow();
  return currentWindow !== undefined &&
    (currentWindow.desktopBridge !== undefined || currentWindow.nativeApi !== undefined);
}

export function isCapacitorShell(): boolean {
  if (Capacitor.isNativePlatform()) {
    return true;
  }

  const currentWindow = getWindow() as
    | (Window & { Capacitor?: { isNativePlatform?: () => boolean } })
    | undefined;
  return typeof currentWindow?.Capacitor?.isNativePlatform === "function" &&
    currentWindow.Capacitor.isNativePlatform();
}

export const isElectron = isElectronShell();
export const isCapacitor = isCapacitorShell();
