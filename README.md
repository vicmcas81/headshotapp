# AI Headshots — Full Stack Starter

Turn 10 selfies into 50 professional headshots. Pay only if you love them.

## Architecture

```
Browser → Next.js (Vercel)
            ├── /api/upload    → fal.ai training job (async)
            ├── /api/webhook   ← fal.ai calls this when done → generates headshots
            ├── /api/pay       → Stripe payment intent
            └── /api/jobs      → job status polling

Storage:   Cloudflare R2  (photos + headshots)
State:     Upstash Redis  (job tracking)
AI:        fal.ai         (Flux LoRA training + inference)
Email:     Resend         (notifications)
Payments:  Stripe         (pay-after-see)
```

## Setup (30 minutes)

### 1. Clone and install
```bash
git clone <your-repo>
cd headshots-app
npm install
cp .env.example .env.local
```

### 2. fal.ai — AI training + generation (~$0.50/user)
1. Sign up at https://fal.ai
2. Go to Dashboard → Keys → Create Key
3. Add to `.env.local`: `FAL_KEY=...`

### 3. Cloudflare R2 — Storage (free tier: 10GB)
1. Go to https://dash.cloudflare.com → R2
2. Create a bucket named `headshots`
3. Settings → Public access → Enable
4. Create an API token with R2 read+write
5. Add all R2 vars to `.env.local`

### 4. Upstash Redis — Job state (free tier: 10k cmds/day)
1. Sign up at https://upstash.com
2. Create a Redis database
3. Copy REST URL and token to `.env.local`

### 5. Stripe — Payments
1. Sign up at https://stripe.com
2. Get your test keys from Dashboard → Developers → API Keys
3. Add to `.env.local`
4. For local testing, run: `stripe listen --forward-to localhost:3000/api/pay`
   (This sets your STRIPE_WEBHOOK_SECRET)

### 6. Resend — Email (free: 3,000/month)
1. Sign up at https://resend.com
2. Add your domain or use their sandbox
3. Add `RESEND_API_KEY` to `.env.local`

### 7. Run locally
```bash
npm run dev
```
Open http://localhost:3000

## Deploy to Vercel
```bash
npm i -g vercel
vercel
```
Add all environment variables in Vercel dashboard.

**Important:** Set `NEXT_PUBLIC_APP_URL` to your Vercel URL in production.

## Cost per user
| Service | Cost per user |
|---------|--------------|
| fal.ai training (1000 steps) | ~$0.50 |
| fal.ai inference (50 images) | ~$0.15 |
| R2 storage (30 days) | ~$0.001 |
| Upstash Redis | ~$0.001 |
| Resend (2 emails) | ~$0.001 |
| **Total** | **~$0.65** |
| Revenue | **$59.00** |
| **Gross margin** | **~99%** |

## Customizing styles
Edit `lib/fal.ts` → `STYLES` array. Add/remove looks freely.
Each style = 5 images. Current: 10 styles × 5 = 50 headshots.

## Going to production checklist
- [ ] Set `NEXT_PUBLIC_APP_URL` to your production domain
- [ ] Switch Stripe to live keys
- [ ] Add your real domain to Resend
- [ ] Set up Cloudflare R2 CORS for your domain
- [ ] Register Stripe webhook: `https://yourdomain.com/api/pay`
      (Events: `payment_intent.succeeded`)
- [ ] Test end-to-end with a real card in Stripe test mode

## RunPod (FAST + PREMIUM)

This repo now supports routing **FAST** and **PREMIUM** tiers to RunPod Serverless endpoints.

### Env vars
Add to `.env.local`:

```bash
RUNPOD_API_KEY=...
RUNPOD_FAST_ENDPOINT_ID=...
RUNPOD_PREMIUM_ENDPOINT_ID=...
FAST_TIER_BACKEND=runpod
PREMIUM_TIER_BACKEND=runpod

## RunPod (recommended: headshot-worker, not ComfyUI)

The built-in `runpod` backend expects a **custom RunPod Serverless worker** that returns generated headshots as base64 images.

Worker source lives in:
- `runpod/headshot-worker/Dockerfile`
- `runpod/headshot-worker/handler.py`

### Deploy (RunPod Console)

1) Push this repo to GitHub.
2) RunPod → Serverless → **Add your repo**
   - Set the build context to `runpod/headshot-worker`
   - Deploy twice if you want separate endpoints for fast vs premium (optional).
3) In `.env.local`:
   - `RUNPOD_API_KEY=...`
   - `RUNPOD_FAST_ENDPOINT_ID=...`
   - `RUNPOD_PREMIUM_ENDPOINT_ID=...`
   - `FAST_TIER_BACKEND=runpod`
   - `PREMIUM_TIER_BACKEND=runpod`

### Input / output contract

Input:
```json
{ "tier":"fast|premium", "face_image_base64":"<raw base64 or data-uri>", "gender":"man|woman" }
```

Output:
```json
{ "images": [{ "type":"base64", "data":"<base64 png>", "filename":"...", "mime":"image/png" }] }
```
```

### Workflows
`app/api/upload/route.ts` currently contains placeholder `workflow = {}` objects for both tiers. Replace these with your **API-exported** ComfyUI workflow JSON (ComfyUI: Workflow → Export (API)).

### Notes
- The RunPod ComfyUI Hub listing ships with a FLUX text-to-image workflow by default. Identity/face workflows usually require a customized worker image with the right nodes/models.
- The app expects RunPod to return images as base64 strings in the job output; it saves them under `public/uploads/<jobId>/output/`.

## Competitive edge ideas
- Train longer (2000 steps) for premium tier
- Add more niche styles (doctor, lawyer, real estate, dating)
- B2B: team/company plans at $500+/company
- Subscription: unlimited regenerations
- Add style previews before user pays
