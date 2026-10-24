"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { createFile, db, deleteFile, renameFile, resetVault, type VaultConfig } from "@/lib/db";
import { newNotePathFor, resolveLink, setPendingHeading, useNoteIndex, type Wikilink } from "@/lib/links";
import { scheduleSync, syncNow } from "@/lib/sync";
import { Editor } from "./Editor";
import { FileTree, noteName } from "./FileTree";
import { SyncBadge, useSyncStatus } from "./SyncBadge";

const PULL_INTERVAL = 2 * 60_000;
const LAST_NOTE_KEY = "lastNote";

// The open note lives in the URL hash so the phone's back button works.
const hash = {
  subscribe(cb: () => void) {
    window.addEventListener("hashchange", cb);
    return () => window.removeEventListener("hashchange", cb);
  },
  get: () => decodeURIComponent(window.location.hash.slice(1)) || null,
  server: () => null,
};

function openNote(path: string) {
  window.location.hash = encodeURIComponent(path);
  try {
    localStorage.setItem(LAST_NOTE_KEY, path);
  } catch {}
}

function readLastNote() {
  try {
    return localStorage.getItem(LAST_NOTE_KEY);
  } catch {
    return null;
  }
}

function normalizeNotePath(input: string) {
  const p = input.trim().replace(/^\/+|\/+$/g, "");
  if (!p) return null;
  return /\.[a-z0-9]+$/i.test(p) ? p : `${p}.md`;
}

/** Pull on open, focus, reconnect and on an interval; push when the app is backgrounded. */
function useSyncTriggers() {
  useEffect(() => {
    void syncNow();
    const onVisibility = () => void syncNow();
    const onOnline = () => void syncNow();
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") void syncNow();
    }, PULL_INTERVAL);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("online", onOnline);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", onOnline);
    };
  }, []);
}

