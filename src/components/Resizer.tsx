import { useRef } from "react";

interface Props {
  /**
   * 拖动方向：
   * - `left`  分隔条左侧的栏变宽（拖动方向与内容方向一致）
   * - `right` 分隔条右侧的栏变宽
   */
  side: "left" | "right";
  /** 拖动过程中的增量（像素），已经换算成「哪一侧变宽」 */
  onDelta: (delta: number) => void;
  /** 拖动结束，用于落盘 */
  onCommit?: () => void;
  /** 双击分隔条，恢复默认宽度 */
  onReset?: () => void;
  title?: string;
}

/**
 * 栏位分隔条。
 *
 * 用 Pointer Capture 抓住指针：指针移出分隔条、甚至移出窗口，拖动依然连续。
 * 增量按「上一帧到这一帧」计算，避免累计误差。
 */
export default function Resizer({
  side,
  onDelta,
  onCommit,
  onReset,
  title,
}: Props) {
  const lastX = useRef(0);
  const dragging = useRef(false);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // 防止拖动时选中页面文本
    e.preventDefault();
    lastX.current = e.clientX;
    dragging.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    document.body.classList.add("resizing");
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    const delta = e.clientX - lastX.current;
    if (delta === 0) return;
    lastX.current = e.clientX;
    onDelta(side === "left" ? delta : -delta);
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    dragging.current = false;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    document.body.classList.remove("resizing");
    onCommit?.();
  };

  return (
    <div
      className="resizer"
      title={title ?? "拖动调整宽度 · 双击恢复默认"}
      role="separator"
      aria-orientation="vertical"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={onReset}
    />
  );
}
