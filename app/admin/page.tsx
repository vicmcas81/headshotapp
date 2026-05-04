"use client";
import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { STYLES, IMAGES_PER_STYLE } from "@/lib/fal";

// ─── Types ──────────────────────────────────────────────────────────────────────

interface Job {
  id: string;
  status: "uploading" | "queued_for_batch" | "training" | "generating" | "ready" | "error";
  createdAt: number;
  photoCount: number;
  triggerWord: string;
  gender: "man" | "woman";
  tier?: "fast" | "premium";
  trainingRequestId?: string;
  loraUrl?: string;
  headshots?: string[];
  error?: string;
  customerEmail?: string;
  customerName?: string;
  paid?: boolean;
  downloadCount?: number;
}

interface DashboardStats {
  jobs: { total: number; ready: number; training: number; generating: number; error: number; paid: number };
  revenue: { totalOrders: number; totalRevenueCents: number; paidOrders: number; refunded: number };
}

interface Order {
  id: number;
  jobId: string;
  customerEmail?: string;
  customerName?: string;
  amountCents: number;
  status: string;
  createdAt: string;
  paidAt?: string;
}

interface AuditEntry {
  id: number;
  action: string;
  detail?: string;
  jobId?: string;
  createdAt: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────────

function statusColor(s: Job["status"]) {
  return s === "ready"      ? "#6abf8a"
       : s === "error"      ? "#e05a5a"
       : s === "generating" ? "#c9a96e"
       : s === "queued_for_batch" ? "#6bb5c9"
       : s === "training"   ? "#a8c96b"
       : "#888";
}

function formatDate(ts: number | string) {
  const d = typeof ts === "number" ? new Date(ts) : new Date(ts);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function formatTime(ts: number | string) {
  const d = typeof ts === "number" ? new Date(ts) : new Date(ts);
  return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
}

function formatCurrency(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

// ─── Tab type ───────────────────────────────────────────────────────────────────

type Tab = "overview" | "jobs" | "orders" | "audit" | "settings";

// ─── Component ──────────────────────────────────────────────────────────────────

export default function AdminDashboard() {
  const [tab, setTab] = useState<Tab>("overview");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [filter, setFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [genSettings, setGenSettings] = useState({ images_per_batch: "2" });
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsSaved, setSettingsSaved] = useState(false);

  // ── Data fetchers ──────────────────────────────────────────────────────────
  const fetchJobs = useCallback(async () => {
    const res = await fetch("/api/admin/jobs");
    if (res.ok) { setJobs(await res.json()); setLastRefresh(new Date()); }
  }, []);

  const fetchStats = useCallback(async () => {
    const res = await fetch("/api/admin/jobs?view=stats");
    if (res.ok) setStats(await res.json());
  }, []);

  const fetchOrders = useCallback(async () => {
    const res = await fetch("/api/admin/jobs?view=orders");
    if (res.ok) setOrders(await res.json());
  }, []);

  const fetchAudit = useCallback(async () => {
    const res = await fetch("/api/admin/jobs?view=audit");
    if (res.ok) setAudit(await res.json());
  }, []);

  const refreshAll = useCallback(async () => {
    await Promise.all([fetchJobs(), fetchStats(), fetchOrders(), fetchAudit()]);
  }, [fetchJobs, fetchStats, fetchOrders, fetchAudit]);

  useEffect(() => { refreshAll(); }, [refreshAll]);

  // Load generation settings
  useEffect(() => {
    fetch("/api/admin/settings")
      .then(r => r.ok ? r.json() : null)
      .then(d => d && setGenSettings(d));
  }, []);

  const saveGenSettings = async () => {
    setSettingsSaving(true);
    try {
      await fetch("/api/admin/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "images_per_batch", value: genSettings.images_per_batch }),
      });
      setSettingsSaved(true);
      setTimeout(() => setSettingsSaved(false), 2000);
    } finally {
      setSettingsSaving(false);
    }
  };

  // Auto-poll active jobs
  const pollActive = useCallback(async () => {
    const active = jobs.filter(j => j.status === "training" || j.status === "generating");
    await Promise.all(active.map(j => fetch(`/api/jobs/${j.id}`)));
    if (active.length > 0) await refreshAll();
  }, [jobs, refreshAll]);

  useEffect(() => {
    const hasActive = jobs.some(j => j.status === "training" || j.status === "generating");
    if (!hasActive) return;
    const id = setInterval(pollActive, 12000);
    return () => clearInterval(id);
  }, [jobs, pollActive]);

  // ── Delete job ─────────────────────────────────────────────────────────────
  const handleDeleteJob = async (id: string) => {
    if (!confirm(`Delete job ${id.slice(0, 8)}...? This cannot be undone.`)) return;
    await fetch("/api/admin/jobs", { method: "DELETE", body: JSON.stringify({ id }), headers: { "Content-Type": "application/json" } });
    await refreshAll();
  };

  // ── Cleanup non-completed jobs ────────────────────────────────────────────
  const handleCleanupNonCompleted = async () => {
    const nonCompletedCount = jobs.filter(j => j.status !== "ready").length;
    if (nonCompletedCount <= 0) return;
    if (!confirm(`Delete ${nonCompletedCount} non-completed job(s) and keep only COMPLETED (READY) jobs? This cannot be undone.`)) return;
    await fetch("/api/admin/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "cleanup_non_completed_jobs" }),
    });
    await refreshAll();
  };

  // ── Run premium batch (manual trigger) ────────────────────────────────────
  const handleRunPremiumBatch = async () => {
    const queued = jobs.filter(j => j.tier === "premium" && j.status === "queued_for_batch").length;
    if (queued <= 0) return;
    if (!confirm(`Submit ${queued} premium job(s) to RunPod now? (This is normally run overnight in batch.)`)) return;
    await fetch("/api/admin/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "run_premium_batch", limit: queued }),
    });
    await refreshAll();
  };

