// app/api/jobs/[jobId]/route.ts
// Polled every 5s by the gallery page.

import { NextRequest, NextResponse } from "next/server";
import { getJob, updateJob, getSetting } from "@/lib/db";
import fs from "fs";
import path from "path";
import { getRunPodConfig, parseComfyImagesFromRunPodOutput, runpodStatus } from "@/lib/runpod";

export const runtime = "nodejs";
export const maxDuration = 300;

const USE_LOCAL_ML = process.env.USE_LOCAL_ML === "true";

export async function GET(
  _req: NextRequest,
  { params }: { params: { jobId: string } }
) {
  const job = await getJob(params.jobId);
  if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (job.tier === "fast") {
    const fastBackend = process.env.FAST_TIER_BACKEND || "local";
    if (fastBackend === "runpod") return handleFastTierRunPod(job, params.jobId);
    return fastBackend === "fal"
      ? handleFastTierFal(job, params.jobId)
      : handleFastTierLocal(job, params.jobId);
  }

  const premiumBackend = process.env.PREMIUM_TIER_BACKEND || (USE_LOCAL_ML ? "local" : "fal");
  if (premiumBackend === "runpod") return handlePremiumRunPod(job, params.jobId);
  if (USE_LOCAL_ML) {
    return handleLocalML(job, params.jobId);
  } else {
    return handleFalAI(job, params.jobId);
  }
}

// ── FAST TIER — RUNPOD (ComfyUI Serverless) ─────────────────────────────────

async function handleFastTierRunPod(job: any, jobId: string) {
  const { fastEndpointId } = getRunPodConfig();
  if (!fastEndpointId) return NextResponse.json({ status: "error", tier: "fast", error: "RUNPOD_FAST_ENDPOINT_ID missing" });

  if (job.status === "ready") {
    return NextResponse.json({ status: "ready", tier: "fast", headshots: job.headshots ?? [], photoCount: job.photoCount });
  }

  if ((job.status === "generating" || job.status === "error") && job.trainingRequestId) {
    const status = await runpodStatus(fastEndpointId, job.trainingRequestId);

    if (status.status === "FAILED" || status.status === "CANCELLED") {
      const msg = typeof status.error === "string" ? status.error : "RunPod fast job failed";
      await updateJob(job.id, { status: "error", error: msg });
      return NextResponse.json({ status: "error", tier: "fast", error: msg });
    }

    if (status.status === "COMPLETED") {
      const images = parseComfyImagesFromRunPodOutput(status.output);
      if (images.length === 0) {
        await updateJob(job.id, { status: "error", error: "RunPod returned no images" });
        return NextResponse.json({ status: "error", tier: "fast", error: "RunPod returned no images" });
      }

      const outputDir = path.join(process.cwd(), "public", "uploads", job.id, "output");
      fs.mkdirSync(outputDir, { recursive: true });
      const localPaths: string[] = [];

      images.forEach((img, i) => {
        if (!img.base64) return;
        const data = img.base64.startsWith("data:") ? img.base64.split(",")[1] : img.base64;
        const mime = img.base64.startsWith("data:") ? img.base64.slice(5).split(";")[0] : (img.mime || "image/png");
        const ext = mime.includes("jpeg") || mime.includes("jpg") ? "jpg" : "png";
        const filename = `headshot_${String(i + 1).padStart(2, "0")}.${ext}`;
        fs.writeFileSync(path.join(outputDir, filename), Buffer.from(data, "base64"));
        localPaths.push(`/uploads/${job.id}/output/${filename}`);
      });

      if (localPaths.length === 0) {
        await updateJob(job.id, { status: "error", error: "RunPod images could not be decoded" });
        return NextResponse.json({ status: "error", tier: "fast", error: "RunPod images could not be decoded" });
      }

      const updated = await updateJob(job.id, { status: "ready", headshots: localPaths, error: "" });
      return NextResponse.json({ status: "ready", tier: "fast", headshots: updated.headshots ?? localPaths, photoCount: job.photoCount });
    }

    return NextResponse.json({ status: "generating", tier: "fast", progress: { phase: status.status } });
  }

  return NextResponse.json({ status: job.status, tier: "fast", headshots: job.headshots ?? [], photoCount: job.photoCount, error: job.error ?? undefined });
}

