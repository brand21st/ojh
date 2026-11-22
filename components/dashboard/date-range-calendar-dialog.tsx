"use client";

import { useMemo, useState } from "react";
import {
  addMonths,
  eachDayOfInterval,
  format,
  isSameDay,
  isSameMonth,
  isWithinInterval,
  startOfDay,
  startOfMonth,
  startOfWeek,
} from "date-fns";
import { Check, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function localDayRange(date: Date) {
  const from = new Date(date);
  from.setHours(0, 0, 0, 0);
  const to = new Date(date);
  to.setHours(23, 59, 59, 999);
  return { from, to };
}

export function nextDraftRange(
  draftStart: Date | null,
  draftEnd: Date | null,
  date: Date
): { start: Date; end: Date } {
  const completeRange = Boolean(draftStart && draftEnd && !isSameDay(draftStart, draftEnd));
  if (!draftStart || completeRange) {
    return { start: date, end: date };
  }
  if (isSameDay(date, draftStart)) {
    return { start: draftStart, end: date };
  }
  if (date.getTime() < startOfDay(draftStart).getTime()) {
    return { start: date, end: draftStart };
  }
  return { start: draftStart, end: date };
}

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialStart: Date | null;
  initialEnd: Date | null;
  maxDate?: Date;
  title?: string;
  description?: string;
  onApply: (range: { from: Date; to: Date }) => void;
};

export function DateRangeCalendarDialog({
  open,
  onOpenChange,
  initialStart,
  initialEnd,
  maxDate,
  title = "Select dates",
  description = "Choose one day, or a start date and then an end date. Each day uses the full local day.",
  onApply,
}: Props) {
  const [visibleMonth, setVisibleMonth] = useState(() => startOfMonth(initialStart ?? new Date()));
  const [draftStart, setDraftStart] = useState<Date | null>(initialStart);
  const [draftEnd, setDraftEnd] = useState<Date | null>(initialEnd);
  const syncKey = `${open}:${initialStart?.getTime() ?? ""}:${initialEnd?.getTime() ?? ""}`;
  const [seenSync, setSeenSync] = useState(syncKey);
  if (open && syncKey !== seenSync) {
    setSeenSync(syncKey);
    const initial = initialStart ?? new Date();
    setVisibleMonth(startOfMonth(initial));
    setDraftStart(initialStart);
    setDraftEnd(initialEnd);
  }
  if (!open && syncKey !== seenSync) {
    setSeenSync(syncKey);
  }

  const calendarDays = useMemo(() => {
    const monthStart = startOfMonth(visibleMonth);
    const firstDay = startOfWeek(monthStart, { weekStartsOn: 1 });
    return eachDayOfInterval({
      start: firstDay,
      end: new Date(firstDay.getFullYear(), firstDay.getMonth(), firstDay.getDate() + 41),
    });
  }, [visibleMonth]);

  const todayMark = maxDate ?? new Date();
  const maxDay = maxDate ? startOfDay(maxDate).getTime() : null;
  const nextMonthStarts = startOfMonth(addMonths(visibleMonth, 1));
  const nextMonthDisabled = Boolean(
    maxDate && nextMonthStarts.getTime() > startOfDay(maxDate).getTime() && !isSameMonth(nextMonthStarts, maxDate)
  );

  function isFuture(date: Date) {
    return maxDay !== null && startOfDay(date).getTime() > maxDay;
  }

  function chooseDate(date: Date) {
    if (isFuture(date)) return;
    const next = nextDraftRange(draftStart, draftEnd, date);
    setDraftStart(next.start);
    setDraftEnd(next.end);
  }

  function apply() {
    if (!draftStart || isFuture(draftStart)) return;
    const end = draftEnd ?? draftStart;
    if (isFuture(end)) return;
    onApply({
      from: localDayRange(draftStart).from,
      to: localDayRange(end).to,
    });
    onOpenChange(false);
  }

  const draftLabel = draftStart
    ? draftEnd && !isSameDay(draftStart, draftEnd)
      ? `${format(draftStart, "d MMM")} → ${format(draftEnd, "d MMM")}`
      : format(draftStart, "d MMM yyyy")
    : "Select a date";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="!bottom-0 !left-0 !top-auto !w-full !max-w-none !translate-x-0 !translate-y-0 !rounded-b-none p-0 sm:!bottom-auto sm:!left-1/2 sm:!top-1/2 sm:!max-w-xl sm:!-translate-x-1/2 sm:!-translate-y-1/2 sm:!rounded-2xl">
        <div className="border-b border-border px-5 py-5 sm:px-7">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <p className="mt-4 text-lg font-semibold text-ink" aria-live="polite" aria-atomic="true">
            {draftLabel}
          </p>
        </div>

        <div className="px-4 py-5 sm:px-7">
          <div className="mb-5 flex items-center justify-between">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Previous month"
              onClick={() => setVisibleMonth((month) => addMonths(month, -1))}
            >
              <ChevronLeft aria-hidden />
            </Button>
            <h3 className="text-base font-semibold text-ink">{format(visibleMonth, "MMMM yyyy")}</h3>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Next month"
              disabled={nextMonthDisabled}
              onClick={() => setVisibleMonth((month) => addMonths(month, 1))}
            >
              <ChevronRight aria-hidden />
            </Button>
          </div>

          <div className="grid grid-cols-7 text-center">
            {WEEKDAYS.map((weekday) => (
              <div key={weekday} className="pb-2 text-xs font-semibold text-muted">
                {weekday}
              </div>
            ))}
            {calendarDays.map((date) => {
              const inMonth = isSameMonth(date, visibleMonth);
              const future = isFuture(date);
              const start = Boolean(draftStart && isSameDay(date, draftStart));
              const end = Boolean(draftEnd && isSameDay(date, draftEnd));
              const inRange = Boolean(
                draftStart && draftEnd && isWithinInterval(date, { start: draftStart, end: draftEnd })
              );
              const today = isSameDay(date, todayMark);
              return (
                <div
                  key={date.toISOString()}
                  className={cn(
                    "my-0.5 flex h-11 items-center justify-center",
                    inRange && "bg-brand/10",
                    start && "rounded-l-full",
                    end && "rounded-r-full",
                    start && end && "rounded-full"
                  )}
                >
                  <button
                    type="button"
                    tabIndex={inMonth && !future ? 0 : -1}
                    disabled={!inMonth || future}
                    aria-label={format(date, "EEEE, d MMMM yyyy")}
                    aria-pressed={start || end}
                    className={cn(
                      "relative flex size-11 items-center justify-center rounded-full text-sm font-medium transition-all focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2",
                      inMonth ? "hover:bg-surface-soft" : "invisible",
                      future && inMonth && "cursor-not-allowed text-muted opacity-40 hover:bg-transparent",
                      today && !start && !end && !future && "border border-brand/40 text-brand",
                      (start || end) && "bg-brand text-white shadow-sm hover:bg-brand-dark"
                    )}
                    onClick={() => chooseDate(date)}
                  >
                    {format(date, "d")}
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        <DialogFooter className="!flex-row !justify-between border-t border-border px-5 py-4 sm:px-7">
          <Button
            type="button"
            variant="ghost"
            className="sm:mr-auto"
            onClick={() => {
              setDraftStart(null);
              setDraftEnd(null);
            }}
          >
            Clear dates
          </Button>
          <Button type="button" disabled={!draftStart} onClick={apply}>
            <Check className="size-4" aria-hidden />
            Apply
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
