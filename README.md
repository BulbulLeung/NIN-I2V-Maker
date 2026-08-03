# Pictoer

**Prompt → Generate** for Wan 2.2 Image-to-Video. Create motion prompts from still images with a local vision LLM, then generate videos through **ComfyUI** — all in one Windows app.

Two views: **Prompt** · **Generate**.

---

## Features

### Prompt

- Open an image folder; browse list or thumbnails
- English I2V motion prompt editing with sidecar `.txt` (same stem as the image)
- Bidirectional translation (English ↔ target language) via LM Studio / Ollama
- **Generate Prompt / Re-generate**: vision LLM writes a motion-first prompt (camera, action, timing) — not a static scene caption
- Editable prompt presets in Settings
- **Send to Generate** carries the current image + prompt into the Generate view

### Generate

- Start / stop **ComfyUI** from the app (or point at an existing install)
- Built-in **Wan2.2 14B I2V** workflow (dual high/low noise DiT, `WanImageToVideo`, dual `KSamplerAdvanced`, `CreateVideo` / `SaveVideo`)
- Optional Lightning 4-step LoRA toggle (high + low LoRA pair)
- Parameters: size, frames, fps, steps, CFG, seed, ModelSampling shift, sampler / scheduler
- Result gallery with MP4 preview; copies finished videos into your output folder
- Resource monitor (CPU / RAM / GPU), with optional kill of VRAM-holding processes

---

## Requirements

| Item | Notes |
|------|--------|
| OS | Windows x64 |
| Development | Node.js 18+ |
| AI backend (optional) | [LM Studio](https://lmstudio.ai/) or [Ollama](https://ollama.com/) with a **vision** model |
| ComfyUI | Recent ComfyUI with native Wan 2.2 nodes (`WanImageToVideo`, `CreateVideo`, `SaveVideo`) |
| Models | See below |

### Wan2.2 14B I2V models

Place under your ComfyUI `models/` tree (or folders you point to in the Generate view):

```text
diffusion_models/
  wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors   # or fp16
  wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors
text_encoders/
  umt5_xxl_fp8_e4m3fn_scaled.safetensors
vae/
  wan_2.1_vae.safetensors
loras/   # optional Lightning
  wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors
  wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors
```

Repackaged weights: [Comfy-Org/Wan_2.2_ComfyUI_Repackaged](https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged)

Default generation size is **640×640**, **81** frames @ **16** fps (~5s). 14B I2V needs substantial VRAM; lower resolution/frames if needed.

---

## Quick start

```bash
npm install
npm run dev
```

### Build Windows portable

```bash
npm run dist
```

Output under `release/`.

Settings are stored at `%AppData%\Pictoer\settings.json`.

---

## How to use

### 1. Prompt view

1. Add / open an image folder
2. Select an image
3. Configure LM Studio or Ollama + vision model in **Settings**
4. Click **Generate Prompt**, edit if needed, **Save**
5. **Send to Generate** when ready

### 2. Generate view

1. Set ComfyUI `.bat` (or Download from the field)
2. Browse High DiT / Low DiT / VAE / CLIP paths
3. Confirm image + prompt (from Prompt view or browse)
4. Set output folder → **Start** ComfyUI → **Generate**

---

## Sidecar layout

```text
my-images/
  shot_001.png
  shot_001.txt    ← English I2V motion prompt
  shot_002.jpg
  shot_002.txt
```
