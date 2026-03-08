import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Settings2Icon } from "lucide-react";

import { isElectron } from "../env";
import { Button } from "../components/ui/button";
import { SidebarTrigger } from "../components/ui/sidebar";

function ChatIndexRouteView() {
  const navigate = useNavigate();

  return (
    <div className="safe-area-shell flex min-h-0 min-w-0 flex-1 flex-col bg-background text-muted-foreground/40">
      {!isElectron && (
        <header className="border-b border-border px-3 py-2 md:hidden">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <SidebarTrigger className="size-7 shrink-0" />
              <span className="text-sm font-medium text-foreground">Threads</span>
            </div>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Open preferences"
              onClick={() => void navigate({ to: "/settings" })}
            >
              <Settings2Icon />
            </Button>
          </div>
        </header>
      )}

      {isElectron && (
        <div className="drag-region flex h-[52px] shrink-0 items-center border-b border-border px-5">
          <span className="text-xs text-muted-foreground/50">No active thread</span>
        </div>
      )}

      <div className="flex flex-1 items-center justify-center">
        <div className="text-center">
          <p className="text-sm">Select a thread or create a new one to get started.</p>
        </div>
      </div>
    </div>
  );
}

export const Route = createFileRoute("/_chat/")({
  component: ChatIndexRouteView,
});
