import { api } from "@/lib/hooks/use-api";
import type { PrebookingCheckResult, PrebookingOrderResult } from "@/types/api";

const CHUNK = 25;

export async function precheckOrderIds(
  orderIds: string[],
  onProgress: (done: number, total: number) => void,
  options: { allowAi: boolean; forceAi?: boolean } = { allowAi: true }
) {
  const orders: PrebookingOrderResult[] = [];
  const allowAi = options.allowAi;
  const forceAi = allowAi && Boolean(options.forceAi);
  for (let index = 0; index < orderIds.length; index += CHUNK) {
    const chunk = orderIds.slice(index, index + CHUNK);
    const result = await api<PrebookingCheckResult>("/api/v1/bookings/precheck", {
      method: "POST",
      body: JSON.stringify({ orderIds: chunk, allowAi, forceAi }),
    });
    orders.push(...result.orders);
    onProgress(Math.min(index + chunk.length, orderIds.length), orderIds.length);
  }
  return tallyPrecheck(orders);
}

export function tallyPrecheck(orders: PrebookingOrderResult[]): PrebookingCheckResult {
  return {
    total: orders.length,
    ready: orders.filter((order) => order.status === "ready").length,
    fixRequired: orders.filter((order) => order.status === "fix_required").length,
    needsReview: orders.filter((order) => order.status === "needs_review").length,
    unavailable: orders.filter((order) => order.status === "validation_unavailable").length,
    orders,
  };
}
