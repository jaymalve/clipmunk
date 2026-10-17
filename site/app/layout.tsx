import type { Metadata, Viewport } from "next";
import { Geist_Mono, Host_Grotesk, Inter } from "next/font/google";
import type { ReactNode } from "react";
import { Analytics } from "@vercel/analytics/next";
import { SITE } from "@/lib/site";
import "./globals.css";
import "@/components/chip/chip.css";
import "@/demo/demo.css";
import "@/styles/chrome.css";
import "@/styles/hero.css";
import "@/styles/take.css";
import "@/styles/story.css";
import "@/styles/sections.css";

const geistMono = Geist_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
});

// Headings and the wordmark.
const hostGrotesk = Host_Grotesk({
  variable: "--font-display",
  subsets: ["latin"],
});

// Body text.
const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const title = `${SITE.name}: ${SITE.headline}`;

export const metadata: Metadata = {
  // Link previews need absolute image URLs, so the live address is the default.
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "https://clipmunk.dev"),
  title,
  description: SITE.description,
  openGraph: { title, description: SITE.description, type: "website", url: "/", siteName: SITE.name },
  twitter: { card: "summary_large_image", title, description: SITE.description },
};

export const viewport: Viewport = {
  themeColor: "#171717",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${geistMono.variable} ${hostGrotesk.variable} ${inter.variable}`}>
      <body>
        {children}
        <Analytics />
      </body>
    </html>
  );
}
