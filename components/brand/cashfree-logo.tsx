import { useId } from "react";

import { cn } from "@/lib/utils";

/** Official Cashfree mark (icon from cashfree.com brand SVG) plus wordmark. */
export function CashfreeLogo({ className }: { className?: string }) {
  const uid = useId().replace(/:/g, "");
  const outer = `cf-outer-${uid}`;
  const inner = `cf-inner-${uid}`;

  return (
    <span className={cn("inline-flex h-6 items-center gap-1.5", className)} aria-label="Cashfree Payments" role="img">
      <svg viewBox="3 9 69 61" className="h-full w-auto" aria-hidden>
        <defs>
          <linearGradient id={outer} x1="12.6" y1="9" x2="12.6" y2="57.2" gradientUnits="userSpaceOnUse">
            <stop stopColor="#00ADA1" />
            <stop offset="0.67" stopColor="#00AD5B" />
          </linearGradient>
          <linearGradient id={inner} x1="20.1" y1="21" x2="20.1" y2="46" gradientUnits="userSpaceOnUse">
            <stop stopColor="#FBB016" />
            <stop offset="0.67" stopColor="#FF8FA7" />
          </linearGradient>
        </defs>
        <path
          d="M46.3528 9C48.9708 9 51.4677 9.8512 53.49 11.3934L53.4919 11.3904C53.8093 11.6592 54.1357 11.9137 54.4378 12.2003L67.3658 23.2696L67.3697 23.2735C70.2835 25.5766 71.7407 29.2737 71.1562 32.9191L71.1484 32.9688L71.1395 33.0185L64.0773 70.0271L57.822 63.7971L64.0773 31.7965C64.2509 30.6797 63.7988 29.5234 62.8967 28.8077L57.532 24.2957L51.395 57.1812L45.2067 51.0194L50.7499 21.3225C50.9888 20.048 50.6302 18.7025 49.7942 17.7111C48.934 16.696 47.6909 16.1294 46.3528 16.1294H10.2263L3.05859 9H46.3528Z"
          fill={`url(#${outer})`}
        />
        <path
          d="M43.8662 26.3269L40.1865 46.0147L33.9983 39.8534V39.7354L35.3363 32.6062L36.1725 28.1682H22.2905L15.1226 21.0391H39.3981C40.0337 21.0391 41.2711 21.0391 42.3952 21.0391C43.6262 21.0391 44.5648 22.1402 44.366 23.3551C44.1837 24.4695 43.9799 25.6977 43.8662 26.3269Z"
          fill={`url(#${inner})`}
        />
      </svg>
      <span className="text-base font-bold tracking-tight text-[#2B1A5A] dark:text-white">Cashfree</span>
    </span>
  );
}
