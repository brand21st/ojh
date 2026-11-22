"use client";

import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export function DatePresetChip({
  active,
  size = "md",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { active: boolean; size?: "sm" | "md" }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      className={cn(
        "inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-full border font-semibold transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2",
        size === "sm" ? "h-8 px-3 text-xs" : "h-11 px-3.5 text-sm",
        active
          ? "border-brand bg-brand text-white shadow-sm"
          : "border-border bg-card text-foreground hover:border-zinc-300 hover:bg-surface-soft",
        className
      )}
      {...props}
    />
  );
}
