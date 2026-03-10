import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { gitStatusQueryOptions } from "../lib/gitReactQuery";

const EMPTY_FILES: readonly { readonly path: string; readonly deletions: number; readonly insertions: number }[] = [];

export function FileChangesPanel({ cwd }: { cwd: string | null }) {
  const { data: gitStatus } = useQuery(gitStatusQueryOptions(cwd));

  const files = gitStatus?.workingTree?.files ?? EMPTY_FILES;
  const summary = useMemo(() => {
    let additions = 0;
    let deletions = 0;
    for (const file of files) {
      additions += file.insertions;
      deletions += file.deletions;
    }
    return { additions, deletions };
  }, [files]);

  if (!cwd) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-xs text-muted-foreground/60">
        No working directory
      </div>
    );
  }

  if (files.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-xs text-muted-foreground/60">
        No file changes
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b border-border px-3 py-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{files.length}</span> file
        {files.length !== 1 ? "s" : ""} changed
        {summary.additions > 0 && (
          <span className="ml-1.5 text-green-500">+{summary.additions}</span>
        )}
        {summary.deletions > 0 && (
          <span className="ml-1 text-red-500">-{summary.deletions}</span>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {files.map((file) => (
          <div
            key={file.path}
            className="flex items-center gap-2 border-b border-border/50 px-3 py-1.5 text-xs"
          >
            <span className="min-w-0 flex-1 truncate text-foreground/80">{file.path}</span>
            <div className="flex shrink-0 items-center gap-1.5">
              {file.insertions > 0 && (
                <span className="text-green-500">+{file.insertions}</span>
              )}
              {file.deletions > 0 && (
                <span className="text-red-500">-{file.deletions}</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
