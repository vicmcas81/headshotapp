// lib/local-ml.ts — Local ML server client (replaces fal.ai)
// Talks to the Python job queue API on http://127.0.0.1:8420

const ML_API = process.env.LOCAL_ML_URL || "http://127.0.0.1:8420";

export const STYLES = ["corporate", "creative", "casual", "startup", "academic", "realtor"];
export const IMAGES_PER_STYLE = 1; // 1 for local testing — bump to 3+ for production

// ── Submit a training job ─────────────────────────────────────────────────
export async function startTraining(
  photosDir: string,
  triggerWord: string,
  userId: string
): Promise<string> {
  console.log(`[local-ml] submitting training job for ${userId}, photos: ${photosDir}`);

  let res: Response;
  try {
    res = await fetch(`${ML_API}/api/train`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: userId,
        photos_dir: photosDir,
        instance_prompt: `a photo of ${triggerWord} person`,
        steps: 1000,
        resolution: 512,
        lora_rank: 16,
        learning_rate: 1e-4,
      }),
      cache: "no-store" as any,
    });
  } catch (e: any) {
    throw new Error(`Local ML server unreachable at ${ML_API} (train): ${e?.message || String(e)}`);
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(`Local ML training failed: ${err.error || res.statusText}`);
  }

  const data = await res.json();
  console.log(`[local-ml] training job submitted: ${data.job_id}`);
  return data.job_id;
}

// ── Check training/generation job status ──────────────────────────────────
export type LocalJobStatus = "queued" | "running" | "completed" | "failed";

export interface LocalJobResult {
  status: LocalJobStatus;
  loraPath?: string;
  outputDir?: string;
  error?: string;
  liveProgress?: {
    status: string;
    progress: number;
    step?: number;
    total_steps?: number;
    completed_images?: number;
    total_images?: number;
  };
}

export async function checkJobStatus(jobId: string): Promise<LocalJobResult> {
  const url = `${ML_API}/api/job/${jobId}`;
  // In Next.js route handlers, `fetch` may apply caching semantics; force no-store.
  let res: Response;
  try {
    res = await fetch(url, { cache: "no-store" as any });
  } catch (e: any) {
    return { status: "queued", error: `Local ML server unreachable at ${ML_API} (job): ${e?.message || String(e)}` };
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`[local-ml] status check failed (${res.status}) for ${url}${body ? `: ${body.slice(0, 200)}` : ""}`);
    if (res.status === 404) return { status: "queued" };
    return { status: "queued" };
  }

  const data = await res.json();

  const result: LocalJobResult = {
    status: data.status as LocalJobStatus,
  };

  // Some job types (e.g. fast_generate) know their output directory upfront.
  if (data.payload && typeof data.payload.output_dir === "string") {
    result.outputDir = data.payload.output_dir;
  }

  if (data.result) {
    const parsed = typeof data.result === "string" ? JSON.parse(data.result) : data.result;
    result.loraPath = parsed.lora_path;
    result.outputDir = parsed.output_dir;
  }

  if (data.error) {
    result.error = data.error;
  }

  if (data.live_progress) {
    result.liveProgress = data.live_progress;
  }

  return result;
}

// ── Submit a generation job ───────────────────────────────────────────────
export async function startGeneration(
  userId: string,
  batchId: string,
  styles: string[] = ["corporate", "creative", "casual"],
  imagesPerStyle: number = IMAGES_PER_STYLE,
): Promise<string> {
  console.log(`[local-ml] submitting generation job for ${userId}, batch: ${batchId}`);

  let res: Response;
  try {
    res = await fetch(`${ML_API}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: userId,
        batch_id: batchId,
        styles,
        images_per_style: imagesPerStyle,
        guidance_scale: 7.5,
        inference_steps: 30,
        resolution: 512,
      }),
      cache: "no-store" as any,
    });
  } catch (e: any) {
    throw new Error(`Local ML server unreachable at ${ML_API} (generate): ${e?.message || String(e)}`);
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(`Local ML generation failed: ${err.error || res.statusText}`);
  }

  const data = await res.json();
  console.log(`[local-ml] generation job submitted: ${data.job_id}`);
  return data.job_id;
}

// ── Check if user has a trained model ─────────────────────────────────────
export async function hasTrainedModel(userId: string): Promise<boolean> {
  try {
    const res = await fetch(`${ML_API}/api/user/${userId}/model`);
    if (!res.ok) return false;
    const data = await res.json();
    return data.has_model === true;
  } catch {
    return false;
  }
}

// ── Health check ──────────────────────────────────────────────────────────
export async function checkHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${ML_API}/api/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}
