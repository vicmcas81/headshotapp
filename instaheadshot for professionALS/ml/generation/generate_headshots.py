#!/usr/bin/env python3
"""
InstaHeadshot — Generate professional headshots using a trained LoRA.
Loads a saved LoRA and runs style-specific prompts to produce batches of headshots.

Usage:
    python generate_headshots.py \
        --lora_dir ./models/user_123/lora_weights \
        --output_dir ./outputs/user_123/batch_1 \
        --styles corporate creative casual
"""

import argparse
import json
import os
import sys
import time
import logging
from pathlib import Path
from datetime import datetime
from typing import Optional, List

import torch
from PIL import Image

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Headshot style definitions
# ---------------------------------------------------------------------------

HEADSHOT_STYLES = {
    "corporate": {
        "name": "Corporate Professional",
        "prompts": [
            "a professional corporate headshot of sks person, wearing a navy blue suit and tie, clean white background, soft studio lighting, sharp focus, high resolution, business portrait, confident expression",
            "a professional executive headshot of sks person, wearing a charcoal gray blazer, neutral gray background, rembrandt lighting, sharp details, LinkedIn profile photo, approachable smile",
        ],
        "negative_prompt": "cartoon, illustration, painting, blurry, low quality, distorted face, extra fingers, watermark, text, logo, casual clothing, messy background",
    },
    "creative": {
        "name": "Creative Professional",
        "prompts": [
            "a modern creative professional headshot of sks person, wearing a smart casual outfit, bokeh background with warm tones, natural lighting, artistic composition, editorial style photography",
            "a stylish creative headshot of sks person, contemporary fashion, minimalist background, dramatic side lighting, high contrast, magazine quality portrait",
        ],
        "negative_prompt": "cartoon, illustration, painting, blurry, low quality, distorted face, extra fingers, watermark, text, logo, overly formal, boring background",
    },
    "casual": {
        "name": "Casual Friendly",
        "prompts": [
            "a warm friendly headshot of sks person, smart casual attire, outdoor setting with blurred greenery background, golden hour natural lighting, genuine smile, approachable and relaxed",
            "a natural casual portrait of sks person, relaxed pose, soft natural background, window light, warm color tones, authentic and personable expression",
        ],
        "negative_prompt": "cartoon, illustration, painting, blurry, low quality, distorted face, extra fingers, watermark, text, logo, formal suit, studio background",
    },
    "startup": {
        "name": "Startup / Tech",
        "prompts": [
            "a modern tech startup headshot of sks person, wearing a clean t-shirt or henley, minimalist white or light gray background, bright even lighting, friendly confident expression, Silicon Valley style",
            "a contemporary tech professional portrait of sks person, casual smart attire, modern office environment blurred background, natural light from large windows, approachable tech leader look",
        ],
        "negative_prompt": "cartoon, illustration, painting, blurry, low quality, distorted face, extra fingers, watermark, text, logo, formal suit, tie, old fashioned",
    },
    "academic": {
        "name": "Academic / Research",
        "prompts": [
            "a professional academic headshot of sks person, wearing business casual with optional glasses, library or office background subtly blurred, warm studio lighting, scholarly and approachable",
            "an intellectual portrait of sks person, smart professional attire, bookshelf background with soft focus, warm directional lighting, thoughtful expression, university faculty style",
        ],
        "negative_prompt": "cartoon, illustration, painting, blurry, low quality, distorted face, extra fingers, watermark, text, logo, too casual, party setting",
    },
    "realtor": {
        "name": "Real Estate Professional",
        "prompts": [
            "a polished real estate agent headshot of sks person, wearing a professional blazer, clean bright background, studio lighting with catchlights, warm trustworthy smile, high-end professional photo",
            "a welcoming realtor portrait of sks person, smart professional attire, soft gradient background, perfect lighting, confident and approachable expression, real estate marketing photo",
        ],
        "negative_prompt": "cartoon, illustration, painting, blurry, low quality, distorted face, extra fingers, watermark, text, logo, casual clothes, messy hair",
    },
}


# ---------------------------------------------------------------------------
# Generation
# ---------------------------------------------------------------------------

def get_device():
    if torch.backends.mps.is_available():
        return torch.device("mps")
    elif torch.cuda.is_available():
        return torch.device("cuda")
    return torch.device("cpu")


