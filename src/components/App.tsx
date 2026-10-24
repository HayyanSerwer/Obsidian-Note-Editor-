"use client";

import { useEffect } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { getConfig } from "@/lib/db";
import { SetupScreen } from "./SetupScreen";
import { Vault } from "./Vault";

function useServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").then(async (reg) => {
      // Assets loaded before the worker took control aren't cached yet; hand it the list.
      const worker = reg.active ?? (await navigator.serviceWorker.ready).active;
      const urls = performance
        .getEntriesByType("resource")
        .map((e) => e.name)
        .filter((u) => u.startsWith(location.origin));
      worker?.postMessage({ type: "cache-urls", urls: [...urls, location.pathname] });
    });
  }, []);
}

export function App() {
  useServiceWorker();
  // null = no vault configured; undefined = still loading from IndexedDB.
  const config = useLiveQuery(() => getConfig().then((c) => c ?? null), []);
  if (config === undefined) return null;
  return config ? <Vault config={config} /> : <SetupScreen />;
}