  // ── Filtered jobs ──────────────────────────────────────────────────────────
  const filteredJobs = jobs.filter(j => {
    if (filter !== "all" && j.status !== filter) return false;
    if (search) {
      const q = search.toLowerCase();
      return j.id.toLowerCase().includes(q)
        || j.triggerWord.toLowerCase().includes(q)
        || (j.customerEmail || "").toLowerCase().includes(q)
        || (j.customerName || "").toLowerCase().includes(q);
    }
    return true;
  });

  const activeCount = jobs.filter(j => j.status === "training" || j.status === "generating").length;
  const nonCompletedCount = jobs.filter(j => j.status !== "ready").length;
  const queuedPremiumCount = jobs.filter(j => j.tier === "premium" && j.status === "queued_for_batch").length;

  // ─── Styles ────────────────────────────────────────────────────────────────
  const card = (extra?: React.CSSProperties): React.CSSProperties => ({
    background: "var(--surface, #1a1a1a)",
    border: "1px solid var(--border)",
    padding: "24px",
    ...extra,
  });

  const mono = (size = 11, extra?: React.CSSProperties): React.CSSProperties => ({
    fontFamily: "var(--font-mono)",
    fontSize: size,
    letterSpacing: 1,
    ...extra,
  });

  const tabBtn = (t: Tab): React.CSSProperties => ({
    ...mono(11),
    letterSpacing: 2,
    padding: "10px 20px",
    background: tab === t ? "var(--accent)" : "transparent",
    color: tab === t ? "#0a0a0a" : "var(--muted)",
    border: `1px solid ${tab === t ? "var(--accent)" : "var(--border)"}`,
    cursor: "pointer",
    transition: "all 0.2s",
  });

