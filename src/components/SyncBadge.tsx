"use client";

import { useSyncExternalStore } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "@/lib/db";
import { syncNow, syncStatus } from "@/lib/sync";

export function useSyncStatus() {
  return useSyncExternalStore(syncStatus.subscribe, syncStatus.get, syncStatus.get);
}

export function SyncBadge() {
  const status = useSyncStatus();
  const pending = useLiveQuery(() => db.files.filter((f) => f.dirty).count(), []) ?? 0;

  const [color, label] =
    status.state === "syncing"
      ? ["bg-[var(--accent)] animate-pulse", "Syncing"]
      : status.state === "error"
        ? ["bg-[var(--error)]", "Sync error"]
        : status.state === "offline"
          ? ["bg-[var(--muted)]", pending ? `Offline · ${pending}` : "Offline"]
          : pending
            ? ["bg-[var(--warn)]", `${pending} pending`]
            : ["bg-[var(--ok)]", "Synced"];

  return (
    <button
      onClick={() => void syncNow()}
      className="flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs text-[var(--muted-strong)] active:bg-[var(--hover)]"
      title={status.error ?? (status.lastSync ? `Last synced ${new Date(status.lastSync).toLocaleTimeString()}` : "Tap to sync")}
    >
      <span className={`h-2 w-2 rounded-full ${color}`} />
      {label}
    </button>
  );
}
