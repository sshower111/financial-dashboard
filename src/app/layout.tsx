import type { Metadata, Viewport } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import "./globals.css";

export const metadata: Metadata = { title: "Financial Dashboard", description: "Real-time personal finance dashboard with local-AI categorization" };
export const viewport: Viewport = { themeColor: [{ media: "(prefers-color-scheme: light)", color: "#F9F8F6" }, { media: "(prefers-color-scheme: dark)", color: "#121212" }] };

// applied before paint so an explicit theme choice never flashes
const themeScript = `try{var t=localStorage.getItem("ledger.theme");if(t)document.documentElement.dataset.theme=t}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`} suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: themeScript }} /></head>
      <body>{children}</body>
    </html>
  );
}