export function Vault({ config }: { config: VaultConfig }) {
  useSyncTriggers();
  const activePath = useSyncExternalStore(hash.subscribe, hash.get, hash.server);
  // Vault only renders client-side (after IndexedDB loads), so window is available here.
  const [drawerOpen, setDrawerOpen] = useState(() => !window.location.hash && !readLastNote());
  const [menuOpen, setMenuOpen] = useState(false);
  const status = useSyncStatus();
  const index = useNoteIndex();

  // Only query while the drawer is open; otherwise every keystroke save would re-read the vault.
  const files = useLiveQuery(
    async () => {
      if (!drawerOpen) return null;
      const rows = await db.files.filter((f) => !f.deleted).toArray();
      return rows.map((f) => ({ path: f.path, dirty: f.dirty }));
    },
    [drawerOpen],
  );

  // Restore the last note on launch.
  useEffect(() => {
    const last = readLastNote();
    if (!window.location.hash && last) window.location.replace(`#${encodeURIComponent(last)}`);
  }, []);

  const open = (path: string) => {
    openNote(path);
    setDrawerOpen(false);
  };

  /** Follow a [[wikilink]]; like Obsidian, a link to a missing note creates it. */
  async function follow(link: Wikilink) {
    if (!activePath || !index) return;
    if (/\.(?!md$)[a-z0-9]+$/i.test(link.target)) return; // attachments aren't viewable yet
    let path = resolveLink(link.target, activePath, index);
    if (!path) {
      path = await newNotePathFor(link.target, activePath);
      try {
        await createFile(path);
        scheduleSync(10_000);
      } catch {
        // Already exists (index was momentarily stale): just open it.
      }
    }
    setPendingHeading(link.heading ?? null);
    openNote(path);
  }

  async function newNote() {
    const folder = activePath?.includes("/") ? activePath.slice(0, activePath.lastIndexOf("/") + 1) : "";
    const path = normalizeNotePath(prompt("New note", folder) ?? "");
    if (!path) return;
    try {
      await createFile(path);
      open(path);
      scheduleSync(10_000);
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
  }

  async function rename() {
    setMenuOpen(false);
    if (!activePath) return;
    const to = normalizeNotePath(prompt("Rename to", activePath.replace(/\.md$/i, "")) ?? "");
    if (!to || to === activePath) return;
    try {
      await renameFile(activePath, to);
      window.location.replace(`#${encodeURIComponent(to)}`);
      scheduleSync(2_000);
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
  }

  async function remove() {
    setMenuOpen(false);
    if (!activePath || !confirm(`Delete "${noteName(activePath)}"?`)) return;
    await deleteFile(activePath);
    window.location.replace("#");
    scheduleSync(2_000);
  }

  async function signOut() {
    const pending = await db.files.filter((f) => f.dirty).count();
    const msg = pending
      ? `${pending} change(s) haven't synced and will be lost. Disconnect anyway?`
      : "Disconnect this vault and remove it from this device?";
    if (!confirm(msg)) return;
    await resetVault();
    try {
      localStorage.removeItem(LAST_NOTE_KEY);
    } catch {}
    window.location.replace("#");
  }

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <header className="flex h-12 shrink-0 items-center gap-1 border-b border-[var(--border)] px-1 pt-[env(safe-area-inset-top)] box-content">
        <button onClick={() => setDrawerOpen(true)} className="rounded-lg p-2.5 active:bg-[var(--hover)]" aria-label="Open notes">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <path d="M3 5h14M3 10h14M3 15h14" />
          </svg>
        </button>
        <h1 className="min-w-0 flex-1 truncate text-[15px] font-semibold">{activePath ? noteName(activePath) : "Notes"}</h1>
        <SyncBadge />
        {activePath && (
          <div className="relative">
            <button onClick={() => setMenuOpen((o) => !o)} className="rounded-lg p-2.5 active:bg-[var(--hover)]" aria-label="Note actions">
              <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
                <circle cx="10" cy="4" r="1.6" /><circle cx="10" cy="10" r="1.6" /><circle cx="10" cy="16" r="1.6" />
              </svg>
            </button>
            {menuOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
                <div className="absolute right-1 top-11 z-20 w-40 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--panel)] shadow-lg">
                  <button onClick={rename} className="block w-full px-4 py-3 text-left text-[15px] active:bg-[var(--hover)]">Rename</button>
                  <button onClick={remove} className="block w-full px-4 py-3 text-left text-[15px] text-[var(--error)] active:bg-[var(--hover)]">Delete</button>
                </div>
              </>
            )}
          </div>
        )}
      </header>

      {status.state === "error" && (
        <button onClick={() => void syncNow()} className="shrink-0 bg-[var(--error-bg)] px-4 py-2 text-left text-sm text-[var(--error)]">
          {status.error} · Tap to retry
        </button>
      )}

      <main className="min-h-0 flex-1 overflow-hidden">
        {activePath ? (
          <Editor key={activePath} path={activePath} index={index} onFollow={follow} />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-[var(--muted)]">
            <p>No note open</p>
            <button onClick={() => setDrawerOpen(true)} className="rounded-lg bg-[var(--input)] px-4 py-2 text-[var(--foreground)]">Browse notes</button>
          </div>
        )}
      </main>

      {/* Drawer */}
      <div
        className={`fixed inset-0 z-30 bg-black/40 transition-opacity ${drawerOpen ? "opacity-100" : "pointer-events-none opacity-0"}`}
        onClick={() => setDrawerOpen(false)}
      />
      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-[85vw] max-w-sm flex-col bg-[var(--panel)] pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] transition-transform ${
          drawerOpen ? "translate-x-0 shadow-xl" : "-translate-x-full"
        }`}
      >
        <div className="flex items-center gap-2 px-4 pb-2 pt-3">
          <div className="min-w-0 flex-1">
            <div className="truncate font-semibold">{config.repo}</div>
            <div className="truncate text-xs text-[var(--muted)]">{config.owner} · {config.branch}</div>
          </div>
          <button onClick={newNote} className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-white">New</button>
        </div>
        {drawerOpen && files && <FileTree files={files} activePath={activePath} onOpen={open} />}
        <div className="border-t border-[var(--border)] px-4 py-2">
          <button onClick={signOut} className="py-1.5 text-sm text-[var(--muted)]">Disconnect vault</button>
        </div>
      </aside>
    </div>
  );
}
