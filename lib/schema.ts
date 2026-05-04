// lib/schema.ts — Drizzle ORM schema for Portraly.AI
import {
  pgTable, serial, text, integer, boolean, timestamp, numeric, jsonb,
} from "drizzle-orm/pg-core";

// ─── Jobs ──────────────────────────────────────────────────────────────────────
export const jobs = pgTable("jobs", {
  id:                text("id").primaryKey(),                      // UUID
  status:            text("status").notNull().default("uploading"),// uploading | training | generating | ready | error
  createdAt:         timestamp("created_at").defaultNow().notNull(),
  updatedAt:         timestamp("updated_at").defaultNow().notNull(),
  photoCount:        integer("photo_count").notNull().default(0),
  triggerWord:       text("trigger_word").notNull(),
  gender:            text("gender").notNull().default("man"),      // man | woman
  tier:              text("tier").notNull().default("premium"),    // fast | premium
  // fal.ai state
  trainingRequestId: text("training_request_id"),
  loraUrl:           text("lora_url"),
  // Output
  headshots:         jsonb("headshots").$type<string[]>(),         // array of image paths/URLs
  error:             text("error"),
  // Customer info (when Stripe is connected)
  customerEmail:     text("customer_email"),
  customerName:      text("customer_name"),
  paid:              boolean("paid").default(false),
  stripeSessionId:   text("stripe_session_id"),
  // Delivery
  downloadCount:     integer("download_count").default(0),
  lastDownloadedAt:  timestamp("last_downloaded_at"),
});

// ─── Users (admin accounts) ────────────────────────────────────────────────────
export const users = pgTable("users", {
  id:           serial("id").primaryKey(),
  email:        text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  displayName:  text("display_name"),
  role:         text("role").notNull().default("admin"),           // admin | superadmin
  createdAt:    timestamp("created_at").defaultNow().notNull(),
  lastLoginAt:  timestamp("last_login_at"),
});

// ─── Orders (Stripe payments) ──────────────────────────────────────────────────
export const orders = pgTable("orders", {
  id:               serial("id").primaryKey(),
  jobId:            text("job_id").notNull(),
  stripeSessionId:  text("stripe_session_id"),
  stripePaymentId:  text("stripe_payment_id"),
  customerEmail:    text("customer_email"),
  customerName:     text("customer_name"),
  amountCents:      integer("amount_cents").notNull().default(5900),
  currency:         text("currency").default("usd"),
  status:           text("status").notNull().default("pending"),   // pending | paid | refunded | failed
  createdAt:        timestamp("created_at").defaultNow().notNull(),
  paidAt:           timestamp("paid_at"),
  refundedAt:       timestamp("refunded_at"),
});

// ─── App settings (key-value) ──────────────────────────────────────────────────
export const appSettings = pgTable("app_settings", {
  key:   text("key").primaryKey(),
  value: text("value").notNull(),
});

// ─── Audit log ─────────────────────────────────────────────────────────────────
export const auditLog = pgTable("audit_log", {
  id:        serial("id").primaryKey(),
  action:    text("action").notNull(),
  detail:    text("detail"),
  userId:    integer("user_id"),
  jobId:     text("job_id"),
  ip:        text("ip"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