// ── PREMIUM — RUNPOD (custom/pipeline endpoint) ─────────────────────────────

async function handlePremiumRunPod(job: any, jobId: string) {
  const { premiumEndpointId } = getRunPodConfig();
  if (!premiumEndpointId) return NextResponse.json({ status: "error", tier: "premium", error: "RUNPOD_PREMIUM_ENDPOINT_ID missing" });

  if (job.status === "queued_for_batch") {
    return NextResponse.json({
      status: "queued_for_batch",
      tier: "premium",
      headshots: [],
      photoCount: job.photoCount,
      progress: { phase: "queued_for_batch" },
      error: job.error ?? undefined,
    });
  }

  if (job.status === "ready") {
    return NextResponse.json({ status: "ready", tier: "premium", headshots: job.headshots ?? [], photoCount: job.photoCount });
  }

  if ((job.status === "training" || job.status === "generating" || job.status === "error") && job.trainingRequestId) {
    const status = await runpodStatus(premiumEndpointId, job.trainingRequestId);

    if (status.status === "FAILED" || status.status === "CANCELLED") {
      const msg = typeof status.error === "string" ? status.error : "RunPod premium job failed";
      await updateJob(job.id, { status: "error", error: msg });
      return NextResponse.json({ status: "error", tier: "premium", error: msg });
    }

    if (status.status === "COMPLETED") {
      // Expect images in output like ComfyUI; if your premium endpoint returns URLs instead, we'll extend this parser.
      const images = parseComfyImagesFromRunPodOutput(status.output);
      if (images.length === 0) {
        await updateJob(job.id, { status: "error", error: "RunPod returned no images" });
        return NextResponse.json({ status: "error", tier: "premium", error: "RunPod returned no images" });
      }

      const outputDir = path.join(process.cwd(), "public", "uploads", job.id, "output");
      fs.mkdirSync(outputDir, { recursive: true });
      const localPaths: string[] = [];

      images.forEach((img, i) => {
        if (!img.base64) return;
        const data = img.base64.startsWith("data:") ? img.base64.split(",")[1] : img.base64;
        const mime = img.base64.startsWith("data:") ? img.base64.slice(5).split(";")[0] : (img.mime || "image/png");
        const ext = mime.includes("jpeg") || mime.includes("jpg") ? "jpg" : "png";
        const filename = `headshot_${String(i + 1).padStart(2, "0")}.${ext}`;
        fs.writeFileSync(path.join(outputDir, filename), Buffer.from(data, "base64"));
        localPaths.push(`/uploads/${job.id}/output/${filename}`);
      });

      const updated = await updateJob(job.id, { status: "ready", headshots: localPaths, error: "" });
      return NextResponse.json({ status: "ready", tier: "premium", headshots: updated.headshots ?? localPaths, photoCount: job.photoCount });
    }

    // Translate to our UI steps
    const phase = status.status === "IN_QUEUE" ? "queued" : "running";
    const nextStatus = job.status === "training" ? "training" : "generating";
    return NextResponse.json({ status: nextStatus, tier: "premium", progress: { phase, runpod: status.status } });
  }

  return NextResponse.json({ status: job.status, tier: "premium", headshots: job.headshots ?? [], photoCount: job.photoCount, error: job.error ?? undefined });
}

// ── FAST TIER — LOCAL (IP-Adapter on M5) ─────────────────────────────────────

