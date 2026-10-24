import { merge } from "node-diff3";
import { db, getConfig, getHeadOid, setKV, type VaultConfig, type VaultFile } from "./db";
import {
  createCommit,
  getBlobTexts,
  getHeadCommit,
  getTree,
  gitBlobSha,
  GitHubError,
  StaleHeadError,
  type TreeEntry,
} from "./github";

const MAX_TEXT_SIZE = 2 * 1024 * 1024;

/** Files whose content we keep locally. Everything else is tracked by metadata only. */
export function isTextPath(path: string) {
  return /\.(md|markdown|txt|canvas)$/i.test(path) || /^\.obsidian\/[^/]+\.json$/.test(path);
}

const isTextEntry = (e: TreeEntry) => isTextPath(e.path) && e.size <= MAX_TEXT_SIZE;

// ---------------------------------------------------------------------------
// Status store (consumed via useSyncExternalStore)

export type SyncState = "idle" | "syncing" | "offline" | "error";

export interface SyncStatus {
  state: SyncState;
  error?: string;
  lastSync?: number;
  progress?: string;
}

let status: SyncStatus = { state: "idle" };
const listeners = new Set<() => void>();

function setStatus(next: Partial<SyncStatus>) {
  status = { ...status, ...next };
  listeners.forEach((l) => l());
}

