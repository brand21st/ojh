import { describe, expect, it } from "vitest";
import { looksLikeLaptopCamera, pickLaptopCameraId, resolvePackingCameraId } from "@/lib/vms/recorder";

describe("looksLikeLaptopCamera", () => {
  it("recognises built-in laptop cameras", () => {
    expect(looksLikeLaptopCamera("Integrated Camera")).toBe(true);
    expect(looksLikeLaptopCamera("HP TrueVision HD Camera")).toBe(true);
    expect(looksLikeLaptopCamera("FaceTime HD Camera")).toBe(true);
  });

  it("rejects USB packing webcams and virtual cameras", () => {
    expect(looksLikeLaptopCamera("Logitech C920")).toBe(false);
    expect(looksLikeLaptopCamera("OBS Virtual Camera")).toBe(false);
  });
});

describe("resolvePackingCameraId", () => {
  const laptop = { deviceId: "lap-1", label: "Integrated Camera" };
  const usb = { deviceId: "usb-1", label: "Logitech C920" };

  it("defaults to the laptop webcam", () => {
    expect(pickLaptopCameraId([usb, laptop])).toBe("lap-1");
    expect(resolvePackingCameraId([usb, laptop])).toBe("lap-1");
  });

  it("uses a just-plugged camera while it is connected", () => {
    expect(resolvePackingCameraId([usb, laptop], { plugged: "usb-1", preferred: "lap-1" })).toBe("usb-1");
  });

  it("falls back to the laptop when the plugged camera is gone", () => {
    expect(resolvePackingCameraId([laptop], { plugged: "usb-1" })).toBe("lap-1");
  });

  it("keeps a saved pick when that camera is still present", () => {
    expect(resolvePackingCameraId([usb, laptop], { preferred: "usb-1" })).toBe("usb-1");
  });
});
