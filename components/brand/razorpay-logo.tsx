import { cn } from "@/lib/utils";

/** Simple Razorpay wordmark for the integrations screen. */
export function RazorpayLogo({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex h-6 items-center gap-1.5", className)} aria-label="Razorpay" role="img">
      <svg viewBox="0 0 24 24" className="h-full w-auto" aria-hidden>
        <path d="M9.6 3 7.9 9.4l5.4-3.5L9.4 21h3.8L17.6 3z" fill="#3395FF" />
        <path d="m5.7 13.4-1.4 5.3h6.8l2.8-10.4z" fill="#072654" />
      </svg>
      <span className="text-base font-bold tracking-tight text-[#072654] dark:text-white">Razorpay</span>
    </span>
  );
}
