import { ThreadId } from "@t3tools/contracts";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Suspense, lazy, type ReactNode, useCallback, useEffect } from "react";

import ChatView from "../components/ChatView";
import { useComposerDraftStore } from "../composerDraftStore";
import { type RightTab, parseDiffRouteSearch, stripDiffSearchParams } from "../diffRouteSearch";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { useStore } from "../store";
import { Sheet, SheetPopup } from "../components/ui/sheet";
import { Sidebar, SidebarInset, SidebarProvider, SidebarRail } from "~/components/ui/sidebar";
import { RightPanel } from "../components/RightPanel";

const DiffPanel = lazy(() => import("../components/DiffPanel"));
const DIFF_INLINE_LAYOUT_MEDIA_QUERY = "(max-width: 1180px)";
const DIFF_INLINE_SIDEBAR_WIDTH_STORAGE_KEY = "chat_diff_sidebar_width";
const DIFF_INLINE_DEFAULT_WIDTH = "clamp(28rem,48vw,44rem)";
const DIFF_INLINE_SIDEBAR_MIN_WIDTH = 26 * 16;
const COMPOSER_COMPACT_MIN_LEFT_CONTROLS_WIDTH_PX = 208;

const DiffPanelSheet = (props: {
  children: ReactNode;
  diffOpen: boolean;
  onCloseDiff: () => void;
}) => {
  return (
    <Sheet
      open={props.diffOpen}
      onOpenChange={(open) => {
        if (!open) {
          props.onCloseDiff();
        }
      }}
    >
      <SheetPopup
        side="right"
        showCloseButton={false}
        keepMounted
        className="w-[min(88vw,820px)] max-w-[820px] p-0"
      >
        {props.children}
      </SheetPopup>
    </Sheet>
  );
};

const DiffLoadingFallback = (props: { inline: boolean }) => {
  if (props.inline) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center px-4 text-center text-xs text-muted-foreground/70">
        Loading diff viewer...
      </div>
    );
  }

  return (
    <aside className="flex h-full w-[560px] shrink-0 items-center justify-center border-l border-border bg-card px-4 text-center text-xs text-muted-foreground/70">
      Loading diff viewer...
    </aside>
  );
};

const RightPanelTabs = (props: {
  activeTab: RightTab;
  onTabChange: (tab: RightTab) => void;
}) => {
  const { activeTab, onTabChange } = props;
  return (
    <div className="flex shrink-0 border-b border-border">
      <button
        type="button"
        className={`flex-1 px-3 py-1.5 text-xs font-medium transition-colors ${
          activeTab === "changes"
            ? "border-b-2 border-primary text-foreground"
            : "text-muted-foreground hover:text-foreground"
        }`}
        onClick={() => onTabChange("changes")}
      >
        Changes
      </button>
      <button
        type="button"
        className={`flex-1 px-3 py-1.5 text-xs font-medium transition-colors ${
          activeTab === "diff"
            ? "border-b-2 border-primary text-foreground"
            : "text-muted-foreground hover:text-foreground"
        }`}
        onClick={() => onTabChange("diff")}
      >
        Diff
      </button>
    </div>
  );
};

const RightPanelInlineSidebar = (props: {
  sidebarOpen: boolean;
  activeTab: RightTab;
  cwd: string | null;
  onClose: () => void;
  onOpen: () => void;
  onTabChange: (tab: RightTab) => void;
}) => {
  const { sidebarOpen, activeTab, cwd, onClose, onOpen, onTabChange } = props;
  const onOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        onOpen();
        return;
      }
      onClose();
    },
    [onClose, onOpen],
  );
  const shouldAcceptInlineSidebarWidth = useCallback(
    ({ nextWidth, wrapper }: { nextWidth: number; wrapper: HTMLElement }) => {
      const composerForm = document.querySelector<HTMLElement>("[data-chat-composer-form='true']");
      if (!composerForm) return true;
      const composerViewport = composerForm.parentElement;
      if (!composerViewport) return true;
      const previousSidebarWidth = wrapper.style.getPropertyValue("--sidebar-width");
      wrapper.style.setProperty("--sidebar-width", `${nextWidth}px`);

      const viewportStyle = window.getComputedStyle(composerViewport);
      const viewportPaddingLeft = Number.parseFloat(viewportStyle.paddingLeft) || 0;
      const viewportPaddingRight = Number.parseFloat(viewportStyle.paddingRight) || 0;
      const viewportContentWidth = Math.max(
        0,
        composerViewport.clientWidth - viewportPaddingLeft - viewportPaddingRight,
      );
      const formRect = composerForm.getBoundingClientRect();
      const composerFooter = composerForm.querySelector<HTMLElement>(
        "[data-chat-composer-footer='true']",
      );
      const composerRightActions = composerForm.querySelector<HTMLElement>(
        "[data-chat-composer-actions='right']",
      );
      const composerRightActionsWidth = composerRightActions?.getBoundingClientRect().width ?? 0;
      const composerFooterGap = composerFooter
        ? Number.parseFloat(window.getComputedStyle(composerFooter).columnGap) ||
          Number.parseFloat(window.getComputedStyle(composerFooter).gap) ||
          0
        : 0;
      const minimumComposerWidth =
        COMPOSER_COMPACT_MIN_LEFT_CONTROLS_WIDTH_PX + composerRightActionsWidth + composerFooterGap;
      const hasComposerOverflow = composerForm.scrollWidth > composerForm.clientWidth + 0.5;
      const overflowsViewport = formRect.width > viewportContentWidth + 0.5;
      const violatesMinimumComposerWidth = composerForm.clientWidth + 0.5 < minimumComposerWidth;

      if (previousSidebarWidth.length > 0) {
        wrapper.style.setProperty("--sidebar-width", previousSidebarWidth);
      } else {
        wrapper.style.removeProperty("--sidebar-width");
      }

      return !hasComposerOverflow && !overflowsViewport && !violatesMinimumComposerWidth;
    },
    [],
  );

  return (
    <SidebarProvider
      defaultOpen={false}
      open={sidebarOpen}
      onOpenChange={onOpenChange}
      className="w-auto min-h-0 flex-none bg-transparent"
      style={{ "--sidebar-width": DIFF_INLINE_DEFAULT_WIDTH } as React.CSSProperties}
    >
      <Sidebar
        side="right"
        collapsible="offcanvas"
        className="border-l border-border bg-card text-foreground"
        resizable={{
          minWidth: DIFF_INLINE_SIDEBAR_MIN_WIDTH,
          shouldAcceptWidth: shouldAcceptInlineSidebarWidth,
          storageKey: DIFF_INLINE_SIDEBAR_WIDTH_STORAGE_KEY,
        }}
      >
        <div className="flex h-full flex-col">
          <RightPanelTabs activeTab={activeTab} onTabChange={onTabChange} />
          <div className="min-h-0 flex-1">
            {activeTab === "changes" ? (
              <RightPanel cwd={cwd} />
            ) : (
              <Suspense fallback={<DiffLoadingFallback inline />}>
                <DiffPanel mode="sidebar" />
              </Suspense>
            )}
          </div>
        </div>
        <SidebarRail />
      </Sidebar>
    </SidebarProvider>
  );
};

