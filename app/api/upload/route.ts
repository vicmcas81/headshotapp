// app/api/upload/route.ts

import { NextRequest, NextResponse } from "next/server";
import { v4 as uuid } from "uuid";
import fs from "fs";
import path from "path";
import { createJob, updateJob, getSetting } from "@/lib/db";
import { startTraining as localStartTraining } from "@/lib/local-ml";
import { bufferToBase64, getRunPodConfig, runpodRun } from "@/lib/runpod";

export const runtime = "nodejs";
export const maxDuration = 60;

const USE_LOCAL_ML = process.env.USE_LOCAL_ML === "true";

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const files = formData.getAll("photos") as File[];
    const gender = (formData.get("gender") as string) === "woman" ? "woman" : "man";
    const tier = (formData.get("tier") as string) === "fast" ? "fast" : "premium";

    // Validate photo count per tier
    const minPhotos = tier === "fast" ? 1 : 4;
    if (files.length < minPhotos) {
      return NextResponse.json(
        { error: tier === "fast" ? "Upload at least 1 photo" : "Upload at least 4 photos" },
        { status: 400 }
      );
    }
    if (files.length > 10) {
      return NextResponse.json({ error: "Maximum 10 photos" }, { status: 400 });
    }

    const jobId = uuid();
    const triggerWord = `PERSON${jobId.replace(/-/g, "").slice(0, 8).toUpperCase()}`;
    await createJob(jobId, triggerWord, files.length, gender, tier);

    // Save photos locally
    const uploadDir = path.join(process.cwd(), "public", "uploads", jobId);
    fs.mkdirSync(uploadDir, { recursive: true });

    const photoBuffers: Buffer[] = [];
    for (let i = 0; i < files.length; i++) {
      const buffer = Buffer.from(await files[i].arrayBuffer());
      fs.writeFileSync(path.join(uploadDir, `photo_${i + 1}.jpg`), buffer);
      photoBuffers.push(buffer);
    }

    // ── FAST TIER ─────────────────────────────────────────────────────────────
    // FAST_TIER_BACKEND=local  → IP-Adapter on M5 via local ML server (default)
    // FAST_TIER_BACKEND=fal    → InstantID via fal.ai (requires FAL_KEY with credits)
    // FAST_TIER_BACKEND=runpod → ComfyUI Serverless endpoint (RunPod)
    if (tier === "fast") {
      const fastBackend = process.env.FAST_TIER_BACKEND || "local";
      const imagesPerBatch = parseInt((await getSetting("images_per_batch")) ?? "2", 10);

      if (fastBackend === "runpod") {
        const { fastEndpointId } = getRunPodConfig();
        if (!fastEndpointId) {
          return NextResponse.json({ error: "RUNPOD_FAST_ENDPOINT_ID is required when FAST_TIER_BACKEND=runpod." }, { status: 500 });
        }

        const faceBase64 = bufferToBase64(photoBuffers[0]);
        // RunPod "headshot-worker" contract (runpod/headshot-worker):
        // Sends the face photo as base64; the worker runs SD1.5 + IP-Adapter and returns generated images as base64 PNGs.
        const count = Math.max(1, Math.min(6, imagesPerBatch));
        const fastStyles = ["corporate", "linkedin", "executive"];
        const styles = fastStyles.slice(0, Math.min(count, fastStyles.length));
        const requestId = await runpodRun(fastEndpointId, {
          tier: "fast",
          face_image_base64: faceBase64,
          gender,
          styles,
          num_images: count,
        });

        await updateJob(jobId, { status: "generating", trainingRequestId: requestId });
        return NextResponse.json({ jobId });
      }

      if (fastBackend === "fal") {
        const falKey = process.env.FAL_KEY;
        if (!falKey || falKey === "your_fal_api_key_here" || falKey.trim() === "") {
          return NextResponse.json(
            { error: "FAL_KEY is required when FAST_TIER_BACKEND=fal." },
            { status: 500 }
          );
        }
        const base64 = photoBuffers[0].toString("base64");
        const faceImageUrl = `data:image/jpeg;base64,${base64}`;
        console.log(`[upload/fast/fal] submitting ${imagesPerBatch} images to InstantID`);

        const { submitFastJobs } = await import("@/lib/fast-fal");
        const requestIds = await submitFastJobs(faceImageUrl, gender, imagesPerBatch);
        await updateJob(jobId, { status: "generating", trainingRequestId: JSON.stringify(requestIds) });
      } else {
        // Local IP-Adapter path — face photo is already saved at uploadDir/photo_1.jpg
        const faceImagePath = path.join(uploadDir, "photo_1.jpg");
        console.log(`[upload/fast/local] submitting ${imagesPerBatch} images via IP-Adapter, face:`, faceImagePath);

        const { startLocalFastGeneration } = await import("@/lib/fast-local");
        const fastJobId = await startLocalFastGeneration(
          jobId,
          `fast_${Date.now()}`,
          faceImagePath,
          gender,
          imagesPerBatch,
        );
        await updateJob(jobId, { status: "generating", trainingRequestId: fastJobId });
      }

      return NextResponse.json({ jobId });
    }

    // ── PREMIUM TIER: LoRA training ──────────────────────────────────────────
    const premiumBackend = process.env.PREMIUM_TIER_BACKEND || (USE_LOCAL_ML ? "local" : "fal");

    if (premiumBackend === "runpod") {
      // Premium batching: queue premium jobs during the day; run them overnight to reduce cost.
      const batchMode = (process.env.PREMIUM_BATCH_MODE ?? "true") === "true";
      if (batchMode) {
        await updateJob(jobId, { status: "queued_for_batch" as any });
        return NextResponse.json({ jobId });
      }

      const { premiumEndpointId } = getRunPodConfig();
      if (!premiumEndpointId) {
        return NextResponse.json({ error: "RUNPOD_PREMIUM_ENDPOINT_ID is required when PREMIUM_TIER_BACKEND=runpod." }, { status: 500 });
      }

      await updateJob(jobId, { status: "training" });
      const faceBase64 = bufferToBase64(photoBuffers[0]);
      const requestId = await runpodRun(premiumEndpointId, {
        tier: "premium",
        face_image_base64: faceBase64,
        gender,
        styles: ["corporate", "linkedin", "executive"],
        num_images: 3,
        ip_adapter_scale: 1.1,
      });

      await updateJob(jobId, { trainingRequestId: requestId, status: "generating" as any });
      return NextResponse.json({ jobId });
    }

    if (USE_LOCAL_ML && premiumBackend === "local") {
      const mlUploadsDir = path.join(
        process.cwd(),
        "instaheadshot for professionALS",
        "ml",
        "data",
        "uploads",
        jobId
      );
      fs.mkdirSync(mlUploadsDir, { recursive: true });

      for (let i = 0; i < photoBuffers.length; i++) {
        fs.writeFileSync(path.join(mlUploadsDir, `photo_${i + 1}.jpg`), photoBuffers[i]);
      }

      await updateJob(jobId, { status: "training" });
      const trainingJobId = await localStartTraining(mlUploadsDir, triggerWord, jobId);
      console.log("[upload/premium] local training submitted, mlJobId:", trainingJobId);
      await updateJob(jobId, { trainingRequestId: trainingJobId });

      return NextResponse.json({ jobId });
    } else {
      // fal.ai cloud training
      const falKey = process.env.FAL_KEY;
      if (!falKey || falKey === "your_fal_api_key_here" || falKey.trim() === "") {
        return NextResponse.json(
          { error: "FAL_KEY is missing. Set USE_LOCAL_ML=true in .env.local for local training, or add your fal.ai key." },
          { status: 500 }
        );
      }

      const { fal } = await import("@fal-ai/client");
      const { startTraining } = await import("@/lib/fal");
      fal.config({ credentials: falKey });

      const JSZip = (await import("jszip")).default;
      const zip = new JSZip();
      photoBuffers.forEach((buf, i) => zip.file(`photo_${i + 1}.jpg`, buf));
      const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });
      const zipFile = new File([zipBuffer as unknown as BlobPart], "photos.zip", { type: "application/zip" });

      let zipUrl: string;
      try {
        const uploadResult = await fal.storage.upload(zipFile);
        if (typeof uploadResult === "string") {
          zipUrl = uploadResult;
        } else if (uploadResult && typeof (uploadResult as any).url === "string") {
          zipUrl = (uploadResult as any).url;
        } else {
          throw new Error(`Unexpected shape from fal.storage.upload: ${JSON.stringify(uploadResult)}`);
        }
        console.log("[upload/premium] zip uploaded to fal.ai:", zipUrl);
      } catch (storageErr: any) {
        const msg = storageErr?.message || String(storageErr);
        const isAuth = msg.includes("403") || msg.includes("401") || msg.includes("Unauthorized") || msg.includes("Forbidden");
        return NextResponse.json(
          { error: isAuth ? "fal.ai rejected your API key." : `fal.ai storage upload failed: ${msg}` },
          { status: 500 }
        );
      }

      await updateJob(jobId, { status: "training" });
      const trainingRequestId = await startTraining(zipUrl, triggerWord);
      console.log("[upload/premium] fal.ai training started, requestId:", trainingRequestId);
      await updateJob(jobId, { trainingRequestId });

      return NextResponse.json({ jobId });
    }
  } catch (err: any) {
    console.error("[upload] error:", err.message, err.body ?? "");
    return NextResponse.json({ error: err.message || "Upload failed" }, { status: 500 });
  }
}
