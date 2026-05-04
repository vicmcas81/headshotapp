// lib/db.ts — PostgreSQL-backed job store (Drizzle ORM)
// Replaces the old JSON file store. Docker Compose spins up Postgres locally.

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq, ne, desc, sql, count, sum, and, gte } from "drizzle-orm";
import * as schema from "./schema";

// ─── Connection ────────────────────────────────────────────────────────────────
const DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgresql://portraly:portraly_dev@localhost:5434/portraly";

const client = postgres(DATABASE_URL, { max: 10, prepare: false });
export const db = drizzle(client, { schema });

// ─── Types ─────────────────────────────────────────────────────────────────────
export type JobStatus =
  | "uploading"
  | "queued_for_batch"
  | "training"
  | "generating"
  | "ready"
  | "error";

export interface Job {
  id: string;
  status: JobStatus;
  createdAt: number;
  photoCount: number;
  triggerWord: string;
  gender: "man" | "woman";
  tier: "fast" | "premium";
  trainingRequestId?: string;
  loraUrl?: string;
  headshots?: string[];
  error?: string;
  customerEmail?: string;
  customerName?: string;
  paid?: boolean;
  stripeSessionId?: string;
  downloadCount?: number;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────
function rowToJob(row: typeof schema.jobs.$inferSelect): Job {
  return {
    id: row.id,
    status: row.status as JobStatus,
    createdAt: row.createdAt.getTime(),
    photoCount: row.photoCount,
    triggerWord: row.triggerWord,
    gender: row.gender as "man" | "woman",
    tier: (row.tier ?? "premium") as "fast" | "premium",
    trainingRequestId: row.trainingRequestId ?? undefined,
    loraUrl: row.loraUrl ?? undefined,
    headshots: (row.headshots as string[]) ?? undefined,
    error: row.error ?? undefined,
    customerEmail: row.customerEmail ?? undefined,
    customerName: row.customerName ?? undefined,
    paid: row.paid ?? false,
    stripeSessionId: row.stripeSessionId ?? undefined,
    downloadCount: row.downloadCount ?? 0,
  };
}

// ─── Public API (same signatures as old JSON store) ────────────────────────────

export async function createJob(
  id: string,
  triggerWord: string,
  photoCount: number,
  gender: "man" | "woman",
  tier: "fast" | "premium" = "premium"
): Promise<Job> {
  const [row] = await db
    .insert(schema.jobs)
    .values({ id, triggerWord, photoCount, gender, tier, status: "uploading" })
    .returning();
  return rowToJob(row);
}

export async function getJob(id: string): Promise<Job | null> {
  const [row] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, id)).limit(1);
  return row ? rowToJob(row) : null;
}

export async function updateJob(id: string, updates: Partial<Job>): Promise<Job> {
  // Map our Job interface back to DB columns
  const dbUpdates: Record<string, any> = { updatedAt: new Date() };
  if (updates.status !== undefined)            dbUpdates.status = updates.status;
  if (updates.trainingRequestId !== undefined) dbUpdates.trainingRequestId = updates.trainingRequestId;
  if (updates.loraUrl !== undefined)           dbUpdates.loraUrl = updates.loraUrl;
  if (updates.headshots !== undefined)         dbUpdates.headshots = updates.headshots;
  if (updates.error !== undefined)             dbUpdates.error = updates.error;
  if (updates.customerEmail !== undefined)     dbUpdates.customerEmail = updates.customerEmail;
  if (updates.customerName !== undefined)      dbUpdates.customerName = updates.customerName;
  if (updates.paid !== undefined)              dbUpdates.paid = updates.paid;
  if (updates.stripeSessionId !== undefined)   dbUpdates.stripeSessionId = updates.stripeSessionId;
  if (updates.downloadCount !== undefined)     dbUpdates.downloadCount = updates.downloadCount;

  const [row] = await db.update(schema.jobs).set(dbUpdates).where(eq(schema.jobs.id, id)).returning();
  if (!row) throw new Error(`Job ${id} not found`);
  return rowToJob(row);
}

