"use client";

import { useEffect, useRef } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Annotation, EditorState } from "@codemirror/state";
import { EditorView, keymap, placeholder, drawSelection, highlightActiveLine } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { db, saveContent } from "@/lib/db";
import { beforeSync, merge3, scheduleSync } from "@/lib/sync";

const SAVE_DELAY = 400;
const PUSH_DELAY = 10_000;

/** Marks transactions that came from the DB rather than the user, so they aren't saved back. */
const external = Annotation.define<boolean>();

const highlight = HighlightStyle.define([
  { tag: t.heading1, fontSize: "1.6em", fontWeight: "700" },
  { tag: t.heading2, fontSize: "1.35em", fontWeight: "700" },
  { tag: t.heading3, fontSize: "1.15em", fontWeight: "600" },
  { tag: [t.heading4, t.heading5, t.heading6], fontWeight: "600" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: [t.link, t.url], color: "var(--accent)" },
  { tag: t.monospace, fontFamily: "var(--font-mono)", color: "var(--code)" },
  { tag: [t.processingInstruction, t.meta, t.quote], color: "var(--muted)" },
  { tag: t.keyword, color: "var(--accent)" },
  { tag: [t.string, t.number], color: "var(--code)" },
  { tag: t.comment, color: "var(--muted)", fontStyle: "italic" },
]);

const theme = EditorView.theme({
  "&": { height: "100%", fontSize: "16px", backgroundColor: "transparent", color: "var(--foreground)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-sans)", lineHeight: "1.6", padding: "12px 0 40vh" },
  ".cm-content": { padding: "0 16px", maxWidth: "48rem", margin: "0 auto", caretColor: "var(--accent)" },
  ".cm-line": { padding: "0" },
  ".cm-activeLine": { backgroundColor: "transparent" },
  ".cm-cursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": { backgroundColor: "var(--selection) !important" },
  ".cm-placeholder": { color: "var(--muted)" },
});

/** Replace the doc with `next` as one minimal change, so the cursor stays put. */
function minimalChange(prev: string, next: string) {
  let start = 0;
  while (start < prev.length && start < next.length && prev[start] === next[start]) start++;
  let endPrev = prev.length;
  let endNext = next.length;
  while (endPrev > start && endNext > start && prev[endPrev - 1] === next[endNext - 1]) {
    endPrev--;
    endNext--;
  }
  return { from: start, to: endPrev, insert: next.slice(start, endNext) };
}

export function Editor({ path }: { path: string }) {
  const file = useLiveQuery(() => db.files.get(path).then((f) => f ?? null), [path]);
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  /** The content we know the DB holds and the editor was last in agreement with. */
  const synced = useRef<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const loaded = file !== undefined && file !== null && !file.deleted;
  const initialContent = loaded ? file.content : null;

  // Create the editor once the file has loaded.
  useEffect(() => {
    if (initialContent === null || view.current || !host.current) return;

    const flush = async () => {
      clearTimeout(saveTimer.current);
      saveTimer.current = undefined;
      const v = view.current;
      if (!v) return;
      const doc = v.state.doc.toString();
      if (doc === synced.current) return;
      synced.current = doc;
      await saveContent(path, doc);
    };

    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: initialContent,
        extensions: [
          history(),
          drawSelection(),
          highlightActiveLine(),
          EditorView.lineWrapping,
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          markdown({ base: markdownLanguage, codeLanguages: languages }),
          syntaxHighlighting(highlight),
          placeholder("Start writing…"),
          theme,
          EditorView.contentAttributes.of({ autocapitalize: "sentences", spellcheck: "true", autocorrect: "on" }),
          EditorView.updateListener.of((u) => {
            if (!u.docChanged || u.transactions.some((tr) => tr.annotation(external))) return;
            clearTimeout(saveTimer.current);
            saveTimer.current = setTimeout(() => {
              void flush().then(() => scheduleSync(PUSH_DELAY));
            }, SAVE_DELAY);
          }),
        ],
      }),
    });
    view.current = v;
    synced.current = initialContent;
    // New notes: open straight into typing.
    if (initialContent === "") v.focus();

    const onHide = () => {
      if (document.visibilityState === "hidden") void flush();
    };
    beforeSync.add(flush);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      beforeSync.delete(flush);
      void flush();
      v.destroy();
      view.current = null;
    };
  }, [initialContent === null, path]); // eslint-disable-line react-hooks/exhaustive-deps

  // Apply changes that arrive from sync while the note is open.
  const dbContent = loaded ? file.content : null;
  useEffect(() => {
    const v = view.current;
    if (!v || dbContent === null || dbContent === synced.current) return;
    const doc = v.state.doc.toString();
    // If the user has unsaved typing, merge it with the incoming version.
    const next = doc === synced.current ? dbContent : merge3(synced.current ?? "", doc, dbContent).text;
    synced.current = dbContent;
    if (next !== doc) {
      v.dispatch({ changes: minimalChange(doc, next), annotations: external.of(true) });
    }
    if (next !== dbContent) void saveContent(path, next).then(() => (synced.current = next));
  }, [dbContent, path]);

  if (file === undefined) return null;
  if (file === null || file.deleted) {
    return <div className="p-6 text-center text-[var(--muted)]">This note no longer exists.</div>;
  }
  return <div ref={host} className="h-full" />;
}
