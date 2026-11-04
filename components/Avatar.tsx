"use client";
import type { Member } from "@/lib/types";

/* 八种柔和底色，按名字哈希固定分配，同一个人在所有页面颜色一致。 */
const PALETTE = [
  ["#e0e7ff", "#3730a3"],
  ["#fce7f3", "#9d174d"],
  ["#dcfce7", "#166534"],
  ["#fef3c7", "#92400e"],
  ["#cffafe", "#155e75"],
  ["#ede9fe", "#5b21b6"],
  ["#ffedd5", "#9a3412"],
  ["#e2e8f0", "#334155"],
];

function hash(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

/** 名字取最后一个字（中文名习惯），英文名取首字母。 */
function initial(name: string) {
  const t = name.trim();
  if (!t) return "?";
  return /^[a-z]/i.test(t) ? t[0].toUpperCase() : t[t.length - 1];
}

const SIZE = { xs: "h-5 w-5 text-[10px]", sm: "h-6 w-6 text-[11px]", md: "h-8 w-8 text-xs", lg: "h-10 w-10 text-sm" } as const;

export function Avatar({ name, size = "sm", muted = false, title }: { name: string; size?: keyof typeof SIZE; muted?: boolean; title?: string }) {
  const [bg, fg] = PALETTE[hash(name) % PALETTE.length];
  return (
    <span
      title={title ?? name}
      aria-label={name}
      className={`inline-grid shrink-0 place-items-center rounded-full font-semibold ring-2 ring-surface ${SIZE[size]} ${muted ? "grayscale" : ""}`}
      style={muted ? { background: "var(--c-ink-100)", color: "var(--c-ink-400)", opacity: 0.7 } : { background: bg, color: fg }}
    >
      {initial(name)}
    </span>
  );
}

/**
 * 叠放头像：按成员顺序排列，activeIds 之外的人灰显，一眼看出谁没参与。
 * activeIds 省略时全员高亮（用于行程头部）。
 */
export function AvatarStack({ members, activeIds, size = "sm", max = 6 }: { members: Member[]; activeIds?: string[]; size?: keyof typeof SIZE; max?: number }) {
  const active = activeIds ? new Set(activeIds) : null;
  const shown = members.slice(0, max);
  const rest = members.length - shown.length;
  const label = active ? members.filter((m) => active.has(m.id)).map((m) => m.name).join("、") || "参与人为空" : members.map((m) => m.name).join("、");
  return (
    <span className="inline-flex items-center -space-x-1.5" title={label} aria-label={label}>
      {shown.map((m) => (
        <Avatar key={m.id} name={m.name} size={size} muted={!!active && !active.has(m.id)} title={active && !active.has(m.id) ? `${m.name}（未参与）` : m.name} />
      ))}
      {rest > 0 && <span className={`inline-grid place-items-center rounded-full bg-ink-100 font-semibold text-ink-600 ring-2 ring-surface ${SIZE[size]}`}>+{rest}</span>}
    </span>
  );
}
