import type { SupabaseClient } from "@supabase/supabase-js";

export type MerchantMailContact = {
  name: string;
  email: string;
  phone: string;
};

function clean(value: unknown, max = 200) {
  return String(value ?? "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

export async function loadMerchantMailContact(
  supabase: SupabaseClient,
  organizationId: string
): Promise<MerchantMailContact> {
  const [{ data: org }, { data: invoice }] = await Promise.all([
    supabase.from("organizations").select("name, phone").eq("id", organizationId).maybeSingle(),
    supabase
      .from("invoice_settings")
      .select("business_email")
      .eq("organization_id", organizationId)
      .maybeSingle(),
  ]);
  return {
    name: clean(org?.name) || "Merchant",
    email: clean(invoice?.business_email, 254),
    phone: clean(org?.phone, 32),
  };
}
