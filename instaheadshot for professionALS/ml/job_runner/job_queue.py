#!/usr/bin/env python3
"""
InstaHeadshot — Job Queue for Training & Generation
SQLite-backed queue that runs on your M4 Mac. No Redis, no external deps.

The queue runs as a background process and picks up jobs sequentially
(your Mac can only train one LoRA at a time on the GPU).

Usage:
    # Start the worker (runs forever, processing jobs one at a time)
    python job_queue.py worker

    # Submit a training job
    python job_queue.py submit-train --user_id user_123 --photos_dir ./uploads/user_123

    # Submit a generation job
    python job_queue.py submit-generate --user_id user_123 --batch_id batch_1 --styles corporate creative casual

    # Check job status
    python job_queue.py status --job_id <job_id>
"""

import argparse
import json
import os
import signal
import sqlite3
import subprocess
import sys
import time
import uuid
import logging
from pathlib import Path
from datetime import datetime
from typing import Optional, List, Dict

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

BASE_DIR = Path(__file__).resolve().parent.parent  # ml/
DB_PATH = BASE_DIR / "data" / "job_queue.db"
MODELS_DIR = BASE_DIR / "data" / "models"
OUTPUTS_DIR = BASE_DIR / "data" / "outputs"
UPLOADS_DIR = BASE_DIR / "data" / "uploads"

TRAINING_SCRIPT = BASE_DIR / "training" / "train_lora.py"
GENERATION_SCRIPT = BASE_DIR / "generation" / "generate_headshots.py"
FAST_SCRIPT = BASE_DIR / "generation" / "fast_generate.py"

# How often the worker checks for new jobs (seconds)
POLL_INTERVAL = 2


# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------

def init_db():
    """Initialize the SQLite database with job tables."""
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    conn.execute("""
        CREATE TABLE IF NOT EXISTS jobs (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            job_type TEXT NOT NULL,  -- 'train' or 'generate'
            status TEXT NOT NULL DEFAULT 'queued',  -- queued, running, completed, failed
            priority INTEGER DEFAULT 0,
            payload TEXT NOT NULL,  -- JSON config
            result TEXT,  -- JSON result
            error TEXT,
            created_at TEXT NOT NULL,
            started_at TEXT,
            completed_at TEXT,
            pid INTEGER
        )
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status)
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_jobs_user ON jobs(user_id)
    """)

    # User LoRA tracking
    conn.execute("""
        CREATE TABLE IF NOT EXISTS user_models (
            user_id TEXT PRIMARY KEY,
            lora_path TEXT NOT NULL,
            trained_at TEXT NOT NULL,
            training_job_id TEXT NOT NULL,
            instance_prompt TEXT NOT NULL,
            num_images_trained INTEGER,
            FOREIGN KEY (training_job_id) REFERENCES jobs(id)
        )
    """)

    # Batch tracking
    conn.execute("""
        CREATE TABLE IF NOT EXISTS batches (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            batch_number INTEGER NOT NULL,
            generation_job_id TEXT,
            styles TEXT NOT NULL,  -- JSON array
            status TEXT NOT NULL DEFAULT 'pending',
            output_dir TEXT,
            created_at TEXT NOT NULL,
            completed_at TEXT,
            FOREIGN KEY (generation_job_id) REFERENCES jobs(id)
        )
    """)

    conn.commit()
    return conn


def get_db():
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    return conn


# ---------------------------------------------------------------------------
# Job submission
# ---------------------------------------------------------------------------

