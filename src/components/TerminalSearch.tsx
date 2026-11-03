import { useEffect, useRef } from "react";
import Icon from "./Icon";

interface Props {
  /** 当前搜索词 */
  query: string;
  onQueryChange: (v: string) => void;
  /** 上一处 */
  onPrev: () => void;
  /** 下一处 */
  onNext: () => void;
  /** 关闭搜索 */
  onClose: () => void;
  /** 是否区分大小写 */
  caseSensitive: boolean;
  onCaseSensitiveChange: (v: boolean) => void;
  /** 匹配数；-1 表示结果数超出阈值 */
  matchIndex: number;
  matchCount: number;
}

/**
 * 终端内搜索栏。
 *
 * 浮在终端右上角，不打断终端内容 —— 与主流终端的做法一致。
 * 键盘操作：Enter 下一处、Shift+Enter 上一处、Esc 关闭。
 */
export default function TerminalSearch({
  query,
  onQueryChange,
  onPrev,
  onNext,
  onClose,
  caseSensitive,
  onCaseSensitiveChange,
  matchIndex,
  matchCount,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    // 选中已有内容，方便直接替换
    inputRef.current?.select();
  }, []);

  /** 匹配数文案 */
  const counter = (() => {
    if (!query) return "";
    if (matchCount === 0) return "无结果";
    if (matchIndex < 0) return `${matchCount}+`;
    return `${matchIndex + 1}/${matchCount}`;
  })();

  return (
    <div className="term-search" role="search" aria-label="终端内搜索">
      <Icon name="search" size={13} className="ts-icon" />
      <input
        ref={inputRef}
        className="ts-input"
        value={query}
        placeholder="搜索终端输出"
        spellCheck={false}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            // Shift+Enter 往回找
            if (e.shiftKey) onPrev();
            else onNext();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
      />

      <span className={`ts-count ${matchCount === 0 && query ? "none" : ""}`}>
        {counter}
      </span>

      <button
        className={`ts-toggle ${caseSensitive ? "on" : ""}`}
        onClick={() => onCaseSensitiveChange(!caseSensitive)}
        title="区分大小写"
        aria-pressed={caseSensitive}
      >
        Aa
      </button>

      <button
        className="icon-btn"
        onClick={onPrev}
        disabled={!query || matchCount === 0}
        title="上一处 (Shift+Enter)"
      >
        <Icon name="chevron-up" size={13} />
      </button>
      <button
        className="icon-btn"
        onClick={onNext}
        disabled={!query || matchCount === 0}
        title="下一处 (Enter)"
      >
        <Icon name="chevron-down" size={13} />
      </button>
      <button className="icon-btn" onClick={onClose} title="关闭 (Esc)">
        <Icon name="close" size={12} />
      </button>
    </div>
  );
}
