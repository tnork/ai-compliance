import type { Metadata } from "next";
import { Archivo, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const archivo = Archivo({ variable: "--font-archivo", subsets: ["latin"], weight: ["400", "500", "600", "700", "800", "900"] });
const mono = JetBrains_Mono({ variable: "--font-mono", subsets: ["latin"], weight: ["500", "700"] });

export const metadata: Metadata = {
  title: "AI Compliance",
  description: "The record of supervision for CPAs and Enrolled Agents under Circular 230.",
  icons: { icon: "/favicon.svg", apple: "/favicon.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // suppressHydrationWarning: scoped to the <html> element's ATTRIBUTES only -
  // browser extensions (Grammarly, Dark Reader, …) mutate them before React
  // hydrates. Children are still fully hydration-checked.
  return (
    <html lang="en" className={`${archivo.variable} ${mono.variable}`} suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