async function handleFastTierLocal(job: any, jobId: string) {
  if (job.status === "ready") {
    return NextResponse.json({ status: "ready", tier: "fast", headshots: job.headshots ?? [], photoCount: job.photoCount });
  }

  // Allow recovery if we previously marked the job as error (e.g. timeout) but the ML job later completed.
  if ((job.status === "generating" || job.status === "error") && job.trainingRequestId) {
    try {
      const { checkJobStatus } = await import("@/lib/local-ml");
      const result = await checkJobStatus(job.trainingRequestId);

      if (result.status === "completed" && result.outputDir) {
        const localPaths = collectLocalImages(result.outputDir, job.id);
        if (localPaths.length > 0) {
          const updated = await updateJob(job.id, { status: "ready", headshots: localPaths });
          return NextResponse.json({ status: "ready", tier: "fast", headshots: updated.headshots, photoCount: job.photoCount });
        }
      }

      if (result.status === "failed") {
        await updateJob(job.id, { status: "error", error: result.error || "Fast generation failed" });
        return NextResponse.json({ status: "error", tier: "fast", error: result.error });
      }

      // Only time out if we are not completed/failed yet.
      if (isFastJobStale(job, result.outputDir)) {
        const msg = "Fast job timed out. Please try again or contact support.";
        await updateJob(job.id, { status: "error", error: msg });
        return NextResponse.json({ status: "error", tier: "fast", error: msg });
      }

      return NextResponse.json({
        status: "generating",
        tier: "fast",
        progress: result.liveProgress || readFastProgress(result.outputDir) || { phase: result.status },
      });
    } catch (err: any) {
      console.error("[poll-fast-local] error:", err.message);
      return NextResponse.json({
        status: "generating",
        tier: "fast",
        progress: { error: err.message || "Fast generation status check failed" },
      });
    }
  }

  return NextResponse.json({
    status: job.status,
    tier: "fast",
    headshots: job.headshots ?? [],
    photoCount: job.photoCount,
    error: job.error ?? undefined,
  });
}

// ── FAST TIER — FAL.AI (InstantID) ───────────────────────────────────────────

async function handleFastTierFal(job: any, jobId: string) {
  if (job.status === "ready") {
    return NextResponse.json({
      status: "ready",
      tier: "fast",
      headshots: job.headshots ?? [],
      photoCount: job.photoCount,
    });
  }

  // Allow recovery if we previously marked the job as error (e.g. timeout) but the fal job later completed.
  if ((job.status === "generating" || job.status === "error") && job.trainingRequestId) {
    if (isFastJobStale(job)) {
      const msg = "Fast job timed out. Please try again or contact support.";
      await updateJob(job.id, { status: "error", error: msg });
      return NextResponse.json({ status: "error", tier: "fast", error: msg });
    }
    try {
      const requestIds: string[] = JSON.parse(job.trainingRequestId);
      const { checkFastJobs } = await import("@/lib/fast-fal");
      const result = await checkFastJobs(requestIds);

      if (result.failed) {
        await updateJob(job.id, { status: "error", error: result.failedReason || "InstantID failed" });
        return NextResponse.json({ status: "error", tier: "fast", error: result.failedReason });
      }

      if (result.done && result.imageUrls?.length) {
        // Download all images and save locally
        const outputDir = path.join(process.cwd(), "public", "uploads", job.id, "output");
        fs.mkdirSync(outputDir, { recursive: true });

        const localPaths: string[] = [];
        await Promise.all(
          result.imageUrls.map(async (url, i) => {
            const res = await fetch(url);
            const buffer = Buffer.from(await res.arrayBuffer());
            const filename = `headshot_${String(i + 1).padStart(2, "0")}.jpg`;
            fs.writeFileSync(path.join(outputDir, filename), buffer);
            localPaths[i] = `/uploads/${job.id}/output/${filename}`;
          })
        );

        const updated = await updateJob(job.id, { status: "ready", headshots: localPaths });
        return NextResponse.json({
          status: "ready",
          tier: "fast",
          headshots: updated.headshots,
          photoCount: job.photoCount,
        });
      }

      // Still in progress
      return NextResponse.json({
        status: "generating",
        tier: "fast",
        progress: result.progress,
      });
    } catch (err: any) {
      console.error("[poll-fast] error:", err.message);
      return NextResponse.json({
        status: "generating",
        tier: "fast",
        progress: { error: err.message || "InstantID status check failed" },
      });
    }
  }

  return NextResponse.json({
    status: job.status,
    tier: "fast",
    headshots: job.headshots ?? [],
    photoCount: job.photoCount,
  });
}

