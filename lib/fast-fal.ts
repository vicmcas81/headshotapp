// lib/fast-fal.ts — Fast tier: InstantID via fal.ai (no LoRA training)
// Takes a face photo + prompts → generates headshots in ~1-2 min

import { fal } from "@fal-ai/client";

const FAST_MODEL = "fal-ai/instantid";

export const FAST_STYLES = [
  {
    label: "Corporate",
    prompt: "professional corporate headshot, {GENDER}, tailored dark charcoal suit, white dress shirt, neutral grey studio backdrop, even studio lighting, sharp focus, photorealistic, 8k",
  },
  {
    label: "LinkedIn",
    prompt: "LinkedIn profile photo, {GENDER}, business casual attire, clean white studio background, bright even lighting, genuine warm smile, photorealistic, 8k",
  },
  {
    label: "Creative",
    prompt: "modern creative professional headshot, {GENDER}, stylish outfit, soft urban bokeh background, natural window light, relaxed expression, editorial style, photorealistic, 8k",
  },
];

export const FAST_IMAGES_PER_STYLE = 1;

// ── Submit style jobs to the fal.ai queue ────────────────────────────────────
export async function submitFastJobs(
  faceImageUrl: string,
  gender: "man" | "woman",
  imagesPerBatch: number = 2,
): Promise<string[]> {
  fal.config({ credentials: process.env.FAL_KEY! });
  const genderWord = gender === "woman" ? "woman" : "man";
  const requestIds: string[] = [];

  // Use first N styles to hit the total count
  const stylesToRun = FAST_STYLES.slice(0, Math.min(imagesPerBatch, FAST_STYLES.length));

  for (const style of stylesToRun) {
    const prompt = style.prompt.replace(/{GENDER}/g, genderWord);
    console.log(`[fast-fal] submitting style: ${style.label}`);

    const { request_id } = await fal.queue.submit(FAST_MODEL, {
      input: {
        face_image_url: faceImageUrl,
        prompt,
        negative_prompt: "deformed, ugly, bad anatomy, blurry, low quality, out of frame",
        num_inference_steps: 30,
        guidance_scale: 5.0,
        num_images: FAST_IMAGES_PER_STYLE,
        image_size: "portrait_4_3",
        enable_safety_checker: true,
      } as any,
    });

    requestIds.push(request_id);
    console.log(`[fast-fal] submitted ${style.label}, requestId: ${request_id}`);
  }

  return requestIds;
}

// ── Poll all queued jobs — returns done=true only when every style is ready ───
export async function checkFastJobs(requestIds: string[]): Promise<{
  done: boolean;
  imageUrls?: string[];
  failed?: boolean;
  failedReason?: string;
  progress?: Array<{ requestId: string; status?: string; error?: string }>;
}> {
  fal.config({ credentials: process.env.FAL_KEY! });
  const imageUrls: string[] = [];
  const progress: Array<{ requestId: string; status?: string; error?: string }> = [];

  for (const requestId of requestIds) {
    const statusRes = await fetch(
      `https://queue.fal.run/${FAST_MODEL}/requests/${requestId}/status`,
      { headers: { Authorization: `Key ${process.env.FAL_KEY}` } }
    );

    if (!statusRes.ok) {
      const text = await statusRes.text().catch(() => "");
      const reason = `InstantID status check failed (${statusRes.status})${text ? `: ${text.slice(0, 200)}` : ""}`;
      console.error(`[fast-fal] ${reason}`);
      progress.push({ requestId, status: "ERROR", error: reason });
      return { done: false, failed: true, failedReason: reason, progress };
    }

    const statusData = await statusRes.json();
    console.log(`[fast-fal] ${requestId} status: ${statusData.status}`);
    progress.push({ requestId, status: statusData.status, error: statusData.error });

    if (statusData.status === "FAILED") {
      return { done: false, failed: true, failedReason: statusData.error ?? "InstantID job failed", progress };
    }

    if (statusData.status !== "COMPLETED") {
      return { done: false, progress }; // still waiting on at least one
    }

    // Fetch result for this completed request
    const resultRes = await fetch(
      `https://queue.fal.run/${FAST_MODEL}/requests/${requestId}`,
      { headers: { Authorization: `Key ${process.env.FAL_KEY}` } }
    );

    if (!resultRes.ok) {
      const text = await resultRes.text().catch(() => "");
      const reason = `InstantID result fetch failed (${resultRes.status})${text ? `: ${text.slice(0, 200)}` : ""}`;
      console.error(`[fast-fal] ${reason}`);
      return { done: false, failed: true, failedReason: reason, progress };
    }

    const result = await resultRes.json();
    const images: Array<{ url: string }> = result.images ?? result.output?.images ?? [];
    for (const img of images) {
      imageUrls.push(img.url);
    }
  }

  console.log(`[fast-fal] all ${requestIds.length} jobs done, ${imageUrls.length} images`);
  return { done: true, imageUrls, progress };
}
