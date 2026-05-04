"use client";
// app/gallery/[jobId]/page.tsx

import { useState, useEffect, useRef } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";

type Status = "uploading" | "queued_for_batch" | "training" | "generating" | "ready" | "error";
type Tier = "fast" | "premium";

const USE_LOCAL = process.env.NEXT_PUBLIC_USE_LOCAL_ML === "true";

const PREMIUM_STEPS: { status: Status; label: string; detail: string }[] = [
  { status: "uploading",  label: "Uploading",  detail: "Saving your photos" },
  { status: "queued_for_batch", label: "Queued", detail: "Queued for overnight batch (starts ~11:00 PM PT)" },
  { status: "training",   label: "Training",   detail: USE_LOCAL ? "LoRA training on M5 (~10–20 min)" : "AI learning your face on fal.ai (~20–30 min)" },
  { status: "generating", label: "Generating", detail: "Creating headshots from your trained model" },
  { status: "ready",      label: "Ready",      detail: "Your headshots are here!" },
];

const FAST_STEPS: { status: Status; label: string; detail: string }[] = [
  { status: "uploading",  label: "Uploading",  detail: "Saving your photo" },
  { status: "generating", label: "Generating", detail: "InstantID running · 3 styles · ~2 min" },
  { status: "ready",      label: "Ready",      detail: "Your headshots are here!" },
];

