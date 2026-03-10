import { type KanbanCreateInput, type KanbanMoveInput, type KanbanUpdateInput, ProjectId } from "@t3tools/contracts";
import { mutationOptions, queryOptions, type QueryClient } from "@tanstack/react-query";
import { ensureNativeApi } from "~/nativeApi";

const KANBAN_STALE_TIME_MS = 10_000;
const KANBAN_REFETCH_INTERVAL_MS = 30_000;

export const kanbanQueryKeys = {
  all: ["kanban"] as const,
  list: (projectId: string | null) => ["kanban", "list", projectId] as const,
};

export function invalidateKanbanQueries(queryClient: QueryClient, projectId?: string) {
  if (projectId) {
    return queryClient.invalidateQueries({ queryKey: kanbanQueryKeys.list(projectId) });
  }
  return queryClient.invalidateQueries({ queryKey: kanbanQueryKeys.all });
}

export function kanbanListQueryOptions(projectId: string | null) {
  return queryOptions({
    queryKey: kanbanQueryKeys.list(projectId),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!projectId) throw new Error("Kanban list requires a project ID.");
      return api.kanban.list({ projectId: ProjectId.makeUnsafe(projectId) });
    },
    enabled: projectId !== null,
    staleTime: KANBAN_STALE_TIME_MS,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    refetchInterval: KANBAN_REFETCH_INTERVAL_MS,
  });
}

export function kanbanCreateMutationOptions(input: {
  projectId: string | null;
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: ["kanban", "mutation", "create", input.projectId] as const,
    mutationFn: async (params: Omit<KanbanCreateInput, "projectId">) => {
      const api = ensureNativeApi();
      if (!input.projectId) throw new Error("Kanban create requires a project ID.");
      return api.kanban.create({ ...params, projectId: ProjectId.makeUnsafe(input.projectId) });
    },
    onSettled: async () => {
      await invalidateKanbanQueries(input.queryClient, input.projectId ?? undefined);
    },
  });
}

export function kanbanUpdateMutationOptions(input: {
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: ["kanban", "mutation", "update"] as const,
    mutationFn: async (params: KanbanUpdateInput) => {
      const api = ensureNativeApi();
      return api.kanban.update(params);
    },
    onSettled: async () => {
      await invalidateKanbanQueries(input.queryClient);
    },
  });
}

export function kanbanMoveMutationOptions(input: {
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: ["kanban", "mutation", "move"] as const,
    mutationFn: async (params: KanbanMoveInput) => {
      const api = ensureNativeApi();
      return api.kanban.move(params);
    },
    onSettled: async () => {
      await invalidateKanbanQueries(input.queryClient);
    },
  });
}

export function kanbanDeleteMutationOptions(input: {
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: ["kanban", "mutation", "delete"] as const,
    mutationFn: async (id: string) => {
      const api = ensureNativeApi();
      return api.kanban.delete({ id });
    },
    onSettled: async () => {
      await invalidateKanbanQueries(input.queryClient);
    },
  });
}
