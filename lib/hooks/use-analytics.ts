"use client";

import { useEffect } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/hooks/use-api";
import { useMe } from "@/lib/hooks/use-me";
import { FEATURE } from "@/modules/billing/entitlements";
import { createClient } from "@/lib/supabase/client";
import type { AnalyticsFocusId, DashboardAnalytics } from "@/types/api";

export const ANALYTICS_QUERY_KEY = ["dashboard-analytics"] as const;

export type AnalyticsFilter = {
  range: AnalyticsFocusId;
  from?: string;
  to?: string;
};

export function useAnalytics(filter: AnalyticsFilter = { range: "today" }) {
  const me = useMe();
  const queryClient = useQueryClient();
  const organizationId = me.data?.organization?.id;
  const customReady = filter.range !== "custom" || Boolean(filter.from && filter.to);

  const query = useQuery({
    queryKey: [...ANALYTICS_QUERY_KEY, filter.range, filter.from ?? null, filter.to ?? null],
    queryFn: () => {
      const params = new URLSearchParams({ range: filter.range });
      if (filter.range === "custom" && filter.from && filter.to) {
        params.set("from", filter.from);
        params.set("to", filter.to);
      }
      return api<DashboardAnalytics>(`/api/v1/dashboard/analytics?${params.toString()}`);
    },
    refetchInterval: 10_000,
    refetchOnWindowFocus: true,
    staleTime: 0,
    placeholderData: keepPreviousData,
    enabled:
      customReady &&
      (Boolean(me.data?.subscription?.trial) ||
        (me.data?.subscription?.features ?? []).includes(FEATURE.analytics)),
  });

  useEffect(() => {
    if (!organizationId) return;
    let channel: ReturnType<ReturnType<typeof createClient>["channel"]> | null = null;
    try {
      const supabase = createClient();
      channel = supabase
        .channel(`analytics:${organizationId}`)
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "orders",
            filter: `organization_id=eq.${organizationId}`,
          },
          () => {
            void queryClient.invalidateQueries({ queryKey: ANALYTICS_QUERY_KEY });
          }
        )
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "shipments",
            filter: `organization_id=eq.${organizationId}`,
          },
          () => {
            void queryClient.invalidateQueries({ queryKey: ANALYTICS_QUERY_KEY });
          }
        )
        .subscribe();
    } catch {
      // Polling still refreshes the page if Realtime is unavailable.
    }
    return () => {
      if (channel) void channel.unsubscribe();
    };
  }, [organizationId, queryClient]);

  return query;
}
