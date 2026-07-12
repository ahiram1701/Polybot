import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

// Under load (AV scans, many overlapping writers) 200ms of total backoff proved flaky on Windows;
// the tail retries make the worst case ~1.6s, which beats failing a state write.
const RETRY_DELAYS_MS = [10, 30, 80, 200, 400, 900];
// Windows-specific transient failures: AV/indexer holds a brief lock on the temp or target (EPERM/
// EACCES/EBUSY), or a rename lands on a vanished path (ENOENT). All are safe to retry.
const RETRYABLE_CODES = new Set(["EPERM", "EACCES", "EBUSY", "ENOENT"]);

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Write a file atomically: write to a UNIQUE temp path, then rename over the target. The unique
 * per-call temp name means overlapping writers to the same file never share a temp file (the old
 * fixed `${path}.tmp` caused ENOENT when one writer's rename removed the temp another was about to
 * rename). Retries the transient Windows lock failures (EPERM/EACCES/EBUSY) with a short backoff.
 */
export async function writeFileAtomic(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      await writeFile(tempPath, contents, "utf8");
      await rename(tempPath, path);
      return;
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (!code || !RETRYABLE_CODES.has(code) || attempt === RETRY_DELAYS_MS.length) {
        await rm(tempPath, { force: true }).catch(() => undefined);
        throw error;
      }
      await delay(RETRY_DELAYS_MS[attempt]);
    }
  }
  await rm(tempPath, { force: true }).catch(() => undefined);
  throw lastError;
}
