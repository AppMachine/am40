import { TurnId } from "@t3tools/contracts";

export type RightTab = "changes" | "diff";

export interface DiffRouteSearch {
  diff?: "1";
  diffTurnId?: TurnId;
  diffFilePath?: string;
  rightTab?: RightTab;
}

function isDiffOpenValue(value: unknown): boolean {
  return value === "1" || value === 1 || value === true;
}

function normalizeSearchString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

export function stripDiffSearchParams<T extends Record<string, unknown>>(
  params: T,
): Omit<T, "diff" | "diffTurnId" | "diffFilePath" | "rightTab"> {
  const {
    diff: _diff,
    diffTurnId: _diffTurnId,
    diffFilePath: _diffFilePath,
    rightTab: _rightTab,
    ...rest
  } = params;
  return rest as Omit<T, "diff" | "diffTurnId" | "diffFilePath" | "rightTab">;
}

function isRightTab(value: unknown): value is RightTab {
  return value === "changes" || value === "diff";
}

export function parseDiffRouteSearch(search: Record<string, unknown>): DiffRouteSearch {
  const diff = isDiffOpenValue(search.diff) ? "1" : undefined;
  const diffTurnIdRaw = diff ? normalizeSearchString(search.diffTurnId) : undefined;
  const diffTurnId = diffTurnIdRaw ? TurnId.makeUnsafe(diffTurnIdRaw) : undefined;
  const diffFilePath = diff && diffTurnId ? normalizeSearchString(search.diffFilePath) : undefined;
  const rightTab = isRightTab(search.rightTab) ? search.rightTab : undefined;

  return {
    ...(diff ? { diff } : {}),
    ...(diffTurnId ? { diffTurnId } : {}),
    ...(diffFilePath ? { diffFilePath } : {}),
    ...(rightTab ? { rightTab } : {}),
  };
}
