"use client";

import { useEffect } from "react";
import { captureClientException } from "@/lib/analytics/posthog";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    captureClientException(error);
  }, [error]);

  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 px-6 text-center">
      <p className="font-semibold">Something went wrong.</p>
      <p className="text-sm text-muted">Check your connection and try again.</p>
      <button
        type="button"
        className="rounded-md border px-3 py-1.5 text-sm"
        onClick={() => reset()}
      >
        Try again
      </button>
    </div>
  );
}
