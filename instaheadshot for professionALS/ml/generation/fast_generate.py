#!/usr/bin/env python3
"""
Fast headshot generation using IP-Adapter (no LoRA training required).
Takes a reference face photo and generates headshots in multiple styles.

Uses SD 1.5 + IP-Adapter full-face model — runs locally on Apple Silicon (MPS).
Models are downloaded from HuggingFace on first run (~2 GB total), cached after.

Usage:
    python fast_generate.py \
        --face_image ./uploads/job_abc/photo_1.jpg \
        --output_dir  ./outputs/job_abc/fast_batch \
        --styles corporate linkedin creative \
        --images_per_style 1 \
        --gender man
"""

import argparse
import json
import os
import sys
import time
import logging
from pathlib import Path

import torch
from PIL import Image
from PIL import ImageStat
from PIL import ImageChops, ImageFilter

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Style definitions
# ---------------------------------------------------------------------------

FAST_STYLES = {
    "corporate": (
        "professional corporate headshot, {GENDER}, tailored dark charcoal suit, "
        "white dress shirt, neutral grey studio backdrop, even studio lighting, "
        "sharp focus, photorealistic, 8k"
    ),
    "linkedin": (
        "LinkedIn profile photo, {GENDER}, business casual attire, "
        "clean white studio background, bright even lighting, "
        "genuine warm smile, photorealistic, 8k"
    ),
    "creative": (
        "modern creative professional headshot, {GENDER}, stylish outfit, "
        "soft urban bokeh background, natural window light, "
        "relaxed expression, editorial style, photorealistic, 8k"
    ),
    "executive": (
        "executive portrait, {GENDER}, premium dark suit, "
        "dramatic studio lighting with rim light, dark gradient background, "
        "confident expression, cinematic, photorealistic, 8k"
    ),
    "casual": (
        "friendly approachable headshot, {GENDER}, smart casual outfit, "
        "warm blurred outdoor background, natural golden hour light, "
        "genuine smile, photorealistic, 8k"
    ),
}

NEGATIVE_PROMPT = (
    "deformed, ugly, bad anatomy, bad face, blurry, low quality, "
    "out of frame, watermark, text, extra fingers, mutation, duplicate face"
)

# ---------------------------------------------------------------------------
# Pipeline (module-level cache — warm across calls if used as a long-running process)
# ---------------------------------------------------------------------------

_pipes = {}


def get_device():
    if torch.backends.mps.is_available():
        return "mps"
    if torch.cuda.is_available():
        return "cuda"
    return "cpu"


def load_pipeline():
    return load_pipeline_for_device(get_device())


def load_pipeline_for_device(device: str):
    global _pipes
    if device in _pipes:
        return _pipes[device]

    # NOTE: float16 on Apple MPS can yield near-blank/NaN-ish outputs on some setups.
    # Prefer float32 on MPS for correctness, even if it's slower.
    if device == "cuda":
        dtype = torch.float16
    else:
        dtype = torch.float32

    logger.info("[fast-gen] loading SD 1.5 pipeline on %s (%s)...", device, dtype)

    from diffusers import StableDiffusionPipeline, DPMSolverMultistepScheduler

    pipe = StableDiffusionPipeline.from_pretrained(
        "runwayml/stable-diffusion-v1-5",
        torch_dtype=dtype,
        safety_checker=None,
        requires_safety_checker=False,
    )
    # Higher-quality scheduler than DDIM for SD 1.5 (often less grainy at the same steps)
    pipe.scheduler = DPMSolverMultistepScheduler.from_config(pipe.scheduler.config, use_karras_sigmas=True)
    pipe = pipe.to(device)

    logger.info("[fast-gen] loading IP-Adapter full-face weights...")
    pipe.load_ip_adapter(
        "h94/IP-Adapter",
        subfolder="models",
        weight_name="ip-adapter-full-face_sd15.bin",
    )
    pipe.set_ip_adapter_scale(0.7)

    _pipes[device] = pipe
    logger.info("[fast-gen] pipeline ready")
    return _pipes[device]


def looks_blank(img: Image.Image) -> bool:
    """Heuristic: near-uniform images (often black/brown) are treated as failed generations."""
    try:
        stat = ImageStat.Stat(img.convert("RGB"))
        # Sum variance across RGB channels
        variance = sum(stat.var)
        return variance < 5.0
    except Exception:
        return False


