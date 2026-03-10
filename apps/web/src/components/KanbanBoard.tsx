import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DndContext,
  DragOverlay,
  closestCorners,
  type DragEndEvent,
  type DragStartEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVerticalIcon, LinkIcon, PlusIcon, TrashIcon, XIcon } from "lucide-react";
import type { KanbanStatus, KanbanTicket } from "@t3tools/contracts";
import {
  invalidateKanbanQueries,
  kanbanCreateMutationOptions,
  kanbanDeleteMutationOptions,
  kanbanListQueryOptions,
  kanbanMoveMutationOptions,
} from "../lib/kanbanReactQuery";
import { ensureNativeApi } from "../nativeApi";

// ── Column configuration ──────────────────────────────────────────────

interface ColumnDef {
  id: KanbanStatus;
  label: string;
  colorClass: string;
  dotClass: string;
}

const COLUMNS: readonly ColumnDef[] = [
  { id: "backlog", label: "Backlog", colorClass: "text-zinc-400", dotClass: "bg-zinc-400" },
  { id: "ready", label: "Ready", colorClass: "text-blue-400", dotClass: "bg-blue-400" },
  {
    id: "in_progress",
    label: "In Progress",
    colorClass: "text-amber-400",
    dotClass: "bg-amber-400",
  },
  { id: "done", label: "Done", colorClass: "text-emerald-400", dotClass: "bg-emerald-400" },
];

// ── Sortable ticket card ──────────────────────────────────────────────

