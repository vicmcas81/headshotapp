import base64
import io
import os
from typing import Any, Dict, List

import runpod
import torch
from PIL import Image

# ---- Model config (avoid gated weights) -------------------------------------
# For best identity/quality use SDXL + FaceID.
SD_MODEL_ID = os.environ.get("SD_MODEL_ID", "stabilityai/stable-diffusion-xl-base-1.0")
HF_TOKEN = os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_HUB_TOKEN")

# SDXL FaceID (requires InsightFace embeddings)
IP_ADAPTER_REPO = os.environ.get("IP_ADAPTER_REPO", "h94/IP-Adapter-FaceID")
IP_ADAPTER_WEIGHT = os.environ.get("IP_ADAPTER_WEIGHT", "ip-adapter-faceid_sdxl.bin")
IP_ADAPTER_SUBFOLDER = os.environ.get("IP_ADAPTER_SUBFOLDER", None)

# ---- Generation defaults ----------------------------------------------------
DEFAULT_STYLES = os.environ.get("DEFAULT_STYLES", "corporate,linkedin").split(",")
DEFAULT_IMAGES_PER_STYLE = int(os.environ.get("DEFAULT_IMAGES_PER_STYLE", "1"))
DEFAULT_STEPS_FAST = int(os.environ.get("DEFAULT_STEPS_FAST", "32"))
DEFAULT_STEPS_PREMIUM = int(os.environ.get("DEFAULT_STEPS_PREMIUM", "45"))
DEFAULT_GUIDANCE = float(os.environ.get("DEFAULT_GUIDANCE", "5.5"))
DEFAULT_IP_SCALE = float(os.environ.get("DEFAULT_IP_SCALE", "0.75"))

FAST_STYLES = {
    "corporate": (
        "professional corporate headshot, {GENDER}, tailored dark charcoal suit, "
        "white dress shirt, neutral grey studio backdrop, even studio lighting, "
        "sharp focus, photorealistic"
    ),
    "linkedin": (
        "LinkedIn profile photo, {GENDER}, business casual attire, "
        "clean white studio background, bright even lighting, "
        "genuine warm smile, photorealistic"
    ),
    "creative": (
        "modern creative professional headshot, {GENDER}, stylish outfit, "
        "soft urban bokeh background, natural window light, "
        "relaxed expression, editorial style, photorealistic"
    ),
    "executive": (
        "executive portrait, {GENDER}, premium dark suit, "
        "dramatic studio lighting with rim light, dark gradient background, "
        "confident expression, cinematic, photorealistic"
    ),
    "casual": (
        "friendly approachable headshot, {GENDER}, smart casual outfit, "
        "warm blurred outdoor background, natural golden hour light, "
        "genuine smile, photorealistic"
    ),
}

NEGATIVE_PROMPT = (
    "deformed, ugly, bad anatomy, bad face, blurry, low quality, "
    "out of frame, watermark, text, extra fingers, mutation, duplicate face"
)


_pipe = None
_face_app = None


def _get_pipe():
    global _pipe
    if _pipe is not None:
        return _pipe

    from diffusers import AutoPipelineForText2Image, DDIMScheduler

    device = "cuda" if torch.cuda.is_available() else "cpu"
    dtype = torch.float16 if device == "cuda" else torch.float32

    pipe = AutoPipelineForText2Image.from_pretrained(
        SD_MODEL_ID,
        torch_dtype=dtype,
        safety_checker=None,
        requires_safety_checker=False,
        token=HF_TOKEN,
    )
    # DDIM is recommended for face models.
    pipe.scheduler = DDIMScheduler.from_config(pipe.scheduler.config)
    pipe = pipe.to(device)

    pipe.load_ip_adapter(
        IP_ADAPTER_REPO,
        subfolder=IP_ADAPTER_SUBFOLDER,
        weight_name=IP_ADAPTER_WEIGHT,
        image_encoder_folder=None,
    )
    pipe.set_ip_adapter_scale(DEFAULT_IP_SCALE)

    _pipe = pipe
    return _pipe


def _decode_image_b64(b64: str) -> Image.Image:
    # Accept raw base64 or data: URI
    if b64.startswith("data:"):
        b64 = b64.split(",", 1)[1]
    data = base64.b64decode(b64)
    return Image.open(io.BytesIO(data)).convert("RGB")

