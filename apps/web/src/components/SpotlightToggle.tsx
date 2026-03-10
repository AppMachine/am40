import type { ThreadId } from "@t3tools/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { EyeIcon, EyeOffIcon, LoaderCircleIcon } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { ensureNativeApi } from "~/nativeApi";
import { toastManager } from "~/components/ui/toast";

const SPOTLIGHT_STATUS_STALE_TIME_MS = 5_000;
const SPOTLIGHT_STATUS_REFETCH_INTERVAL_MS = 10_000;

function spotlightQueryKey(threadId: string | null) {
  return ["spotlight", "status", threadId] as const;
}

function useSpotlightStatus(threadId: string | null) {
  return useQuery({
    queryKey: spotlightQueryKey(threadId),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!threadId) throw new Error("Spotlight status is unavailable.");
      return api.spotlight.status({ threadId });
    },
    enabled: threadId !== null,
    staleTime: SPOTLIGHT_STATUS_STALE_TIME_MS,
    refetchInterval: SPOTLIGHT_STATUS_REFETCH_INTERVAL_MS,
  });
}

interface SpotlightToggleProps {
  activeThreadId: ThreadId | null;
}

export default function SpotlightToggle({ activeThreadId }: SpotlightToggleProps) {
  const queryClient = useQueryClient();
  const threadId = activeThreadId as string | null;
  const { data: status } = useSpotlightStatus(threadId);

  const enableMutation = useMutation({
    mutationFn: async () => {
      const api = ensureNativeApi();
      if (!threadId) throw new Error("Spotlight is unavailable.");
      return api.spotlight.enable({ threadId });
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: spotlightQueryKey(threadId) });
    },
  });

  const disableMutation = useMutation({
    mutationFn: async () => {
      const api = ensureNativeApi();
      if (!threadId) throw new Error("Spotlight is unavailable.");
      return api.spotlight.disable({ threadId });
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: spotlightQueryKey(threadId) });
    },
  });

  const isBusy = enableMutation.isPending || disableMutation.isPending;
  const isActive = status?.active ?? false;

  const toggle = useCallback(() => {
    if (isBusy) return;
    if (isActive) {
      const promise = disableMutation.mutateAsync();
      toastManager.promise(promise, {
        loading: { title: "Disabling spotlight..." },
        success: () => ({ title: "Spotlight disabled" }),
        error: (err) => ({
          title: "Failed to disable spotlight",
          description: err instanceof Error ? err.message : "An error occurred.",
        }),
      });
      void promise.catch(() => undefined);
    } else {
      const promise = enableMutation.mutateAsync();
      toastManager.promise(promise, {
        loading: { title: "Enabling spotlight..." },
        success: () => ({ title: "Spotlight enabled" }),
        error: (err) => ({
          title: "Failed to enable spotlight",
          description: err instanceof Error ? err.message : "An error occurred.",
        }),
      });
      void promise.catch(() => undefined);
    }
  }, [isBusy, isActive, enableMutation, disableMutation]);

  if (!threadId) return null;

  const lastSyncLabel = status?.lastSyncAt
    ? `Last sync: ${new Date(status.lastSyncAt).toLocaleTimeString()}`
    : null;

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        render={
          <Button
            variant="outline"
            size="icon-xs"
            aria-label={isActive ? "Disable spotlight" : "Enable spotlight"}
            disabled={isBusy}
            onClick={toggle}
            className={isActive ? "border-primary/50 text-primary" : ""}
          />
        }
      >
        {isBusy ? (
          <LoaderCircleIcon className="size-3.5 animate-spin" />
        ) : isActive ? (
          <EyeIcon className="size-3.5" />
        ) : (
          <EyeOffIcon className="size-3.5" />
        )}
      </PopoverTrigger>
      <PopoverPopup tooltipStyle side="bottom" align="center">
        <div className="space-y-1">
          <p>{isActive ? "Spotlight active" : "Spotlight inactive"}</p>
          {lastSyncLabel && <p className="text-xs text-muted-foreground">{lastSyncLabel}</p>}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
