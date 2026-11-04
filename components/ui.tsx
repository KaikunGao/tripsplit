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

export function Section({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="card p-4 sm:p-5">
      <div className="mb-3 flex items-center justify-between">
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
