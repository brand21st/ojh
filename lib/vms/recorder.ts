"use client";

import { api } from "@/lib/hooks/use-api";
import { VMS_CHUNK_BYTES, type VmsChunkResult, type VmsFinishResult } from "@/types/vms";

/**
 * Browser side of packing videos. The webcam is drawn onto a canvas with the
 * watermark (brand, IST date and time, barcode, order) painted on every frame, and
 * the canvas is what gets recorded, so the stamp cannot be cropped or edited out
 * without re-encoding the video. Chrome and Edge record MP4 (H.264); browsers that
 * cannot fall back to WebM.
 */

export type Watermark = {
  barcode: string;
  orderNumber: string | null;
  trackingNumber: string | null;
  operator: string | null;
  workspace: string | null;
};

const WIDTH = 1280;
const HEIGHT = 720;
const FPS = 24;
export const MAX_RECORDING_MS = 20 * 60 * 1000;

const MIME_CANDIDATES = [
  "video/mp4;codecs=avc1.42E01F",
  "video/mp4;codecs=avc1",
  "video/mp4",
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
];

export function pickMimeType() {
  if (typeof MediaRecorder === "undefined") return null;
  return MIME_CANDIDATES.find((type) => MediaRecorder.isTypeSupported(type)) ?? null;
}

export function recordsMp4() {
  return pickMimeType()?.startsWith("video/mp4") ?? false;
}

const dateFormat = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric" });
const timeFormat = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: true,
});

export function watermarkLines(mark: Watermark, now: Date) {
  const lines = [
    `${dateFormat.format(now).toUpperCase()}  ·  ${timeFormat.format(now)} IST`,
    `Barcode: ${mark.barcode}`,
  ];
  if (mark.orderNumber) lines.push(`Order: ${mark.orderNumber}`);
  if (mark.trackingNumber && mark.trackingNumber !== mark.barcode) lines.push(`Tracking: ${mark.trackingNumber}`);
  if (mark.operator) lines.push(`Packed by: ${mark.operator}`);
  return lines;
}

