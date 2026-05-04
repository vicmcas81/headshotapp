#!/usr/bin/env python3
"""
InstaHeadshot — Local Flux LoRA Training on Apple Silicon (M4)
Uses diffusers + MPS backend. Zero GPU cost.

Usage:
    python train_lora.py \
        --instance_dir ./data/user_123/photos \
        --output_dir ./models/user_123 \
        --instance_prompt "a photo of sks person" \
        --steps 1000 \
        --resolution 512
"""

import argparse
import json
import os
import sys
import time
import logging
from pathlib import Path
from datetime import datetime

import torch
from torch.utils.data import Dataset, DataLoader
from PIL import Image
from torchvision import transforms

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def get_device():
    """Pick the best available device — MPS for Apple Silicon, CUDA, or CPU."""
    if torch.backends.mps.is_available():
        logger.info("Using Apple MPS (Metal Performance Shaders) backend")
        return torch.device("mps")
    elif torch.cuda.is_available():
        logger.info("Using CUDA backend")
        return torch.device("cuda")
    else:
        logger.warning("No GPU detected — falling back to CPU (will be very slow)")
        return torch.device("cpu")


def validate_images(image_dir: Path, min_images: int = 4, max_images: int = 30):
    """Validate training images exist and are readable."""
    supported = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
    images = [f for f in image_dir.iterdir() if f.suffix.lower() in supported]

    if len(images) < min_images:
        raise ValueError(
            f"Need at least {min_images} training images, found {len(images)} in {image_dir}"
        )
    if len(images) > max_images:
        logger.warning(
            f"Found {len(images)} images (max recommended: {max_images}). "
            "Using first %d sorted by name.", max_images
        )
        images = sorted(images)[:max_images]

    # Verify each image opens
    valid = []
    for img_path in images:
        try:
            with Image.open(img_path) as img:
                img.verify()
            valid.append(img_path)
        except Exception as e:
            logger.warning("Skipping corrupt image %s: %s", img_path, e)

    if len(valid) < min_images:
        raise ValueError(
            f"Only {len(valid)} valid images after filtering — need at least {min_images}"
        )

    logger.info("Validated %d training images", len(valid))
    return valid


# ---------------------------------------------------------------------------
# Dataset
# ---------------------------------------------------------------------------

class HeadshotDataset(Dataset):
    """Simple dataset that loads face images and applies training transforms."""

    def __init__(self, image_paths, prompt: str, resolution: int = 512):
        self.image_paths = image_paths
        self.prompt = prompt
        self.transform = transforms.Compose([
            transforms.Resize(resolution, interpolation=transforms.InterpolationMode.LANCZOS),
            transforms.CenterCrop(resolution),
            transforms.RandomHorizontalFlip(p=0.5),
            transforms.ColorJitter(brightness=0.05, contrast=0.05, saturation=0.05),
            transforms.ToTensor(),
            transforms.Normalize([0.5], [0.5]),
        ])

    def __len__(self):
        return len(self.image_paths)

    def __getitem__(self, idx):
        img = Image.open(self.image_paths[idx]).convert("RGB")
        return {
            "pixel_values": self.transform(img),
            "prompt": self.prompt,
        }


# ---------------------------------------------------------------------------
# Training status tracking
# ---------------------------------------------------------------------------

class TrainingStatus:
    """Write status to a JSON file so the web server can poll progress."""

    def __init__(self, output_dir: Path):
        self.status_file = output_dir / "training_status.json"
        self.start_time = time.time()
        self._update(status="initializing", progress=0)

    def _update(self, **kwargs):
        data = {
            "started_at": self.start_time,
            "elapsed_seconds": round(time.time() - self.start_time, 1),
            "updated_at": time.time(),
        }
        data.update(kwargs)
        self.status_file.write_text(json.dumps(data, indent=2))

    def training(self, step: int, total_steps: int, loss: float):
        self._update(
            status="training",
            step=step,
            total_steps=total_steps,
            progress=round(step / total_steps * 100, 1),
            loss=round(loss, 6),
        )

    def saving(self):
        self._update(status="saving_model", progress=95)

    def completed(self, model_path: str):
        self._update(status="completed", progress=100, model_path=model_path)

    def failed(self, error: str):
        self._update(status="failed", progress=0, error=error)


# ---------------------------------------------------------------------------
# Core training loop
# ---------------------------------------------------------------------------

