import type { ThreadId } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { ChevronDownIcon } from "lucide-react";
import { useCallback } from "react";

import { gitBranchesQueryOptions, gitStatusQueryOptions } from "../lib/gitReactQuery";
import { newCommandId } from "../lib/utils";
import { readNativeApi } from "../nativeApi";
import { useComposerDraftStore } from "../composerDraftStore";
import { useAppSettings } from "../appSettings";
import { useStore } from "../store";
import { useCompactPhoneShell } from "../hooks/useCompactPhoneShell";
import {
  listGitRemoteNames,
  EnvMode,
  resolvePreferredGitRemoteName,
  resolveDraftEnvModeAfterBranchChange,
  resolveEffectiveEnvMode,
} from "./BranchToolbar.logic";
import { BranchToolbarBranchSelector } from "./BranchToolbarBranchSelector";
import { Button } from "./ui/button";
import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "./ui/menu";

interface BranchToolbarProps {
  threadId: ThreadId;
  onEnvModeChange: (mode: EnvMode) => void;
  envLocked: boolean;
  onComposerFocusRequest?: () => void;
}

export default function BranchToolbar({
  threadId,
  onEnvModeChange,
  envLocked,
  onComposerFocusRequest,
}: BranchToolbarProps) {
  const isCompactPhoneShell = useCompactPhoneShell();
  const { settings, updateSettings } = useAppSettings();
  const threads = useStore((store) => store.threads);
  const projects = useStore((store) => store.projects);
  const setThreadBranchAction = useStore((store) => store.setThreadBranch);
  const draftThread = useComposerDraftStore((store) => store.getDraftThread(threadId));
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);

  const serverThread = threads.find((thread) => thread.id === threadId);
  const activeProjectId = serverThread?.projectId ?? draftThread?.projectId ?? null;
  const activeProject = projects.find((project) => project.id === activeProjectId);
  const activeThreadId = serverThread?.id ?? (draftThread ? threadId : undefined);
  const activeThreadBranch = serverThread?.branch ?? draftThread?.branch ?? null;
  const activeWorktreePath = serverThread?.worktreePath ?? draftThread?.worktreePath ?? null;
  const branchCwd = activeWorktreePath ?? activeProject?.cwd ?? null;
  const hasServerThread = serverThread !== undefined;
  const effectiveEnvMode = resolveEffectiveEnvMode({
    activeWorktreePath,
    hasServerThread,
    draftThreadEnvMode: draftThread?.envMode,
  });
  const branchesQuery = useQuery(gitBranchesQueryOptions(branchCwd));
  const gitStatusQuery = useQuery(gitStatusQueryOptions(branchCwd));
  const availableRemoteNames = listGitRemoteNames(branchesQuery.data?.branches ?? []);
  const selectedRemoteName = resolvePreferredGitRemoteName({
    availableRemoteNames,
    preferredRemoteName: activeProject
      ? settings.preferredGitRemotesByProjectCwd[activeProject.cwd]
      : null,
    upstreamRemoteName: gitStatusQuery.data?.upstreamRemoteName ?? null,
  });

  const setThreadBranch = useCallback(
    (branch: string | null, worktreePath: string | null) => {
      if (!activeThreadId) return;
      const api = readNativeApi();
      // If the effective cwd is about to change, stop the running session so the
      // next message creates a new one with the correct cwd.
      if (serverThread?.session && worktreePath !== activeWorktreePath && api) {
        void api.orchestration
          .dispatchCommand({
            type: "thread.session.stop",
            commandId: newCommandId(),
            threadId: activeThreadId,
            createdAt: new Date().toISOString(),
          })
          .catch(() => undefined);
      }
      if (api && hasServerThread) {
        void api.orchestration.dispatchCommand({
          type: "thread.meta.update",
          commandId: newCommandId(),
          threadId: activeThreadId,
          branch,
          worktreePath,
        });
      }
      if (hasServerThread) {
        setThreadBranchAction(activeThreadId, branch, worktreePath);
        return;
      }
      const nextDraftEnvMode = resolveDraftEnvModeAfterBranchChange({
        nextWorktreePath: worktreePath,
        currentWorktreePath: activeWorktreePath,
        effectiveEnvMode,
      });
      setDraftThreadContext(threadId, {
        branch,
        worktreePath,
        envMode: nextDraftEnvMode,
      });
    },
    [
      activeThreadId,
      serverThread?.session,
      activeWorktreePath,
      hasServerThread,
      setThreadBranchAction,
      setDraftThreadContext,
      threadId,
      effectiveEnvMode,
    ],
  );

  if (!activeThreadId || !activeProject) return null;

  return (
    <div
      className={
        isCompactPhoneShell
          ? "mx-auto flex w-full max-w-3xl items-center justify-between px-3 pb-1 pt-0.5"
          : "mx-auto flex w-full max-w-3xl items-center justify-between px-5 pb-3 pt-1"
      }
    >
      <div className="flex items-center gap-2">
        {envLocked || activeWorktreePath ? (
          <span className="border border-transparent px-[calc(--spacing(2)-1px)] text-sm font-medium text-muted-foreground/70 sm:text-xs">
            {activeWorktreePath ? "Worktree" : "Local"}
          </span>
        ) : (
          <Button
            type="button"
            variant="ghost"
            className="text-muted-foreground/70 hover:text-foreground/80"
            size="xs"
            onClick={() => onEnvModeChange(effectiveEnvMode === "local" ? "worktree" : "local")}
          >
            {effectiveEnvMode === "worktree" ? "New worktree" : "Local"}
          </Button>
        )}
      </div>

      <div className="flex items-center gap-2">
        {availableRemoteNames.length > 0 && selectedRemoteName ? (
          <Menu>
            <MenuTrigger
              render={<Button variant="ghost" size="xs" />}
              className="text-muted-foreground/70 hover:text-foreground/80"
            >
              <span className="max-w-[120px] truncate">{selectedRemoteName}</span>
              <ChevronDownIcon className="size-3.5" />
            </MenuTrigger>
            <MenuPopup align="end" side="top">
              <MenuRadioGroup
                value={selectedRemoteName}
                onValueChange={(value) => {
                  updateSettings({
                    preferredGitRemotesByProjectCwd: {
                      ...settings.preferredGitRemotesByProjectCwd,
                      [activeProject.cwd]: value,
                    },
                  });
                }}
              >
                {availableRemoteNames.map((remoteName) => (
                  <MenuRadioItem key={remoteName} value={remoteName}>
                    {remoteName}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuPopup>
          </Menu>
        ) : null}

        <BranchToolbarBranchSelector
          activeProjectCwd={activeProject.cwd}
          activeThreadBranch={activeThreadBranch}
          activeWorktreePath={activeWorktreePath}
          branchCwd={branchCwd}
          effectiveEnvMode={effectiveEnvMode}
          envLocked={envLocked}
          onSetThreadBranch={setThreadBranch}
          {...(onComposerFocusRequest ? { onComposerFocusRequest } : {})}
        />
      </div>
    </div>
  );
}
