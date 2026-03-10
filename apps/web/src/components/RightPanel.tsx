import { useState, useCallback, useRef, useEffect } from "react";
import { FileChangesPanel } from "./FileChangesPanel";

const SPLIT_STORAGE_KEY = "t3code:right-panel-split";
const DEFAULT_SPLIT_RATIO = 0.5;
const MIN_SPLIT_RATIO = 0.15;
const MAX_SPLIT_RATIO = 0.85;

function readSplitRatio(): number {
  try {
    const raw = window.localStorage.getItem(SPLIT_STORAGE_KEY);
    if (!raw) return DEFAULT_SPLIT_RATIO;
    const value = Number.parseFloat(raw);
    if (!Number.isFinite(value)) return DEFAULT_SPLIT_RATIO;
    return Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, value));
  } catch {
    return DEFAULT_SPLIT_RATIO;
  }
}

export function RightPanel({ cwd }: { cwd: string | null }) {
  const [splitRatio, setSplitRatio] = useState(readSplitRatio);
  const containerRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  const handlePointerDown = useCallback((event: React.PointerEvent) => {
    event.preventDefault();
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
    draggingRef.current = true;
  }, []);

  const handlePointerMove = useCallback((event: React.PointerEvent) => {
    if (!draggingRef.current || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const ratio = (event.clientY - rect.top) / rect.height;
    const clamped = Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, ratio));
    setSplitRatio(clamped);
  }, []);

  const handlePointerUp = useCallback(() => {
    draggingRef.current = false;
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(SPLIT_STORAGE_KEY, String(splitRatio));
    } catch {}
  }, [splitRatio]);

  return (
    <div ref={containerRef} className="flex h-full flex-col">
      <div className="min-h-0 overflow-hidden" style={{ flex: `0 0 ${splitRatio * 100}%` }}>
        <FileChangesPanel cwd={cwd} />
      </div>
      <div
        className="h-1 shrink-0 cursor-row-resize bg-border/50 transition-colors hover:bg-border"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      />
      <div className="flex min-h-0 flex-1 items-center justify-center text-xs text-muted-foreground/60">
        Terminal (coming soon)
      </div>
    </div>
  );
}
