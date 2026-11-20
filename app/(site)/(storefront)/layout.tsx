import type { ReactNode } from "react";
import { Inter, Manrope } from "next/font/google";

const inter = Inter({ variable: "--font-store-inter", subsets: ["latin"], display: "swap" });
const manrope = Manrope({ variable: "--font-store-manrope", subsets: ["latin"], display: "swap" });

export default function StorefrontLayout({ children }: { children: ReactNode }) {
  return (
    <main id="main-content" className={`${inter.variable} ${manrope.variable} min-h-full min-w-0 w-full flex-1 bg-zinc-50`}>
      {/* PostBus merchant support is not for shoppers (also covers {slug}.postbus.in, where paths have no /store/ prefix). */}
      <style>{"[data-postbus-support]{display:none!important}"}</style>
      {children}
    </main>
  );
}