def train_flux_lora(
    instance_dir: Path,
    output_dir: Path,
    instance_prompt: str = "a photo of sks person",
    model_name: str = "black-forest-labs/FLUX.1-dev",
    resolution: int = 512,
    train_steps: int = 1000,
    learning_rate: float = 1e-4,
    lora_rank: int = 16,
    batch_size: int = 1,
    gradient_accumulation: int = 1,
    save_every: int = 250,
    seed: int = 42,
    use_8bit_adam: bool = False,
):
    """
    Train a LoRA adapter on Flux.1-dev for a specific person's face.

    On M4 Mac (MPS):
      - 500 steps  ≈ 20 min
      - 1000 steps ≈ 40 min
      - 1500 steps ≈ 60 min
    """
    output_dir.mkdir(parents=True, exist_ok=True)
    status = TrainingStatus(output_dir)

    try:
        device = get_device()
        dtype = torch.float32  # MPS works best with float32

        # --- Validate images ---
        image_paths = validate_images(instance_dir)

        # --- Save training config for reproducibility ---
        config = {
            "model_name": model_name,
            "instance_prompt": instance_prompt,
            "resolution": resolution,
            "train_steps": train_steps,
            "learning_rate": learning_rate,
            "lora_rank": lora_rank,
            "batch_size": batch_size,
            "gradient_accumulation": gradient_accumulation,
            "seed": seed,
            "num_images": len(image_paths),
            "device": str(device),
            "started_at": datetime.now().isoformat(),
        }
        (output_dir / "training_config.json").write_text(json.dumps(config, indent=2))

        # --- Load pipeline ---
        logger.info("Loading Flux pipeline: %s", model_name)
        status._update(status="loading_model", progress=5)

        from diffusers import FluxPipeline
        from peft import LoraConfig, get_peft_model

        pipe = FluxPipeline.from_pretrained(
            model_name,
            torch_dtype=dtype,
        )

        # --- Configure LoRA ---
        logger.info("Configuring LoRA (rank=%d)", lora_rank)
        status._update(status="configuring_lora", progress=10)

        # Apply LoRA to the transformer (UNet equivalent in Flux)
        lora_config = LoraConfig(
            r=lora_rank,
            lora_alpha=lora_rank,
            init_lora_weights="gaussian",
            target_modules=[
                "to_q", "to_k", "to_v", "to_out.0",  # attention layers
                "proj_in", "proj_out",                  # projection layers
            ],
        )

        transformer = pipe.transformer
        transformer = get_peft_model(transformer, lora_config)
        transformer.to(device)
        transformer.train()

        trainable_params = sum(p.numel() for p in transformer.parameters() if p.requires_grad)
        total_params = sum(p.numel() for p in transformer.parameters())
        logger.info(
            "LoRA params: %s trainable / %s total (%.2f%%)",
            f"{trainable_params:,}", f"{total_params:,}",
            trainable_params / total_params * 100,
        )

        # --- Text encoding ---
        logger.info("Encoding instance prompt...")
        text_encoder = pipe.text_encoder.to(device)
        text_encoder_2 = pipe.text_encoder_2.to(device) if hasattr(pipe, "text_encoder_2") else None
        tokenizer = pipe.tokenizer
        tokenizer_2 = pipe.tokenizer_2 if hasattr(pipe, "tokenizer_2") else None

        # --- Dataset & DataLoader ---
        dataset = HeadshotDataset(image_paths, instance_prompt, resolution)
        dataloader = DataLoader(
            dataset,
            batch_size=batch_size,
            shuffle=True,
            num_workers=0,  # MPS doesn't benefit from multi-worker
            pin_memory=False,
        )

        # --- Optimizer ---
        if use_8bit_adam:
            try:
                import bitsandbytes as bnb
                optimizer = bnb.optim.AdamW8bit(
                    transformer.parameters(),
                    lr=learning_rate,
                    weight_decay=1e-2,
                )
            except ImportError:
                logger.warning("bitsandbytes not available, using standard AdamW")
                optimizer = torch.optim.AdamW(
                    transformer.parameters(),
                    lr=learning_rate,
                    weight_decay=1e-2,
                )
        else:
            optimizer = torch.optim.AdamW(
                transformer.parameters(),
                lr=learning_rate,
                weight_decay=1e-2,
            )

        # --- Scheduler ---
        from torch.optim.lr_scheduler import CosineAnnealingLR
        scheduler = CosineAnnealingLR(optimizer, T_max=train_steps, eta_min=learning_rate * 0.1)

        # --- VAE for encoding images ---
        vae = pipe.vae.to(device)
        vae.eval()

        # --- Noise scheduler ---
        noise_scheduler = pipe.scheduler

        # --- Training loop ---
        logger.info("Starting training for %d steps...", train_steps)
        torch.manual_seed(seed)

        global_step = 0
        losses = []

        while global_step < train_steps:
            for batch in dataloader:
                if global_step >= train_steps:
                    break

                pixel_values = batch["pixel_values"].to(device, dtype=dtype)

                # Encode images to latent space
                with torch.no_grad():
                    latents = vae.encode(pixel_values).latent_dist.sample()
                    latents = latents * vae.config.scaling_factor

                # Sample noise
                noise = torch.randn_like(latents)
                timesteps = torch.randint(
                    0, noise_scheduler.config.num_train_timesteps,
                    (latents.shape[0],), device=device
                ).long()

                # Add noise to latents
                noisy_latents = noise_scheduler.add_noise(latents, noise, timesteps)

                # Encode text prompt
                text_inputs = tokenizer(
                    batch["prompt"],
                    padding="max_length",
                    max_length=tokenizer.model_max_length,
                    truncation=True,
                    return_tensors="pt",
                ).to(device)

                with torch.no_grad():
                    encoder_hidden_states = text_encoder(text_inputs.input_ids)[0]

                    if text_encoder_2 is not None and tokenizer_2 is not None:
                        text_inputs_2 = tokenizer_2(
                            batch["prompt"],
                            padding="max_length",
                            max_length=tokenizer_2.model_max_length if hasattr(tokenizer_2, "model_max_length") else 256,
                            truncation=True,
                            return_tensors="pt",
                        ).to(device)
                        pooled_prompt_embeds = text_encoder_2(text_inputs_2.input_ids)[0]
                    else:
                        pooled_prompt_embeds = None

                # Forward pass through transformer
                model_pred = transformer(
                    hidden_states=noisy_latents,
                    timestep=timesteps,
                    encoder_hidden_states=encoder_hidden_states,
                    pooled_projections=pooled_prompt_embeds,
                    return_dict=False,
                )[0]

                # Compute loss (predict noise)
                loss = torch.nn.functional.mse_loss(model_pred, noise, reduction="mean")

                # Backward pass
                loss.backward()

                if (global_step + 1) % gradient_accumulation == 0:
                    torch.nn.utils.clip_grad_norm_(transformer.parameters(), 1.0)
                    optimizer.step()
                    scheduler.step()
                    optimizer.zero_grad()

                global_step += 1
                current_loss = loss.item()
                losses.append(current_loss)

                # Log progress
                if global_step % 10 == 0 or global_step == 1:
                    avg_loss = sum(losses[-50:]) / min(len(losses), 50)
                    elapsed = time.time() - status.start_time
                    eta = (elapsed / global_step) * (train_steps - global_step)
                    logger.info(
                        "Step %d/%d | Loss: %.6f (avg: %.6f) | ETA: %dm %ds",
                        global_step, train_steps, current_loss, avg_loss,
                        int(eta // 60), int(eta % 60),
                    )
                    status.training(global_step, train_steps, avg_loss)

                # Save checkpoint
                if save_every > 0 and global_step % save_every == 0:
                    checkpoint_dir = output_dir / f"checkpoint-{global_step}"
                    checkpoint_dir.mkdir(exist_ok=True)
                    transformer.save_pretrained(checkpoint_dir)
                    logger.info("Saved checkpoint at step %d", global_step)

                # MPS memory management
                if device.type == "mps" and global_step % 50 == 0:
                    torch.mps.empty_cache()

        # --- Save final LoRA weights ---
        logger.info("Saving final LoRA weights...")
        status.saving()

        final_dir = output_dir / "lora_weights"
        final_dir.mkdir(exist_ok=True)
        transformer.save_pretrained(final_dir)

        # Save loss history
        (output_dir / "loss_history.json").write_text(json.dumps(losses))

        # Update status
        status.completed(str(final_dir))
        elapsed_total = time.time() - status.start_time
        logger.info(
            "Training complete! %d steps in %dm %ds. Weights saved to %s",
            train_steps, int(elapsed_total // 60), int(elapsed_total % 60), final_dir,
        )

        return str(final_dir)

    except Exception as e:
        logger.error("Training failed: %s", e, exc_info=True)
        status.failed(str(e))
        raise


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Train Flux LoRA on Apple Silicon")
    parser.add_argument("--instance_dir", type=str, required=True, help="Directory with training photos")
    parser.add_argument("--output_dir", type=str, required=True, help="Where to save LoRA weights")
    parser.add_argument("--instance_prompt", type=str, default="a photo of sks person", help="Trigger prompt")
    parser.add_argument("--model_name", type=str, default="black-forest-labs/FLUX.1-dev", help="Base model")
    parser.add_argument("--resolution", type=int, default=512, help="Training resolution")
    parser.add_argument("--steps", type=int, default=1000, help="Training steps")
    parser.add_argument("--lr", type=float, default=1e-4, help="Learning rate")
    parser.add_argument("--lora_rank", type=int, default=16, help="LoRA rank")
    parser.add_argument("--batch_size", type=int, default=1, help="Batch size")
    parser.add_argument("--gradient_accumulation", type=int, default=1, help="Gradient accumulation steps")
    parser.add_argument("--save_every", type=int, default=250, help="Save checkpoint every N steps")
    parser.add_argument("--seed", type=int, default=42, help="Random seed")

    args = parser.parse_args()

    train_flux_lora(
        instance_dir=Path(args.instance_dir),
        output_dir=Path(args.output_dir),
        instance_prompt=args.instance_prompt,
        model_name=args.model_name,
        resolution=args.resolution,
        train_steps=args.steps,
        learning_rate=args.lr,
        lora_rank=args.lora_rank,
        batch_size=args.batch_size,
        gradient_accumulation=args.gradient_accumulation,
        save_every=args.save_every,
        seed=args.seed,
    )


if __name__ == "__main__":
    main()