function isFastJobStale(job: any, outputDir?: string): boolean {
  const createdAt = typeof job.createdAt === "number" ? job.createdAt : Date.now();
  const ageMs = Date.now() - createdAt;

  // Fast can be slower on local MPS; allow up to 30 minutes total wall time.
  if (ageMs < 30 * 60 * 1000) return false;

  // If we have a status file and it was updated recently, don't time out.
  if (outputDir) {
    const statusPath = path.join(outputDir, "fast_status.json");
    try {
      const stat = fs.statSync(statusPath);
      const idleMs = Date.now() - stat.mtimeMs;
      // If progress updated within the last 10 minutes, keep waiting.
      if (idleMs < 10 * 60 * 1000) return false;
    } catch {
      // no status file; fall through to timeout
    }
  }

  return true;
}

function readFastProgress(outputDir?: string) {
  if (!outputDir) return null;
  const statusPath = path.join(outputDir, "fast_status.json");
  try {
    if (!fs.existsSync(statusPath)) return null;
    const data = JSON.parse(fs.readFileSync(statusPath, "utf8"));
    return {
      status: data.status,
      progress: data.progress,
      completed: data.completed,
      total: data.total,
      current_style: data.current_style,
    };
  } catch {
    return null;
  }
}

// ── LOCAL ML HANDLER ─────────────────────────────────────────────────────────

async function handleLocalML(job: any, jobId: string) {
  const { checkJobStatus, startGeneration } = await import("@/lib/local-ml");

  if (job.status === "training" && job.trainingRequestId) {
    console.log(`[poll-local] checking training ${jobId}, mlJobId: ${job.trainingRequestId}`);
    try {
      const result = await checkJobStatus(job.trainingRequestId);

      if (result.status === "completed") {
        await updateJob(job.id, { status: "generating", loraUrl: result.loraPath || "local" });
        const count = parseInt((await getSetting("images_per_batch")) ?? "2", 10);
        const premiumStyles = ["corporate", "creative", "casual", "startup", "academic", "realtor"];
        const styles = premiumStyles.slice(0, Math.min(count, premiumStyles.length));
        const imagesPerStyle = Math.ceil(count / styles.length);
        const genJobId = await startGeneration(jobId, `batch_${Date.now()}`, styles, imagesPerStyle);
        await updateJob(job.id, { trainingRequestId: genJobId });
        return NextResponse.json({
          status: "generating",
          tier: "premium",
          progress: { phase: "generation_queued" },
        });
      }

      if (result.status === "failed") {
        await updateJob(job.id, { status: "error", error: result.error || "Training failed locally" });
        return NextResponse.json({ status: "error", tier: "premium", error: result.error });
      }

      return NextResponse.json({
        status: "training",
        tier: "premium",
        progress: result.liveProgress || { phase: result.status },
      });
    } catch (err: any) {
      console.error("[poll-local] training check error:", err.message);
      return NextResponse.json({ status: job.status, tier: "premium" });
    }
  }

  if (job.status === "generating" && job.trainingRequestId) {
    try {
      const result = await checkJobStatus(job.trainingRequestId);

      if (result.status === "completed" && result.outputDir) {
        const localPaths = collectLocalImages(result.outputDir, job.id);
        if (localPaths.length > 0) {
          const updated = await updateJob(job.id, { status: "ready", headshots: localPaths });
          return NextResponse.json({
            status: "ready",
            tier: "premium",
            headshots: updated.headshots,
            photoCount: job.photoCount,
          });
        }
      }

      if (result.status === "failed") {
        await updateJob(job.id, { status: "error", error: result.error || "Generation failed" });
        return NextResponse.json({ status: "error", tier: "premium", error: result.error });
      }

      return NextResponse.json({
        status: "generating",
        tier: "premium",
        progress: result.liveProgress || { phase: result.status },
      });
    } catch (err: any) {
      console.error("[poll-local] generation check error:", err.message);
      return NextResponse.json({ status: job.status, tier: "premium" });
    }
  }

  return NextResponse.json({
    status: job.status,
    tier: "premium",
    headshots: job.headshots ?? [],
    photoCount: job.photoCount,
  });
}

