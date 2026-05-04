/**
 * Migration script: moves jobs from data/jobs.json → PostgreSQL
 *
 * Usage:
 *   1. Make sure Docker Compose is running:  docker compose up -d
 *   2. Push schema:                          npm run db:push
 *   3. Run migration:                        npx tsx scripts/migrate-json-to-pg.ts
 */

import fs from "fs";
import path from "path";
import postgres from "postgres";
import dotenv from "dotenv";

dotenv.config({ path: path.resolve(__dirname, "../.env.local") });

const DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgresql://portraly:portraly_dev@localhost:5434/portraly";

async function main() {
  const jsonPath = path.resolve(__dirname, "../data/jobs.json");

  if (!fs.existsSync(jsonPath)) {
    console.log("No data/jobs.json found — nothing to migrate.");
    process.exit(0);
  }

  const raw = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
  const jobEntries = Object.values(raw) as any[];

  if (jobEntries.length === 0) {
    console.log("jobs.json is empty — nothing to migrate.");
    process.exit(0);
  }

  console.log(`Found ${jobEntries.length} jobs to migrate.\n`);

  const sql = postgres(DATABASE_URL, { max: 1 });

  let migrated = 0;
  let skipped = 0;

  for (const job of jobEntries) {
    // Check if already exists
    const existing = await sql`SELECT id FROM jobs WHERE id = ${job.id}`;
    if (existing.length > 0) {
      console.log(`  SKIP  ${job.id} (already exists)`);
      skipped++;
      continue;
    }

    await sql`
      INSERT INTO jobs (
        id, status, created_at, updated_at, photo_count, trigger_word, gender,
        training_request_id, lora_url, headshots, error,
        customer_email, customer_name, paid, stripe_session_id,
        download_count
      ) VALUES (
        ${job.id},
        ${job.status || "uploading"},
        ${new Date(job.createdAt)},
        ${new Date(job.createdAt)},
        ${job.photoCount || 0},
        ${job.triggerWord || "UNKNOWN"},
        ${job.gender || "man"},
        ${job.trainingRequestId || null},
        ${job.loraUrl || null},
        ${job.headshots ? JSON.stringify(job.headshots) : null}::jsonb,
        ${job.error || null},
        ${job.customerEmail || null},
        ${job.customerName || null},
        ${job.paid || false},
        ${job.stripeSessionId || null},
        ${job.downloadCount || 0}
      )
    `;

    console.log(`  OK    ${job.id} (${job.status}, ${job.headshots?.length ?? 0} headshots)`);
    migrated++;
  }

  console.log(`\nDone! Migrated: ${migrated}, Skipped: ${skipped}`);

  // Back up the JSON file
  const backupPath = jsonPath + ".bak";
  fs.copyFileSync(jsonPath, backupPath);
  console.log(`Backup saved to data/jobs.json.bak`);

  await sql.end();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
