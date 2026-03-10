/**
 * spotlighter - File watcher that syncs changes from a worktree to a target directory.
 *
 * Uses Node.js built-in `fs.watch` (recursive) to detect file changes,
 * then copies modified files to the target. Ignores common build artifacts.
 *
 * @module spotlighter
 */
import { watch, type FSWatcher } from "node:fs";
import { copyFile, mkdir, stat } from "node:fs/promises";
import { join, relative, dirname } from "node:path";

const IGNORE_PATTERNS = [
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  ".turbo",
  ".cache",
] as const;

const IGNORE_EXTENSIONS = [".lock"] as const;

function shouldIgnore(relativePath: string): boolean {
  const segments = relativePath.split("/");
  for (const segment of segments) {
    if (IGNORE_PATTERNS.some((pattern) => segment === pattern)) {
      return true;
    }
  }
  if (IGNORE_EXTENSIONS.some((ext) => relativePath.endsWith(ext))) {
    return true;
  }
  return false;
}

export interface SpotlighterOptions {
  sourceDir: string;
  targetDir: string;
  onSync?: (relativePath: string) => void;
  onError?: (error: unknown) => void;
}

export interface SpotlighterHandle {
  stop: () => void;
}

/**
 * Start watching `sourceDir` for file changes and sync them to `targetDir`.
 * Returns a handle with a `stop()` method to terminate the watcher.
 */
export function startSpotlighter(options: SpotlighterOptions): SpotlighterHandle {
  const { sourceDir, targetDir, onSync, onError } = options;
  let watcher: FSWatcher | null = null;

  // Debounce map to avoid duplicate syncs for rapid file changes
  const pendingSyncs = new Map<string, ReturnType<typeof setTimeout>>();

  const syncFile = async (relativePath: string) => {
    try {
      const sourcePath = join(sourceDir, relativePath);
      const targetPath = join(targetDir, relativePath);

      // Verify source exists and is a file
      const sourceStats = await stat(sourcePath).catch(() => null);
      if (!sourceStats || !sourceStats.isFile()) return;

      // Ensure target directory exists
      await mkdir(dirname(targetPath), { recursive: true });

      // Copy file
      await copyFile(sourcePath, targetPath);
      onSync?.(relativePath);
    } catch (error) {
      onError?.(error);
    }
  };

  try {
    watcher = watch(sourceDir, { recursive: true }, (_eventType, filename) => {
      if (!filename) return;
      const relativePath = relative(sourceDir, join(sourceDir, filename));
      if (shouldIgnore(relativePath)) return;

      // Debounce: wait 100ms before syncing to coalesce rapid changes
      const existing = pendingSyncs.get(relativePath);
      if (existing) clearTimeout(existing);
      pendingSyncs.set(
        relativePath,
        setTimeout(() => {
          pendingSyncs.delete(relativePath);
          void syncFile(relativePath);
        }, 100),
      );
    });

    watcher.on("error", (error) => {
      onError?.(error);
    });
  } catch (error) {
    onError?.(error);
  }

  return {
    stop: () => {
      // Clear pending syncs
      for (const timeout of pendingSyncs.values()) {
        clearTimeout(timeout);
      }
      pendingSyncs.clear();

      if (watcher) {
        watcher.close();
        watcher = null;
      }
    },
  };
}
