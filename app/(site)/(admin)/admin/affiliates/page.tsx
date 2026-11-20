import { AffiliateAdminDashboard } from "@/components/affiliates/admin-dashboard";
import { PageHeader } from "@/components/dashboard/page-header";
import { accrualEnabled, affiliateEnabled, payoutsEnabled } from "@/modules/affiliates/policy";
import { razorpayxConfigured } from "@/modules/affiliates/razorpayx";

export const dynamic = "force-dynamic";

export default function Page() {
  if (!affiliateEnabled()) {
    return (
      <div className="space-y-4">
        <PageHeader title="Partner program" description="Affiliates who refer merchants to PostBus." />
        <p className="rounded-2xl border border-border bg-card px-4 py-6 text-sm text-muted">
          The partner program is switched off. Set <code>POSTBUS_AFFILIATES_ENABLED=true</code> to manage partners here.
        </p>
      </div>
    );
  }
  return <AffiliateAdminDashboard payoutsEnabled={payoutsEnabled()} accrualEnabled={accrualEnabled()} razorpayxReady={razorpayxConfigured()} />;
}
