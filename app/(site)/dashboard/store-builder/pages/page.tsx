"use client";

import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { PoliciesSettings } from "@/components/dashboard/policies-settings";
import { Panel } from "@/components/store-builder/settings-panels";

export default function StoreBuilderPagesPage() {
  return (
    <div className="space-y-4">
      <Panel title="Navigation" description="Header menu links, the announcement bar and category chips are part of your store design."
        actions={<Link href="/dashboard/store-builder/customize" className={buttonVariants({ size: "xs", variant: "secondary" })}>Edit menu</Link>}>
        <p className="text-xs text-muted">Open Customize → Header to add links to categories, home page sections, policy pages or other websites. Changes go live when you publish.</p>
      </Panel>
      <Panel title="Policy pages" description="Privacy, terms, shipping and returns pages are linked from your store footer and checkout. These are shared with your WhatsApp ordering and save immediately.">
        <PoliciesSettings />
      </Panel>
    </div>
  );
}
