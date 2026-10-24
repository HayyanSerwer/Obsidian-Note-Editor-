import { useMemo } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "./db";

export interface Wikilink {
  /** Note name or path, without heading/alias; empty for same-note links like [[#Heading]]. */
  target: string;
  heading?: string;
  alias?: string;
}

/** Parses the inside of [[...]]: "Note#Heading|Alias" or "Note^block". */
export function parseWikilink(inner: string): Wikilink {
  const [ref, alias] = splitOnce(inner, "|");
  const [target, sub] = splitOnce(ref, "#");
  // Block refs (^id) navigate to the note; we don't scroll to blocks yet.
  const heading = sub && !sub.startsWith("^") ? sub.trim() : undefined;
  return { target: target.replace(/\^.*$/, "").trim(), heading, alias: alias?.trim() };
}

function splitOnce(s: string, sep: string): [string, string | undefined] {
  const i = s.indexOf(sep);
  return i < 0 ? [s, undefined] : [s.slice(0, i), s.slice(i + 1)];
}

const isHidden = (path: string) => path.split("/").some((seg) => seg.startsWith("."));
const stripMd = (path: string) => path.replace(/\.md$/i, "");
const basename = (path: string) => stripMd(path.split("/").pop()!);
const dirname = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

/** Resolves "." and ".." segments, e.g. for relative image paths. */
function normalizePath(path: string) {
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "..") out.pop();
    else if (seg && seg !== ".") out.push(seg);
  }
  return out.join("/");
}

export interface NoteIndex {
  notes: string[];
  /** lowercase name -> paths. Notes are keyed without ".md", attachments with their extension. */
  byName: Map<string, string[]>;
  /** lowercase path (notes without ".md") -> path */
  byPath: Map<string, string>;
}

export function buildIndex(paths: string[]): NoteIndex {
  const files = paths.filter((p) => !isHidden(p));
  const notes = files.filter((p) => /\.md$/i.test(p));
  const byName = new Map<string, string[]>();
  const byPath = new Map<string, string>();
  for (const p of files) {
    const key = basename(p).toLowerCase();
    byName.set(key, [...(byName.get(key) ?? []), p]);
    byPath.set(stripMd(p).toLowerCase(), p);
  }
  return { notes, byName, byPath };
}

/**
 * Obsidian-style resolution: an explicit path wins, then a note with that name,
 * preferring one in the linking note's folder, then the shortest path.
 */
export function resolveLink(target: string, fromPath: string, index: NoteIndex): string | null {
  const t = stripMd(target.trim()).replace(/^\/+/, "").toLowerCase();
  if (!t) return null;
  if (t.includes("/")) {
    const fromDir = dirname(fromPath).toLowerCase();
    return (
      index.byPath.get(normalizePath(t)) ??
      (fromDir ? index.byPath.get(normalizePath(`${fromDir}/${t}`)) : undefined) ??
      // Obsidian falls back to the file name when a path doesn't match exactly.
      resolveLink(t.split("/").pop()!, fromPath, index)
    );
  }
  const matches = index.byName.get(t);
  if (!matches?.length) return null;
  const fromDir = dirname(fromPath);
  return matches.find((p) => dirname(p) === fromDir) ?? [...matches].sort((a, b) => a.length - b.length)[0];
}

/** The shortest link text that unambiguously points at `path`. */
export function linkTextFor(path: string, index: NoteIndex) {
  const name = basename(path);
  return (index.byName.get(name.toLowerCase())?.length ?? 0) > 1 ? stripMd(path) : name;
}

/** Where a note created by following an unresolved link goes, per Obsidian's "Default location for new notes". */
export async function newNotePathFor(target: string, fromPath: string) {
  const name = `${stripMd(target.trim()).replace(/^\/+/, "")}.md`;
  if (name.includes("/")) return name;
  let folder = "";
  try {
    const app = JSON.parse((await db.files.get(".obsidian/app.json"))?.content || "{}");
    if (app.newFileLocation === "current") folder = dirname(fromPath);
    else if (app.newFileLocation === "folder") folder = String(app.newFileFolderPath ?? "").replace(/^\/+|\/+$/g, "");
  } catch {}
  return folder ? `${folder}/${name}` : name;
}

/** Live index of all notes. Reads only primary keys, so it stays cheap as notes are edited. */
export function useNoteIndex(): NoteIndex | undefined {
  const paths = useLiveQuery(() => db.files.toCollection().primaryKeys(), []);
  return useMemo(() => (paths ? buildIndex(paths) : undefined), [paths]);
}

// A heading to scroll to once the next note opens (set when following [[Note#Heading]]).
let pendingHeading: string | null = null;
export const setPendingHeading = (h: string | null) => (pendingHeading = h);
export function takePendingHeading() {
  const h = pendingHeading;
  pendingHeading = null;
  return h;
}
