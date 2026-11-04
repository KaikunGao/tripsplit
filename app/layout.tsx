import type { Metadata, Viewport } from "next";
import Link from "next/link";
import { ThemeToggle } from "@/components/ThemeToggle";
import "./globals.css";

export const metadata: Metadata = {
  title: "TripSplit · 旅游分账 Agent",
  description: "多人自由行 AA 记账助手：多模态录入、历史账目检索、核账 Agent、最少转账结算。",
  applicationName: "TripSplit",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "TripSplit", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f5f5f9" },
    { media: "(prefers-color-scheme: dark)", color: "#121220" },
  ],
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

/* 首屏前应用已保存的主题，避免深色用户看到白屏闪一下。 */
const THEME_SCRIPT = `try{var t=localStorage.getItem("tripsplit.theme");if(t==="dark"||t==="light")document.documentElement.dataset.theme=t;}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-screen">
        <header className="sticky top-0 z-20 border-b border-ink-200 bg-surface/85 backdrop-blur">
          <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-2.5">
            <Link href="/" className="flex items-center gap-2 font-bold">
              <span className="grid h-8 w-8 place-items-center rounded-xl bg-brand-600 text-white">T</span>
              TripSplit
              <span className="hidden text-sm font-normal text-ink-400 sm:inline">旅游分账 Agent</span>
            </Link>
            <nav className="flex items-center gap-1 text-sm text-ink-600">
              <Link href="/about" className="rounded-xl px-2.5 py-1.5 hover:bg-ink-100 hover:text-ink-900">
                关于
              </Link>
              <ThemeToggle />
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-4 pb-28 pt-5 md:pb-10">{children}</main>
      </body>
    </html>
  );
}
