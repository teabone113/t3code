import type { GitBranch } from "@t3tools/contracts";

export type EnvMode = "local" | "worktree";

export function resolveEffectiveEnvMode(input: {
  activeWorktreePath: string | null;
  hasServerThread: boolean;
  draftThreadEnvMode: EnvMode | undefined;
}): EnvMode {
  const { activeWorktreePath, hasServerThread, draftThreadEnvMode } = input;
  return activeWorktreePath || (!hasServerThread && draftThreadEnvMode === "worktree")
    ? "worktree"
    : "local";
}

export function resolveDraftEnvModeAfterBranchChange(input: {
  nextWorktreePath: string | null;
  currentWorktreePath: string | null;
  effectiveEnvMode: EnvMode;
}): EnvMode {
  const { nextWorktreePath, currentWorktreePath, effectiveEnvMode } = input;
  if (nextWorktreePath) {
    return "worktree";
  }
  if (effectiveEnvMode === "worktree" && !currentWorktreePath) {
    return "worktree";
  }
  return "local";
}

export function resolveBranchToolbarValue(input: {
  envMode: EnvMode;
  activeWorktreePath: string | null;
  activeThreadBranch: string | null;
  currentGitBranch: string | null;
}): string | null {
  const { envMode, activeWorktreePath, activeThreadBranch, currentGitBranch } = input;
  if (envMode === "worktree" && !activeWorktreePath) {
    return activeThreadBranch ?? currentGitBranch;
  }
  return currentGitBranch ?? activeThreadBranch;
}

export function deriveLocalBranchNameFromRemoteRef(branchName: string): string {
  const firstSeparatorIndex = branchName.indexOf("/");
  if (firstSeparatorIndex <= 0 || firstSeparatorIndex === branchName.length - 1) {
    return branchName;
  }
  return branchName.slice(firstSeparatorIndex + 1);
}

function deriveLocalBranchNameCandidatesFromRemoteRef(
  branchName: string,
  remoteName?: string,
): ReadonlyArray<string> {
  const candidates = new Set<string>();
  const firstSlashCandidate = deriveLocalBranchNameFromRemoteRef(branchName);
  if (firstSlashCandidate.length > 0) {
    candidates.add(firstSlashCandidate);
  }

  if (remoteName) {
    const remotePrefix = `${remoteName}/`;
    if (branchName.startsWith(remotePrefix) && branchName.length > remotePrefix.length) {
      candidates.add(branchName.slice(remotePrefix.length));
    }
  }

  return [...candidates];
}

export function dedupeRemoteBranchesWithLocalMatches(
  branches: ReadonlyArray<GitBranch>,
): ReadonlyArray<GitBranch> {
  const localBranchNames = new Set(
    branches.filter((branch) => !branch.isRemote).map((branch) => branch.name),
  );

  return branches.filter((branch) => {
    if (!branch.isRemote) {
      return true;
    }

    const localBranchCandidates = deriveLocalBranchNameCandidatesFromRemoteRef(
      branch.name,
      branch.remoteName,
    );
    return !localBranchCandidates.some((candidate) => localBranchNames.has(candidate));
  });
}

export function listGitRemoteNames(branches: ReadonlyArray<GitBranch>): string[] {
  return [...new Set(branches.flatMap((branch) => (branch.remoteName ? [branch.remoteName] : [])))];
}

export function resolvePreferredGitRemoteName(input: {
  availableRemoteNames: ReadonlyArray<string>;
  preferredRemoteName: string | null | undefined;
  upstreamRemoteName?: string | null | undefined;
}): string | null {
  const { availableRemoteNames, preferredRemoteName, upstreamRemoteName } = input;
  if (availableRemoteNames.length === 0) {
    return null;
  }

  const normalizedPreferredRemoteName = preferredRemoteName?.trim() ?? "";
  if (
    normalizedPreferredRemoteName.length > 0 &&
    availableRemoteNames.includes(normalizedPreferredRemoteName)
  ) {
    return normalizedPreferredRemoteName;
  }

  const normalizedUpstreamRemoteName = upstreamRemoteName?.trim() ?? "";
  if (
    normalizedUpstreamRemoteName.length > 0 &&
    availableRemoteNames.includes(normalizedUpstreamRemoteName)
  ) {
    return normalizedUpstreamRemoteName;
  }

  if (availableRemoteNames.includes("origin")) {
    return "origin";
  }

  return availableRemoteNames[0] ?? null;
}