function SortableTicketCard({
  ticket,
  onDelete,
}: {
  ticket: KanbanTicket;
  onDelete: (id: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: ticket.id,
    data: { ticket },
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="group flex items-start gap-1.5 rounded-md border border-zinc-700/60 bg-zinc-800/80 p-2.5 shadow-sm transition-colors hover:border-zinc-600"
    >
      <button
        {...attributes}
        {...listeners}
        className="mt-0.5 shrink-0 cursor-grab text-zinc-500 opacity-0 transition-opacity hover:text-zinc-300 group-hover:opacity-100 active:cursor-grabbing"
        aria-label="Drag to reorder"
      >
        <GripVerticalIcon className="h-3.5 w-3.5" />
      </button>
      <div className="min-w-0 flex-1">
        <p className="text-sm leading-snug text-zinc-200">{ticket.title}</p>
        {ticket.threadId && (
          <span className="mt-1 inline-flex items-center gap-1 text-xs text-zinc-500">
            <LinkIcon className="h-3 w-3" />
            Linked thread
          </span>
        )}
      </div>
      <button
        onClick={() => onDelete(ticket.id)}
        className="mt-0.5 shrink-0 text-zinc-600 opacity-0 transition-opacity hover:text-red-400 group-hover:opacity-100"
        aria-label="Delete ticket"
      >
        <TrashIcon className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function TicketCardOverlay({ ticket }: { ticket: KanbanTicket }) {
  return (
    <div className="flex items-start gap-1.5 rounded-md border border-zinc-600 bg-zinc-800 p-2.5 shadow-lg">
      <GripVerticalIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-400" />
      <p className="min-w-0 flex-1 text-sm leading-snug text-zinc-200">{ticket.title}</p>
    </div>
  );
}

// ── Quick-add input ───────────────────────────────────────────────────

function QuickAddInput({
  columnId,
  projectId,
  queryClient,
}: {
  columnId: KanbanStatus;
  projectId: string;
  queryClient: ReturnType<typeof useQueryClient>;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const createMutation = useMutation(
    kanbanCreateMutationOptions({ projectId, queryClient }),
  );

  const handleSubmit = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed) return;
    createMutation.mutate({ title: trimmed, status: columnId });
    setValue("");
    inputRef.current?.focus();
  }, [value, columnId, createMutation]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleSubmit();
      } else if (e.key === "Escape") {
        setValue("");
        setIsOpen(false);
      }
    },
    [handleSubmit],
  );

  useEffect(() => {
    if (isOpen) inputRef.current?.focus();
  }, [isOpen]);

  if (!isOpen) {
    return (
      <button
        onClick={() => setIsOpen(true)}
        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-300"
      >
        <PlusIcon className="h-3.5 w-3.5" />
        Add ticket
      </button>
    );
  }

  return (
    <div className="flex items-center gap-1">
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Ticket title..."
        className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none"
      />
      <button
        onClick={() => {
          setValue("");
          setIsOpen(false);
        }}
        className="shrink-0 rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
        aria-label="Cancel"
      >
        <XIcon className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

// ── Column component ──────────────────────────────────────────────────

function KanbanColumn({
  column,
  tickets,
  projectId,
  queryClient,
  onDelete,
}: {
  column: ColumnDef;
  tickets: KanbanTicket[];
  projectId: string;
  queryClient: ReturnType<typeof useQueryClient>;
  onDelete: (id: string) => void;
}) {
  const ticketIds = useMemo(() => tickets.map((t) => t.id), [tickets]);

  return (
    <div className="flex min-h-0 flex-1 flex-col rounded-lg border border-zinc-800 bg-zinc-900/50">
      <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2">
        <span className={`h-2 w-2 rounded-full ${column.dotClass}`} />
        <span className={`text-xs font-medium ${column.colorClass}`}>{column.label}</span>
        <span className="ml-auto text-xs text-zinc-600">{tickets.length}</span>
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        <SortableContext items={ticketIds} strategy={verticalListSortingStrategy} id={column.id}>
          <div className="flex flex-col gap-1.5">
            {tickets.map((ticket) => (
              <SortableTicketCard key={ticket.id} ticket={ticket} onDelete={onDelete} />
            ))}
          </div>
        </SortableContext>
        <div className="mt-2">
          <QuickAddInput columnId={column.id} projectId={projectId} queryClient={queryClient} />
        </div>
      </div>
    </div>
  );
}

// ── Main board ────────────────────────────────────────────────────────

interface KanbanBoardProps {
  projectId: string;
}

export default function KanbanBoard({ projectId }: KanbanBoardProps) {
  const queryClient = useQueryClient();
  const { data: tickets = [], isLoading } = useQuery(kanbanListQueryOptions(projectId));

  const moveMutation = useMutation(kanbanMoveMutationOptions({ queryClient }));
  const deleteMutation = useMutation(kanbanDeleteMutationOptions({ queryClient }));

  const [activeTicket, setActiveTicket] = useState<KanbanTicket | null>(null);

  // Subscribe to kanban.updated push channel for real-time invalidation
  useEffect(() => {
    const api = ensureNativeApi();
    const unsub = api.kanban.onUpdated((data) => {
      const payload = data as { projectId?: string };
      if (!payload.projectId || payload.projectId === projectId) {
        void invalidateKanbanQueries(queryClient, projectId);
      }
    });
    return unsub;
  }, [projectId, queryClient]);

  const ticketsByStatus = useMemo(() => {
    const map: Record<KanbanStatus, KanbanTicket[]> = {
      backlog: [],
      ready: [],
      in_progress: [],
      done: [],
    };
    for (const ticket of tickets) {
      const bucket = map[ticket.status as KanbanStatus];
      if (bucket) bucket.push(ticket);
    }
    return map;
  }, [tickets]);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    }),
  );

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const ticket = tickets.find((t) => t.id === event.active.id);
      if (ticket) setActiveTicket(ticket);
    },
    [tickets],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveTicket(null);
      const { active, over } = event;
      if (!over) return;

      const draggedId = String(active.id);
      const draggedTicket = tickets.find((t) => t.id === draggedId);
      if (!draggedTicket) return;

      // Determine target column: either the column header or a ticket in a column
      let targetStatus: KanbanStatus | undefined;
      let targetPosition: number;

      // Check if dropped over another ticket
      const overTicket = tickets.find((t) => t.id === String(over.id));
      if (overTicket) {
        targetStatus = overTicket.status as KanbanStatus;
        targetPosition = overTicket.position;
      } else {
        // Dropped on a column droppable
        targetStatus = String(over.id) as KanbanStatus;
        const columnTickets = ticketsByStatus[targetStatus] ?? [];
        targetPosition = columnTickets.length > 0
          ? (columnTickets[columnTickets.length - 1]?.position ?? 0) + 1
          : 1;
      }

      if (!targetStatus) return;

      // Skip if nothing changed
      if (draggedTicket.status === targetStatus && draggedTicket.position === targetPosition) {
        return;
      }

      moveMutation.mutate({ id: draggedId, status: targetStatus, position: targetPosition });
    },
    [tickets, ticketsByStatus, moveMutation],
  );

  const handleDelete = useCallback(
    (id: string) => {
      deleteMutation.mutate(id);
    },
    [deleteMutation],
  );

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-zinc-500">Loading kanban board...</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-4">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCorners}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        >
          {COLUMNS.map((column) => (
            <KanbanColumn
              key={column.id}
              column={column}
              tickets={ticketsByStatus[column.id]}
              projectId={projectId}
              queryClient={queryClient}
              onDelete={handleDelete}
            />
          ))}
          <DragOverlay>
            {activeTicket ? <TicketCardOverlay ticket={activeTicket} /> : null}
          </DragOverlay>
        </DndContext>
      </div>
    </div>
  );
}
