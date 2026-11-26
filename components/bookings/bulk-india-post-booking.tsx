"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Truck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  BookedExportPartsDialog,
  bookedSelectionMessage,
  downloadBookedExport,
  exportRequestBody,
  type BookedExportPlan,
} from "@/components/booking-queue/export-booked-dialog";
import { PrebookingReviewDialog } from "@/components/orders/prebooking-review-dialog";
import { api } from "@/lib/hooks/use-api";
import type { BulkBookingResult } from "@/types/api";

export function BulkIndiaPostBooking({
  selectedIds,
  onQueued,
  size = "sm",
  iconOnly = false,
}: {
  selectedIds: string[];
  onQueued?: () => void;
  size?: "default" | "sm" | "xs" | "icon-xs";
  iconOnly?: boolean;
}) {
  const [reviewOpen, setReviewOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportPlan, setExportPlan] = useState<BookedExportPlan | null>(null);
  const [partsOpen, setPartsOpen] = useState(false);

  const queue = useMutation({
    mutationFn: (orderIds: string[]) =>
      api<BulkBookingResult>("/api/v1/bookings/queue", {
        method: "POST",
        body: JSON.stringify({ orderIds }),
      }),
    onSuccess: (data) => {
      toast.success(`${data.queued} articles queued for India Post.`);
      onQueued?.();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  async function downloadExcel() {
    const filters = { orderIds: selectedIds };
    setExporting(true);
    try {
      const plan = await api<BookedExportPlan>("/api/v1/booking-queue/export/plan", {
        method: "POST",
        body: JSON.stringify(exportRequestBody(filters)),
      });
      const skipped = Math.max(0, selectedIds.length - plan.total);
      if (plan.parts.length <= 1 && plan.parts[0]) {
        const saved = await downloadBookedExport(filters, plan.parts[0]);
        if (saved) toast.success(bookedSelectionMessage(selectedIds.length, plan.total));
        return;
      }
      setExportPlan(plan);
      setPartsOpen(true);
      if (skipped > 0) {
        toast.message(
          `${skipped} selected order${skipped === 1 ? " is" : "s are"} not booked yet and will be left out of the Excel.`
        );
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not export the India Post Excel.");
    } finally {
      setExporting(false);
    }
  }

  return (
    <>
      <Button
        type="button"
        variant="secondary"
        size={iconOnly ? "icon-xs" : size}
        disabled={selectedIds.length === 0 || queue.isPending}
        title="Bulk book"
        aria-label="Bulk book"
        onClick={() => setReviewOpen(true)}
      >
        <Truck className="size-4" />
        {iconOnly ? null : "Bulk book"}
      </Button>
      {iconOnly ? null : (
        <Button
          type="button"
          variant="ghost"
          size={size}
          disabled={selectedIds.length === 0 || exporting}
          onClick={() => void downloadExcel()}
        >
          {exporting ? "Excel…" : "Excel"}
        </Button>
      )}
      <PrebookingReviewDialog
        open={reviewOpen}
        onOpenChange={setReviewOpen}
        orderIds={selectedIds}
        onBookReady={(ids) => {
          queue.mutate(ids);
          setReviewOpen(false);
        }}
      />
      <BookedExportPartsDialog
        open={partsOpen}
        onOpenChange={setPartsOpen}
        plan={exportPlan}
        filters={{ orderIds: selectedIds }}
        skipped={Math.max(0, selectedIds.length - (exportPlan?.total ?? 0))}
      />
    </>
  );
}
