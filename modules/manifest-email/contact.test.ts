import { describe, expect, it } from "vitest";
import { loadMerchantMailContact } from "@/modules/manifest-email/contact";

function supabase(org: Record<string, unknown> | null, invoice: Record<string, unknown> | null) {
  return {
    from(table: string) {
      return {
        select() {
          return {
            eq() {
              return {
                maybeSingle: async () => ({
                  data: table === "invoice_settings" ? invoice : org,
                }),
              };
            },
          };
        },
      };
    },
  };
}

describe("merchant mail contact", () => {
  it("reads workspace name, phone, and invoice email", async () => {
    const contact = await loadMerchantMailContact(
      supabase({ name: "Kerlaz Stores", phone: "9876543210" }, { business_email: "desk@kerlaz.example" }) as never,
      "org-1"
    );
    expect(contact).toEqual({
      name: "Kerlaz Stores",
      email: "desk@kerlaz.example",
      phone: "9876543210",
    });
  });
});
