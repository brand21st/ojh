import { notFound } from "next/navigation";
import { WalletDashboard } from "@/components/wallet/wallet-dashboard";
import { walletEnabled } from "@/modules/wallet/constants";

export const dynamic = "force-dynamic";

export default function WalletPage() {
  if (!walletEnabled()) notFound();
  return <WalletDashboard />;
}
