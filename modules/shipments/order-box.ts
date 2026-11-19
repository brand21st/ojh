import type { SupabaseClient } from "@supabase/supabase-js";
import { compositionFromOrderLines } from "@/modules/autopack/composition";
import { evaluateAutoPack, loadWorkspacePackages } from "@/modules/autopack/service";
import type { DecisionShipment } from "@/modules/autopack/decide";
import {
  mergeParcelDimensionsMetadata,
  parcelDimensionsMetadata,
  resolveShipmentDimensions,
  type CmBox,
  type PackageOption,
  type ResolvedShipmentDimensions,
  type ShipmentUnit,
} from "@/modules/shopify/dimensions";

export type OrderBoxLine = {
  quantity?: number | null;
  unfulfilled_quantity?: number | null;
  length_cm?: number | string | null;
  width_cm?: number | string | null;
  height_cm?: number | string | null;
  dimension_source?: string | null;
  requires_shipping?: boolean | null;
  shopify_variant_id?: string | null;
  shopify_product_id?: string | null;
  product_id?: string | null;
  sku?: string | null;
  title?: string | null;
};

function positiveCm(value: number | string | null | undefined) {
  const amount = typeof value === "string" ? Number(value) : value;
  return amount != null && Number.isFinite(amount) && amount > 0 ? amount : null;
}

/** Remaining quantity for Shopify, ordered quantity for catalog and manual orders. */
export function unitsFromOrderLines(lines: OrderBoxLine[], shopifyOrder: boolean): ShipmentUnit[] {
  const units: ShipmentUnit[] = [];
  for (const line of lines) {
    if (line.requires_shipping === false) continue;
    const quantity = shopifyOrder
      ? line.unfulfilled_quantity == null
        ? 0
        : Number(line.unfulfilled_quantity) || 0
      : Number(line.quantity) || 0;
    if (quantity <= 0) continue;
    units.push({
      quantity,
      lengthCm: positiveCm(line.length_cm),
      widthCm: positiveCm(line.width_cm),
      heightCm: positiveCm(line.height_cm),
      dimensionSource: line.dimension_source === "postbus_override" ? "postbus_override" : undefined,
    });
  }
  return units;
}

/**
 * Verified AutoPack history wins. Otherwise the existing single-unit rules apply:
 * a measured product box, one saved pack size, or the workspace default.
 * Several units without that history stay unsized.
 */
export function boxFromMeasuredLines(input: {
  lines: OrderBoxLine[];
  shopifyOrder?: boolean;
  packages?: PackageOption[];
  defaultPackage?: CmBox | null;
  autopack?: ResolvedShipmentDimensions | null;
}): ResolvedShipmentDimensions | null {
  if (input.autopack) return input.autopack;
  return resolveShipmentDimensions({
    units: unitsFromOrderLines(input.lines, Boolean(input.shopifyOrder)),
    packages: input.packages,
    defaultPackage: input.defaultPackage ?? null,
  });
}

export function shipmentBoxColumns(choice: ResolvedShipmentDimensions, existingMetadata?: unknown) {
  return {
    length_cm: choice.lengthCm,
    width_cm: choice.widthCm,
    height_cm: choice.heightCm,
    metadata: mergeParcelDimensionsMetadata(existingMetadata, parcelDimensionsMetadata(choice)),
  };
}

async function workspaceDefaultPackage(supabase: SupabaseClient, organizationId: string): Promise<CmBox | null> {
  try {
    const { data } = await supabase
      .from("india_post_connections")
      .select("default_length_cm, default_width_cm, default_height_cm")
      .eq("organization_id", organizationId)
      .maybeSingle();
    const row = data as { default_length_cm?: number | null; default_width_cm?: number | null; default_height_cm?: number | null } | null;
    const lengthCm = positiveCm(row?.default_length_cm);
    const widthCm = positiveCm(row?.default_width_cm);
    const heightCm = positiveCm(row?.default_height_cm);
    if (lengthCm == null || widthCm == null || heightCm == null) return null;
    return { lengthCm, widthCm, heightCm };
  } catch {
    return null;
  }
}

/** Box to write when the caller did not pass one and the merchant has not locked a size. */
export async function lookupOrderShipmentBox(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    orderId: string;
    lines: OrderBoxLine[];
    shopifyOrder?: boolean;
    serviceCode?: string | null;
    weightGrams?: number | null;
    shipment?: DecisionShipment | null;
    packages?: PackageOption[];
    defaultPackage?: CmBox | null;
  }
): Promise<ResolvedShipmentDimensions | null> {
  try {
    const packages = input.packages ?? (await loadWorkspacePackages(supabase, input.organizationId));
    const defaultPackage =
      input.defaultPackage !== undefined ? input.defaultPackage : await workspaceDefaultPackage(supabase, input.organizationId);
    const resolved = boxFromMeasuredLines({
      lines: input.lines,
      shopifyOrder: input.shopifyOrder,
      packages,
      defaultPackage,
    });
    const composition = compositionFromOrderLines(input.lines);
    if (!composition.ok) return resolved;
    const evaluation = await evaluateAutoPack(supabase, {
      organizationId: input.organizationId,
      orderId: input.orderId,
      composition,
      serviceCode: input.serviceCode,
      weightGrams: input.weightGrams,
      shipment: input.shipment ?? null,
      presets: packages,
      fallback: resolved,
    });
    return evaluation.autoChoice ?? resolved;
  } catch {
    return null;
  }
}
