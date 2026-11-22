"use client";

import { useState } from "react";
import { format } from "date-fns";
import { CalendarDays, X } from "lucide-react";
import { DatePresetChip } from "@/components/dashboard/date-preset-chip";
import { DateRangeCalendarDialog, localDayRange } from "@/components/dashboard/date-range-calendar-dialog";

export { nextDraftRange } from "@/components/dashboard/date-range-calendar-dialog";

export type OrderDateFilterValue =
  | { kind: "all" }
  | { kind: "today"; from: Date; to: Date }
  | { kind: "yesterday"; from: Date; to: Date }
  | { kind: "custom"; from: Date; to: Date };

type Props = {
  value: OrderDateFilterValue;
  counts: {
    all?: number;
    today?: number;
    yesterday?: number;
  };
  onChange: (value: OrderDateFilterValue) => void;
};

export function todayOrderRange(now = new Date()) {
  return localDayRange(now);
}

export function yesterdayOrderRange(now = new Date()) {
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  return localDayRange(yesterday);
}

export function OrderDateFilter({ value, counts, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const selectedLabel =
    value.kind === "custom" ? `${format(value.from, "MMM d")} – ${format(value.to, "MMM d")}` : null;

  return (
    <>
      <div className="flex min-w-0 flex-wrap gap-1.5" role="group" aria-label="Filter orders by date">
        <DatePresetChip size="sm" active={value.kind === "all"} onClick={() => onChange({ kind: "all" })}>
          All Orders ({counts.all ?? "—"})
        </DatePresetChip>
        <DatePresetChip
          size="sm"
          active={value.kind === "today"}
          onClick={() => onChange({ kind: "today", ...todayOrderRange() })}
        >
          Today ({counts.today ?? "—"})
        </DatePresetChip>
        <DatePresetChip
          size="sm"
          active={value.kind === "yesterday"}
          onClick={() => onChange({ kind: "yesterday", ...yesterdayOrderRange() })}
        >
          Yesterday ({counts.yesterday ?? "—"})
        </DatePresetChip>
        {selectedLabel ? (
          <div
            className="inline-flex h-8 shrink-0 items-center overflow-hidden rounded-full border border-brand bg-brand/10 text-xs font-semibold text-brand"
            aria-label={`Custom date range ${selectedLabel}`}
          >
            <button
              type="button"
              className="inline-flex h-full items-center gap-2 whitespace-nowrap pl-4 pr-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
              onClick={() => setOpen(true)}
            >
              <CalendarDays className="size-4" aria-hidden />
              {selectedLabel}
            </button>
            <button
              type="button"
              className="mr-1 inline-flex size-8 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-brand/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
              aria-label="Clear custom date range"
              onClick={() => onChange({ kind: "all" })}
            >
              <X className="size-4" aria-hidden />
            </button>
          </div>
        ) : (
          <DatePresetChip size="sm" active={false} onClick={() => setOpen(true)}>
            <CalendarDays className="size-4" aria-hidden />
            Custom Date
          </DatePresetChip>
        )}
      </div>

      <DateRangeCalendarDialog
        open={open}
        onOpenChange={setOpen}
        initialStart={value.kind === "custom" ? value.from : null}
        initialEnd={value.kind === "custom" ? value.to : null}
        onApply={(range) => onChange({ kind: "custom", from: range.from, to: range.to })}
      />
    </>
  );
}
