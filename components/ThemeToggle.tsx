"use client";
import { useSyncExternalStore } from "react";
import { Icon } from "@/components/ui";

const KEY = "tripsplit.theme";
const listeners = new Set<() => void>();

function subscribe(cb: () => void) {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  mq.addEventListener("change", cb);
  listeners.add(cb);
  return () => {
    mq.removeEventListener("change", cb);
    listeners.delete(cb);
  };
}

function isDark() {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(KEY);
  } catch {}
  return stored === "dark" || (stored !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
}

/** 深浅色切换：默认跟随系统；手动选择写入 localStorage 并挂到 <html data-theme>（layout 里的内联脚本首屏就会读它）。 */
export function ThemeToggle() {
  const dark = useSyncExternalStore(subscribe, isDark, () => false);

  function toggle() {
    const next = dark ? "light" : "dark";
    try {
      localStorage.setItem(KEY, next);
    } catch {}
    document.documentElement.dataset.theme = next;
    listeners.forEach((l) => l());
  }

  return (
    <button type="button" onClick={toggle} className="grid h-9 w-9 place-items-center rounded-xl text-ink-600 hover:bg-ink-100" title={dark ? "切换到浅色" : "切换到深色"} aria-label={dark ? "切换到浅色模式" : "切换到深色模式"}>
      <Icon name={dark ? "sun" : "moon"} className="h-[18px] w-[18px]" />
    </button>
  );
}