def _get_face_app():
    global _face_app
    if _face_app is not None:
        return _face_app
    from insightface.app import FaceAnalysis
    # Prefer CUDA if available, otherwise CPU.
    providers = ["CUDAExecutionProvider", "CPUExecutionProvider"] if torch.cuda.is_available() else ["CPUExecutionProvider"]
    app = FaceAnalysis(name="buffalo_l", providers=providers)
    # ctx_id=0 for GPU, -1 for CPU
    app.prepare(ctx_id=0 if torch.cuda.is_available() else -1, det_size=(640, 640))
    _face_app = app
    return _face_app


def _faceid_embeds(face_img: Image.Image, device: torch.device, dtype: torch.dtype):
    import numpy as np
    import cv2
    app = _get_face_app()
    img = cv2.cvtColor(np.asarray(face_img), cv2.COLOR_RGB2BGR)
    faces = app.get(img)
    if not faces:
        raise RuntimeError("No face detected in input image.")
    emb = torch.from_numpy(faces[0].normed_embedding).unsqueeze(0)  # (1, 512)
    # diffusers expects shape like (2,1,1,512) when concatenating negative/positive
    ref = emb.unsqueeze(0).unsqueeze(0)  # (1,1,1,512)
    neg = torch.zeros_like(ref)
    id_embeds = torch.cat([neg, ref], dim=0).to(device=device, dtype=dtype)  # (2,1,1,512)
    return [id_embeds]


def _encode_png_b64(img: Image.Image) -> str:
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("utf-8")


def _gender_word(gender: str) -> str:
    return "woman" if str(gender).lower() == "woman" else "man"


def handler(job: Dict[str, Any]):
    inp = job.get("input", {}) or {}

    # Required
    face_b64 = inp.get("face_image_base64") or inp.get("face") or inp.get("image")
    if not face_b64 or not isinstance(face_b64, str):
        return {"error": "Missing face_image_base64 (base64 string, raw or data: URI)."}

    # Optional
    tier = (inp.get("tier") or "fast").lower()
    gender = _gender_word(inp.get("gender", "man"))
    styles = inp.get("styles") or DEFAULT_STYLES
    if isinstance(styles, str):
        styles = [s.strip() for s in styles.split(",") if s.strip()]
    styles = [s for s in styles if s in FAST_STYLES] or DEFAULT_STYLES

    num_images = inp.get("num_images")
    if num_images is None:
        images_per_style = int(inp.get("images_per_style") or DEFAULT_IMAGES_PER_STYLE)
        num_images = max(1, len(styles) * images_per_style)
    else:
        num_images = int(num_images)
        images_per_style = int(inp.get("images_per_style") or DEFAULT_IMAGES_PER_STYLE)
    steps = int(inp.get("steps") or (DEFAULT_STEPS_PREMIUM if tier == "premium" else DEFAULT_STEPS_FAST))
    guidance_scale = float(inp.get("guidance_scale") or DEFAULT_GUIDANCE)

    pipe = _get_pipe()
    device = pipe.device

    face_img = _decode_image_b64(face_b64).resize((512, 512))
    id_embeds = _faceid_embeds(face_img, device=device, dtype=pipe.unet.dtype)

    outputs: List[Dict[str, Any]] = []
    i = 0
    while len(outputs) < num_images:
        style_key = styles[i % len(styles)]
        prompt = FAST_STYLES[style_key].replace("{GENDER}", gender)
        result = pipe(
            prompt=prompt,
            negative_prompt=NEGATIVE_PROMPT,
            ip_adapter_image_embeds=id_embeds,
            num_inference_steps=steps,
            guidance_scale=guidance_scale,
            height=1024,
            width=1024,
        )
        img = result.images[0]
        outputs.append(
            {
                "type": "base64",
                "data": _encode_png_b64(img),
                "filename": f"headshot_{len(outputs):02d}_{style_key}.png",
                "mime": "image/png",
            }
        )
        i += 1

    return {"images": outputs}


if __name__ == "__main__":
    runpod.serverless.start({"handler": handler})
