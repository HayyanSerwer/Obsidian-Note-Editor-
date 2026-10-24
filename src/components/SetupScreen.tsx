"use client";

import { useState } from "react";
import { getRepoInfo } from "@/lib/github";
import { cloneVault } from "@/lib/sync";

/** Accepts "owner/repo", "github.com/owner/repo", or a full URL. */
function parseRepo(input: string) {
  const m = input.trim().replace(/\.git$/, "").match(/(?:github\.com[/:])?([\w.-]+)\/([\w.-]+)\/?$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

export function SetupScreen() {
  const [token, setToken] = useState("");
  const [repoInput, setRepoInput] = useState("");
  const [branch, setBranch] = useState("");
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const parsed = parseRepo(repoInput);
    if (!parsed) return setError("Enter the repository as owner/name");
    try {
      setProgress("Connecting to GitHub…");
      const info = await getRepoInfo({ token: token.trim(), ...parsed });
      // Ask the browser not to evict our IndexedDB copy under storage pressure.
      // Not awaited: Firefox resolves it only after the user answers a permission prompt.
      void navigator.storage?.persist?.().catch(() => {});
      await cloneVault({ token: token.trim(), ...parsed, branch: branch.trim() || info.default_branch }, setProgress);
    } catch (err) {
      setProgress(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const field = "w-full rounded-lg bg-[var(--input)] px-3 py-2.5 text-base outline-none placeholder:text-[var(--muted)]";

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-4 py-10">
      <h1 className="text-2xl font-semibold">Connect your vault</h1>
      <p className="mt-2 text-sm text-[var(--muted)]">
        Notes are copied to this device and synced with your GitHub repo. Your token stays on this device and is sent only to GitHub.
      </p>
      <form onSubmit={submit} className="mt-6 flex flex-col gap-4">
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Repository</span>
          <input className={field} value={repoInput} onChange={(e) => setRepoInput(e.target.value)} placeholder="you/obsidian-vault" autoCapitalize="none" autoCorrect="off" spellCheck={false} required />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Personal access token</span>
          <input className={field} type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="github_pat_…" autoComplete="off" required />
          <span className="text-xs text-[var(--muted)]">
            Create a{" "}
            <a className="text-[var(--accent)] underline" href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer">
              fine-grained token
            </a>{" "}
            with access to only this repo and <b>Contents: Read and write</b>.
          </span>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Branch <span className="font-normal text-[var(--muted)]">(optional)</span></span>
          <input className={field} value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="default branch" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
        </label>
        {error && <p className="rounded-lg bg-[var(--error-bg)] px-3 py-2 text-sm text-[var(--error)]">{error}</p>}
        <button
          type="submit"
          disabled={progress !== null}
          className="mt-2 rounded-lg bg-[var(--accent)] px-4 py-3 font-medium text-white disabled:opacity-60"
        >
          {progress ?? "Connect"}
        </button>
      </form>
    </main>
  );
}
