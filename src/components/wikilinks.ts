import { EditorState, StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, keymap, MatchDecorator, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { autocompletion, closeBrackets, closeBracketsKeymap, type CompletionContext } from "@codemirror/autocomplete";
import { linkTextFor, parseWikilink, resolveLink, type NoteIndex, type Wikilink } from "@/lib/links";

/** Dispatch with the latest note index so link styling and completions stay current. */
export const setNoteIndex = StateEffect.define<NoteIndex | null>();

export const indexField = StateField.define<NoteIndex | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setNoteIndex)) value = e.value;
    return value;
  },
});

const LINK_RE = /\[\[([^[\]\n]+?)\]\]/g;
const hasAttachmentExt = (target: string) => /\.(?!md$)[a-z0-9]+$/i.test(target);

export function inCode(state: EditorState, pos: number) {
  for (let node: { name: string; parent: unknown } | null = syntaxTree(state).resolveInner(pos, 1); node; node = node.parent as typeof node) {
    if (/Code|Comment/.test(node.name)) return true;
  }
  return false;
}

function decorations(fromPath: string) {
  const matcher = new MatchDecorator({
    regexp: LINK_RE,
    decorate(add, from, to, match, view) {
      if (inCode(view.state, from)) return;
      const index = view.state.field(indexField);
      const { target } = parseWikilink(match[1]);
      const unresolved = index && target && !hasAttachmentExt(target) && !resolveLink(target, fromPath, index);
      add(from, to, Decoration.mark({
        class: unresolved ? "cm-wikilink cm-wikilink-unresolved" : "cm-wikilink",
        attributes: { "data-link": match[1] },
      }));
    },
  });

  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = matcher.createDeco(view);
      }
      update(u: ViewUpdate) {
        const indexChanged = u.startState.field(indexField) !== u.state.field(indexField);
        // The code-block check depends on the parse tree, which fills in lazily.
        if (indexChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) this.decorations = matcher.createDeco(u.view);
        else this.decorations = matcher.updateDeco(u, this.decorations);
      }
    },
    { decorations: (v) => v.decorations },
  );
}

/**
 * Tapping a link follows it, unless the cursor is already on that line in a
 * focused editor (you're editing it), the same rule as Obsidian's live preview.
 */
function followOnTap(onFollow: (link: Wikilink) => void) {
  return EditorView.domEventHandlers({
    mousedown(e, view) {
      const el = (e.target as HTMLElement).closest?.(".cm-wikilink");
      if (!el || e.button !== 0) return false;
      const { doc, selection } = view.state;
      if (view.hasFocus && doc.lineAt(view.posAtDOM(el)).number === doc.lineAt(selection.main.head).number) return false;
      e.preventDefault(); // keeps the keyboard from popping up
      onFollow(parseWikilink(el.getAttribute("data-link")!));
      return true;
    },
  });
}

function linkCompletions(fromPath: string) {
  return (ctx: CompletionContext) => {
    const m = ctx.matchBefore(/\[\[[^[\]|#\n]*$/);
    const index = ctx.state.field(indexField);
    if (!m || !index) return null;
    return {
      from: m.from + 2,
      validFor: /^[^[\]|#\n]*$/,
      options: index.notes
        .filter((p) => p !== fromPath)
        .map((p) => {
          const text = linkTextFor(p, index);
          const slash = p.lastIndexOf("/");
          return {
            label: p.replace(/\.md$/i, ""),
            displayLabel: p.slice(slash + 1).replace(/\.md$/i, ""),
            detail: slash > 0 ? p.slice(0, slash) : undefined,
            apply: (view: EditorView, _c: unknown, from: number, to: number) => {
              // closeBrackets usually inserted "]]" already; don't double it.
              const end = view.state.sliceDoc(to, to + 2) === "]]" ? to + 2 : to;
              view.dispatch({
                changes: { from, to: end, insert: `${text}]]` },
                selection: { anchor: from + text.length + 2 },
              });
            },
          };
        }),
    };
  };
}

export function scrollToHeading(view: EditorView, heading: string) {
  // [[Note#H1#H2]] targets the last, most specific heading.
  const want = heading.split("#").pop()!.trim().toLowerCase();
  const { doc } = view.state;
  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    const m = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line.text);
    if (m && m[1].toLowerCase() === want) {
      view.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: "start", yMargin: 16 }) });
      return true;
    }
  }
  return false;
}

export function wikilinks(opts: { path: string; index: NoteIndex | null; onFollow: (link: Wikilink) => void }): Extension {
  return [
    indexField.init(() => opts.index),
    decorations(opts.path),
    followOnTap(opts.onFollow),
    closeBrackets(),
    keymap.of(closeBracketsKeymap),
    autocompletion({ override: [linkCompletions(opts.path)], icons: false }),
    // Only auto-pair brackets: auto-closing quotes gets in the way when writing prose.
    EditorState.languageData.of(() => [{ closeBrackets: { brackets: ["(", "[", "{"] } }]),
  ];
}
