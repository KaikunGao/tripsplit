"use client";
import type { ReactNode } from "react";

export function Badge({ tone = "gray", children }: { tone?: "gray" | "brand" | "warn" | "danger" | "ok"; children: ReactNode }) {
  const cls = {
    gray: "bg-ink-100 text-ink-600",
    brand: "bg-brand-100 text-brand-700",
    warn: "bg-warn-100 text-warn-700",
    danger: "bg-danger-100 text-danger-700",
    ok: "bg-ok-100 text-ok-700",
  }[tone];
  return <span className={`badge ${cls}`}>{children}</span>;
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block font-medium text-ink-600">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-ink-400">{hint}</span>}
    </label>
  );
}

export function Section({ title, children, right, className = "" }: { title: string; children: ReactNode; right?: ReactNode; className?: string }) {
  return (
    <section className={`card p-4 sm:p-5 ${className}`}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="font-semibold">{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}

export function ConfidenceBar({ value, label }: { value: number; label: string }) {
  const tone = value >= 0.8 ? "bg-ok-700" : value >= 0.7 ? "bg-warn-700" : "bg-danger-700";
  return (
    <div className="flex items-center gap-2 text-xs text-ink-600">
      <span className="w-12">{label}</span>
      <div className="h-1.5 flex-1 rounded bg-ink-100">
        <div className={`h-1.5 rounded ${tone}`} style={{ width: `${Math.round(value * 100)}%` }} />
      </div>
      <span className="mono w-8 text-right">{Math.round(value * 100)}</span>
    </div>
  );
}

export function Spinner() {
  return <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-ink-200 border-t-brand-600" />;
}

/** 骨架屏：一组灰条，用于 AI 请求进行中的占位。 */
export function Skeleton({ lines = 3, className = "" }: { lines?: number; className?: string }) {
  const widths = ["w-11/12", "w-3/4", "w-5/6", "w-2/3", "w-4/5"];
  return (
    <div className={`space-y-2 ${className}`} aria-busy="true" aria-live="polite">
      {Array.from({ length: lines }).map((_, i) => (
        <div key={i} className={`skeleton h-3.5 ${widths[i % widths.length]}`} />
      ))}
    </div>
  );
}

export function SkeletonCard({ lines = 3 }: { lines?: number }) {
  return (
    <div className="card p-4">
      <div className="mb-3 flex items-center gap-2">
        <div className="skeleton h-5 w-10 rounded-full" />
        <div className="skeleton h-4 w-40" />
      </div>
      <Skeleton lines={lines} />
    </div>
  );
}

/** 空状态：图标 + 标题 + 一句提示 + 可选操作。 */
export function Empty({ icon, title, hint, action, compact = false }: { icon: ReactNode; title: string; hint?: string; action?: ReactNode; compact?: boolean }) {
  return (
    <div className={`flex flex-col items-center text-center ${compact ? "py-6" : "py-10"}`}>
      <div className="mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-brand-50 text-2xl text-brand-600">{icon}</div>
      <p className="font-medium">{title}</p>
      {hint && <p className="mt-1 max-w-xs text-sm text-ink-400">{hint}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/** 单色线性图标，取自 Lucide 的路径，用于底部 tab 和空状态。 */
export function Icon({ name, className = "h-5 w-5" }: { name: IconName; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      {ICONS[name]}
    </svg>
  );
}

export type IconName = "pen" | "list" | "search" | "shield" | "scale" | "mic" | "image" | "text" | "plus" | "more" | "back" | "sun" | "moon" | "map" | "check" | "chevron";
const ICONS: Record<IconName, ReactNode> = {
  pen: (
    <>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </>
  ),
  list: (
    <>
      <path d="M8 6h13M8 12h13M8 18h13" />
      <path d="M3 6h.01M3 12h.01M3 18h.01" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </>
  ),
  shield: (
    <>
      <path d="M20 13c0 5-3.5 7.5-7.7 8.9a1 1 0 0 1-.6 0C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.2-2.6a1 1 0 0 1 1.6 0C14.5 3.8 17 5 19 5a1 1 0 0 1 1 1z" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  scale: (
    <>
      <path d="m16 16 3-8 3 8c-.9.7-1.9 1-3 1s-2.1-.3-3-1" />
      <path d="m2 16 3-8 3 8c-.9.7-1.9 1-3 1s-2.1-.3-3-1" />
      <path d="M7 21h10M12 3v18M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2" />
    </>
  ),
  mic: (
    <>
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3" />
    </>
  ),
  image: (
    <>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <circle cx="9" cy="9" r="2" />
      <path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" />
    </>
  ),
  text: (
    <>
      <path d="M17 6.1H3M21 12.1H3M15.1 18H3" />
    </>
  ),
  plus: <path d="M5 12h14M12 5v14" />,
  more: (
    <>
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
      <circle cx="5" cy="12" r="1" />
    </>
  ),
  back: <path d="m15 18-6-6 6-6" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M6.3 17.7l-1.4 1.4M19.1 4.9l-1.4 1.4" />
    </>
  ),
  moon: <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />,
  map: (
    <>
      <path d="M14.1 6 8 3 3 5v15l5-2 6.1 3L21 19V4z" />
      <path d="M8 3v15M14 6v15" />
    </>
  ),
  check: <path d="M20 6 9 17l-5-5" />,
  chevron: <path d="m6 9 6 6 6-6" />,
};
