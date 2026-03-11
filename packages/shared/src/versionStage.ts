export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
}

export function parseSemanticVersion(version: string): ParsedVersion | null {
  const match = version.trim().match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) {
    return null;
  }

  const major = Number.parseInt(match[1] ?? "", 10);
  const minor = Number.parseInt(match[2] ?? "", 10);
  const patch = Number.parseInt(match[3] ?? "", 10);
  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) {
    return null;
  }

  return { major, minor, patch };
}

export function formatStageVersionTag(version: string): string {
  const parsed = parseSemanticVersion(version);
  if (!parsed) {
    return `v ${version}`;
  }
  if (parsed.major > 0) {
    return `REL ${parsed.major}.${parsed.minor}.${parsed.patch}`;
  }
  if (parsed.minor > 0) {
    return `BETA ${parsed.minor}`;
  }
  return `ALPHA ${parsed.patch}`;
}

export function deriveStageLabel(version: string): string {
  const parsed = parseSemanticVersion(version);
  if (!parsed) {
    return "Unknown";
  }
  if (parsed.major > 0) {
    return "Release";
  }
  if (parsed.minor > 0) {
    return "Beta";
  }
  return "Alpha";
}

export function formatStageAppName(baseName: string, version: string): string {
  const parsed = parseSemanticVersion(version);
  if (!parsed) {
    return `${baseName} (${version})`;
  }
  if (parsed.major > 0) {
    return baseName;
  }
  return `${baseName} (${formatStageVersionTag(version)})`;
}