def submit_training_job(
    user_id: str,
    photos_dir: str,
    instance_prompt: str = "a photo of sks person",
    steps: int = 1000,
    resolution: int = 512,
    lora_rank: int = 16,
    learning_rate: float = 1e-4,
    priority: int = 0,
) -> str:
    """Submit a LoRA training job to the queue. Returns job ID."""
    job_id = f"train_{user_id}_{uuid.uuid4().hex[:8]}"
    output_dir = str(MODELS_DIR / user_id)

    payload = {
        "instance_dir": photos_dir,
        "output_dir": output_dir,
        "instance_prompt": instance_prompt,
        "steps": steps,
        "resolution": resolution,
        "lora_rank": lora_rank,
        "learning_rate": learning_rate,
    }

    conn = get_db()
    conn.execute(
        """INSERT INTO jobs (id, user_id, job_type, status, priority, payload, created_at)
           VALUES (?, ?, 'train', 'queued', ?, ?, ?)""",
        (job_id, user_id, priority, json.dumps(payload), datetime.now().isoformat()),
    )
    conn.commit()
    conn.close()

    logger.info("Submitted training job %s for user %s", job_id, user_id)
    return job_id


def submit_generation_job(
    user_id: str,
    batch_id: str,
    styles: Optional[List[str]] = None,
    images_per_style: int = 3,
    guidance_scale: float = 7.5,
    inference_steps: int = 30,
    resolution: int = 512,
    seed: Optional[int] = None,
    priority: int = 0,
) -> str:
    """Submit a headshot generation job. Requires existing LoRA for the user."""
    if styles is None:
        styles = ["corporate", "creative", "casual"]

    conn = get_db()

    # Check user has a trained model
    model = conn.execute(
        "SELECT lora_path FROM user_models WHERE user_id = ?", (user_id,)
    ).fetchone()

    if not model:
        conn.close()
        raise ValueError(f"No trained model found for user {user_id}. Train first.")

    lora_path = model["lora_path"]
    job_id = f"gen_{user_id}_{batch_id}_{uuid.uuid4().hex[:8]}"
    output_dir = str(OUTPUTS_DIR / user_id / batch_id)

    payload = {
        "lora_dir": lora_path,
        "output_dir": output_dir,
        "styles": styles,
        "images_per_style": images_per_style,
        "guidance_scale": guidance_scale,
        "inference_steps": inference_steps,
        "resolution": resolution,
        "seed": seed,
    }

    conn.execute(
        """INSERT INTO jobs (id, user_id, job_type, status, priority, payload, created_at)
           VALUES (?, ?, 'generate', 'queued', ?, ?, ?)""",
        (job_id, user_id, priority, json.dumps(payload), datetime.now().isoformat()),
    )

    # Create batch record
    conn.execute(
        """INSERT INTO batches (id, user_id, batch_number, generation_job_id, styles, status, output_dir, created_at)
           VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)""",
        (
            batch_id, user_id,
            _next_batch_number(conn, user_id),
            job_id, json.dumps(styles), output_dir,
            datetime.now().isoformat(),
        ),
    )

    conn.commit()
    conn.close()

    logger.info("Submitted generation job %s (batch %s) for user %s", job_id, batch_id, user_id)
    return job_id


def submit_fast_job(
    user_id: str,
    batch_id: str,
    face_image_path: str,
    styles: Optional[List[str]] = None,
    images_per_style: int = 1,
    gender: str = "man",
    priority: int = 1,  # higher than standard jobs so fast tier doesn't wait behind training
) -> str:
    """Submit a fast headshot generation job (IP-Adapter, no LoRA required)."""
    if styles is None:
        styles = ["corporate", "linkedin", "creative"]

    job_id = f"fast_{user_id}_{batch_id}_{uuid.uuid4().hex[:8]}"
    output_dir = str(OUTPUTS_DIR / user_id / batch_id)

    payload = {
        "face_image_path": face_image_path,
        "output_dir": output_dir,
        "styles": styles,
        "images_per_style": images_per_style,
        "gender": gender,
    }

    conn = get_db()
    conn.execute(
        """INSERT INTO jobs (id, user_id, job_type, status, priority, payload, created_at)
           VALUES (?, ?, 'fast_generate', 'queued', ?, ?, ?)""",
        (job_id, user_id, priority, json.dumps(payload), datetime.now().isoformat()),
    )
    conn.commit()
    conn.close()

    logger.info("Submitted fast_generate job %s for user %s", job_id, user_id)
    return job_id


