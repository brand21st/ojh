import { describe, expect, it } from "vitest";
import { phonePinCorrectionSchema } from "@/modules/orders/schema";
import { contactCorrectionFields, needsContactCorrection } from "@/modules/orders/contact-correction";

describe("contact correction", () => {
  it("opens the popup for a bad mobile number or PIN and not for a lookup outage", () => {
    expect(needsContactCorrection([{ code: "invalid_phone" }])).toBe(true);
    expect(needsContactCorrection([{ code: "missing_phone" }])).toBe(true);
    expect(needsContactCorrection([{ code: "missing_pincode" }])).toBe(true);
    expect(needsContactCorrection([{ code: "pin_not_found" }])).toBe(true);
    expect(needsContactCorrection([{ code: "pin_state_mismatch" }])).toBe(true);
    expect(needsContactCorrection([{ code: "pin_unavailable" }])).toBe(false);
    expect(contactCorrectionFields([{ code: "invalid_phone" }, { code: "pin_not_found" }])).toEqual({
      phone: true,
      pin: true,
      stateChoice: false,
      pinUnavailable: false,
    });
  });

  it("normalizes +91 and a leading zero and rejects a short or wrong-prefix number", () => {
    expect(phonePinCorrectionSchema.parse({ correction: "phone_pin", phone: "+91 9876543210" }).phone).toBe("9876543210");
    expect(phonePinCorrectionSchema.parse({ correction: "phone_pin", phone: "09876543210" }).phone).toBe("9876543210");
    expect(phonePinCorrectionSchema.parse({ correction: "phone_pin", phone: "98765 43210" }).phone).toBe("9876543210");
    expect(() => phonePinCorrectionSchema.parse({ correction: "phone_pin", phone: "1234567890" })).toThrow();
    expect(() => phonePinCorrectionSchema.parse({ correction: "phone_pin", phone: "987654321" })).toThrow();
    expect(() => phonePinCorrectionSchema.parse({ correction: "phone_pin", phone: "" })).toThrow();
    expect(() => phonePinCorrectionSchema.parse({ correction: "phone_pin", pincode: "012345" })).toThrow();
    expect(phonePinCorrectionSchema.parse({ correction: "phone_pin", pincode: "673121" }).pincode).toBe("673121");
  });
});