export async function getAllJobs(): Promise<Job[]> {
  const rows = await db.select().from(schema.jobs).orderBy(desc(schema.jobs.createdAt));
  return rows.map(rowToJob);
}

export async function deleteJob(id: string): Promise<void> {
  await db.delete(schema.jobs).where(eq(schema.jobs.id, id));
}

export async function deleteNonCompletedJobs(): Promise<number> {
  const deleted = await db
    .delete(schema.jobs)
    .where(ne(schema.jobs.status, "ready"))
    .returning({ id: schema.jobs.id });
  return deleted.length;
}

export async function getQueuedPremiumJobs(limit = 50) {
  const rows = await db
    .select()
    .from(schema.jobs)
    .where(and(eq(schema.jobs.tier, "premium"), eq(schema.jobs.status, "queued_for_batch")))
    .orderBy(desc(schema.jobs.createdAt))
    .limit(limit);
  return rows.map(rowToJob);
}

// ─── Admin stats ───────────────────────────────────────────────────────────────

export async function getJobStats() {
  const [totals] = await db
    .select({
      total:      count(),
      ready:      count(sql`CASE WHEN ${schema.jobs.status} = 'ready' THEN 1 END`),
      training:   count(sql`CASE WHEN ${schema.jobs.status} = 'training' THEN 1 END`),
      generating: count(sql`CASE WHEN ${schema.jobs.status} = 'generating' THEN 1 END`),
      error:      count(sql`CASE WHEN ${schema.jobs.status} = 'error' THEN 1 END`),
      paid:       count(sql`CASE WHEN ${schema.jobs.paid} = true THEN 1 END`),
    })
    .from(schema.jobs);

  return totals;
}

export async function getRevenueStats() {
  const [stats] = await db
    .select({
      totalOrders:  count(),
      totalRevenue: sum(schema.orders.amountCents),
      paidOrders:   count(sql`CASE WHEN ${schema.orders.status} = 'paid' THEN 1 END`),
      refunded:     count(sql`CASE WHEN ${schema.orders.status} = 'refunded' THEN 1 END`),
    })
    .from(schema.orders);

  return {
    totalOrders: Number(stats.totalOrders) || 0,
    totalRevenueCents: Number(stats.totalRevenue) || 0,
    paidOrders: Number(stats.paidOrders) || 0,
    refunded: Number(stats.refunded) || 0,
  };
}

export async function getRecentOrders(limit = 20) {
  return db.select().from(schema.orders).orderBy(desc(schema.orders.createdAt)).limit(limit);
}

// ─── Orders ────────────────────────────────────────────────────────────────────

export async function createOrder(data: typeof schema.orders.$inferInsert) {
  const [row] = await db.insert(schema.orders).values(data).returning();
  return row;
}

export async function updateOrder(id: number, data: Partial<typeof schema.orders.$inferInsert>) {
  const [row] = await db.update(schema.orders).set(data).where(eq(schema.orders.id, id)).returning();
  return row;
}

// ─── Audit log ─────────────────────────────────────────────────────────────────

export async function logAction(action: string, detail?: string, extra?: { userId?: number; jobId?: string; ip?: string }) {
  await db.insert(schema.auditLog).values({
    action,
    detail: detail ?? null,
    userId: extra?.userId ?? null,
    jobId: extra?.jobId ?? null,
    ip: extra?.ip ?? null,
  });
}

export async function getAuditLog(limit = 50) {
  return db.select().from(schema.auditLog).orderBy(desc(schema.auditLog.createdAt)).limit(limit);
}

// ─── App settings ──────────────────────────────────────────────────────────────

export async function getSetting(key: string): Promise<string | null> {
  const [row] = await db.select().from(schema.appSettings).where(eq(schema.appSettings.key, key)).limit(1);
  return row?.value ?? null;
}

export async function setSetting(key: string, value: string) {
  await db
    .insert(schema.appSettings)
    .values({ key, value })
    .onConflictDoUpdate({ target: schema.appSettings.key, set: { value } });
}
