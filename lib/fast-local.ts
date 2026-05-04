// lib/fast-local.ts — Fast tier via local IP-Adapter ML server
// Switch to fal.ai by setting FAST_TIER_BACKEND=fal in .env.local

const ML_API = process.env.LOCAL_ML_URL || "http://127.0.0.1:8420";

const ALL_FAST_STYLES = ["corporate", "linkedin", "creative", "executive", "casual"];

export async function startLocalFastGeneration(
  userId: string,
  batchId: string,
  faceImagePath: string,
  gender: "man" | "woman",
  imagesPerBatch: number = 2,
): Promise<string> {
  // Distribute count across styles: take first N styles × 1 image each.
  // If count > available styles, last style gets the remainder.
  const styleCount = Math.min(imagesPerBatch, ALL_FAST_STYLES.length);
  const styles = ALL_FAST_STYLES.slice(0, styleCount);
  const imagesPerStyle = Math.ceil(imagesPerBatch / styleCount);

  console.log(`[fast-local] submitting fast_generate: ${imagesPerBatch} images, styles: ${styles.join(", ")}`);

  let res: Response;
  try {
    res = await fetch(`${ML_API}/api/fast-generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: userId,
        batch_id: batchId,
        face_image_path: faceImagePath,
        styles,
        images_per_style: imagesPerStyle,
        gender,
      }),
      cache: "no-store" as any,
    });
  } catch (e: any) {
    throw new Error(`Local ML server unreachable at ${ML_API} (fast-generate): ${e?.message || String(e)}`);
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(`Local fast generation failed: ${err.error || res.statusText}`);
  }

  const data = await res.json();
  console.log(`[fast-local] job submitted: ${data.job_id}`);
  return data.job_id;
}
