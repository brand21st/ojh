import { describe, expect, it } from "vitest";
import { boxFromMeasuredLines } from "@/modules/shipments/order-box";

const product = {
  quantity: 1,
  length_cm: 20,
  width_cm: 15,
  height_cm: 10,
  dimension_source: "postbus_override",
  product_id: "11111111-1111-4111-8111-111111111111",
};

describe("boxFromMeasuredLines", () => {
  it("uses the product box for one unit", () => {
    expect(boxFromMeasuredLines({ lines: [product] })).toMatchObject({
      lengthCm: 20,
      widthCm: 15,
      heightCm: 10,
      source: "postbus_override",
    });
  });

  it("does not invent a carton for two units", () => {
    expect(
      boxFromMeasuredLines({
        lines: [
          product,
          { ...product, product_id: "22222222-2222-4222-8222-222222222222", quantity: 1 },
        ],
      })
    ).toBeNull();
    expect(boxFromMeasuredLines({ lines: [{ ...product, quantity: 2 }] })).toBeNull();
  });

  it("lets a verified AutoPack box replace the product measurement", () => {
    expect(
      boxFromMeasuredLines({
        lines: [product, { ...product, quantity: 1 }],
        autopack: {
          lengthCm: 30,
          widthCm: 25,
          heightCm: 15,
          source: "autopack_history",
          evidenceId: "hist-1",
        },
      })
    ).toMatchObject({ source: "autopack_history", lengthCm: 30, evidenceId: "hist-1" });
  });
});
