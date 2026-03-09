import { isCapacitorShell } from "../env";

export function useCompactPhoneShell(): boolean {
  if (!isCapacitorShell() || typeof navigator === "undefined") {
    return false;
  }

  const userAgent = navigator.userAgent;
  return /\biPhone\b/i.test(userAgent) || /\biPod\b/i.test(userAgent);
}
