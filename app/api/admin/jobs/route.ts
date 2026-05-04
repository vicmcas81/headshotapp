import { NextRequest, NextResponse } from "next/server";
import { getAllJobs, deleteJob, deleteNonCompletedJobs, getJobStats, getRevenueStats, getRecentOrders, getAuditLog, logAction, getQueuedPremiumJobs, updateJob } from "@/lib/db";
import fs from "fs";
import path from "path";
import { bufferToBase64, getRunPodConfig, runpodRun } from "@/lib/runpod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const view = searchParams.get("view");

  // Dashboard stats
  if (view === "stats") {
    const [jobStats, revenueStats] = await Promise.all([
      getJobStats(),
      getRevenueStats(),
    ]);
    return NextResponse.json({ jobs: jobStats, revenue: revenueStats });
  }

  // Recent orders
  if (view === "orders") {
    const orders = await getRecentOrders(50);
    return NextResponse.json(orders);
  }

  // Audit log
  if (view === "audit") {
    const logs = await getAuditLog(100);
    return NextResponse.json(logs);
  }

  // Default: all jobs
  const jobs = await getAllJobs();
  return NextResponse.json(jobs);
}

// Delete a job
export async function DELETE(req: NextRequest) {
  const { id } = await req.json();
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  await deleteJob(id);
  await logAction("job_deleted", `Deleted job ${id}`);
  return NextResponse.json({ success: true });
}

// Bulk cleanup: delete everything that's not completed (status !== 'ready')
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({} as any));
  const action = body?.action;

  if (action === "cleanup_non_completed_jobs") {
    const deleted = await deleteNonCompletedJobs();
    await logAction("jobs_cleanup", `Deleted ${deleted} non-completed jobs`);
    return NextResponse.json({ success: true, deleted });
  }

  if (action === "run_premium_batch") {
    const limit = Math.max(1, Math.min(200, Number(body?.limit ?? 50)));
    const jobs = await getQueuedPremiumJobs(limit);
    if (jobs.length === 0) return NextResponse.json({ success: true, submitted: 0 });

    const { premiumEndpointId, fastEndpointId } = getRunPodConfig();
    const endpointId = premiumEndpointId || fastEndpointId;
    if (!endpointId) {
      return NextResponse.json({ error: "RUNPOD_PREMIUM_ENDPOINT_ID (or RUNPOD_FAST_ENDPOINT_ID fallback) is required to run premium batch." }, { status: 500 });
    }

    let submitted = 0;
    for (const job of jobs) {
      try {
        const facePath = path.join(process.cwd(), "public", "uploads", job.id, "photo_1.jpg");
        const faceBase64 = bufferToBase64(fs.readFileSync(facePath));
        const requestId = await runpodRun(endpointId, {
          tier: "premium",
          face_image_base64: faceBase64,
          gender: job.gender,
          styles: ["corporate", "linkedin", "executive"],
          num_images: 3,
          ip_adapter_scale: 1.1,
        });

        await updateJob(job.id, { status: "generating" as any, trainingRequestId: requestId, error: "" });
        submitted += 1;
      } catch (e: any) {
        await updateJob(job.id, { status: "error" as any, error: e?.message || "Batch submit failed" });
      }
    }

    await logAction("premium_batch_run", `Submitted ${submitted}/${jobs.length} premium jobs to RunPod`);
    return NextResponse.json({ success: true, submitted, attempted: jobs.length });
  }

  return NextResponse.json({ error: "Unsupported action" }, { status: 400 });
}
