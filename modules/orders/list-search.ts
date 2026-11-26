import { orIlike } from "@/lib/api/filters";
import { searchPhoneNeedles } from "@/lib/phone/india-whatsapp";

const SEARCH_ID_LIMIT = 200;

export function orderCustomerSearchFilter(q: string): string | null {
  const parts = [
    orIlike(["name", "phone"], q),
    ...searchPhoneNeedles(q).map((needle) => orIlike(["phone"], needle)),
  ].filter(Boolean) as string[];
  return parts.join(",") || null;
}

export function orderListSearchOr(q: string, customerIds: string[]): string | null {
  const ids = [...new Set(customerIds.map((id) => id.trim()).filter(Boolean))].slice(0, SEARCH_ID_LIMIT);
  const parts = [
    orIlike(["order_number", "source_order_id"], q),
    ids.length ? `customer_id.in.(${ids.join(",")})` : null,
  ].filter(Boolean) as string[];
  return parts.join(",") || null;
}
