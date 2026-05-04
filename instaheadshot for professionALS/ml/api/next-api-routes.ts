/**
 * InstaHeadshot — Next.js API Routes for Local ML Training
 *
 * Drop-in replacement for fal.ai API calls. These routes talk to the
 * local Python job queue running on your M4 Mac.
 *
 * Copy these into your Next.js app's `app/api/` directory:
 *   app/api/train/route.ts
 *   app/api/generate/route.ts
 *   app/api/job/[jobId]/route.ts
 *   app/api/user/[userId]/model/route.ts
 *
 * The Python API server runs on http://127.0.0.1:8420
 */

// ============================================================
// Config — point to the local Python API server
// ============================================================

const ML_API_BASE = process.env.ML_API_URL || "http://127.0.0.1:8420";

// ============================================================
// app/api/train/route.ts
// ============================================================

// POST /api/train
// Body: { userId: string, photosDir: string, steps?: number }
// Returns: { jobId: string, status: "queued" }
export async function POST_train(request: Request) {
  try {
    const body = await request.json();
    const { userId, photosDir, steps = 1000, loraRank = 16 } = body;

    if (!userId || !photosDir) {
      return Response.json(
        { error: "userId and photosDir are required" },
        { status: 400 }
      );
    }

    const res = await fetch(`${ML_API_BASE}/api/train`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: userId,
        photos_dir: photosDir,
        steps,
        lora_rank: loraRank,
        instance_prompt: "a photo of sks person",
      }),
    });

    const data = await res.json();
    return Response.json(data, { status: res.status });
  } catch (error) {
    console.error("Train API error:", error);
    return Response.json(
      { error: "Failed to submit training job" },
      { status: 500 }
    );
  }
}

// ============================================================
// app/api/generate/route.ts
// ============================================================