def generate_headshots(
    lora_dir: Path,
    output_dir: Path,
    styles: Optional[List[str]] = None,
    images_per_style: int = 3,
    model_name: str = "black-forest-labs/FLUX.1-dev",
    guidance_scale: float = 7.5,
    num_inference_steps: int = 30,
    resolution: int = 512,
    seed: Optional[int] = None,
):
    """
    Generate a batch of headshots using a trained LoRA.

    Args:
        lora_dir: Path to saved LoRA weights
        output_dir: Where to save generated images
        styles: List of style keys (defaults to ["corporate", "creative", "casual"])
        images_per_style: How many images per style
        model_name: Base Flux model
        guidance_scale: CFG scale (higher = more prompt adherence)
        num_inference_steps: Denoising steps (more = better quality, slower)
        resolution: Output image size
        seed: Random seed for reproducibility
    """
    output_dir.mkdir(parents=True, exist_ok=True)
    device = get_device()
    dtype = torch.float32

    if styles is None:
        styles = ["corporate", "creative", "casual"]

    # Validate styles
    for s in styles:
        if s not in HEADSHOT_STYLES:
            raise ValueError(f"Unknown style '{s}'. Available: {list(HEADSHOT_STYLES.keys())}")

    # Status tracking
    status = {
        "status": "loading",
        "started_at": time.time(),
        "styles": styles,
        "total_images": len(styles) * images_per_style,
        "completed_images": 0,
    }
    status_file = output_dir / "generation_status.json"
    status_file.write_text(json.dumps(status, indent=2))

    # Load pipeline
    logger.info("Loading Flux pipeline...")
    from diffusers import FluxPipeline

    pipe = FluxPipeline.from_pretrained(model_name, torch_dtype=dtype)
    pipe.to(device)

    # Load LoRA weights
    logger.info("Loading LoRA weights from %s", lora_dir)
    pipe.load_lora_weights(str(lora_dir))

    # Generate
    generator = torch.Generator(device=device)
    if seed is not None:
        generator.manual_seed(seed)

    results = []
    total_generated = 0

    for style_key in styles:
        style = HEADSHOT_STYLES[style_key]
        style_dir = output_dir / style_key
        style_dir.mkdir(exist_ok=True)

        logger.info("Generating %d images for style: %s", images_per_style, style["name"])

        for i in range(images_per_style):
            prompt = style["prompts"][i % len(style["prompts"])]
            negative = style["negative_prompt"]

            logger.info("  Image %d/%d — %s", i + 1, images_per_style, style_key)

            image = pipe(
                prompt=prompt,
                negative_prompt=negative,
                num_inference_steps=num_inference_steps,
                guidance_scale=guidance_scale,
                height=resolution,
                width=resolution,
                generator=generator,
            ).images[0]

            # Save image
            filename = f"{style_key}_{i + 1}.png"
            filepath = style_dir / filename
            image.save(filepath, "PNG", quality=95)

            total_generated += 1
            result = {
                "style": style_key,
                "style_name": style["name"],
                "filename": filename,
                "path": str(filepath),
                "prompt": prompt,
                "index": i + 1,
            }
            results.append(result)

            # Update status
            status["completed_images"] = total_generated
            status["status"] = "generating"
            status["current_style"] = style_key
            status["progress"] = round(total_generated / status["total_images"] * 100, 1)
            status_file.write_text(json.dumps(status, indent=2))

            # MPS memory cleanup
            if device.type == "mps":
                torch.mps.empty_cache()

    # Final status
    elapsed = time.time() - status["started_at"]
    status["status"] = "completed"
    status["progress"] = 100
    status["elapsed_seconds"] = round(elapsed, 1)
    status["results"] = results
    status_file.write_text(json.dumps(status, indent=2))

    # Save manifest
    manifest = {
        "generated_at": datetime.now().isoformat(),
        "lora_dir": str(lora_dir),
        "model_name": model_name,
        "styles": styles,
        "images_per_style": images_per_style,
        "total_images": total_generated,
        "guidance_scale": guidance_scale,
        "num_inference_steps": num_inference_steps,
        "resolution": resolution,
        "seed": seed,
        "results": results,
    }
    (output_dir / "batch_manifest.json").write_text(json.dumps(manifest, indent=2))

    logger.info(
        "Generation complete! %d images in %dm %ds. Saved to %s",
        total_generated, int(elapsed // 60), int(elapsed % 60), output_dir,
    )

    return results


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Generate headshots from trained LoRA")
    parser.add_argument("--lora_dir", type=str, required=True, help="Path to LoRA weights")
    parser.add_argument("--output_dir", type=str, required=True, help="Where to save generated images")
    parser.add_argument("--styles", nargs="+", default=["corporate", "creative", "casual"],
                        choices=list(HEADSHOT_STYLES.keys()), help="Styles to generate")
    parser.add_argument("--images_per_style", type=int, default=3, help="Images per style")
    parser.add_argument("--model_name", type=str, default="black-forest-labs/FLUX.1-dev")
    parser.add_argument("--guidance_scale", type=float, default=7.5)
    parser.add_argument("--steps", type=int, default=30, help="Inference steps")
    parser.add_argument("--resolution", type=int, default=512)
    parser.add_argument("--seed", type=int, default=None)

    args = parser.parse_args()

    generate_headshots(
        lora_dir=Path(args.lora_dir),
        output_dir=Path(args.output_dir),
        styles=args.styles,
        images_per_style=args.images_per_style,
        model_name=args.model_name,
        guidance_scale=args.guidance_scale,
        num_inference_steps=args.steps,
        resolution=args.resolution,
        seed=args.seed,
    )


if __name__ == "__main__":
    main()