def looks_noisy(img: Image.Image) -> bool:
    """Heuristic: detect TV-static-like outputs (very high-frequency noise)."""
    try:
        g = img.convert("L").resize((128, 128))
        blurred = g.filter(ImageFilter.GaussianBlur(radius=2))
        diff = ImageChops.difference(g, blurred)
        diff_rms = ImageStat.Stat(diff).rms[0]
        base_rms = ImageStat.Stat(g).rms[0] or 1.0
        # If almost all energy is high-frequency, it's likely static/noise.
        return (diff_rms / base_rms) > 0.85 and diff_rms > 35
    except Exception:
        return False


# ---------------------------------------------------------------------------
# Generation
# ---------------------------------------------------------------------------

def generate(
    face_image_path: str,
    output_dir: str,
    styles: list,
    images_per_style: int = 1,
    gender: str = "man",
    num_inference_steps: int = 40,
    guidance_scale: float = 6.0,
):
    device = get_device()
    pipe = load_pipeline_for_device(device)

    face_img = Image.open(face_image_path).convert("RGB").resize((512, 512))
    Path(output_dir).mkdir(parents=True, exist_ok=True)

    gender_word = "woman" if gender == "woman" else "man"
    total = len(styles) * images_per_style
    done = 0

    status_file = Path(output_dir) / "fast_status.json"
    status_file.write_text(json.dumps({"status": "generating", "progress": 0, "total": total}))

    for style_key in styles:
        if style_key not in FAST_STYLES:
            logger.warning("[fast-gen] unknown style '%s', skipping", style_key)
            continue

        prompt = FAST_STYLES[style_key].replace("{GENDER}", gender_word)
        style_dir = Path(output_dir) / style_key
        style_dir.mkdir(exist_ok=True)

        logger.info("[fast-gen] style: %s", style_key)

        for i in range(images_per_style):
            result = pipe(
                prompt=prompt,
                negative_prompt=NEGATIVE_PROMPT,
                ip_adapter_image=face_img,
                num_inference_steps=num_inference_steps,
                guidance_scale=guidance_scale,
                height=768,
                width=512,
            )
            img = result.images[0]

            # If MPS produced a near-blank image, retry on CPU for correctness.
            if device == "mps" and (looks_blank(img) or looks_noisy(img)):
                logger.warning("[fast-gen] MPS output looks bad (blank/noisy); retrying this image on CPU (slower but reliable)")
                cpu_pipe = load_pipeline_for_device("cpu")
                result = cpu_pipe(
                    prompt=prompt,
                    negative_prompt=NEGATIVE_PROMPT,
                    ip_adapter_image=face_img,
                    num_inference_steps=num_inference_steps,
                    guidance_scale=guidance_scale,
                    height=768,
                    width=512,
                )
                img = result.images[0]

            out_path = style_dir / f"{style_key}_{i + 1}.png"
            img.save(out_path, "PNG")
            logger.info("[fast-gen] saved %s", out_path)

            done += 1
            status_file.write_text(json.dumps({
                "status": "generating",
                "progress": round(done / total * 100),
                "completed": done,
                "total": total,
                "current_style": style_key,
            }))

            if device == "mps":
                torch.mps.empty_cache()

    status_file.write_text(json.dumps({"status": "completed", "progress": 100, "total": total}))
    logger.info("[fast-gen] done — %d images in %s", done, output_dir)
    return output_dir


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Fast headshot generation via IP-Adapter")
    parser.add_argument("--face_image", required=True, help="Path to reference face photo")
    parser.add_argument("--output_dir", required=True, help="Where to save generated images")
    parser.add_argument("--styles", nargs="+", default=["corporate", "linkedin", "creative"],
                        choices=list(FAST_STYLES.keys()))
    parser.add_argument("--images_per_style", type=int, default=1)
    parser.add_argument("--gender", default="man", choices=["man", "woman"])
    parser.add_argument("--steps", type=int, default=40)
    parser.add_argument("--guidance_scale", type=float, default=6.0)
    args = parser.parse_args()

    generate(
        face_image_path=args.face_image,
        output_dir=args.output_dir,
        styles=args.styles,
        images_per_style=args.images_per_style,
        gender=args.gender,
        num_inference_steps=args.steps,
        guidance_scale=args.guidance_scale,
    )


if __name__ == "__main__":
    main()
