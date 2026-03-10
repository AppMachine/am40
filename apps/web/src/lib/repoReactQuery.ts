import type {
  RegisteredRepo,
  RepoAddInput,
  RepoRemoveInput,
  RepoSetActiveInput,
} from "@t3tools/contracts";
import { mutationOptions, queryOptions, type QueryClient } from "@tanstack/react-query";
import { ensureNativeApi } from "../nativeApi";

export const repoQueryKeys = {
  all: ["repos"] as const,
  list: () => ["repos", "list"] as const,
};

export function invalidateRepoQueries(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: repoQueryKeys.all });
}

export function repoListQueryOptions() {
  return queryOptions({
    queryKey: repoQueryKeys.list(),
    queryFn: async (): Promise<RegisteredRepo[]> => {
      const api = ensureNativeApi();
      return api.repo.list();
    },
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}

export function repoAddMutationOptions(input: { queryClient: QueryClient }) {
  return mutationOptions({
    mutationKey: ["repos", "mutation", "add"] as const,
    mutationFn: async (addInput: RepoAddInput): Promise<RegisteredRepo> => {
      const api = ensureNativeApi();
      return api.repo.add(addInput);
    },
    onSuccess: async () => {
      await invalidateRepoQueries(input.queryClient);
    },
  });
}

export function repoRemoveMutationOptions(input: { queryClient: QueryClient }) {
  return mutationOptions({
    mutationKey: ["repos", "mutation", "remove"] as const,
    mutationFn: async (removeInput: RepoRemoveInput): Promise<void> => {
      const api = ensureNativeApi();
      return api.repo.remove(removeInput);
    },
    onSuccess: async () => {
      await invalidateRepoQueries(input.queryClient);
    },
  });
}

export function repoSetActiveMutationOptions(_input: { queryClient: QueryClient }) {
  return mutationOptions({
    mutationKey: ["repos", "mutation", "setActive"] as const,
    mutationFn: async (setActiveInput: RepoSetActiveInput): Promise<void> => {
      const api = ensureNativeApi();
      return api.repo.setActive(setActiveInput);
    },
  });
}
