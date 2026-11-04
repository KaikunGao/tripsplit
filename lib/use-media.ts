"use client";
import { useSyncExternalStore } from "react";

/** 媒体查询 hook：服务端与首屏按 false 渲染，客户端挂载后按真实宽度切换。 */
export function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia(query);
      mq.addEventListener("change", cb);
      return () => mq.removeEventListener("change", cb);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

export const useDesktop = () => useMedia("(min-width: 1024px)");
