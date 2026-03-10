import { createFileRoute } from "@tanstack/react-router";
import { SidebarInset, SidebarTrigger } from "~/components/ui/sidebar";
import KanbanBoard from "../components/KanbanBoard";

function KanbanRoute() {
  const { projectId } = Route.useParams();

  return (
    <SidebarInset>
      <header className="flex h-[52px] shrink-0 items-center gap-2 border-b border-border px-4">
        <SidebarTrigger className="-ml-1 sm:hidden" />
        <h1 className="text-sm font-medium text-foreground">Kanban Board</h1>
      </header>
      <div className="flex-1 overflow-hidden">
        <KanbanBoard projectId={projectId} />
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/kanban/$projectId")({
  component: KanbanRoute,
});
