"use client";

import { useMemo, useState } from "react";

interface Folder {
  name: string;
  path: string;
  folders: Map<string, Folder>;
  files: { name: string; path: string; dirty: boolean }[];
}

export interface TreeFile {
  path: string;
  dirty: boolean;
}

const isHidden = (path: string) => path.split("/").some((seg) => seg.startsWith("."));
export const noteName = (path: string) => path.split("/").pop()!.replace(/\.md$/i, "");

function buildTree(files: TreeFile[]): Folder {
  const root: Folder = { name: "", path: "", folders: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split("/");
    let node = root;
    for (const part of parts.slice(0, -1)) {
      let next = node.folders.get(part);
      if (!next) {
        next = { name: part, path: node.path ? `${node.path}/${part}` : part, folders: new Map(), files: [] };
        node.folders.set(part, next);
      }
      node = next;
    }
    node.files.push({ name: noteName(f.path), path: f.path, dirty: f.dirty });
  }
  return root;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function FolderView({
  folder,
  depth,
  open,
  toggle,
  activePath,
  onOpen,
}: {
  folder: Folder;
  depth: number;
  open: Set<string>;
  toggle: (path: string) => void;
  activePath: string | null;
  onOpen: (path: string) => void;
}) {
  const folders = [...folder.folders.values()].sort((a, b) => collator.compare(a.name, b.name));
  const files = [...folder.files].sort((a, b) => collator.compare(a.name, b.name));
  const pad = { paddingLeft: `${12 + depth * 14}px` };
  return (
    <>
      {folders.map((f) => (
        <div key={f.path}>
          <button
            onClick={() => toggle(f.path)}
            className="flex w-full items-center gap-1.5 py-2 pr-3 text-left text-[15px] font-medium text-[var(--muted-strong)] active:bg-[var(--hover)]"
            style={pad}
          >
            <span className={`inline-block w-3 text-xs transition-transform ${open.has(f.path) ? "rotate-90" : ""}`}>▶</span>
            <span className="truncate">{f.name}</span>
          </button>
          {open.has(f.path) && (
            <FolderView folder={f} depth={depth + 1} open={open} toggle={toggle} activePath={activePath} onOpen={onOpen} />
          )}
        </div>
      ))}
      {files.map((f) => (
        <button
          key={f.path}
          onClick={() => onOpen(f.path)}
          className={`flex w-full items-center gap-2 py-2 pr-3 text-left text-[15px] active:bg-[var(--hover)] ${
            f.path === activePath ? "bg-[var(--hover)] text-[var(--accent)]" : ""
          }`}
          style={{ paddingLeft: `${12 + depth * 14 + 18}px` }}
        >
          <span className="truncate">{f.name}</span>
          {f.dirty && <span className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--warn)]" title="Not yet synced" />}
        </button>
      ))}
    </>
  );
}

export function FileTree({
  files,
  activePath,
  onOpen,
}: {
  files: TreeFile[];
  activePath: string | null;
  onOpen: (path: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Set<string>>(() => {
    // Start with the active note's folders expanded.
    const s = new Set<string>();
    const parts = activePath?.split("/").slice(0, -1) ?? [];
    parts.forEach((_, i) => s.add(parts.slice(0, i + 1).join("/")));
    return s;
  });

  const notes = useMemo(() => files.filter((f) => /\.md$/i.test(f.path) && !isHidden(f.path)), [files]);
  const tree = useMemo(() => buildTree(notes), [notes]);

  const q = query.trim().toLowerCase();
  const matches = useMemo(
    () =>
      q
        ? notes
            .filter((f) => f.path.toLowerCase().includes(q))
            .sort((a, b) => collator.compare(noteName(a.path), noteName(b.path)))
            .slice(0, 200)
        : [],
    [notes, q],
  );

  const toggle = (path: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-3 pb-2">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search notes"
          className="w-full rounded-lg bg-[var(--input)] px-3 py-2 text-[15px] outline-none placeholder:text-[var(--muted)]"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-4">
        {q ? (
          matches.length ? (
            matches.map((f) => (
              <button
                key={f.path}
                onClick={() => onOpen(f.path)}
                className="block w-full px-4 py-2 text-left active:bg-[var(--hover)]"
              >
                <div className="truncate text-[15px]">{noteName(f.path)}</div>
                <div className="truncate text-xs text-[var(--muted)]">{f.path}</div>
              </button>
            ))
          ) : (
            <p className="px-4 py-2 text-sm text-[var(--muted)]">No matching notes</p>
          )
        ) : (
          <FolderView folder={tree} depth={0} open={open} toggle={toggle} activePath={activePath} onOpen={onOpen} />
        )}
      </div>
    </div>
  );
}