// POST /api/generate
// Body: { userId: string, styles?: string[], imagesPerStyle?: number }
// Returns: { jobId: string, batchId: string, status: "queued" }
export async function POST_generate(request: Request) {
  try {
    const body = await request.json();
    const {
      userId,
      batchId,
      styles = ["corporate", "creative", "casual"],
      imagesPerStyle = 3,
      guidanceScale = 7.5,
      inferenceSteps = 30,
    } = body;

    if (!userId) {
      return Response.json({ error: "userId is required" }, { status: 400 });
    }

    const res = await fetch(`${ML_API_BASE}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: userId,
        batch_id: batchId,
        styles,
        images_per_style: imagesPerStyle,
        guidance_scale: guidanceScale,
        inference_steps: inferenceSteps,
      }),
    });

    const data = await res.json();
    return Response.json(data, { status: res.status });
  } catch (error) {
    console.error("Generate API error:", error);
    return Response.json(
      { error: "Failed to submit generation job" },
      { status: 500 }
    );
  }
}

// ============================================================
// app/api/job/[jobId]/route.ts
// ============================================================

// GET /api/job/:jobId
// Returns full job status including live progress during training
export async function GET_job(jobId: string) {
  try {
    const res = await fetch(`${ML_API_BASE}/api/job/${jobId}`);
    const data = await res.json();
    return Response.json(data, { status: res.status });
  } catch (error) {
    console.error("Job status error:", error);
    return Response.json(
      { error: "Failed to get job status" },
      { status: 500 }
    );
  }
}

// ============================================================
// app/api/user/[userId]/model/route.ts
// ============================================================

// GET /api/user/:userId/model
// Returns: { hasModel: boolean, loraPath?: string, trainedAt?: string }
export async function GET_user_model(userId: string) {
  try {
    const res = await fetch(`${ML_API_BASE}/api/user/${userId}/model`);
    const data = await res.json();
    return Response.json(data, { status: res.status });
  } catch (error) {
    console.error("User model check error:", error);
    return Response.json(
      { error: "Failed to check user model" },
      { status: 500 }
    );
  }
}

// ============================================================
// Example: Replacing fal.ai in your existing code
// ============================================================

/**
 * BEFORE (fal.ai):
 *
 *   const result = await fal.subscribe("fal-ai/flux-lora-fast-training", {
 *     input: {
 *       images_data_url: dataUrl,
 *       trigger_word: "sks",
 *       steps: 1000,
 *     },
 *   });
 *   const loraUrl = result.diffusers_lora_file.url;
 *
 * AFTER (local M4):
 *
 *   // 1. Save uploaded photos to disk
 *   const photosDir = `/path/to/ml/data/uploads/${userId}`;
 *   await saveUploadedPhotos(files, photosDir);
 *
 *   // 2. Submit training job
 *   const res = await fetch('/api/train', {
 *     method: 'POST',
 *     body: JSON.stringify({ userId, photosDir }),
 *   });
 *   const { jobId } = await res.json();
 *
 *   // 3. Poll for completion
 *   let status = 'queued';
 *   while (status !== 'completed' && status !== 'failed') {
 *     await new Promise(r => setTimeout(r, 5000));
 *     const statusRes = await fetch(`/api/job/${jobId}`);
 *     const job = await statusRes.json();
 *     status = job.status;
 *     // Update UI with job.live_progress if available
 *   }
 *
 *   // 4. Generate headshots
 *   const genRes = await fetch('/api/generate', {
 *     method: 'POST',
 *     body: JSON.stringify({
 *       userId,
 *       styles: ['corporate', 'creative', 'casual'],
 *     }),
 *   });
 *   const { jobId: genJobId, batchId } = await genRes.json();
 */

// ============================================================
// Utility: Save uploaded photos to disk for training
// ============================================================

import { writeFile, mkdir } from "fs/promises";
import { join } from "path";

const ML_DATA_DIR = process.env.ML_DATA_DIR || join(process.cwd(), "ml", "data");

export async function saveUploadedPhotos(
  files: File[],
  userId: string
): Promise<string> {
  const uploadDir = join(ML_DATA_DIR, "uploads", userId);
  await mkdir(uploadDir, { recursive: true });

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const buffer = Buffer.from(await file.arrayBuffer());
    const ext = file.name.split(".").pop() || "jpg";
    const filename = `photo_${i + 1}.${ext}`;
    await writeFile(join(uploadDir, filename), buffer);
  }

  return uploadDir;
}

// ============================================================
// Ready-to-copy Next.js route files
// ============================================================

/*
FILE: app/api/train/route.ts
---
import { NextRequest } from "next/server";

const ML_API = process.env.ML_API_URL || "http://127.0.0.1:8420";

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { userId, photosDir, steps = 1000 } = body;

  if (!userId || !photosDir) {
    return Response.json({ error: "userId and photosDir required" }, { status: 400 });
  }

  const res = await fetch(`${ML_API}/api/train`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      user_id: userId,
      photos_dir: photosDir,
      steps,
      instance_prompt: "a photo of sks person",
    }),
  });

  return Response.json(await res.json(), { status: res.status });
}

---

FILE: app/api/generate/route.ts
---
import { NextRequest } from "next/server";

const ML_API = process.env.ML_API_URL || "http://127.0.0.1:8420";

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { userId, styles = ["corporate", "creative", "casual"], imagesPerStyle = 3 } = body;

  if (!userId) {
    return Response.json({ error: "userId required" }, { status: 400 });
  }

  const res = await fetch(`${ML_API}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      user_id: userId,
      styles,
      images_per_style: imagesPerStyle,
    }),
  });

  return Response.json(await res.json(), { status: res.status });
}

---

FILE: app/api/job/[jobId]/route.ts
---
import { NextRequest } from "next/server";

const ML_API = process.env.ML_API_URL || "http://127.0.0.1:8420";

export async function GET(
  req: NextRequest,
  { params }: { params: { jobId: string } }
) {
  const res = await fetch(`${ML_API}/api/job/${params.jobId}`);
  return Response.json(await res.json(), { status: res.status });
}

---

FILE: app/api/user/[userId]/model/route.ts
---
import { NextRequest } from "next/server";

const ML_API = process.env.ML_API_URL || "http://127.0.0.1:8420";

export async function GET(
  req: NextRequest,
  { params }: { params: { userId: string } }
) {
  const res = await fetch(`${ML_API}/api/user/${params.userId}/model`);
  return Response.json(await res.json(), { status: res.status });
}
*/
