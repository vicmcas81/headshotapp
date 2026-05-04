"use client";
import { useState, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

const MAX_PHOTOS = 10;
const MAX_FILE_MB = 20;

type Tier = "fast" | "premium";

const TIERS = {
  fast: {
    label: "Fast",
    badge: "$5–10",
    tagline: "Results in ~2 min",
    minPhotos: 1,
    description: "InstantID face consistency — no training required. Upload just one clear photo and get professional headshots in minutes.",
    bullets: [
      "No training · instant queue",
      "Face-consistency via InstantID",
      "3 styles · results in ~2 min",
      "Just 1 photo needed",
    ],
    submitLabel: (n: number) => `GENERATE FAST HEADSHOTS WITH ${n} PHOTO${n !== 1 ? "S" : ""} →`,
    footer: "InstantID · 3 styles · no training · ~2 min",
  },
  premium: {
    label: "Premium",
    badge: "$19–50",
    tagline: "LoRA fine-tuning · highest accuracy",
    minPhotos: 4,
    description: "We train a custom LoRA model on your photos — the AI actually learns your exact facial features for studio-quality results.",
    bullets: [
      "Custom LoRA trained on your face",
      "5 styles · multiple shots each",
      "Saved model · re-batch anytime",
      "4–10 photos for best accuracy",
    ],
    submitLabel: (n: number) => `GENERATE HEADSHOTS WITH ${n} PHOTOS →`,
    footer: "LoRA training · 1 style · 1 headshot · M5 local",
  },
};

export default function UploadPage() {
  const router = useRouter();
  const [tier, setTier] = useState<Tier>("premium");
  const [files, setFiles] = useState<File[]>([]);
  const [gender, setGender] = useState<"man" | "woman">("man");
  const [dragging, setDragging] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const activeTier = TIERS[tier];

  const addFiles = useCallback((incoming: FileList | File[]) => {
    const oversized: string[] = [];
    const valid = Array.from(incoming).filter((f) => {
      if (!f.type.startsWith("image/")) return false;
      if (f.size > MAX_FILE_MB * 1024 * 1024) { oversized.push(f.name); return false; }
      return true;
    });
    if (oversized.length) setError(`Skipped ${oversized.length} file(s) over ${MAX_FILE_MB}MB: ${oversized.join(", ")}`);
    setFiles((prev) => [...prev, ...valid].slice(0, MAX_PHOTOS));
  }, []);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    addFiles(e.dataTransfer.files);
  };

  const removeFile = (i: number) =>
    setFiles((prev) => prev.filter((_, idx) => idx !== i));

  // Reset files when switching tiers so the count/validation is fresh
  const switchTier = (t: Tier) => {
    setTier(t);
    setError("");
  };

  const handleSubmit = async () => {
    setError("");
    if (files.length < activeTier.minPhotos) {
      return setError(`Upload at least ${activeTier.minPhotos} photo${activeTier.minPhotos !== 1 ? "s" : ""}.`);
    }

    setLoading(true);
    setProgress(tier === "fast" ? "Uploading photo..." : "Uploading photos...");

    try {
      const form = new FormData();
      files.forEach((f) => form.append("photos", f));
      form.append("gender", gender);
      form.append("tier", tier);

      const res = await fetch("/api/upload", { method: "POST", body: form });
      const data = await res.json();

      if (!res.ok) throw new Error(data.error || "Upload failed");

      setProgress(tier === "fast" ? "Submitting to InstantID..." : "Starting AI training...");
      router.push(`/gallery/${data.jobId}`);
    } catch (err: any) {
      setError(err.message);
      setLoading(false);
      setProgress("");
    }
  };

  const canSubmit = files.length >= activeTier.minPhotos && !loading;
  const remaining = activeTier.minPhotos - files.length;

  return (
    <main style={{ minHeight: "100vh", padding: "40px 24px" }}>

      {/* Nav */}
      <div style={{ marginBottom: 64, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <Link href="/" style={{ fontFamily: "var(--font-display)", fontSize: 20, letterSpacing: 2, color: "var(--accent)" }}>
          PORTRALY.AI
        </Link>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: 2, color: "var(--accent)", border: "1px solid var(--accent)", padding: "6px 14px" }}>
          LOCAL TEST MODE
        </span>
      </div>

      <div style={{ maxWidth: 600, margin: "0 auto" }}>

        <p style={{ fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: 4, color: "var(--accent)", marginBottom: 20 }}>
          CHOOSE YOUR TIER
        </p>
        <h1 style={{ fontWeight: 300, fontSize: 44, marginBottom: 40, lineHeight: 1.1 }}>
          How do you want<br />
          <em style={{ color: "var(--accent)", fontStyle: "italic" }}>your headshots?</em>
        </h1>

        {/* ── Tier tabs ── */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 24 }}>
          {(["fast", "premium"] as Tier[]).map((t) => {
            const td = TIERS[t];
            const isActive = tier === t;
            return (
              <button
                key={t}
                onClick={() => switchTier(t)}
                style={{
                  padding: "20px 18px",
                  background: isActive ? "var(--surface)" : "transparent",
                  border: `1px solid ${isActive ? "var(--accent)" : "var(--border)"}`,
                  textAlign: "left",
                  cursor: "pointer",
                  transition: "all 0.2s",
                  outline: "none",
                }}
              >
                <div style={{
                  fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: 3,
                  color: isActive ? "var(--accent)" : "var(--muted)", marginBottom: 8,
                }}>
                  {td.label.toUpperCase()}
                </div>
                <div style={{
                  fontSize: 26, fontWeight: 300,
                  color: isActive ? "var(--text)" : "var(--muted)", marginBottom: 6, lineHeight: 1,
                }}>
                  {td.badge}
                </div>
                <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: isActive ? "var(--muted)" : "var(--border)" }}>
                  {td.tagline}
                </div>
              </button>
            );
          })}
        </div>

        {/* Tier detail */}
        <div style={{ background: "var(--surface)", border: "1px solid var(--border)", padding: "24px", marginBottom: 36 }}>
          <p style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--text)", lineHeight: 1.8, marginBottom: 18 }}>
            {activeTier.description}
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px 24px" }}>
            {activeTier.bullets.map((b) => (
              <p key={b} style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--muted)", lineHeight: 1.6 }}>
                ✓  {b}
              </p>
            ))}
          </div>
        </div>

        {/* ── Upload section (both tiers) ── */}
        <p style={{ fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: 4, color: "var(--accent)", marginBottom: 16 }}>
          UPLOAD PHOTOS
        </p>
        <h2 style={{ fontWeight: 300, fontSize: 30, marginBottom: 10, lineHeight: 1.1 }}>
          {tier === "fast"
            ? <>Add <em style={{ color: "var(--accent)", fontStyle: "italic" }}>at least 1 photo</em></>
            : <>Add <em style={{ color: "var(--accent)", fontStyle: "italic" }}>4–10 photos</em></>
          }
        </h2>
        <p style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--muted)", marginBottom: 28, lineHeight: 1.8 }}>
          {tier === "fast"
            ? "One clear face photo is enough · more photos = we pick the best one"
            : "Minimum 4 · more photos = better accuracy · 10 gives the best results"
          }
        </p>

        {/* Quality bar (fast: just shows count, premium: scored) */}
        {files.length > 0 && (() => {
          const count = files.length;
          const min = activeTier.minPhotos;
          let score: string, scoreColor: string;
          if (tier === "fast") {
            score = count >= 3 ? "Excellent" : count >= 2 ? "Great" : "Good";
            scoreColor = count >= 3 ? "var(--success, #6abf8a)" : count >= 2 ? "#a8c96b" : "var(--accent)";
          } else {
            score = count < min ? "Fair" : count < 8 ? "Good" : count < 10 ? "Great" : "Excellent";
            scoreColor = score === "Excellent" ? "var(--success, #6abf8a)" : score === "Great" ? "#a8c96b" : score === "Good" ? "var(--accent)" : "#e09a5a";
          }
          const pct = Math.round((count / MAX_PHOTOS) * 100);
          return (
            <div style={{ background: "var(--surface)", border: "1px solid var(--border)", padding: "14px 20px", marginBottom: 24, display: "flex", alignItems: "center", gap: 16 }}>
              <div style={{ flex: 1 }}>
                <div style={{ height: 4, background: "var(--border)", borderRadius: 2, overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${pct}%`, background: scoreColor, transition: "width 0.3s, background 0.3s" }} />
                </div>
              </div>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: 2, color: scoreColor, minWidth: 72, textAlign: "right" }}>
                {score.toUpperCase()}
              </span>
            </div>
          );
        })()}

        {/* Gender selector */}
        <div style={{ marginBottom: 28 }}>
          <p style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: 3, color: "var(--muted)", marginBottom: 12 }}>
            SUBJECT GENDER
          </p>
          <div style={{ display: "flex", gap: 10 }}>
            {(["man", "woman"] as const).map((g) => (
              <button
                key={g}
                onClick={() => setGender(g)}
                style={{
                  flex: 1, padding: "14px",
                  background: gender === g ? "var(--accent)" : "var(--surface)",
                  color: gender === g ? "#0a0a0a" : "var(--muted)",
                  border: `1px solid ${gender === g ? "var(--accent)" : "var(--border)"}`,
                  fontFamily: "var(--font-mono)", fontSize: 12, letterSpacing: 2,
                  cursor: "pointer", transition: "all 0.2s",
                }}
              >
                {g === "man" ? "MALE" : "FEMALE"}
              </button>
            ))}
          </div>
        </div>

        {/* Drop zone */}
        <div
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          onClick={() => files.length < MAX_PHOTOS && inputRef.current?.click()}
          style={{
            border: `1px dashed ${dragging ? "var(--accent)" : "var(--border)"}`,
            background: dragging ? "rgba(201,169,110,0.06)" : "var(--bg2)",
            borderRadius: 2,
            padding: files.length === 0 ? "64px 24px" : "24px",
            textAlign: "center",
            cursor: files.length < MAX_PHOTOS ? "pointer" : "default",
            transition: "all 0.2s",
            marginBottom: 20,
          }}
        >
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            multiple
            onChange={(e) => e.target.files && addFiles(e.target.files)}
            style={{ display: "none" }}
          />

          {files.length === 0 && (
            <>
              <div style={{ fontSize: 40, marginBottom: 16, color: "var(--accent)", opacity: 0.6 }}>⊕</div>
              <p style={{ fontFamily: "var(--font-mono)", fontSize: 14, color: "var(--text)", marginBottom: 8 }}>
                Drop photos here or click to browse
              </p>
              <p style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--muted)" }}>
                JPG, PNG, WEBP · {tier === "fast" ? "1 minimum" : "4 minimum · 10 recommended"} · max {MAX_FILE_MB}MB each
              </p>
            </>
          )}

          {files.length > 0 && (
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "center" }}>
              {files.map((file, i) => (
                <div key={i} style={{ position: "relative", width: 100, height: 100, flexShrink: 0 }}>
                  <img
                    src={URL.createObjectURL(file)}
                    alt=""
                    style={{ width: "100%", height: "100%", objectFit: "cover" }}
                  />
                  <button
                    onClick={(e) => { e.stopPropagation(); removeFile(i); }}
                    style={{
                      position: "absolute", top: 4, right: 4,
                      width: 20, height: 20,
                      background: "rgba(0,0,0,0.85)", color: "#fff",
                      border: "none", borderRadius: "50%",
                      fontSize: 12, cursor: "pointer",
                      display: "flex", alignItems: "center", justifyContent: "center",
                    }}
                  >×</button>
                  <div style={{
                    position: "absolute", bottom: 0, left: 0, right: 0,
                    background: "rgba(0,0,0,0.6)",
                    fontFamily: "var(--font-mono)", fontSize: 9,
                    color: "#fff", textAlign: "center", padding: "3px 0", letterSpacing: 1,
                  }}>
                    {i === 0 && tier === "fast" ? "FACE" : i + 1}
                  </div>
                </div>
              ))}
              {files.length < MAX_PHOTOS && (
                <div
                  onClick={() => inputRef.current?.click()}
                  style={{
                    width: 100, height: 100,
                    border: "1px dashed var(--border)",
                    display: "flex", flexDirection: "column",
                    alignItems: "center", justifyContent: "center",
                    cursor: "pointer", color: "var(--muted)", gap: 6,
                  }}
                >
                  <span style={{ fontSize: 24, color: "var(--accent)", opacity: 0.5 }}>+</span>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: 1 }}>ADD</span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Counter dots */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 28 }}>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--muted)" }}>
            {files.length} / {MAX_PHOTOS} photos · minimum {activeTier.minPhotos}
          </span>
          <div style={{ display: "flex", gap: 4 }}>
            {Array.from({ length: MAX_PHOTOS }).map((_, i) => (
              <div key={i} style={{
                width: 6, height: 6, borderRadius: "50%",
                background: i < files.length
                  ? i < activeTier.minPhotos ? "var(--accent)" : "var(--success, #6abf8a)"
                  : "var(--border)",
                transition: "background 0.3s",
              }} />
            ))}
          </div>
        </div>

        {/* Tips */}
        <div style={{ background: "var(--surface)", border: "1px solid var(--border)", padding: "20px 24px", marginBottom: 28 }}>
          <p style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: 2, color: "var(--accent)", marginBottom: 14 }}>
            {tier === "fast" ? "TIPS FOR FAST TIER" : "TIPS FOR BEST RESULTS"}
          </p>
          {tier === "fast" ? [
            ["✓", "Clear, well-lit face photo — front-facing is best"],
            ["✓", "No sunglasses, hats, or heavy shadows on face"],
            ["✓", "Multiple photos = we pick the sharpest face"],
            ["✗", "No group photos — solo shots only"],
          ].map(([icon, tip]) => (
            <p key={tip} style={{
              fontFamily: "var(--font-mono)", fontSize: 12,
              color: icon === "✗" ? "#e05a5a" : "var(--muted)",
              lineHeight: 2, opacity: icon === "✗" ? 0.7 : 1,
            }}>
              {icon}  {tip}
            </p>
          )) : [
            ["✓", "Different angles — front, left, right, slight up/down"],
            ["✓", "Varied lighting — indoor, outdoor, bright, soft"],
            ["✓", "Different expressions — neutral, smiling, serious"],
            ["✓", "Solo only — no other people in frame"],
            ["✗", "No heavy filters or Snapchat effects"],
            ["✗", "No sunglasses or hats (unless you want them in headshots)"],
          ].map(([icon, tip]) => (
            <p key={tip} style={{
              fontFamily: "var(--font-mono)", fontSize: 12,
              color: icon === "✗" ? "#e05a5a" : "var(--muted)",
              lineHeight: 2, opacity: icon === "✗" ? 0.7 : 1,
            }}>
              {icon}  {tip}
            </p>
          ))}
        </div>

        {/* Error */}
        {error && (
          <div style={{
            background: "rgba(224,90,90,0.1)", border: "1px solid rgba(224,90,90,0.3)",
            padding: "14px 20px", marginBottom: 20,
            fontFamily: "var(--font-mono)", fontSize: 13, color: "#e05a5a",
          }}>
            ⚠  {error}
          </div>
        )}

        {/* Submit */}
        <button
          onClick={handleSubmit}
          disabled={!canSubmit}
          style={{
            width: "100%", padding: "20px",
            background: canSubmit ? "var(--accent)" : "var(--surface)",
            color: canSubmit ? "#0a0a0a" : "var(--muted)",
            border: `1px solid ${canSubmit ? "var(--accent)" : "var(--border)"}`,
            fontFamily: "var(--font-mono)", fontSize: 13, letterSpacing: 2,
            cursor: canSubmit ? "pointer" : "not-allowed",
            transition: "all 0.2s",
          }}
        >
          {loading
            ? `⟳  ${progress.toUpperCase()}`
            : remaining > 0
            ? `ADD ${remaining} MORE PHOTO${remaining !== 1 ? "S" : ""} TO CONTINUE`
            : activeTier.submitLabel(files.length)
          }
        </button>

        <p style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--muted)", textAlign: "center", marginTop: 14 }}>
          {activeTier.footer}
        </p>

      </div>
    </main>
  );
}
