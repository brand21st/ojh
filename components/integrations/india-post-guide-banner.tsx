"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { BookOpen } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { IndiaPostBookingGuideBody } from "@/components/shipments/india-post-booking-guide";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  hasLocalIndiaPostBookingGuideHidden,
  setLocalIndiaPostBookingGuideHidden,
  shouldAutoOpenIndiaPostBookingGuide,
} from "@/lib/dashboard/india-post-booking-guide";
import { api } from "@/lib/hooks/use-api";
import { useMe } from "@/lib/hooks/use-me";
import type { MeResponse } from "@/types/api";

function subscribeNever() {
  return () => {};
}

export function IndiaPostGuideBanner({ selectedService }: { selectedService?: string }) {
  const me = useMe();
  const queryClient = useQueryClient();
  const hydrated = useSyncExternalStore(subscribeNever, () => true, () => false);
  const userId = me.data?.user.id;
  const hiddenAt = me.data?.user.indiaPostBookingGuideHiddenAt ?? null;
  const [open, setOpen] = useState(false);
  const [dontShow, setDontShow] = useState(false);
  const [localHidden, setLocalHidden] = useState(false);
  const [seenUserId, setSeenUserId] = useState(userId);
  const [autoOpened, setAutoOpened] = useState(false);

  if (userId !== seenUserId) {
    setSeenUserId(userId);
    const nextLocal = userId ? hasLocalIndiaPostBookingGuideHidden(userId) : false;
    setLocalHidden(nextLocal);
    setDontShow(Boolean(hiddenAt) || nextLocal);
    setAutoOpened(false);
  }

  const persistHidden = useCallback(
    async (hidden: boolean) => {
      if (userId) setLocalIndiaPostBookingGuideHidden(userId, hidden);
      setLocalHidden(hidden);
      setDontShow(hidden);
      const hiddenStamp = hidden ? new Date().toISOString() : null;
      queryClient.setQueryData<MeResponse>(["me"], (current) => {
        if (!current) return current;
        return {
          ...current,
          user: { ...current.user, indiaPostBookingGuideHiddenAt: hiddenStamp },
        };
      });
      try {
        await api("/api/v1/me", {
          method: "PATCH",
          body: JSON.stringify({ indiaPostBookingGuideHidden: hidden }),
        });
      } catch {
        // Local skip plus optimistic /me keep the guide from returning this session.
      }
    },
    [queryClient, userId],
  );

  const shouldAutoOpen = shouldAutoOpenIndiaPostBookingGuide({
    hydrated,
    meLoading: me.isLoading,
    meError: Boolean(me.error),
    hiddenAt,
    localHidden,
  });

  useEffect(() => {
    if (!userId || me.isLoading || me.error) return;
    if (localHidden && !hiddenAt) void persistHidden(true);
  }, [hiddenAt, localHidden, me.error, me.isLoading, persistHidden, userId]);

  useEffect(() => {
    if (!shouldAutoOpen || autoOpened) return;
    const timer = window.setTimeout(() => {
      setDontShow(false);
      setOpen(true);
      setAutoOpened(true);
    }, 400);
    return () => window.clearTimeout(timer);
  }, [autoOpened, shouldAutoOpen]);

  function handleOpenChange(next: boolean) {
    if (!next && dontShow && !hiddenAt && !localHidden) {
      void persistHidden(true);
    }
    setOpen(next);
  }

  function openGuide() {
    setDontShow(Boolean(hiddenAt) || localHidden);
    setOpen(true);
  }

  return (
    <>
      <div className="flex flex-col gap-3 rounded-2xl border border-amber-200 bg-amber-50/70 p-3 sm:flex-row sm:items-center sm:p-4">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-amber-100 text-amber-700">
            <BookOpen className="size-4.5" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-amber-950">India Post Booking Guide</p>
            <p className="text-xs leading-relaxed text-amber-800">
              Parcels book from <span className="rounded bg-brand/15 px-1 font-bold tabular-nums text-brand">1 g</span>{" "}
              to 35 kg. A selected Speed Post Parcel or Business Parcel is not treated as a document when weight is
              below 500 g. Parcels need Length, Width and Height.
            </p>
          </div>
        </div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="shrink-0 self-start sm:self-auto"
          onClick={openGuide}
        >
          <BookOpen className="size-4" />
          View guide
        </Button>
      </div>

      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="max-h-[90vh] max-w-3xl gap-3 overflow-y-auto p-4 sm:p-6">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base sm:text-lg">
              <span className="flex size-8 items-center justify-center rounded-lg bg-amber-100 text-amber-700">
                <BookOpen className="size-4" />
              </span>
              India Post Booking Guide
            </DialogTitle>
            <DialogDescription>
              Check weight and box size before booking so India Post accepts the shipment.
            </DialogDescription>
          </DialogHeader>

          <div className="rounded-xl border border-amber-200 bg-amber-50/60 p-3 text-xs text-amber-950">
            <IndiaPostBookingGuideBody selectedService={selectedService} />
          </div>

          <DialogFooter className="items-stretch gap-3 sm:items-center sm:justify-between">
            <label className="flex items-center gap-2 text-sm text-muted">
              <Checkbox
                checked={dontShow}
                onCheckedChange={(value) => {
                  const hidden = value === true;
                  void persistHidden(hidden);
                  if (hidden) setOpen(false);
                }}
              />
              Don&apos;t show this automatically
            </label>
            <Button type="button" size="sm" onClick={() => handleOpenChange(false)}>
              Got it
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
