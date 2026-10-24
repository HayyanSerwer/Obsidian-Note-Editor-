# Vault: Obsidian notes on your phone, synced with GitHub

A mobile-first PWA that clones an Obsidian vault from a GitHub repo into the
browser (IndexedDB), lets you edit notes offline, and auto-commits changes back.
It pairs with the [Obsidian Git](https://github.com/Vinzent03/obsidian-git) plugin on desktop.

## How sync works

- **Local first:** every edit is saved to IndexedDB about 400 ms after you stop typing.
- **Push:** about 10 s after you stop typing, when the app is backgrounded, and when you come back online.
  All pending changes go in one commit (GraphQL `createCommitOnBranch`) guarded by
  `expectedHeadOid`, so it never overwrites commits it hasn't seen.
- **Pull:** on open, on focus, every 2 min and before every push. Remote changes are
  3-way merged with local edits. If the same lines changed on both sides, your
  version stays in place and the remote version is saved next to it as
  `Note (conflict YYYY-MM-DD HHMM).md`.

## Setup

1. Create a [fine-grained token](https://github.com/settings/personal-access-tokens/new)
   with access to only your vault repo and **Contents: Read and write**.
2. `pnpm install && pnpm dev`, open http://localhost:3000, and enter the repo and token.
3. On desktop, set Obsidian Git to pull on startup and auto commit-and-sync every few minutes.

## Deploy

`pnpm build` produces a static site in `out/`. Host it anywhere with HTTPS
(Cloudflare Pages, GitHub Pages, Netlify). HTTPS is required for the service
worker and for `crypto.subtle`. Open it on your phone and use **Add to Home Screen**.
On iOS, installing it matters: Safari may clear storage for sites that aren't installed.

## Layout

- `src/lib/db.ts`: IndexedDB schema (Dexie) and local file operations
- `src/lib/github.ts`: GitHub REST/GraphQL client
- `src/lib/sync.ts`: clone, pull + 3-way merge, push, sync scheduling
- `src/lib/links.ts`: Obsidian-style `[[wikilink]]` parsing and resolution, and the live note index
- `src/components/Editor.tsx`: CodeMirror 6 editor with debounced saving and live merging of incoming changes
- `src/components/wikilinks.ts`: editor extension for link styling, tap to follow, `[[` autocomplete and heading scroll
- `public/sw.js`: service worker that caches the app shell for offline launch
