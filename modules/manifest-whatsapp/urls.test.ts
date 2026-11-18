import { describe, expect, it } from "vitest";
import { redactSignedUrl } from "@/modules/manifest-whatsapp/urls";

describe("signed URL redaction", () => {
  it("strips token query values", () => {
    expect(redactSignedUrl("https://files.example/obj?token=super-secret&exp=1")).toBe(
      "https://files.example/obj?token=[redacted]&exp=1"
    );
  });
});