  return (
    <main style={{ minHeight: "100vh", padding: "32px", background: "var(--bg)" }}>
      <style>{`
        .admin-thumb img { transition: transform 0.25s; }
        .admin-thumb:hover img { transform: scale(1.05); }
        .stat-card:hover { border-color: var(--accent) !important; }
      `}</style>

      {/* ── Header ── */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 32, flexWrap: "wrap", gap: 16 }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
            <span style={{ ...mono(18, { letterSpacing: 3, color: "var(--accent)" }) }}>PORTRALY.AI</span>
            <span style={{ ...mono(9, { letterSpacing: 2, color: "#e05a5a", border: "1px solid #e05a5a", padding: "3px 8px" }) }}>
              ADMIN
            </span>
          </div>
          <p style={{ ...mono(11, { color: "var(--muted)" }) }}>
            {jobs.length} total jobs · {activeCount > 0 ? `${activeCount} processing` : "all idle"}
            {lastRefresh && <span style={{ opacity: 0.5 }}> · updated {formatTime(lastRefresh.getTime())}</span>}
          </p>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          {queuedPremiumCount > 0 && (
            <button
              onClick={handleRunPremiumBatch}
              style={{ ...mono(11, { letterSpacing: 2, color: "#6bb5c9", border: "1px solid #6bb5c9", padding: "8px 16px", background: "none", cursor: "pointer" }) }}
              title="Manually kicks off the overnight premium batch"
            >
              RUN PREMIUM BATCH ({queuedPremiumCount})
            </button>
          )}
          {activeCount > 0 && (
            <span style={{ ...mono(9, { letterSpacing: 2, color: "#a8c96b", border: "1px solid #a8c96b", padding: "6px 12px" }) }}>
              ⟳ {activeCount} ACTIVE
            </span>
          )}
          {nonCompletedCount > 0 && (
            <button
              onClick={handleCleanupNonCompleted}
              style={{ ...mono(11, { letterSpacing: 2, color: "#e05a5a", border: "1px solid #e05a5a", padding: "8px 16px", background: "none", cursor: "pointer" }) }}
              title="Deletes all jobs that are not COMPLETED (READY)"
            >
              DELETE NON-COMPLETED ({nonCompletedCount})
            </button>
          )}
          <button onClick={refreshAll} style={{ ...mono(11, { letterSpacing: 2, color: "var(--muted)", border: "1px solid var(--border)", padding: "8px 16px", background: "none", cursor: "pointer" }) }}>
            REFRESH
          </button>
          <Link href="/upload" style={{ ...mono(11, { letterSpacing: 2, color: "var(--accent)", border: "1px solid var(--accent)", padding: "8px 16px", textDecoration: "none" }) }}>
            + NEW JOB
          </Link>
          <Link href="/" style={{ ...mono(11, { letterSpacing: 2, color: "var(--muted)", border: "1px solid var(--border)", padding: "8px 16px", textDecoration: "none" }) }}>
            ← SITE
          </Link>
        </div>
      </div>

      {/* ── Tabs ── */}
      <div style={{ display: "flex", gap: 0, marginBottom: 32 }}>
        {(["overview", "jobs", "orders", "audit", "settings"] as Tab[]).map(t => (
          <button key={t} onClick={() => setTab(t)} style={tabBtn(t)}>
            {t.toUpperCase()}
          </button>
        ))}
      </div>

      {/* ══════════════════════════════════════════════════════════════════════
         ██ OVERVIEW TAB
         ══════════════════════════════════════════════════════════════════════ */}
      {tab === "overview" && stats && (
        <div>
          {/* Stat cards */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 16, marginBottom: 32 }}>
            {[
              { label: "TOTAL JOBS", value: stats.jobs.total, color: "var(--text)" },
              { label: "COMPLETED", value: stats.jobs.ready, color: "#6abf8a" },
              { label: "PROCESSING", value: Number(stats.jobs.training) + Number(stats.jobs.generating), color: "#a8c96b" },
              { label: "FAILED", value: stats.jobs.error, color: "#e05a5a" },
              { label: "REVENUE", value: formatCurrency(stats.revenue.totalRevenueCents), color: "var(--accent)" },
              { label: "PAID ORDERS", value: stats.revenue.paidOrders, color: "#6abf8a" },
            ].map(s => (
              <div key={s.label} className="stat-card" style={card({ transition: "border-color 0.2s" })}>
                <p style={{ ...mono(9, { letterSpacing: 3, color: "var(--muted)", marginBottom: 12 }) }}>{s.label}</p>
                <p style={{ fontSize: 32, fontWeight: 300, color: s.color, lineHeight: 1 }}>
                  {s.value}
                </p>
              </div>
            ))}
          </div>

          {/* Pipeline */}
          <div style={card({ marginBottom: 32 })}>
            <p style={{ ...mono(10, { letterSpacing: 3, color: "var(--accent)", marginBottom: 20 }) }}>JOB PIPELINE</p>
            <div style={{ display: "flex", gap: 4, height: 8, borderRadius: 4, overflow: "hidden" }}>
              {[
                { count: Number(stats.jobs.ready), color: "#6abf8a" },
                { count: Number(stats.jobs.training), color: "#a8c96b" },
                { count: Number(stats.jobs.generating), color: "#c9a96e" },
                { count: Number(stats.jobs.error), color: "#e05a5a" },
              ].filter(s => s.count > 0).map((s, i) => (
                <div key={i} style={{ flex: s.count, background: s.color, minWidth: 4 }} />
              ))}
            </div>
            <div style={{ display: "flex", gap: 24, marginTop: 14 }}>
              {[
                { label: "Ready", count: stats.jobs.ready, color: "#6abf8a" },
                { label: "Training", count: stats.jobs.training, color: "#a8c96b" },
                { label: "Generating", count: stats.jobs.generating, color: "#c9a96e" },
                { label: "Error", count: stats.jobs.error, color: "#e05a5a" },
              ].map(s => (
                <div key={s.label} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <div style={{ width: 8, height: 8, borderRadius: "50%", background: s.color }} />
                  <span style={{ ...mono(10, { color: "var(--muted)" }) }}>{s.label}: {s.count}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Recent activity (last 5 jobs) */}
          <div style={card()}>
            <p style={{ ...mono(10, { letterSpacing: 3, color: "var(--accent)", marginBottom: 20 }) }}>RECENT JOBS</p>
            {jobs.slice(0, 5).map(job => (
              <div key={job.id} style={{ display: "flex", alignItems: "center", gap: 16, padding: "12px 0", borderBottom: "1px solid var(--border)" }}>
                <span style={{ ...mono(9), color: statusColor(job.status), border: `1px solid ${statusColor(job.status)}`, padding: "2px 8px", minWidth: 80, textAlign: "center" }}>
                  {job.status.toUpperCase()}
                </span>
                <span style={{ ...mono(11, { color: "var(--text)", flex: 1 }) }}>{job.id.slice(0, 8)}...</span>
                <span style={{ ...mono(10, { color: "var(--muted)" }) }}>{job.photoCount} photos</span>
                <span style={{ ...mono(10, { color: "var(--muted)" }) }}>{formatDate(job.createdAt)}</span>
                {job.headshots?.length ? (
                  <span style={{ ...mono(9, { color: "#6abf8a" }) }}>✓ {job.headshots.length} shots</span>
                ) : null}
                <Link href={`/gallery/${job.id}`} style={{ ...mono(10, { color: "var(--accent)", textDecoration: "none" }) }}>
                  VIEW →
                </Link>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════════
         ██ JOBS TAB
         ══════════════════════════════════════════════════════════════════════ */}
      {tab === "jobs" && (
        <div>
          {/* Filters */}
          <div style={{ display: "flex", gap: 12, marginBottom: 24, flexWrap: "wrap", alignItems: "center" }}>
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search by ID, email, trigger..."
              style={{ ...mono(12), background: "var(--surface)", border: "1px solid var(--border)", padding: "10px 16px", color: "var(--text)", width: 280 }}
            />
            {["all", "ready", "training", "generating", "error"].map(f => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                style={{
                  ...mono(10, { letterSpacing: 2 }),
                  padding: "8px 14px",
                  background: filter === f ? "var(--accent)" : "transparent",
                  color: filter === f ? "#0a0a0a" : "var(--muted)",
                  border: `1px solid ${filter === f ? "var(--accent)" : "var(--border)"}`,
                  cursor: "pointer",
                }}
              >
                {f.toUpperCase()}
              </button>
            ))}
            <span style={{ ...mono(10, { color: "var(--muted)", marginLeft: "auto" }) }}>
              {filteredJobs.length} job{filteredJobs.length !== 1 ? "s" : ""}
            </span>
          </div>

          {/* Jobs list */}
          <div style={{ display: "flex", flexDirection: "column", gap: 48 }}>
            {filteredJobs.map((job, jobIdx) => {
              const hasImages = job.headshots && job.headshots.length > 0;
              const isActive = job.status === "training" || job.status === "generating";

              return (
                <div key={job.id} style={{ borderTop: "1px solid var(--border)", paddingTop: 24 }}>
                  {/* Job header */}
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20, flexWrap: "wrap", gap: 12 }}>
                    <div>
                      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 6 }}>
                        <span style={{ ...mono(11, { color: "var(--muted)" }) }}>
                          JOB #{jobs.length - jobIdx}
                        </span>
                        <span style={{
                          ...mono(9, { letterSpacing: 2 }),
                          color: statusColor(job.status),
                          border: `1px solid ${statusColor(job.status)}`,
                          padding: "2px 8px",
                        }}>
                          {isActive ? `⟳ ${job.status.toUpperCase()}` : job.status.toUpperCase()}
                        </span>
                        <span style={{ ...mono(9, { color: "var(--muted)", opacity: 0.6 }) }}>
                          {job.gender.toUpperCase()}
                        </span>
                        {job.paid && (
                          <span style={{ ...mono(9, { color: "#6abf8a", border: "1px solid #6abf8a", padding: "2px 8px" }) }}>
                            PAID
                          </span>
                        )}
                      </div>
                      <p style={{ ...mono(12, { color: "var(--text)", marginBottom: 4 }) }}>{job.id}</p>
                      <p style={{ ...mono(11, { color: "var(--muted)" }) }}>
                        {formatDate(job.createdAt)} · {formatTime(job.createdAt)} · {job.photoCount} photos
                        {hasImages && <span style={{ color: "#6abf8a", marginLeft: 8 }}>· {job.headshots!.length} headshots</span>}
                        {job.customerEmail && <span style={{ marginLeft: 8 }}>· {job.customerEmail}</span>}
                        {job.downloadCount ? <span style={{ marginLeft: 8 }}>· {job.downloadCount} downloads</span> : null}
                      </p>
                    </div>
                    <div style={{ display: "flex", gap: 8 }}>
                      <Link href={`/gallery/${job.id}`} style={{ ...mono(10, { letterSpacing: 1, color: "var(--accent)", border: "1px solid var(--accent)", padding: "6px 14px", textDecoration: "none" }) }}>
                        GALLERY →
                      </Link>
                      <button
                        onClick={() => handleDeleteJob(job.id)}
                        style={{ ...mono(10, { letterSpacing: 1, color: "#e05a5a", border: "1px solid rgba(224,90,90,0.3)", padding: "6px 14px", background: "none", cursor: "pointer" }) }}
                      >
                        DELETE
                      </button>
                    </div>
                  </div>

                  {/* Active job progress */}
                  {isActive && (
                    <div style={card({ marginBottom: 16 })}>
                      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                        <span style={{ ...mono(11, { color: statusColor(job.status), letterSpacing: 2 }) }}>
                          ⟳ {job.status === "training" ? "TRAINING ON FAL.AI" : "GENERATING HEADSHOTS"}
                        </span>
                        <span style={{ ...mono(10, { color: "var(--muted)" }) }}>· auto-polling every 12s</span>
                      </div>
                    </div>
                  )}

                  {/* Error detail */}
                  {job.status === "error" && job.error && (
                    <div style={{ background: "rgba(224,90,90,0.1)", border: "1px solid rgba(224,90,90,0.3)", padding: "14px 20px", marginBottom: 16, ...mono(12, { color: "#e05a5a" }) }}>
                      ⚠ {job.error}
                    </div>
                  )}

                  {/* Headshots by style */}
                  {hasImages && (
                    <>
                      {STYLES.map((style, styleIdx) => {
                        const start = styleIdx * IMAGES_PER_STYLE;
                        const styleImages = job.headshots!.slice(start, start + IMAGES_PER_STYLE);
                        if (styleImages.length === 0) return null;
                        return (
                          <div key={style.label} style={{ marginBottom: 20 }}>
                            <p style={{ ...mono(9, { letterSpacing: 3, color: "var(--accent)", marginBottom: 10, opacity: 0.7 }) }}>
                              {style.label.toUpperCase()}
                            </p>
                            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                              {styleImages.map((url, i) => (
                                <a key={i} href={url} target="_blank" rel="noreferrer" className="admin-thumb"
                                  style={{ display: "block", width: 120, height: 160, border: "1px solid var(--border)", overflow: "hidden" }}>
                                  <img src={url} alt={`${style.label} ${i + 1}`} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                                </a>
                              ))}
                            </div>
                          </div>
                        );
                      })}
                    </>
                  )}
                </div>
              );
            })}
          </div>

          {filteredJobs.length === 0 && (
            <div style={{ textAlign: "center", padding: "80px 0", ...mono(13, { color: "var(--muted)" }) }}>
              {search || filter !== "all" ? "No matching jobs." : "No jobs yet."}{" "}
              <Link href="/upload" style={{ color: "var(--accent)" }}>Create one →</Link>
            </div>
          )}
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════════
         ██ ORDERS TAB
         ══════════════════════════════════════════════════════════════════════ */}
      {tab === "orders" && (
        <div>
          <div style={card()}>
            <p style={{ ...mono(10, { letterSpacing: 3, color: "var(--accent)", marginBottom: 20 }) }}>PAYMENT HISTORY</p>
            {orders.length === 0 ? (
              <p style={{ ...mono(12, { color: "var(--muted)", textAlign: "center", padding: "40px 0" }) }}>
                No orders yet. Payments will appear here once Stripe is connected.
              </p>
            ) : (
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--border)" }}>
                    {["Order", "Job", "Customer", "Amount", "Status", "Date"].map(h => (
                      <th key={h} style={{ ...mono(9, { letterSpacing: 2, color: "var(--muted)", textAlign: "left", padding: "8px 12px" }) }}>
                        {h.toUpperCase()}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {orders.map(o => (
                    <tr key={o.id} style={{ borderBottom: "1px solid var(--border)" }}>
                      <td style={{ ...mono(11, { padding: "10px 12px", color: "var(--text)" }) }}>#{o.id}</td>
                      <td style={{ ...mono(10, { padding: "10px 12px", color: "var(--muted)" }) }}>{o.jobId.slice(0, 8)}...</td>
                      <td style={{ ...mono(11, { padding: "10px 12px", color: "var(--text)" }) }}>{o.customerEmail || "—"}</td>
                      <td style={{ ...mono(11, { padding: "10px 12px", color: "var(--accent)" }) }}>{formatCurrency(o.amountCents)}</td>
                      <td style={{ padding: "10px 12px" }}>
                        <span style={{
                          ...mono(9, { letterSpacing: 1 }),
                          color: o.status === "paid" ? "#6abf8a" : o.status === "refunded" ? "#e05a5a" : "#c9a96e",
                          border: `1px solid ${o.status === "paid" ? "#6abf8a" : o.status === "refunded" ? "#e05a5a" : "#c9a96e"}`,
                          padding: "2px 8px",
                        }}>
                          {o.status.toUpperCase()}
                        </span>
                      </td>
                      <td style={{ ...mono(10, { padding: "10px 12px", color: "var(--muted)" }) }}>{formatDate(o.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════════
         ██ AUDIT LOG TAB
         ══════════════════════════════════════════════════════════════════════ */}
      {tab === "audit" && (
        <div style={card()}>
          <p style={{ ...mono(10, { letterSpacing: 3, color: "var(--accent)", marginBottom: 20 }) }}>AUDIT LOG</p>
          {audit.length === 0 ? (
            <p style={{ ...mono(12, { color: "var(--muted)", textAlign: "center", padding: "40px 0" }) }}>
              No actions logged yet.
            </p>
          ) : (
            <div>
              {audit.map(entry => (
                <div key={entry.id} style={{ display: "flex", gap: 16, padding: "10px 0", borderBottom: "1px solid var(--border)", alignItems: "center" }}>
                  <span style={{ ...mono(10, { color: "var(--muted)", minWidth: 100 }) }}>
                    {formatDate(entry.createdAt)} {formatTime(entry.createdAt)}
                  </span>
                  <span style={{ ...mono(10, { color: "var(--accent)", minWidth: 120 }) }}>{entry.action}</span>
                  <span style={{ ...mono(11, { color: "var(--text)", flex: 1 }) }}>{entry.detail || "—"}</span>
                  {entry.jobId && (
                    <span style={{ ...mono(9, { color: "var(--muted)" }) }}>{entry.jobId.slice(0, 8)}...</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════════
         ██ SETTINGS TAB
         ══════════════════════════════════════════════════════════════════════ */}
      {tab === "settings" && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24, maxWidth: 900 }}>

          {/* Generation settings */}
          <div style={card({ gridColumn: "1 / -1" })}>
            <p style={{ ...mono(10, { letterSpacing: 3, color: "var(--accent)", marginBottom: 20 }) }}>GENERATION SETTINGS</p>
            <div style={{ display: "flex", alignItems: "flex-end", gap: 24, flexWrap: "wrap" }}>
              <div style={{ flex: 1, minWidth: 200 }}>
                <p style={{ ...mono(10, { color: "var(--muted)", marginBottom: 8 }) }}>
                  IMAGES PER BATCH
                </p>
                <p style={{ ...mono(11, { color: "var(--muted)", marginBottom: 12 }) }}>
                  Total images generated per job — applies to both Fast and Premium tiers.
                </p>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <input
                    type="number"
                    min={1}
                    max={20}
                    value={genSettings.images_per_batch}
                    onChange={e => setGenSettings(s => ({ ...s, images_per_batch: e.target.value }))}
                    style={{
                      width: 80,
                      padding: "10px 12px",
                      background: "var(--bg)",
                      border: "1px solid var(--border)",
                      color: "var(--text)",
                      fontFamily: "var(--font-mono)",
                      fontSize: 18,
                      textAlign: "center",
                    }}
                  />
                  <span style={{ ...mono(11, { color: "var(--muted)" }) }}>
                    images total per job
                  </span>
                </div>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {[1, 2, 3, 5, 10, 15].map(n => (
                    <button
                      key={n}
                      onClick={() => setGenSettings(s => ({ ...s, images_per_batch: String(n) }))}
                      style={{
                        ...mono(11),
                        padding: "8px 16px",
                        background: genSettings.images_per_batch === String(n) ? "var(--accent)" : "var(--surface)",
                        color: genSettings.images_per_batch === String(n) ? "#0a0a0a" : "var(--muted)",
                        border: `1px solid ${genSettings.images_per_batch === String(n) ? "var(--accent)" : "var(--border)"}`,
                        cursor: "pointer",
                      }}
                    >
                      {n}
                    </button>
                  ))}
                </div>
                <button
                  onClick={saveGenSettings}
                  disabled={settingsSaving}
                  style={{
                    ...mono(12, { letterSpacing: 2 }),
                    padding: "12px 24px",
                    background: settingsSaved ? "#6abf8a" : "var(--accent)",
                    color: "#0a0a0a",
                    border: "none",
                    cursor: settingsSaving ? "not-allowed" : "pointer",
                    transition: "background 0.3s",
                  }}
                >
                  {settingsSaved ? "✓ SAVED" : settingsSaving ? "SAVING..." : "SAVE"}
                </button>
              </div>
            </div>
          </div>

          {/* API Keys */}
          <div style={card()}>
            <p style={{ ...mono(10, { letterSpacing: 3, color: "var(--accent)", marginBottom: 20 }) }}>API KEYS</p>
            <div style={{ marginBottom: 16 }}>
              <p style={{ ...mono(10, { color: "var(--muted)", marginBottom: 6 }) }}>FAL.AI</p>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{ ...mono(12, { color: process.env.NEXT_PUBLIC_FAL_KEY ? "#6abf8a" : "var(--muted)", flex: 1 }) }}>
                  {process.env.FAL_KEY ? "●●●●●●●● (configured in .env.local)" : "Not configured"}
                </div>
              </div>
            </div>
            <div style={{ marginBottom: 16 }}>
              <p style={{ ...mono(10, { color: "var(--muted)", marginBottom: 6 }) }}>STRIPE</p>
              <p style={{ ...mono(12, { color: "var(--muted)" }) }}>
                {process.env.STRIPE_SECRET_KEY ? "Connected" : "Not configured — add keys to .env.local"}
              </p>
            </div>
            <div>
              <p style={{ ...mono(10, { color: "var(--muted)", marginBottom: 6 }) }}>DATABASE</p>
              <p style={{ ...mono(12, { color: "#6abf8a" }) }}>PostgreSQL (Docker)</p>
            </div>
          </div>

          {/* System info */}
          <div style={card()}>
            <p style={{ ...mono(10, { letterSpacing: 3, color: "var(--accent)", marginBottom: 20 }) }}>SYSTEM</p>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {[
                ["App", "Portraly.AI v0.1.0"],
                ["Framework", "Next.js 14"],
                ["Database", "PostgreSQL 16 (Drizzle ORM)"],
                ["AI Engine", "fal.ai (Flux LoRA)"],
                ["Pricing", "$59 per batch"],
                ["Styles", `${STYLES.length} (${STYLES.map(s => s.label).join(", ")})`],
                ["Images/Style", String(IMAGES_PER_STYLE)],
              ].map(([label, value]) => (
                <div key={label} style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ ...mono(10, { color: "var(--muted)" }) }}>{label}</span>
                  <span style={{ ...mono(11, { color: "var(--text)" }) }}>{value}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Quick actions */}
          <div style={card({ gridColumn: "1 / -1" })}>
            <p style={{ ...mono(10, { letterSpacing: 3, color: "var(--accent)", marginBottom: 20 }) }}>QUICK ACTIONS</p>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              <Link href="/upload" style={{ ...mono(11, { letterSpacing: 2, color: "var(--accent)", border: "1px solid var(--accent)", padding: "12px 24px", textDecoration: "none" }) }}>
                + NEW JOB
              </Link>
              <button onClick={refreshAll} style={{ ...mono(11, { letterSpacing: 2, color: "var(--muted)", border: "1px solid var(--border)", padding: "12px 24px", background: "none", cursor: "pointer" }) }}>
                REFRESH ALL DATA
              </button>
              <button
                onClick={async () => {
                  const active = jobs.filter(j => j.status === "training" || j.status === "generating");
                  if (active.length === 0) return alert("No active jobs to poll.");
                  await pollActive();
                  alert(`Polled ${active.length} active job(s).`);
                }}
                style={{ ...mono(11, { letterSpacing: 2, color: "#a8c96b", border: "1px solid #a8c96b", padding: "12px 24px", background: "none", cursor: "pointer" }) }}
              >
                POLL ACTIVE JOBS
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