export default function GalleryPage() {
  const { jobId } = useParams<{ jobId: string }>();
  const [status, setStatus] = useState<Status>("uploading");
  const [tier, setTier] = useState<Tier>("premium");
  const [headshots, setHeadshots] = useState<string[]>([]);
  const [photoCount, setPhotoCount] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    timerRef.current = setInterval(() => setElapsedSeconds((s) => s + 1), 1000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, []);

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${String(sec).padStart(2, "0")}`;
  };

  useEffect(() => {
    const poll = async () => {
      try {
        const res = await fetch(`/api/jobs/${jobId}`);
        if (!res.ok) return;
        const data = await res.json();

        setStatus(data.status);
        if (data.tier) setTier(data.tier as Tier);
        if (data.photoCount) setPhotoCount(data.photoCount);
        if (data.headshots?.length) setHeadshots(data.headshots);
        if (data.error) setErrorMessage(String(data.error));

        if (["ready", "error"].includes(data.status)) {
          if (intervalRef.current) clearInterval(intervalRef.current);
          if (timerRef.current) clearInterval(timerRef.current);
        }
      } catch (err) {
        console.error("[poll]", err);
      }
    };

    poll();
    intervalRef.current = setInterval(poll, 5000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [jobId]);

  const STEPS = tier === "fast" ? FAST_STEPS : PREMIUM_STEPS;
  const currentStepIdx = STEPS.findIndex((s) => s.status === status);
  const isLoading = !["ready", "error"].includes(status);

  return (
    <main style={{ minHeight: "100vh", padding: "40px 24px" }}>

      {/* Nav */}
      <div style={{ marginBottom: 64, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <Link href="/" style={{ fontFamily: "var(--font-display)", fontSize: 20, letterSpacing: 2, color: "var(--accent)" }}>
          PORTRALY.AI
        </Link>
        <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
          <span style={{
            fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: 2,
            color: tier === "fast" ? "#6abf8a" : "var(--accent)",
            border: `1px solid ${tier === "fast" ? "#6abf8a" : "var(--accent)"}`,
            padding: "4px 10px",
          }}>
            {tier === "fast" ? "FAST" : "PREMIUM"}
          </span>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--muted)", letterSpacing: 1 }}>
            JOB {jobId?.slice(0, 8).toUpperCase()}
          </span>
        </div>
      </div>

      {/* Loading view */}
      {isLoading && (
        <div style={{ maxWidth: 560, margin: "0 auto" }}>
          <p style={{ fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: 4, color: "var(--accent)", marginBottom: 24 }}>
            IN PROGRESS
          </p>
          <h1 style={{ fontWeight: 300, fontSize: 44, marginBottom: 48, lineHeight: 1.1 }}>
            {tier === "fast" ? "Running InstantID" : "Generating your"}<br />
            <em style={{ color: "var(--accent)", fontStyle: "italic" }}>
              {tier === "fast" ? "on your photos" : "headshots"}
            </em>
          </h1>

          {/* Step tracker */}
          <div style={{ marginBottom: 48 }}>
            {STEPS.map((step, i) => {
              const isDone = i < currentStepIdx;
              const isCurrent = i === currentStepIdx;
              return (
                <div key={step.status} style={{
                  display: "flex", alignItems: "flex-start", gap: 20, marginBottom: 28,
                  opacity: i > currentStepIdx ? 0.3 : 1, transition: "opacity 0.4s",
                }}>
                  <div style={{
                    width: 32, height: 32, borderRadius: "50%", flexShrink: 0, fontSize: 13,
                    border: `1px solid ${isDone ? "var(--success)" : isCurrent ? "var(--accent)" : "var(--border)"}`,
                    background: isDone ? "rgba(106,191,138,0.15)" : isCurrent ? "rgba(201,169,110,0.15)" : "transparent",
                    display: "flex", alignItems: "center", justifyContent: "center",
                  }}>
                    {isDone ? "✓" : isCurrent
                      ? <span style={{ animation: "spin 1s linear infinite", display: "inline-block" }}>⟳</span>
                      : String(i + 1)}
                  </div>
                  <div style={{ paddingTop: 4 }}>
                    <p style={{
                      fontFamily: "var(--font-mono)", fontSize: 13, letterSpacing: 1, marginBottom: 4,
                      color: isDone ? "var(--success)" : isCurrent ? "var(--accent)" : "var(--muted)",
                    }}>
                      {step.label.toUpperCase()}
                    </p>
                    <p style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--muted)" }}>
                      {step.detail}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Elapsed time */}
          <div style={{
            background: "var(--surface)", border: "1px solid var(--border)", padding: "20px 24px",
            display: "flex", justifyContent: "space-between", alignItems: "center",
          }}>
            <div>
              <p style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--muted)", letterSpacing: 2, marginBottom: 6 }}>ELAPSED TIME</p>
              <p style={{ fontFamily: "var(--font-mono)", fontSize: 22, color: "var(--accent)" }}>{formatTime(elapsedSeconds)}</p>
            </div>
            <div style={{ textAlign: "right" }}>
              <p style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--muted)", letterSpacing: 2, marginBottom: 6 }}>PHOTOS USED</p>
              <p style={{ fontFamily: "var(--font-mono)", fontSize: 22, color: "var(--text)" }}>{photoCount}</p>
            </div>
          </div>

          <p style={{
            fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--muted)",
            marginTop: 24, textAlign: "center", lineHeight: 1.8,
          }}>
            {tier === "fast"
              ? "This page polls automatically every 5 seconds.\nInstantID on fal.ai takes ~1–3 min. Keep this tab open."
              : "This page polls automatically every 5 seconds.\nPremium jobs run in an overnight batch and deliver within 24 hours."
            }
          </p>

          <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
        </div>
      )}

      {/* Error view */}
      {status === "error" && (
        <div style={{ maxWidth: 560, margin: "0 auto", textAlign: "center", padding: "80px 0" }}>
          <p style={{ fontSize: 48, marginBottom: 24 }}>⚠</p>
          <h2 style={{ fontWeight: 300, fontSize: 32, marginBottom: 16 }}>Something went wrong</h2>
          <p style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--muted)", marginBottom: 32 }}>
            {errorMessage
              ? errorMessage
              : (tier === "fast"
                ? "Check your FAL_KEY in .env.local — InstantID requires a valid fal.ai key."
                : "Check your FAL_KEY or local ML server and try again."
              )
            }
          </p>
          <Link href="/upload" style={{
            fontFamily: "var(--font-mono)", fontSize: 13, letterSpacing: 2,
            color: "var(--accent)", border: "1px solid var(--accent)", padding: "14px 32px",
          }}>
            ← TRY AGAIN
          </Link>
        </div>
      )}

      {/* Ready: gallery */}
      {status === "ready" && headshots.length > 0 && (
        <div style={{ maxWidth: 960, margin: "0 auto" }}>
          <div style={{ marginBottom: 48, display: "flex", justifyContent: "space-between", alignItems: "flex-end", flexWrap: "wrap", gap: 20 }}>
            <div>
              <p style={{ fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: 4, color: "var(--success)", marginBottom: 12 }}>
                ✓ COMPLETE · {formatTime(elapsedSeconds)}
              </p>
              <h1 style={{ fontWeight: 300, fontSize: 44, lineHeight: 1.1 }}>
                Your headshots<br />
                <em style={{ color: "var(--accent)", fontStyle: "italic" }}>are ready</em>
              </h1>
            </div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--muted)", textAlign: "right" }}>
              <p>{headshots.length} headshot{headshots.length !== 1 ? "s" : ""} · {tier === "fast" ? "InstantID" : "LoRA"}</p>
              <p style={{ fontSize: 11, marginTop: 4 }}>Saved locally · click ↓ to download each</p>
            </div>
          </div>

          {/* Photo grid */}
          <div style={{
            display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
            gap: 12, marginBottom: 48,
          }}>
            {headshots.map((url, i) => (
              <div key={i} style={{ position: "relative", aspectRatio: "3/4", overflow: "hidden", border: "1px solid var(--border)" }}>
                <img
                  src={url}
                  alt={`Headshot ${i + 1}`}
                  onClick={() => setSelectedIdx(i)}
                  style={{ width: "100%", height: "100%", objectFit: "cover", transition: "transform 0.3s", cursor: "pointer", display: "block" }}
                  onMouseEnter={(e) => (e.currentTarget.style.transform = "scale(1.04)")}
                  onMouseLeave={(e) => (e.currentTarget.style.transform = "scale(1)")}
                />
                <div style={{
                  position: "absolute", bottom: 0, left: 0, right: 0,
                  background: "linear-gradient(transparent, rgba(0,0,0,0.85))",
                  padding: "28px 10px 10px",
                  display: "flex", alignItems: "flex-end", justifyContent: "space-between",
                }}>
                  <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "rgba(255,255,255,0.45)", letterSpacing: 1 }}>
                    #{String(i + 1).padStart(2, "0")}
                  </div>
                  <a
                    href={url}
                    download={`headshot_${String(i + 1).padStart(2, "0")}.jpg`}
                    onClick={(e) => e.stopPropagation()}
                    title="Download"
                    style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "rgba(255,255,255,0.6)", textDecoration: "none", lineHeight: 1, padding: "4px 2px" }}
                  >
                    ↓
                  </a>
                </div>
              </div>
            ))}
          </div>

          {/* Actions */}
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center", borderTop: "1px solid var(--border)", paddingTop: 32 }}>
            <Link href="/upload" style={{
              fontFamily: "var(--font-mono)", fontSize: 13, letterSpacing: 2,
              color: "var(--text)", border: "1px solid var(--border)", padding: "14px 28px",
            }}>
              ← NEW BATCH
            </Link>
            <p style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--muted)" }}>
              Files saved locally · Right-click any image to save
            </p>
          </div>
        </div>
      )}

      {/* Lightbox */}
      {selectedIdx !== null && (
        <div
          onClick={() => setSelectedIdx(null)}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.95)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}
        >
          <img
            src={headshots[selectedIdx]}
            alt=""
            onClick={(e) => e.stopPropagation()}
            style={{ maxHeight: "90vh", maxWidth: "85vw", objectFit: "contain" }}
          />
          <button onClick={() => setSelectedIdx(null)}
            style={{ position: "fixed", top: 24, right: 32, background: "none", border: "none", color: "#fff", fontSize: 36, cursor: "pointer" }}>×</button>
          <button
            onClick={(e) => { e.stopPropagation(); setSelectedIdx(Math.max(0, selectedIdx - 1)); }}
            style={{ position: "fixed", left: 24, background: "none", border: "none", color: "rgba(255,255,255,0.6)", fontSize: 56, cursor: "pointer" }}>‹</button>
          <button
            onClick={(e) => { e.stopPropagation(); setSelectedIdx(Math.min(headshots.length - 1, selectedIdx + 1)); }}
            style={{ position: "fixed", right: 24, background: "none", border: "none", color: "rgba(255,255,255,0.6)", fontSize: 56, cursor: "pointer" }}>›</button>
          <div style={{ position: "fixed", bottom: 24, fontFamily: "var(--font-mono)", fontSize: 12, color: "rgba(255,255,255,0.4)", letterSpacing: 2 }}>
            {selectedIdx + 1} / {headshots.length}
          </div>
        </div>
      )}

    </main>
  );
}
