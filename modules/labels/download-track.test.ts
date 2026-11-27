import { describe, expect, it } from "vitest";
import { shouldTrackLabelDownload } from "@/modules/labels/download-track";

describe("shouldTrackLabelDownload", () => {
  it("is true only for the download flag", () => {
    expect(shouldTrackLabelDownload(new Request("http://localhost/api/v1/labels/1/shipping-slip"))).toBe(false);
    expect(
      shouldTrackLabelDownload(new Request("http://localhost/api/v1/labels/1/shipping-slip?track=1"))
    ).toBe(true);
    expect(
      shouldTrackLabelDownload(
        new Request("http://localhost/api/v1/labels/1/india-post", {
          method: "POST",
          headers: { "X-Label-Download": "1" },
        })
      )
    ).toBe(true);
    expect(
      shouldTrackLabelDownload(
        new Request("http://localhost/api/v1/labels/1/shipping-slip", {
          headers: { "X-Label-Download": "0" },
        })
      )
    ).toBe(false);
  });
});
