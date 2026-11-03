/**
 * 轻量级 Toast 通知。
 *
 * 替代旧版「错误信息塞进状态栏」的做法 —— 状态栏只能承载一行文本，
 * 错误与成功提示混在一起既容易溢出，也会把失败当成普通信息。
 */
import { useEffect, useState } from "react";
import Icon from "../components/Icon";

export type ToastKind = "error" | "success" | "info";

export interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

type Listener = (toasts: ToastItem[]) => void;

let items: ToastItem[] = [];
let seq = 0;
const listeners = new Set<Listener>();

function emit() {
  const snapshot = items;
  listeners.forEach((l) => l(snapshot));
}

/** 弹出一条通知 */
export function toast(kind: ToastKind, message: string, ttl = 4000) {
  const id = ++seq;
  items = [...items, { id, kind, message }];
  emit();

  window.setTimeout(() => {
    items = items.filter((t) => t.id !== id);
    emit();
  }, ttl);

  return id;
}

export const notify = {
  error: (m: string) => toast("error", m, 6000),
  success: (m: string) => toast("success", m, 3000),
  info: (m: string) => toast("info", m, 3000),
};

/** 订阅通知列表 */
export function useToasts(): ToastItem[] {
  const [list, setList] = useState<ToastItem[]>(items);
  useEffect(() => {
    listeners.add(setList);
    return () => {
      listeners.delete(setList);
    };
  }, []);
  return list;
}

/** Toast 容器 */
export function ToastHost() {
  const list = useToasts();
  if (list.length === 0) return null;

  return (
    <div className="toast-host">
      {list.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          <Icon
            className="ti"
            name={
              t.kind === "error"
                ? "alert-circle"
                : t.kind === "success"
                  ? "check"
                  : "info"
            }
          />
          <span>{t.message}</span>
        </div>
      ))}
    </div>
  );
}
