import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "TripSplit · 旅游分账 Agent",
  description: "多人自由行 AA 记账助手：多模态录入、历史账目检索、核账 Agent、最少转账结算。",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className="min-h-screen">
        <header className="sticky top-0 z-20 border-b border-ink-200 bg-white/85 backdrop-blur">
          <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
            <Link href="/" className="flex items-center gap-2 font-bold">
              <span className="grid h-8 w-8 place-items-center rounded-xl bg-brand-600 text-white">T</span>
              TripSplit
              <span className="hidden text-sm font-normal text-ink-400 sm:inline">旅游分账 Agent</span>
            </Link>
            <nav className="flex items-center gap-3 text-sm text-ink-600">
              <Link href="/about" className="hover:text-ink-900">
                产品说明
              </Link>
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-5xl px-4 py-6">{children}</main>
      </body>
    </html>
  );
}