def _next_batch_number(conn, user_id: str) -> int:
    row = conn.execute(
        "SELECT MAX(batch_number) as n FROM batches WHERE user_id = ?", (user_id,)
    ).fetchone()
    return (row["n"] or 0) + 1


# ---------------------------------------------------------------------------
# Job status
# ---------------------------------------------------------------------------

def get_job_status(job_id: str) -> Optional[Dict]:
    """Get current status of a job."""
    conn = get_db()
    row = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
    conn.close()

    if not row:
        return None

    result = dict(row)
    result["payload"] = json.loads(result["payload"]) if result["payload"] else None
    result["result"] = json.loads(result["result"]) if result["result"] else None

    # If running, try to read live progress from status file
    if result["status"] == "running" and result["payload"]:
        output_dir = result["payload"].get("output_dir")
        if output_dir:
            status_file = Path(output_dir) / (
                "training_status.json" if result["job_type"] == "train" else "generation_status.json"
            )
            if status_file.exists():
                try:
                    result["live_progress"] = json.loads(status_file.read_text())
                except json.JSONDecodeError:
                    pass

    return result


def get_user_jobs(user_id: str) -> List[Dict]:
    """Get all jobs for a user."""
    conn = get_db()
    rows = conn.execute(
        "SELECT * FROM jobs WHERE user_id = ? ORDER BY created_at DESC", (user_id,)
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_queue_status() -> dict:
    """Get overall queue statistics."""
    conn = get_db()
    stats = {}
    for status in ["queued", "running", "completed", "failed"]:
        row = conn.execute(
            "SELECT COUNT(*) as n FROM jobs WHERE status = ?", (status,)
        ).fetchone()
        stats[status] = row["n"]
    conn.close()
    return stats


# ---------------------------------------------------------------------------
# Worker
# ---------------------------------------------------------------------------

def run_training_job(job: dict) -> dict:
    """Execute a training job."""
    payload = json.loads(job["payload"])

    cmd = [
        sys.executable, str(TRAINING_SCRIPT),
        "--instance_dir", payload["instance_dir"],
        "--output_dir", payload["output_dir"],
        "--instance_prompt", payload.get("instance_prompt", "a photo of sks person"),
        "--steps", str(payload.get("steps", 1000)),
        "--resolution", str(payload.get("resolution", 512)),
        "--lora_rank", str(payload.get("lora_rank", 16)),
        "--lr", str(payload.get("learning_rate", 1e-4)),
    ]

    logger.info("Running: %s", " ".join(cmd))
    result = subprocess.run(cmd, capture_output=True, text=True)

    if result.returncode != 0:
        raise RuntimeError(f"Training failed:\nSTDOUT: {result.stdout[-500:]}\nSTDERR: {result.stderr[-500:]}")

    lora_path = str(Path(payload["output_dir"]) / "lora_weights")

    # Register the trained model
    conn = get_db()
    conn.execute(
        """INSERT OR REPLACE INTO user_models (user_id, lora_path, trained_at, training_job_id, instance_prompt, num_images_trained)
           VALUES (?, ?, ?, ?, ?, ?)""",
        (
            job["user_id"], lora_path, datetime.now().isoformat(),
            job["id"], payload.get("instance_prompt", "a photo of sks person"),
            len(list(Path(payload["instance_dir"]).iterdir())),
        ),
    )
    conn.commit()
    conn.close()

    return {"lora_path": lora_path, "stdout": result.stdout[-200:]}


def run_generation_job(job: dict) -> dict:
    """Execute a generation job."""
    payload = json.loads(job["payload"])

    cmd = [
        sys.executable, str(GENERATION_SCRIPT),
        "--lora_dir", payload["lora_dir"],
        "--output_dir", payload["output_dir"],
        "--styles", *payload.get("styles", ["corporate", "creative", "casual"]),
        "--images_per_style", str(payload.get("images_per_style", 3)),
        "--guidance_scale", str(payload.get("guidance_scale", 7.5)),
        "--steps", str(payload.get("inference_steps", 30)),
        "--resolution", str(payload.get("resolution", 512)),
    ]

    if payload.get("seed") is not None:
        cmd.extend(["--seed", str(payload["seed"])])

    logger.info("Running: %s", " ".join(cmd))
    result = subprocess.run(cmd, capture_output=True, text=True)

    if result.returncode != 0:
        raise RuntimeError(f"Generation failed:\nSTDOUT: {result.stdout[-500:]}\nSTDERR: {result.stderr[-500:]}")

    # Update batch status
    conn = get_db()
    conn.execute(
        "UPDATE batches SET status = 'completed', completed_at = ? WHERE generation_job_id = ?",
        (datetime.now().isoformat(), job["id"]),
    )
    conn.commit()
    conn.close()

    # Read the manifest
    manifest_path = Path(payload["output_dir"]) / "batch_manifest.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}

    return {"output_dir": payload["output_dir"], "manifest": manifest}


def run_fast_job(job: dict) -> dict:
    """Execute a fast headshot generation job via IP-Adapter."""
    payload = json.loads(job["payload"])

    output_dir = payload.get("output_dir")
    if output_dir:
        try:
            Path(output_dir).mkdir(parents=True, exist_ok=True)
        except Exception:
            output_dir = None

    cmd = [
        sys.executable, str(FAST_SCRIPT),
        "--face_image", payload["face_image_path"],
        "--output_dir",  payload["output_dir"],
        "--styles",      *payload.get("styles", ["corporate", "linkedin", "creative"]),
        "--images_per_style", str(payload.get("images_per_style", 1)),
        "--gender",      payload.get("gender", "man"),
    ]

    logger.info("Running: %s", " ".join(cmd))
    result = subprocess.run(cmd, capture_output=True, text=True)

    if result.returncode != 0:
        # Persist full logs for debugging (stderr often exceeds our truncation window).
        if output_dir:
            try:
                (Path(output_dir) / "fast_stdout.log").write_text(result.stdout or "")
                (Path(output_dir) / "fast_stderr.log").write_text(result.stderr or "")
            except Exception:
                pass
        raise RuntimeError(
            f"Fast generation failed:\nSTDOUT: {result.stdout[-2000:]}\nSTDERR: {result.stderr[-2000:]}"
        )

    return {"output_dir": payload["output_dir"]}


def worker_loop():
    """Main worker loop — picks up jobs one at a time and processes them."""
    logger.info("Worker started. Polling for jobs every %ds...", POLL_INTERVAL)
    logger.info("Queue DB: %s", DB_PATH)

    running = True

    def handle_shutdown(signum, frame):
        nonlocal running
        logger.info("Shutdown signal received, finishing current job...")
        running = False

    signal.signal(signal.SIGINT, handle_shutdown)
    signal.signal(signal.SIGTERM, handle_shutdown)

    while running:
        conn = get_db()

        # Pick the next queued job (highest priority first, then FIFO)
        job = conn.execute(
            """SELECT * FROM jobs WHERE status = 'queued'
               ORDER BY priority DESC, created_at ASC LIMIT 1"""
        ).fetchone()

        if not job:
            conn.close()
            time.sleep(POLL_INTERVAL)
            continue

        job = dict(job)
        job_id = job["id"]

        # Mark as running
        conn.execute(
            "UPDATE jobs SET status = 'running', started_at = ?, pid = ? WHERE id = ?",
            (datetime.now().isoformat(), os.getpid(), job_id),
        )
        conn.commit()
        conn.close()

        logger.info("Processing job %s (type: %s, user: %s)", job_id, job["job_type"], job["user_id"])

        try:
            if job["job_type"] == "train":
                result = run_training_job(job)
            elif job["job_type"] == "generate":
                result = run_generation_job(job)
            elif job["job_type"] == "fast_generate":
                result = run_fast_job(job)
            else:
                raise ValueError(f"Unknown job type: {job['job_type']}")

            # Mark completed
            conn = get_db()
            conn.execute(
                "UPDATE jobs SET status = 'completed', result = ?, completed_at = ? WHERE id = ?",
                (json.dumps(result), datetime.now().isoformat(), job_id),
            )
            conn.commit()
            conn.close()
            logger.info("Job %s completed successfully", job_id)

        except Exception as e:
            logger.error("Job %s failed: %s", job_id, e, exc_info=True)
            conn = get_db()
            conn.execute(
                "UPDATE jobs SET status = 'failed', error = ?, completed_at = ? WHERE id = ?",
                (str(e), datetime.now().isoformat(), job_id),
            )
            conn.commit()
            conn.close()

    logger.info("Worker shut down cleanly.")


# ---------------------------------------------------------------------------
# HTTP API server (lightweight, runs alongside Next.js)
# ---------------------------------------------------------------------------

def start_api_server(host: str = "127.0.0.1", port: int = 8420):
    """
    Minimal HTTP API for the Next.js app to talk to.
    Endpoints:
        POST /api/train          — submit training job
        POST /api/generate       — submit generation job
        GET  /api/job/:id        — get job status
        GET  /api/user/:id/jobs  — get user's jobs
        GET  /api/queue          — queue stats
        GET  /api/user/:id/model — check if user has trained model
        GET  /api/health         — health check
    """
    from http.server import HTTPServer, BaseHTTPRequestHandler
    import urllib.parse

    init_db()

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            parsed = urllib.parse.urlparse(self.path)
            path = parsed.path.rstrip("/")

            if path == "/api/health":
                self._json(200, {"status": "ok", "queue": get_queue_status()})

            elif path == "/api/queue":
                self._json(200, get_queue_status())

            elif path.startswith("/api/job/"):
                job_id = path.split("/api/job/")[1]
                status = get_job_status(job_id)
                if status:
                    self._json(200, status)
                else:
                    self._json(404, {"error": "Job not found"})

            elif path.startswith("/api/user/") and path.endswith("/jobs"):
                user_id = path.split("/api/user/")[1].replace("/jobs", "")
                jobs = get_user_jobs(user_id)
                self._json(200, {"jobs": jobs})

            elif path.startswith("/api/user/") and path.endswith("/model"):
                user_id = path.split("/api/user/")[1].replace("/model", "")
                conn = get_db()
                model = conn.execute(
                    "SELECT * FROM user_models WHERE user_id = ?", (user_id,)
                ).fetchone()
                conn.close()
                if model:
                    self._json(200, {"has_model": True, **dict(model)})
                else:
                    self._json(200, {"has_model": False})

            else:
                self._json(404, {"error": "Not found"})

        def do_POST(self):
            parsed = urllib.parse.urlparse(self.path)
            path = parsed.path.rstrip("/")

            content_len = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(content_len)) if content_len > 0 else {}

            if path == "/api/train":
                try:
                    user_id = body["user_id"]
                    photos_dir = body["photos_dir"]
                    job_id = submit_training_job(
                        user_id=user_id,
                        photos_dir=photos_dir,
                        instance_prompt=body.get("instance_prompt", "a photo of sks person"),
                        steps=body.get("steps", 1000),
                        resolution=body.get("resolution", 512),
                        lora_rank=body.get("lora_rank", 16),
                        learning_rate=body.get("learning_rate", 1e-4),
                    )
                    self._json(200, {"job_id": job_id, "status": "queued"})
                except (KeyError, ValueError) as e:
                    self._json(400, {"error": str(e)})

            elif path == "/api/generate":
                try:
                    user_id = body["user_id"]
                    batch_id = body.get("batch_id", f"batch_{uuid.uuid4().hex[:8]}")
                    job_id = submit_generation_job(
                        user_id=user_id,
                        batch_id=batch_id,
                        styles=body.get("styles", ["corporate", "creative", "casual"]),
                        images_per_style=body.get("images_per_style", 3),
                        guidance_scale=body.get("guidance_scale", 7.5),
                        inference_steps=body.get("inference_steps", 30),
                        resolution=body.get("resolution", 512),
                        seed=body.get("seed"),
                    )
                    self._json(200, {"job_id": job_id, "batch_id": batch_id, "status": "queued"})
                except (KeyError, ValueError) as e:
                    self._json(400, {"error": str(e)})

            elif path == "/api/fast-generate":
                try:
                    user_id = body["user_id"]
                    batch_id = body.get("batch_id", f"fast_{uuid.uuid4().hex[:8]}")
                    job_id = submit_fast_job(
                        user_id=user_id,
                        batch_id=batch_id,
                        face_image_path=body["face_image_path"],
                        styles=body.get("styles", ["corporate", "linkedin", "creative"]),
                        images_per_style=body.get("images_per_style", 1),
                        gender=body.get("gender", "man"),
                    )
                    self._json(200, {"job_id": job_id, "batch_id": batch_id, "status": "queued"})
                except (KeyError, ValueError) as e:
                    self._json(400, {"error": str(e)})

            else:
                self._json(404, {"error": "Not found"})

        def _json(self, code: int, data: dict):
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(data, default=str).encode())

        def do_OPTIONS(self):
            self.send_response(200)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.end_headers()

        def log_message(self, format, *args):
            logger.info("%s %s", self.client_address[0], format % args)

    server = HTTPServer((host, port), Handler)
    logger.info("API server running on http://%s:%d", host, port)
    server.serve_forever()


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    init_db()

    parser = argparse.ArgumentParser(description="InstaHeadshot Job Queue")
    sub = parser.add_subparsers(dest="command")

    # Worker
    sub.add_parser("worker", help="Start the job worker")

    # API server
    api_parser = sub.add_parser("api", help="Start the HTTP API server")
    api_parser.add_argument("--host", default="127.0.0.1")
    api_parser.add_argument("--port", type=int, default=8420)

    # Submit training
    train_parser = sub.add_parser("submit-train", help="Submit a training job")
    train_parser.add_argument("--user_id", required=True)
    train_parser.add_argument("--photos_dir", required=True)
    train_parser.add_argument("--steps", type=int, default=1000)
    train_parser.add_argument("--prompt", default="a photo of sks person")

    # Submit generation
    gen_parser = sub.add_parser("submit-generate", help="Submit a generation job")
    gen_parser.add_argument("--user_id", required=True)
    gen_parser.add_argument("--batch_id", default=None)
    gen_parser.add_argument("--styles", nargs="+", default=["corporate", "creative", "casual"])

    # Status
    status_parser = sub.add_parser("status", help="Check job status")
    status_parser.add_argument("--job_id", required=True)

    # Queue stats
    sub.add_parser("queue-status", help="Show queue statistics")

    args = parser.parse_args()

    if args.command == "worker":
        worker_loop()
    elif args.command == "api":
        start_api_server(args.host, args.port)
    elif args.command == "submit-train":
        job_id = submit_training_job(
            user_id=args.user_id,
            photos_dir=args.photos_dir,
            steps=args.steps,
            instance_prompt=args.prompt,
        )
        print(json.dumps({"job_id": job_id}, indent=2))
    elif args.command == "submit-generate":
        batch_id = args.batch_id or f"batch_{uuid.uuid4().hex[:8]}"
        job_id = submit_generation_job(
            user_id=args.user_id,
            batch_id=batch_id,
            styles=args.styles,
        )
        print(json.dumps({"job_id": job_id, "batch_id": batch_id}, indent=2))
    elif args.command == "status":
        status = get_job_status(args.job_id)
        print(json.dumps(status, indent=2, default=str))
    elif args.command == "queue-status":
        print(json.dumps(get_queue_status(), indent=2))
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