function ChatThreadRouteView() {
  const threadsHydrated = useStore((store) => store.threadsHydrated);
  const navigate = useNavigate();
  const threadId = Route.useParams({
    select: (params) => ThreadId.makeUnsafe(params.threadId),
  });
  const search = Route.useSearch();
  const threadExists = useStore((store) => store.threads.some((thread) => thread.id === threadId));
  const draftThreadExists = useComposerDraftStore((store) =>
    Object.hasOwn(store.draftThreadsByThreadId, threadId),
  );
  const routeThreadExists = threadExists || draftThreadExists;
  const diffOpen = search.diff === "1";
  const rightTab = search.rightTab ?? (diffOpen ? "diff" : undefined);
  const sidebarOpen = diffOpen || rightTab === "changes";
  const activeTab: RightTab = rightTab ?? "diff";
  const shouldUseDiffSheet = useMediaQuery(DIFF_INLINE_LAYOUT_MEDIA_QUERY);

  const threadCwd = useStore((store) => {
    const thread = store.threads.find((t) => t.id === threadId);
    if (!thread) return null;
    if (thread.worktreePath) return thread.worktreePath;
    const project = store.projects.find((p) => p.id === thread.projectId);
    return project?.cwd ?? null;
  });

  const closeRightPanel = useCallback(() => {
    void navigate({
      to: "/$threadId",
      params: { threadId },
      search: (previous) => {
        return stripDiffSearchParams(previous);
      },
    });
  }, [navigate, threadId]);

  const openDiff = useCallback(() => {
    void navigate({
      to: "/$threadId",
      params: { threadId },
      search: (previous) => {
        const rest = stripDiffSearchParams(previous);
        return { ...rest, diff: "1", rightTab: "diff" as const };
      },
    });
  }, [navigate, threadId]);

  const switchTab = useCallback(
    (tab: RightTab) => {
      void navigate({
        to: "/$threadId",
        params: { threadId },
        replace: true,
        search: (previous) => {
          const rest = stripDiffSearchParams(previous);
          if (tab === "diff") {
            return { ...rest, diff: "1", rightTab: "diff" as const };
          }
          return { ...rest, rightTab: "changes" as const };
        },
      });
    },
    [navigate, threadId],
  );

  useEffect(() => {
    if (!threadsHydrated) {
      return;
    }

    if (!routeThreadExists) {
      void navigate({ to: "/", replace: true });
      return;
    }
  }, [navigate, routeThreadExists, threadsHydrated, threadId]);

  if (!threadsHydrated || !routeThreadExists) {
    return null;
  }

  if (!shouldUseDiffSheet) {
    return (
      <>
        <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
          <ChatView key={threadId} threadId={threadId} />
        </SidebarInset>
        <RightPanelInlineSidebar
          sidebarOpen={sidebarOpen}
          activeTab={activeTab}
          cwd={threadCwd}
          onClose={closeRightPanel}
          onOpen={openDiff}
          onTabChange={switchTab}
        />
      </>
    );
  }

  return (
    <>
      <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
        <ChatView key={threadId} threadId={threadId} />
      </SidebarInset>
      <DiffPanelSheet diffOpen={diffOpen} onCloseDiff={closeRightPanel}>
        <Suspense fallback={<DiffLoadingFallback inline={false} />}>
          <DiffPanel mode="sheet" />
        </Suspense>
      </DiffPanelSheet>
    </>
  );
}

export const Route = createFileRoute("/_chat/$threadId")({
  validateSearch: (search) => parseDiffRouteSearch(search),
  component: ChatThreadRouteView,
});
