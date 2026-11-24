/** 远端文本文件的 CodeMirror 6 编辑器标签。 */

import { useEffect, useRef } from "react";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  rectangularSelection,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import {
  bracketMatching,
  foldGutter,
  indentOnInput,
  syntaxHighlighting,
  defaultHighlightStyle,
} from "@codemirror/language";
import type { EditorTab as EditorTabModel } from "../lib/editorTabs";
import { useEditorTabs } from "../lib/editorTabs";
import { base64ToBytes, bytesToText, loadLanguage } from "../lib/editor";
import { onThemeChange } from "../lib/theme";
import type { TabStatus } from "../lib/tabs";

interface Props {
  tab: EditorTabModel;
  sessionStatus: TabStatus;
  onRequestSave: (tab: EditorTabModel) => void;
}

/** 从 tokens.css 读取当前主题变量，生成 CodeMirror 主题扩展 */
function makeEditorTheme(): Extension {
  const css = getComputedStyle(document.documentElement);
  const c = (name: string) => css.getPropertyValue(name).trim();
  return [
    EditorView.theme(
      {
        "&": {
          height: "100%",
          backgroundColor: c("--bg-app"),
          color: c("--fg"),
          fontSize: "13px",
        },
        ".cm-scroller": {
          fontFamily: "var(--font-mono, Consolas, monospace)",
          lineHeight: "1.6",
        },
        ".cm-content": { caretColor: c("--accent") },
        ".cm-gutters": {
          backgroundColor: c("--bg-panel"),
          color: c("--fg-faint"),
          border: "none",
        },
        ".cm-activeLine": { backgroundColor: c("--bg-hover") },
        ".cm-activeLineGutter": {
          backgroundColor: c("--bg-hover"),
          color: c("--fg"),
        },
        ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
          backgroundColor: c("--term-sel"),
        },
        ".cm-cursor": { borderLeftColor: c("--term-cursor") },
      },
      { dark: document.documentElement.dataset.theme !== "light" }
    ),
    syntaxHighlighting(defaultHighlightStyle),
  ];
}

export function EditorTabView({ tab, sessionStatus, onRequestSave }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const saveRef = useRef(onRequestSave);
  const langCompartment = useRef(new Compartment());
  const themeCompartment = useRef(new Compartment());
  saveRef.current = onRequestSave;

  const initialText = tab.text || (
    tab.meta.contentBase64 ? bytesToText(base64ToBytes(tab.meta.contentBase64)) : ""
  );

  // 每个编辑器标签常挂载：只按 tab.id 建一次 View，切标签只隐藏 DOM
  useEffect(() => {
    if (!hostRef.current) return;
    const extensions: Extension[] = [
      lineNumbers(),
      highlightActiveLineGutter(),
      history(),
      drawSelection(),
      rectangularSelection(),
      foldGutter(),
      indentOnInput(),
      bracketMatching(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      EditorView.lineWrapping,
      keymap.of([
        {
          key: "Mod-s",
          preventDefault: true,
          run: () => {
            saveRef.current(useEditorTabs.getState().tabs.find((t) => t.id === tab.id)!);
            return true;
          },
        },
        indentWithTab,
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
      ]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          useEditorTabs.getState().setText(tab.id, update.state.doc.toString());
        }
      }),
      langCompartment.current.of([]),
      themeCompartment.current.of(makeEditorTheme()),
    ];
    if (tab.meta.readOnly) {
      extensions.push(EditorState.readOnly.of(true));
      extensions.push(EditorView.editable.of(false));
    }

    const view = new EditorView({
      state: EditorState.create({ doc: initialText, extensions }),
      parent: hostRef.current,
    });
    viewRef.current = view;
    // 对话框打开即可输入；焦点落在 CodeMirror 上，Escape 仍能冒泡到对话框
    view.focus();

    const store = useEditorTabs.getState();
    store.setText(tab.id, initialText);
    store.setStatus(tab.id, { loading: false });

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // 语言 / 只读状态变化时通过 compartment 重配，不重建 View
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id]);

  // 语法高亮懒加载；简化模式（大文件）关闭
  useEffect(() => {
    if (tab.meta.softLimitMode) return;
    let cancelled = false;
    loadLanguage(tab.meta.language).then((ext) => {
      if (!cancelled && ext && viewRef.current) {
        viewRef.current.dispatch({
          effects: langCompartment.current.reconfigure(ext),
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [tab.meta.language, tab.meta.softLimitMode]);

  // 主题热切换：重新读取 CSS 变量并重配
  useEffect(() => {
    return onThemeChange(() => {
      viewRef.current?.dispatch({
        effects: themeCompartment.current.reconfigure(makeEditorTheme()),
      });
    });
  }, []);

  // 冲突对话框「重新加载」会替换 store 里的文本；用户没在编辑时同步进 View。
  //
  // 必须从 store 取最新文本，不能用渲染时的 tab.text：首次打开时本 effect 与上面的
  // 挂载 effect 在同一次 commit 执行，props 里的 tab.text 仍是空串，用它比对会把刚
  // 从 contentBase64 解码出来的内容清空；清空又会经 updateListener 写回 store，
  // 把 dirty 误置为 true —— 表现为「内容加载不出来」且「没改过也关不掉」。
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const latest = useEditorTabs.getState().tabs.find((t) => t.id === tab.id);
    if (!latest || latest.dirty || latest.loading) return;
    const current = view.state.doc.toString();
    if (current !== latest.text) {
      view.dispatch({
        changes: { from: 0, to: current.length, insert: latest.text },
      });
    }
  }, [tab.text, tab.dirty]);

  const waiting = sessionStatus === "paused" || sessionStatus === "connecting";
  const eolLabel = tab.meta.eol === "crlf" ? "CRLF" : tab.meta.eol === "lf" ? "LF" : "无换行";

  return (
    <div className="editor-tab">
      <div className="editor-canvas-wrap">
        <div ref={hostRef} className="editor-canvas" />
        {waiting && (
          <div className="editor-overlay">等待连接后加载文件…</div>
        )}
        {tab.loading && !waiting && (
          <div className="editor-overlay">读取远端文件…</div>
        )}
        {tab.error && (
          <div className="editor-overlay error">{tab.error}</div>
        )}
      </div>

      <div className="editor-status">
        <span>{tab.meta.encoding.toUpperCase()}</span>
        <span>{eolLabel}{tab.meta.bom ? " · BOM" : ""}</span>
        <span>{tab.meta.language}</span>
        <span>{tab.meta.softLimitMode ? "简化模式" : "完整模式"}</span>
        {tab.meta.warning && <span className="warn">{tab.meta.warning}</span>}
      </div>
    </div>
  );
}
