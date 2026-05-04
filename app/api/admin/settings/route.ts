import { NextRequest, NextResponse } from "next/server";
import { getSetting, setSetting } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Defaults applied when a key hasn't been saved yet
const DEFAULTS: Record<string, string> = {
  images_per_batch: "2",
};

export async function GET() {
  const out: Record<string, string> = {};
  for (const key of Object.keys(DEFAULTS)) {
    out[key] = (await getSetting(key)) ?? DEFAULTS[key];
  }
  return NextResponse.json(out);
}

export async function POST(req: NextRequest) {
  const { key, value } = await req.json();
  if (!key || value === undefined || value === null) {
    return NextResponse.json({ error: "key and value required" }, { status: 400 });
  }
  await setSetting(String(key), String(value));
  return NextResponse.json({ ok: true, key, value });
}
