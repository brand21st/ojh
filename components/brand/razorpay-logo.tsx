import { cn } from "@/lib/utils";

/** Official Razorpay bolt (Simple Icons / Razorpay brand colors) plus wordmark. */
export function RazorpayLogo({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex h-6 items-center gap-1.5", className)} aria-label="Razorpay" role="img">
      <svg viewBox="0 0 24 24" className="h-full w-auto" aria-hidden>
        <path d="M22.436 0 10.526 7.773 9.352 12.05l6.625-4.297L11.65 24h4.391L22.436 0Z" fill="#3395FF" />
        <path d="M14.26 10.098 3.389 17.166 1.564 24h9.008l3.688-13.902Z" fill="#072654" />
      </svg>
      <span className="text-base font-bold tracking-tight text-[#072654] dark:text-white">Razorpay</span>
    </span>
  );
}