function formatElapsed(ms: number) {
  const total = Math.floor(ms / 1000);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

export async function listCameras() {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((device) => device.kind === "videoinput");
}

type CameraChoice = { deviceId: string; label: string };

/** Built-in laptop cameras. USB packing webcams and virtual cameras are not. */
export function looksLikeLaptopCamera(label: string) {
  const text = label.trim().toLowerCase();
  if (!text) return false;
  if (/(obs|snap camera|manycam|droidcam|ndi|elgato|capture card|virtual)/.test(text)) return false;
  if (/(integrated|built[- ]?in|internal|facetime|ishutter|laptop)/.test(text)) return true;
  if (/(truevision|realtek|azurewave|chicony|microdia|easywebcam)/.test(text)) return true;
  return false;
}

export function pickLaptopCameraId(devices: CameraChoice[]) {
  return devices.find((device) => device.deviceId && looksLikeLaptopCamera(device.label))?.deviceId ?? null;
}

/**
 * Camera to open: a just-plugged USB cam, else the operator's saved pick, else the laptop webcam.
 */
export function resolvePackingCameraId(
  devices: CameraChoice[],
  options: { preferred?: string | null; plugged?: string | null } = {}
) {
  const ids = new Set(devices.map((device) => device.deviceId).filter(Boolean));
  if (options.plugged && ids.has(options.plugged)) return options.plugged;
  if (options.preferred && ids.has(options.preferred)) return options.preferred;
  return pickLaptopCameraId(devices) ?? devices.find((device) => device.deviceId)?.deviceId ?? null;
}

export class PackingCamera {
  readonly canvas: HTMLCanvasElement;
  private video: HTMLVideoElement;
  private stream: MediaStream | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private recorder: MediaRecorder | null = null;
  private parts: Blob[] = [];
  private mark: Watermark | null = null;
  private startedAt = 0;
  private mimeType: string | null = null;

  constructor() {
    this.canvas = document.createElement("canvas");
    this.canvas.width = WIDTH;
    this.canvas.height = HEIGHT;
    this.video = document.createElement("video");
    this.video.muted = true;
    this.video.playsInline = true;
  }

  get recording() {
    return this.recorder?.state === "recording";
  }

  get elapsedMs() {
    return this.recording ? Date.now() - this.startedAt : 0;
  }

  /** Called when the camera stops sending frames (unplugged, or taken by another app). */
  onEnded: (() => void) | null = null;

  /**
   * Opens the chosen camera, or the laptop webcam when none is chosen or the chosen one is gone.
   * Swapping cameras mid-recording keeps the recording going.
   */
  async open(deviceId?: string | null): Promise<string | null> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw Object.assign(new Error("The camera needs a secure (https) connection."), { name: "InsecureContext" });
    }
    const constraints = (id?: string | null): MediaStreamConstraints => ({
      audio: false,
      video: {
        width: { ideal: WIDTH },
        height: { ideal: HEIGHT },
        frameRate: { ideal: FPS },
        ...(id ? { deviceId: { exact: id } } : {}),
      },
    });
    this.releaseStream();
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints(deviceId));
    } catch (error) {
      const name = (error as Error).name;
      if (!deviceId || (name !== "OverconstrainedError" && name !== "NotFoundError")) throw error;
      stream = await navigator.mediaDevices.getUserMedia(constraints(null));
    }
    this.stream = stream;
    const track = stream.getVideoTracks()[0];
    if (track) {
      track.onended = () => {
        if (this.stream === stream) this.onEnded?.();
      };
    }
    this.video.srcObject = stream;
    await this.video.play();
    if (!this.timer) {
      // setInterval keeps drawing when the tab loses focus; requestAnimationFrame would stop.
      this.timer = setInterval(() => this.draw(), 1000 / FPS);
    }
    this.draw();
    return track?.getSettings().deviceId ?? null;
  }

  private releaseStream() {
    const stream = this.stream;
    this.stream = null;
    stream?.getTracks().forEach((track) => {
      track.onended = null;
      track.stop();
    });
    this.video.srcObject = null;
  }

  get live() {
    return this.stream?.getVideoTracks().some((track) => track.readyState === "live") ?? false;
  }

  close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.recorder && this.recorder.state !== "inactive") this.recorder.stop();
    this.recorder = null;
    this.releaseStream();
  }

  get isOpen() {
    return this.live;
  }

  start(mark: Watermark) {
    if (!this.live) throw new Error("Turn the camera on first.");
    const mimeType = pickMimeType();
    if (!mimeType) throw new Error("This browser cannot record video. Use Chrome or Edge.");
    this.mark = mark;
    this.parts = [];
    this.mimeType = mimeType;
    const output = this.canvas.captureStream(FPS);
    this.recorder = new MediaRecorder(output, { mimeType, videoBitsPerSecond: 1_500_000 });
    this.recorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.parts.push(event.data);
    };
    this.startedAt = Date.now();
    this.recorder.start(1000);
    this.draw();
  }

  /** Stops and returns the whole file plus its length in milliseconds. */
  stop(): Promise<{ blob: Blob; durationMs: number; mimeType: string }> {
    const recorder = this.recorder;
    if (!recorder || recorder.state === "inactive") return Promise.reject(new Error("Not recording."));
    const durationMs = Date.now() - this.startedAt;
    return new Promise((resolve, reject) => {
      recorder.onstop = () => {
        const type = (this.mimeType ?? "video/webm").split(";")[0];
        const blob = new Blob(this.parts, { type });
        this.parts = [];
        this.mark = null;
        this.recorder = null;
        if (blob.size === 0) reject(new Error("The camera produced no video."));
        else resolve({ blob, durationMs, mimeType: type });
      };
      recorder.onerror = () => reject(new Error("Recording failed."));
      recorder.stop();
    });
  }

  /** Throws the recording away. */
  discard() {
    if (this.recorder && this.recorder.state !== "inactive") {
      this.recorder.onstop = null;
      this.recorder.stop();
    }
    this.recorder = null;
    this.parts = [];
    this.mark = null;
  }

  private draw() {
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    if (this.video.readyState >= 2) {
      // Cover-fit the camera into 16:9.
      const vw = this.video.videoWidth || WIDTH;
      const vh = this.video.videoHeight || HEIGHT;
      const scale = Math.max(WIDTH / vw, HEIGHT / vh);
      const dw = vw * scale;
      const dh = vh * scale;
      ctx.drawImage(this.video, (WIDTH - dw) / 2, (HEIGHT - dh) / 2, dw, dh);
    } else {
      ctx.fillStyle = "#111";
      ctx.fillRect(0, 0, WIDTH, HEIGHT);
    }

    const now = new Date();
    if (this.mark) {
      const lines = watermarkLines(this.mark, now);
      const brand = this.mark.workspace ? `POSTBUS · ${this.mark.workspace.toUpperCase()}` : "POSTBUS · PACKING PROOF";
      ctx.font = "600 26px ui-monospace, Menlo, Consolas, monospace";
      const width = Math.max(ctx.measureText(brand).width, ...lines.map((line) => ctx.measureText(line).width)) + 36;
      const height = 50 + lines.length * 36;
      ctx.fillStyle = "rgba(0, 0, 0, 0.62)";
      ctx.fillRect(16, 16, width, height);
      ctx.fillStyle = "#facc15";
      ctx.fillText(brand, 34, 52);
      ctx.fillStyle = "#ffffff";
      lines.forEach((line, index) => ctx.fillText(line, 34, 90 + index * 36));

      // REC badge and elapsed time, bottom right.
      const elapsed = formatElapsed(Date.now() - this.startedAt);
      ctx.font = "700 26px ui-monospace, Menlo, Consolas, monospace";
      const badge = `REC ${elapsed}`;
      const bw = ctx.measureText(badge).width + 64;
      ctx.fillStyle = "rgba(0, 0, 0, 0.62)";
      ctx.fillRect(WIDTH - bw - 16, HEIGHT - 66, bw, 50);
      ctx.fillStyle = Math.floor(Date.now() / 500) % 2 ? "#ef4444" : "#7f1d1d";
      ctx.beginPath();
      ctx.arc(WIDTH - bw + 10, HEIGHT - 41, 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.fillText(badge, WIDTH - bw + 30, HEIGHT - 32);
    } else {
      ctx.font = "600 22px ui-monospace, Menlo, Consolas, monospace";
      ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
      ctx.fillRect(16, 16, 470, 44);
      ctx.fillStyle = "#ffffff";
      ctx.fillText("Ready · scan a barcode to start recording", 30, 46);
    }
  }
}

