// lib/runpod.ts — Minimal RunPod Serverless client

type RunPodRunResponse = { id: string };
type RunPodStatusResponse = {
  status: "IN_QUEUE" | "IN_PROGRESS" | "COMPLETED" | "FAILED" | "CANCELLED" | string;
  output?: any;
  error?: any;
};

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") throw new Error(`${name} is required`);
  return v;
}

export function getRunPodConfig() {
  const apiKey = requiredEnv("RUNPOD_API_KEY");
  return {
    apiKey,
    fastEndpointId: process.env.RUNPOD_FAST_ENDPOINT_ID || "",
    premiumEndpointId: process.env.RUNPOD_PREMIUM_ENDPOINT_ID || "",
  };
}

export async function runpodRun(endpointId: string, input: any): Promise<string> {
  const { apiKey } = getRunPodConfig();
  if (!endpointId) throw new Error("RunPod endpointId is required");

  const res = await fetch(`https://api.runpod.ai/v2/${endpointId}/run`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ input }),
    cache: "no-store" as any,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`RunPod /run failed (${res.status}): ${text.slice(0, 300)}`);
  }

  const data = (await res.json()) as RunPodRunResponse;
  if (!data?.id) throw new Error("RunPod /run: missing id");
  return data.id;
}

export async function runpodStatus(endpointId: string, requestId: string): Promise<RunPodStatusResponse> {
  const { apiKey } = getRunPodConfig();
  if (!endpointId) throw new Error("RunPod endpointId is required");
  if (!requestId) throw new Error("RunPod requestId is required");

  const res = await fetch(`https://api.runpod.ai/v2/${endpointId}/status/${requestId}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    cache: "no-store" as any,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`RunPod /status failed (${res.status}): ${text.slice(0, 300)}`);
  }

  return (await res.json()) as RunPodStatusResponse;
}

export function fileToBase64DataUri(buffer: Buffer, mime: string) {
  const base64 = buffer.toString("base64");
  return `data:${mime};base64,${base64}`;
}

export function bufferToBase64(buffer: Buffer) {
  return buffer.toString("base64");
}

export function parseComfyImagesFromRunPodOutput(output: any): Array<{ base64?: string; mime?: string }> {
  // worker-comfyui returns `output.images: [{ type: "base64"|"s3_url", data, filename }]`
  // but we stay defensive across versions.
  const images: any[] = output?.images ?? output?.output?.images ?? output?.result?.images ?? [];

  if (!Array.isArray(images)) return [];

  return images.map((img: any) => {
    const data = img?.data ?? img?.image ?? img?.base64 ?? null;
    if (typeof data !== "string") return {};
    // If it already includes a data: prefix, keep it; otherwise treat it as raw base64 payload.
    const mime = img?.mime_type ?? img?.mime ?? undefined;
    return { base64: data, mime };
  });
}
