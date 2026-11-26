export type PackingVideoStatus = "RECORDING" | "READY" | "FAILED" | "CANCELLED" | "EXPIRED";
export type PackingVideoBilling = "PENDING" | "FREE" | "CHARGED" | "UNPAID";

export type VmsStartResult =
  | {
      status: "RECORDING";
      videoId: string;
      code: string;
      orderId: string | null;
      orderNumber: string | null;
      trackingNumber: string | null;
      free: boolean;
      freeRemaining: number;
      priceMicros: string;
    }
  | { status: "CANCELLED"; code: string; orderId: string; orderNumber: string | null }
  | { status: "NO_BALANCE"; code: string; priceMicros: string; availableMicros: string }
  | { status: "INVALID_CODE"; code: string };

export type VmsChunkResult = { ok: boolean; size: number };

export type VmsFinishResult = {
  videoId: string;
  billingStatus: PackingVideoBilling;
  sizeBytes: number;
};

export type PackingVideo = {
  id: string;
  barcode: string;
  orderId: string | null;
  orderNumber: string | null;
  trackingNumber: string | null;
  status: PackingVideoStatus;
  billingStatus: PackingVideoBilling;
  chargeMicros: number;
  mimeType: string | null;
  sizeBytes: number | null;
  durationMs: number | null;
  startedAt: string;
  endedAt: string | null;
  expiresAt: string | null;
  recordedBy: string | null;
  recordedByName: string | null;
};

export type PackingVideoList = {
  items: PackingVideo[];
  total: number;
  page: number;
  pageSize: number;
};

export type VmsSummary = {
  enabled: boolean;
  priceMicros: number;
  freeVideos: number;
  freeRemaining: number;
  retentionDays: number;
  walletAvailableMicros: number | null;
  videosThisMonth: number;
  workspaceName: string;
  operatorName: string | null;
};

/** Upload pieces stay under the proxy's 10 MB body buffer. */
export const VMS_CHUNK_BYTES = 4 * 1024 * 1024;
export const VMS_MAX_VIDEO_BYTES = 600 * 1024 * 1024;
export const VMS_ZIP_MAX_VIDEOS = 100;