/**
 * Uploads the recording in 4 MB pieces (the proxy buffers at most 10 MB per request)
 * and resumes from whatever the server already has, so a retry after a dropped
 * connection never re-sends or duplicates bytes. Then saves and charges it.
 */
export async function uploadRecording(
  videoId: string,
  blob: Blob,
  durationMs: number,
  onProgress?: (fraction: number) => void
): Promise<VmsFinishResult> {
  let offset = (await api<VmsChunkResult>(`/api/v1/vms/${videoId}/chunk`)).size;
  if (offset > blob.size) offset = 0;
  let failures = 0;
  while (offset < blob.size) {
    onProgress?.(offset / blob.size);
    const piece = blob.slice(offset, Math.min(offset + VMS_CHUNK_BYTES, blob.size));
    try {
      const result = await api<VmsChunkResult>(`/api/v1/vms/${videoId}/chunk?offset=${offset}`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: piece,
      });
      offset = result.size;
      failures = 0;
    } catch (error) {
      failures += 1;
      if (failures >= 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 800 * failures));
      offset = (await api<VmsChunkResult>(`/api/v1/vms/${videoId}/chunk`).catch(() => ({ size: offset }))).size;
    }
  }
  onProgress?.(1);
  return api<VmsFinishResult>(`/api/v1/vms/${videoId}/finish`, {
    method: "POST",
    body: JSON.stringify({ durationMs: Math.round(durationMs) }),
  });
}
