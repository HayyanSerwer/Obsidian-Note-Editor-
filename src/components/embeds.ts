import { RangeSetBuilder, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { imageUrl, isImagePath } from "@/lib/attachments";
import { resolveLink } from "@/lib/links";
import { indexField, inCode } from "./wikilinks";

// ![[file.png|300]]  or  ![alt|300](path/to/file.png "title")
const EMBED_RE = /!\[\[([^[\]\n]+?)\]\]|!\[([^\]\n]*)\]\(<?([^)\n]+?)>?(?:\s+"[^"\n]*")?\)/g;

/** "300" or "300x200" after a pipe sets the display width, as in Obsidian. */
function parseSize(s: string | undefined) {
  const m = s?.trim().match(/^(\d+)(?:x\d+)?$/);
  return m ? Number(m[1]) : undefined;
}

type Source = { kind: "vault"; path: string } | { kind: "url"; url: string } | { kind: "missing"; name: string };

class ImageWidget extends WidgetType {
  constructor(
    readonly source: Source,
    readonly alt: string,
    readonly width: number | undefined,
  ) {
    super();
  }

  eq(other: ImageWidget) {
    return JSON.stringify([this.source, this.alt, this.width]) === JSON.stringify([other.source, other.alt, other.width]);
  }

  toDOM(view: EditorView) {
    const wrap = document.createElement("span");
    wrap.className = "cm-embed";
    const note = (text: string) => {
      wrap.classList.add("cm-embed-note");
      wrap.textContent = text;
    };

    if (this.source.kind === "missing") {
      note(`Image not found: ${this.source.name}`);
      return wrap;
    }
    const img = document.createElement("img");
    img.alt = this.alt;
    if (this.width) img.style.width = `${this.width}px`;
    // Images change the line height once loaded; tell CodeMirror to re-measure.
    img.onload = () => view.requestMeasure();
    img.onerror = () => note(`Couldn't load ${this.alt}`);
    wrap.append(img);

    if (this.source.kind === "url") img.src = this.source.url;
    else {
      wrap.classList.add("cm-embed-loading");
      void imageUrl(this.source.path).then((url) => {
        wrap.classList.remove("cm-embed-loading");
        if (url) img.src = url;
        else note(`${this.alt} isn't downloaded yet. It will load when you're online.`);
      });
    }
    return wrap;
  }
}

function embedSource(state: EditorState, fromPath: string, target: string): Source | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return /^(https?|data):/i.test(target) ? { kind: "url", url: target } : null;
  let decoded = target;
  try {
    decoded = decodeURIComponent(target);
  } catch {}
  if (!isImagePath(decoded)) return null; // note transclusion, PDFs, etc. aren't rendered yet
  const index = state.field(indexField);
  if (!index) return null;
  const path = resolveLink(decoded, fromPath, index);
  return path ? { kind: "vault", path } : { kind: "missing", name: decoded.split("/").pop()! };
}

/** Lines that hold a cursor or selection show their source, like Obsidian's live preview. */
function activeLines(view: EditorView) {
  const lines = new Set<number>();
  if (!view.hasFocus) return lines;
  const { doc } = view.state;
  for (const r of view.state.selection.ranges) {
    for (let n = doc.lineAt(r.from).number; n <= doc.lineAt(r.to).number; n++) lines.add(n);
  }
  return lines;
}

function buildDecorations(view: EditorView, fromPath: string): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const active = activeLines(view);
  const { state } = view;
  for (const { from, to } of view.visibleRanges) {
    const text = state.sliceDoc(from, to);
    for (const m of text.matchAll(EMBED_RE)) {
      const start = from + m.index;
      const end = start + m[0].length;
      if (active.has(state.doc.lineAt(start).number) || inCode(state, start)) continue;

      let target: string, alt: string, width: number | undefined;
      if (m[1] !== undefined) {
        const [file, size] = m[1].split("|");
        target = file.trim();
        alt = target.split("/").pop()!;
        width = parseSize(size);
      } else {
        const [label, size] = m[2].split("|");
        target = m[3].trim();
        alt = label.trim() || target.split("/").pop()!;
        width = parseSize(size);
      }
      const source = embedSource(state, fromPath, target);
      if (source) builder.add(start, end, Decoration.replace({ widget: new ImageWidget(source, alt, width) }));
    }
  }
  return builder.finish();
}

export function embeds(fromPath: string): Extension {
  return [
    ViewPlugin.fromClass(
      class {
        decorations: DecorationSet;
        constructor(view: EditorView) {
          this.decorations = buildDecorations(view, fromPath);
        }
        update(u: ViewUpdate) {
          if (
            u.docChanged ||
            u.viewportChanged ||
            u.selectionSet ||
            u.focusChanged ||
            u.startState.field(indexField) !== u.state.field(indexField) ||
            syntaxTree(u.startState) !== syntaxTree(u.state)
          ) {
            this.decorations = buildDecorations(u.view, fromPath);
          }
        }
      },
      { decorations: (v) => v.decorations },
    ),
    EditorView.baseTheme({
      ".cm-embed": { display: "block", padding: "4px 0" },
      ".cm-embed img": { display: "block", maxWidth: "100%", height: "auto", borderRadius: "6px" },
      ".cm-embed-loading": { minHeight: "120px", borderRadius: "6px", backgroundColor: "var(--hover)" },
      ".cm-embed-note": { color: "var(--muted)", fontSize: "14px", fontStyle: "italic" },
    }),
  ];
}