export const syncStatus = {
  get: () => status,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

// ---------------------------------------------------------------------------
// Clone

export async function cloneVault(cfg: VaultConfig, onProgress: (msg: string) => void) {
  onProgress("Reading repository…");
  const head = await getHeadCommit(cfg);
  const tree = await getTree(cfg, head.treeSha);
  const textEntries = tree.filter(isTextEntry);

  onProgress(`Downloading 0 / ${textEntries.length} notes…`);
  const texts = await getBlobTexts(
    cfg,
    textEntries.map((e) => e.sha),
    (done) => onProgress(`Downloading ${done} / ${textEntries.length} notes…`),
  );

  const now = Date.now();
  const rows: VaultFile[] = tree.map((e) => {
    const isText = isTextEntry(e);
    const text = isText ? (texts.get(e.sha) ?? "") : "";
    return { path: e.path, sha: e.sha, isText, content: text, base: text, dirty: false, deleted: false, updatedAt: now };
  });

  await db.transaction("rw", db.files, db.kv, async () => {
    await db.files.clear();
    await db.files.bulkPut(rows);
    await setKV("config", cfg);
    await setKV("headOid", head.oid);
  });
  setStatus({ state: "idle", lastSync: Date.now(), error: undefined, progress: undefined });
}

// ---------------------------------------------------------------------------
// Pull

export function merge3(base: string, ours: string, theirs: string): { clean: boolean; text: string } {
  const result = merge(ours.split("\n"), base.split("\n"), theirs.split("\n"), { excludeFalseConflicts: true });
  return { clean: !result.conflict, text: result.result.join("\n") };
}

function conflictPath(path: string) {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}`;
  const dot = path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  return dot > slash
    ? `${path.slice(0, dot)} (conflict ${stamp})${path.slice(dot)}`
    : `${path} (conflict ${stamp})`;
}

/** Brings remote commits into the local DB. Returns true if anything changed. */
async function pull(cfg: VaultConfig): Promise<boolean> {
  const headOid = await getHeadOid();
  const remote = await getHeadCommit(cfg);
  if (remote.oid === headOid) return false;

  const tree = await getTree(cfg, remote.treeSha);
  const remoteByPath = new Map(tree.map((e) => [e.path, e]));
  const local = await db.files.toArray();
  const localByPath = new Map(local.map((f) => [f.path, f]));

  const changed = tree.filter((e) => localByPath.get(e.path)?.sha !== e.sha);
  const removed = local.filter((f) => f.sha !== null && !remoteByPath.has(f.path)).map((f) => f.path);

  const texts = await getBlobTexts(
    cfg,
    changed.filter(isTextEntry).map((e) => e.sha),
  );

  await db.transaction("rw", db.files, db.kv, async () => {
    const now = Date.now();
    for (const entry of changed) {
      const isText = isTextEntry(entry);
      const remoteText = isText ? (texts.get(entry.sha) ?? "") : "";
      const clean: VaultFile = {
        path: entry.path, sha: entry.sha, isText, content: remoteText, base: remoteText,
        dirty: false, deleted: false, updatedAt: now,
      };
      // Re-read inside the transaction: the user may have typed during the fetch.
      const cur = await db.files.get(entry.path);

      if (!cur || !cur.dirty || cur.deleted || !isText) {
        // No local edits, or a local delete of something that changed remotely
        // (keep the remote version rather than silently losing it).
        await db.files.put(clean);
        continue;
      }

      const merged = merge3(cur.base, cur.content, remoteText);
      if (merged.clean) {
        await db.files.put({ ...clean, content: merged.text, dirty: merged.text !== remoteText });
      } else {
        // Local version wins in place; the remote version is kept beside it.
        await db.files.put({ ...clean, content: cur.content, dirty: true });
        await db.files.put({ ...clean, path: conflictPath(entry.path), sha: null, base: "", dirty: true });
      }
    }

    for (const path of removed) {
      const cur = await db.files.get(path);
      if (!cur) continue;
      if (!cur.dirty || cur.deleted) await db.files.delete(path);
      // Edited locally but deleted remotely: keep it, it'll be re-added on push.
      else await db.files.update(path, { sha: null, base: "" });
    }

    await setKV("headOid", remote.oid);
  });
  return true;
}

// ---------------------------------------------------------------------------
// Push

function commitMessage(updated: string[], deleted: string[]) {
  const name = (p: string) => p.split("/").pop()!.replace(/\.md$/, "");
  if (updated.length + deleted.length > 1) return `mobile: update ${updated.length + deleted.length} files`;
  return updated.length ? `mobile: update ${name(updated[0])}` : `mobile: delete ${name(deleted[0])}`;
}

async function push(cfg: VaultConfig, retry = true): Promise<void> {
  const dirty = await db.files.filter((f) => f.dirty).toArray();
  if (dirty.length === 0) return;

  const additions = dirty.filter((f) => !f.deleted && f.isText).map((f) => ({ path: f.path, content: f.content }));
  const deletions = dirty.filter((f) => f.deleted && f.sha !== null).map((f) => f.path);
  if (additions.length === 0 && deletions.length === 0) return;

  const headOid = await getHeadOid();
  if (!headOid) throw new Error("Vault not cloned");

  let newOid: string;
  try {
    newOid = await createCommit(cfg, headOid, commitMessage(additions.map((a) => a.path), deletions), additions, deletions);
  } catch (e) {
    if (e instanceof StaleHeadError && retry) {
      await pull(cfg);
      return push(cfg, false);
    }
    throw e;
  }

  const shas = await Promise.all(additions.map((a) => gitBlobSha(a.content)));

  await db.transaction("rw", db.files, db.kv, async () => {
    for (let i = 0; i < additions.length; i++) {
      const { path, content } = additions[i];
      const cur = await db.files.get(path);
      if (!cur) continue;
      // Anything typed after the snapshot stays dirty for the next push.
      await db.files.update(path, { sha: shas[i], base: content, dirty: cur.deleted || cur.content !== content });
    }
    for (const path of deletions) {
      const cur = await db.files.get(path);
      if (!cur) continue;
      if (cur.deleted) await db.files.delete(path);
      else await db.files.update(path, { sha: null, base: "" });
    }
    await setKV("headOid", newOid);
  });
}

// ---------------------------------------------------------------------------
// Sync orchestration

/** Hooks awaited before every sync, e.g. the editor flushing its debounced save. */
export const beforeSync = new Set<() => Promise<void>>();

let running: Promise<void> | null = null;
let again = false;

/** Pull then push. Concurrent calls coalesce into one follow-up run. */
export function syncNow(): Promise<void> {
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    try {
      do {
        again = false;
        await runOnce();
      } while (again);
    } finally {
      running = null;
    }
  })();
  return running;
}

async function runOnce() {
  await Promise.all([...beforeSync].map((fn) => fn()));
  const cfg = await getConfig();
  if (!cfg) return;
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    setStatus({ state: "offline" });
    return;
  }
  setStatus({ state: "syncing", error: undefined });
  try {
    await pull(cfg);
    await push(cfg);
    setStatus({ state: "idle", lastSync: Date.now() });
  } catch (e) {
    const offline = e instanceof TypeError; // fetch network failure
    const msg =
      e instanceof GitHubError && e.status === 401
        ? "GitHub token is invalid or expired"
        : e instanceof Error
          ? e.message
          : String(e);
    setStatus(offline ? { state: "offline" } : { state: "error", error: msg });
  }
}

let timer: ReturnType<typeof setTimeout> | undefined;

/** Debounced sync, used after edits. */
export function scheduleSync(delayMs: number) {
  clearTimeout(timer);
  timer = setTimeout(() => void syncNow(), delayMs);
}
