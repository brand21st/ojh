import type { ReactNode } from "react";
import { DM_Serif_Display, Inter, Manrope, Playfair_Display, Poppins } from "next/font/google";

const inter = Inter({ variable: "--font-store-inter", subsets: ["latin"], display: "swap" });
const manrope = Manrope({ variable: "--font-store-manrope", subsets: ["latin"], display: "swap" });
// Store Builder theme fonts; preload off so classic stores don't download them.
const poppins = Poppins({ variable: "--font-store-poppins", subsets: ["latin"], weight: ["400", "500", "600", "700", "800"], display: "swap", preload: false });
const playfair = Playfair_Display({ variable: "--font-store-playfair", subsets: ["latin"], display: "swap", preload: false });
const dmSerif = DM_Serif_Display({ variable: "--font-store-dm-serif", subsets: ["latin"], weight: "400", display: "swap", preload: false });

export default function StorefrontLayout({ children }: { children: ReactNode }) {
  return (
    <main id="main-content" className={`${inter.variable} ${manrope.variable} ${poppins.variable} ${playfair.variable} ${dmSerif.variable} min-h-full min-w-0 w-full flex-1 bg-zinc-50`}>
      {/* PostBus merchant support is not for shoppers (also covers {slug}.postbus.in, where paths have no /store/ prefix). */}
      <style>{"[data-postbus-support]{display:none!important}"}</style>
      {children}
    </main>
  );
}
