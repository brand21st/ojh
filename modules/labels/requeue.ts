import type { SupabaseClient } from "@supabase/supabase-js";
import { createBackgroundJob } from "@/modules/jobs/service";

const BATCH = 50;

/** Put failed or missing label jobs back on the queue for shipments India Post already booked. */
export async function requeueStuckLabelJobs(supabase: SupabaseClient) {
  const { data, error } = await supabase
    .from("shipments")
    .select("id, organization_id")
    .eq("status", "LABEL_PENDING")
    .not("booked_at", "is", null)
    .limit(BATCH);
  if (error) throw new Error(error.message);

  let requeued = 0;
  for (const shipment of data ?? []) {
    const shipmentId = String(shipment.id);
    const organizationId = String(shipment.organization_id);
    const { data: jobs, error: jobError } = await supabase
      .from("background_jobs")
      .select("id, status")
      .eq("organization_id", organizationId)
      .eq("entity_id", shipmentId)
      .eq("job_type", "label-generation")
      .order("created_at", { ascending: false })
      .limit(1);
    if (jobError) throw new Error(jobError.message);
    const latest = jobs?.[0] as { id?: string; status?: string } | undefined;
    if (latest?.status && latest.status !== "FAILED") continue;
    if (latest?.id) {
      const { error: updateError } = await supabase
        .from("background_jobs")
        .update({
          status: "QUEUED",
          attempt_count: 0,
          next_attempt_at: new Date().toISOString(),
          locked_at: null,
          last_error: null,
          last_error_code: null,
          completed_at: null,
        })
        .eq("id", latest.id)
        .eq("status", "FAILED");
      if (updateError) throw new Error(updateError.message);
      requeued += 1;
      continue;
    }
    await createBackgroundJob(supabase, {
      organizationId,
      jobType: "label-generation",
      entityType: "shipment",
      entityId: shipmentId,
    });
    requeued += 1;
  }
  return { requeued };
}
