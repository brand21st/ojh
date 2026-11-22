"use client";

import { useMemo, useState } from "react";
import { format } from "date-fns";
import { CalendarDays, X } from "lucide-react";
import { DatePresetChip } from "@/components/dashboard/date-preset-chip";
import { DateRangeCalendarDialog } from "@/components/dashboard/date-range-calendar-dialog";

const ANALYTICS_TIMEZONE = "Asia/Kolkata";

export type AnalyticsDatePreset = "today" | "yesterday" | "month" | "year";

export type AnalyticsDateFilterValue =
  | { kind: AnalyticsDatePreset }
  | { kind: "custom"; from: string; to: string };

const PRESETS: { kind: AnalyticsDatePreset; label: string }[] = [
  { kind: "today", label: "Today" },
  { kind: "yesterday", label: "Yesterday" },
  { kind: "month", label: "This month" },
  { kind: "year", label: "This year" },
];

function calendarDate(dateKey: string) {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(year, month - 1, day);
}

export function istCalendarToday(now = new Date()) {
  const key = new Intl.DateTimeFormat("en-CA", {
    timeZone: ANALYTICS_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  return calendarDate(key);
}

function formatDay(dateKey: string, withYear: boolean) {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "short",
    year: withYear ? "numeric" : undefined,
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

export function formatAnalyticsCustomLabel(from: string, to: string) {
  if (from === to) return formatDay(from, true);
  const sameYear = from.slice(0, 4) === to.slice(0, 4);
  if (sameYear) return `${formatDay(from, false)} – ${formatDay(to, false)}`;
  return `${formatDay(from, true)} – ${formatDay(to, true)}`;
}

export function AnalyticsDateFilter({
  value,
  onChange,
}: {
  value: AnalyticsDateFilterValue;
  onChange: (value: AnalyticsDateFilterValue) => void;
}) {
  const [open, setOpen] = useState(false);
  const maxDate = useMemo(() => istCalendarToday(), []);
  const customLabel = value.kind === "custom" ? formatAnalyticsCustomLabel(value.from, value.to) : null;

  return (
    <>
      <div
        className="flex min-w-0 flex-wrap items-center gap-1.5"
        role="group"
        aria-label="Analytics date range"
      >
        {PRESETS.map((preset) => (
          <DatePresetChip
            key={preset.kind}
            active={value.kind === preset.kind}
            onClick={() => onChange({ kind: preset.kind })}
          >
            {preset.label}
          </DatePresetChip>
        ))}
        {customLabel ? (
          <div
            className="inline-flex h-11 shrink-0 items-center overflow-hidden rounded-full border border-brand bg-brand/10 text-sm font-semibold text-brand"
            aria-label={`Custom date range ${customLabel}`}
          >
            <button
              type="button"
              className="inline-flex h-full min-w-0 items-center gap-2 whitespace-nowrap pl-3.5 pr-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
              onClick={() => setOpen(true)}
            >
              <CalendarDays className="size-4 shrink-0" aria-hidden />
              <span className="truncate">{customLabel}</span>
            </button>
            <button
              type="button"
              className="inline-flex size-11 shrink-0 items-center justify-center transition-colors hover:bg-brand/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
              aria-label="Clear custom date range"
              onClick={() => onChange({ kind: "today" })}
            >
              <X className="size-4" aria-hidden />
            </button>
          </div>
        ) : (
          <DatePresetChip active={false} onClick={() => setOpen(true)}>
            <CalendarDays className="size-4" aria-hidden />
            Custom Date
          </DatePresetChip>
        )}
      </div>

      <DateRangeCalendarDialog
        open={open}
        onOpenChange={setOpen}
        maxDate={maxDate}
        initialStart={value.kind === "custom" ? calendarDate(value.from) : null}
        initialEnd={value.kind === "custom" ? calendarDate(value.to) : null}
        title="Select dates"
        description="Choose one day, or a start date and then an end date. Each day is a full day in India time (IST). Future dates are unavailable."
        onApply={(range) =>
          onChange({
            kind: "custom",
            from: format(range.from, "yyyy-MM-dd"),
            to: format(range.to, "yyyy-MM-dd"),
          })
        }
      />
    </>
  );
}
