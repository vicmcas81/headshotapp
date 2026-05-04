// lib/fal.ts
import { fal } from "@fal-ai/client";

export const STYLES = [
  {
    label: "Corporate",
    prompt: "photo of {TRIGGER} {GENDER}, professional corporate headshot, tailored dark charcoal suit, white dress shirt, neutral grey studio backdrop, even studio lighting, sharp focus, photorealistic, 8k",
  },
  {
    label: "Business Casual",
    prompt: "photo of {TRIGGER} {GENDER}, professional headshot, smart casual navy blazer, light shirt, warm blurred office background, approachable smile, rembrandt lighting, photorealistic, 8k",
  },
  {
    label: "LinkedIn",
    prompt: "photo of {TRIGGER} {GENDER}, LinkedIn profile photo, business casual attire, clean white studio background, bright even lighting, genuine warm smile, photorealistic, 8k",
  },
  {
    label: "Creative",
    prompt: "photo of {TRIGGER} {GENDER}, modern creative professional headshot, stylish outfit, soft urban bokeh background, natural window light, relaxed expression, editorial style, photorealistic, 8k",
  },
  {
    label: "Executive",
    prompt: "photo of {TRIGGER} {GENDER}, executive portrait, premium dark suit, dramatic studio lighting with rim light, dark gradient background, confident expression, cinematic, photorealistic, 8k",
  },
];

export const IMAGES_PER_STYLE = 1; // 1 for local testing — bump to 3+ for production

// ── Step 1: Start training ─────────────────────────────────────────────────
export async function startTraining(
  photosZipUrl: string,
  triggerWord: string
): Promise<string> {
  if (!photosZipUrl || !photosZipUrl.startsWith("http")) {
    throw new Error(`Invalid zip URL: "${photosZipUrl}" — fal.storage.upload likely failed`);
  }
  console.log("[fal] starting training with zip:", photosZipUrl);

  const { request_id } = await fal.queue.submit(
    "fal-ai/flux-lora-portrait-trainer",
    {
      input: {
        images_data_url: photosZipUrl,
        trigger_word: triggerWord,
        steps: 2500,
        learning_rate: 0.0002,
        rank: 32,
      } as any,
    }
  );
  return request_id;
}

// ── Step 2: Poll training status via REST ──────────────────────────────────
export type TrainingStatus = "IN_QUEUE" | "IN_PROGRESS" | "COMPLETED" | "FAILED";

const FAL_MODEL = "fal-ai/flux-lora-portrait-trainer";

export async function checkTraining(requestId: string): Promise<{
  status: TrainingStatus;
  loraUrl?: string;
}> {
  console.log(`[fal] checking status for requestId: ${requestId}`);

  const statusRes = await fetch(
    `https://queue.fal.run/${FAL_MODEL}/requests/${requestId}/status`,
    {
      headers: {
        Authorization: `Key ${process.env.FAL_KEY}`,
        "Content-Type": "application/json",
      },
    }
  );

  if (!statusRes.ok) {
    const body = await statusRes.text();
    console.error(`[fal] status check failed ${statusRes.status}:`, body);
    return { status: "IN_PROGRESS" };
  }

  const statusData = await statusRes.json();
  console.log(`[fal] status: ${statusData.status}`);

  if (statusData.status === "COMPLETED") {
    const resultRes = await fetch(
      `https://queue.fal.run/${FAL_MODEL}/requests/${requestId}`,
      {
        headers: {
          Authorization: `Key ${process.env.FAL_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (!resultRes.ok) {
      console.error(`[fal] result fetch failed ${resultRes.status}`);
      return { status: "COMPLETED" };
    }

    const result = await resultRes.json();
    const loraUrl =
      result.diffusers_lora_file?.url ??
      result.output?.diffusers_lora_file?.url;

    console.log(`[fal] lora URL: ${loraUrl}`);
    return { status: "COMPLETED", loraUrl };
  }

  return { status: statusData.status as TrainingStatus };
}

// ── Step 3: Generate headshots ─────────────────────────────────────────────
export async function generateHeadshots(
  loraUrl: string,
  triggerWord: string,
  gender: "man" | "woman" = "man"
): Promise<string[]> {
  fal.config({ credentials: process.env.FAL_KEY! });
  const urls: string[] = [];

  for (const style of STYLES) {
    const prompt = style.prompt
      .replace(/{TRIGGER}/g, triggerWord)
      .replace(/{GENDER}/g, gender);
    console.log(`[fal] generating style: ${style.label}`);

    const result = await fal.run("fal-ai/flux-lora", {
      input: {
        prompt,
        loras: [{ path: loraUrl, scale: 1.0 }],
        num_images: IMAGES_PER_STYLE,
        image_size: "portrait_4_3",
        num_inference_steps: 40,
        guidance_scale: 3.5,
        enable_safety_checker: true,
      },
    });

    // fal client v1.x wraps output in { data, requestId }
    const images: Array<{ url: string }> = (result as any).data?.images ?? [];
    for (const img of images) {
      urls.push(img.url);
      console.log(`[fal] generated image: ${img.url}`);
    }
  }

  console.log(`[fal] total images generated: ${urls.length}`);
  return urls;
}
