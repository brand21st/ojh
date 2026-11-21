"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/hooks/use-api";

const toRupees = (micros: string) => Number(BigInt(micros) / BigInt(1_000_000));

/** Up to five balance levels; crossing one sends an in-app alert (and email, when PostBus has it on). */
export function AlertLevels({ thresholdsMicros, canEdit }: { thresholdsMicros: string[]; canEdit: boolean }) {
  const client = useQueryClient();
  const [value, setValue] = useState(() => thresholdsMicros.map(toRupees).join(", "));
  const levels = value
    .split(/[,\s]+/)
    .filter(Boolean)
    .map((v) => Number(v));
  const valid = levels.length <= 5 && levels.every((v) => Number.isInteger(v) && v >= 1 && v <= 100000);

  const save = useMutation({
    mutationFn: () =>
      api("/api/v1/wallet/alerts", { method: "PATCH", body: JSON.stringify({ thresholdsRupees: [...new Set(levels)] }) }),
    onSuccess: async () => {
      toast.success(levels.length ? "Alert levels saved." : "Low-balance alerts turned off.");
      await client.invalidateQueries({ queryKey: ["wallet"] });
      await client.invalidateQueries({ queryKey: ["me"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Low-balance alerts</CardTitle>
        <CardDescription>We notify you when your balance falls below each level. Leave empty to turn alerts off.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="space-y-1.5 sm:flex-1">
          <Label htmlFor="wallet-alert-levels">Alert me below (₹, up to 5, comma separated)</Label>
          <Input
            id="wallet-alert-levels"
            inputMode="numeric"
            value={value}
            disabled={!canEdit}
            onChange={(event) => setValue(event.target.value.replace(/[^\d,\s]/g, ""))}
            placeholder="100, 50, 20"
          />
          {!valid ? <p className="text-xs text-rose-600">Use up to five whole rupee amounts between 1 and 1,00,000.</p> : null}
          {!canEdit ? <p className="text-xs text-muted">Only the workspace owner can change alert levels.</p> : null}
        </div>
        {canEdit ? (
          <Button variant="secondary" disabled={!valid || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? "Saving…" : "Save alerts"}
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}