function collectLocalImages(outputDir: string, jobId: string): string[] {
  const publicOutputDir = path.join(process.cwd(), "public", "uploads", jobId, "output");
  fs.mkdirSync(publicOutputDir, { recursive: true });

  const localPaths: string[] = [];
  let index = 1;

  if (!fs.existsSync(outputDir)) return [];

  const entries = fs.readdirSync(outputDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const styleDir = path.join(outputDir, entry.name);
      const images = fs.readdirSync(styleDir)
        .filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f))
        .sort();
      for (const img of images) {
        const src = path.join(styleDir, img);
        const ext = (path.extname(img) || ".jpg").toLowerCase();
        const safeExt = [".png", ".jpg", ".jpeg", ".webp"].includes(ext) ? ext : ".jpg";
        const filename = `headshot_${String(index).padStart(2, "0")}${safeExt}`;
        fs.copyFileSync(src, path.join(publicOutputDir, filename));
        localPaths.push(`/uploads/${jobId}/output/${filename}`);
        index++;
      }
    }
  }

  console.log(`[poll-local] collected ${localPaths.length} images from ${outputDir}`);
  return localPaths;
}

// ── FAL.AI PREMIUM HANDLER ───────────────────────────────────────────────────

async function handleFalAI(job: any, jobId: string) {
  const { checkTraining, generateHeadshots } = await import("@/lib/fal");

  if (job.status === "training" && job.trainingRequestId) {
    console.log(`[poll] checking job ${jobId}, requestId: ${job.trainingRequestId}`);
    try {
      const { status, loraUrl } = await checkTraining(job.trainingRequestId);

      if (status === "COMPLETED" && loraUrl) {
        await updateJob(job.id, { status: "generating", loraUrl });
        const imageUrls = await generateHeadshots(loraUrl, job.triggerWord, job.gender);

        const outputDir = path.join(process.cwd(), "public", "uploads", job.id, "output");
        fs.mkdirSync(outputDir, { recursive: true });

        const localPaths: string[] = [];
        await Promise.all(
          imageUrls.map(async (url: string, i: number) => {
            const res = await fetch(url);
            const buffer = Buffer.from(await res.arrayBuffer());
            const filename = `headshot_${String(i + 1).padStart(2, "0")}.jpg`;
            fs.writeFileSync(path.join(outputDir, filename), buffer);
            localPaths[i] = `/uploads/${job.id}/output/${filename}`;
          })
        );

        const updated = await updateJob(job.id, { status: "ready", headshots: localPaths });
        return NextResponse.json({ status: updated.status, tier: "premium", headshots: updated.headshots });
      }

      if (status === "FAILED") {
        await updateJob(job.id, { status: "error", error: "Training failed on fal.ai" });
        return NextResponse.json({ status: "error", tier: "premium" });
      }

      return NextResponse.json({ status: job.status, tier: "premium" });
    } catch (err: any) {
      console.error("[poll] error:", err.message);
      return NextResponse.json({ status: job.status, tier: "premium" });
    }
  }

  if (job.status === "generating" && job.loraUrl && !job.headshots?.length) {
    try {
      const imageUrls = await generateHeadshots(job.loraUrl, job.triggerWord, job.gender);
      const outputDir = path.join(process.cwd(), "public", "uploads", job.id, "output");
      fs.mkdirSync(outputDir, { recursive: true });

      const localPaths: string[] = [];
      await Promise.all(
        imageUrls.map(async (url: string, i: number) => {
          const res = await fetch(url);
          const buffer = Buffer.from(await res.arrayBuffer());
          const filename = `headshot_${String(i + 1).padStart(2, "0")}.jpg`;
          fs.writeFileSync(path.join(outputDir, filename), buffer);
          localPaths[i] = `/uploads/${job.id}/output/${filename}`;
        })
      );

      const updated = await updateJob(job.id, { status: "ready", headshots: localPaths });
      return NextResponse.json({
        status: updated.status,
        tier: "premium",
        headshots: updated.headshots,
        photoCount: job.photoCount,
      });
    } catch (err: any) {
      console.error("[poll] generation retry failed:", err.message);
    }
  }

  return NextResponse.json({
    status: job.status,
    tier: "premium",
    headshots: job.headshots ?? [],
    photoCount: job.photoCount,
  });
}
