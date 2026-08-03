"""
Pictoer — Wan2.2 latent motion enhancement nodes.
- NINI2VWanMotionI2V: drop-in for WanImageToVideo with brightness-protected motion scale
- NINI2VWanMotionFLF: drop-in for WanFirstLastFrameToVideo (mid-frame motion amplify)

Amplifies concat-latent distance from the start (and end for FLF) frame so high-res /
Lightning runs keep more motion amplitude without washing brightness.
"""

from __future__ import annotations

import comfy.clip_vision
import comfy.model_management
import comfy.utils
import node_helpers
import torch


NODE_CLASS_MAPPINGS: dict[str, type] = {}
NODE_DISPLAY_NAME_MAPPINGS: dict[str, str] = {}


def _spacial_scale(vae) -> int:
    fn = getattr(vae, "spacial_compression_encode", None)
    if callable(fn):
        try:
            return int(fn())
        except Exception:
            pass
    return 8


def _latent_channels(vae) -> int:
    ch = getattr(vae, "latent_channels", None)
    if isinstance(ch, int) and ch > 0:
        return ch
    return 16


def _amplify_from_base(
    concat: torch.Tensor,
    base: torch.Tensor,
    motion_amplitude: float,
    noise_strength: float,
) -> torch.Tensor:
    """Scale (frames - base) with per-frame brightness mean protection; optional noise."""
    if concat.shape[2] == 0:
        return concat
    amp = float(motion_amplitude)
    noise = float(noise_strength)
    if amp <= 1.0 and noise <= 0.0:
        return concat

    diff = concat - base
    if amp > 1.0:
        mean = diff.mean(dim=(1, 3, 4), keepdim=True)
        centered = diff - mean
        concat = base + centered * amp + mean
    if noise > 0.0:
        concat = concat + noise * torch.randn_like(concat)
    return torch.clamp(concat, -6.0, 6.0)


def _empty_latent(vae, batch_size: int, length: int, height: int, width: int) -> dict:
    scale = _spacial_scale(vae)
    channels = _latent_channels(vae)
    samples = torch.zeros(
        [batch_size, channels, ((length - 1) // 4) + 1, height // scale, width // scale],
        device=comfy.model_management.intermediate_device(),
    )
    return {"samples": samples}


class NINI2VWanMotionI2V:
    """
    WanImageToVideo replacement: zero latent + concat/mask, with motion_amplitude
    scaling on non-first concat frames (brightness-protected).
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "positive": ("CONDITIONING",),
                "negative": ("CONDITIONING",),
                "vae": ("VAE",),
                "width": ("INT", {"default": 832, "min": 16, "max": 4096, "step": 16}),
                "height": ("INT", {"default": 480, "min": 16, "max": 4096, "step": 16}),
                "length": ("INT", {"default": 81, "min": 1, "max": 4096, "step": 4}),
                "batch_size": ("INT", {"default": 1, "min": 1, "max": 4096}),
                "motion_amplitude": (
                    "FLOAT",
                    {"default": 1.15, "min": 1.0, "max": 2.0, "step": 0.05},
                ),
                "noise_strength": (
                    "FLOAT",
                    {"default": 0.0, "min": 0.0, "max": 0.3, "step": 0.01},
                ),
            },
            "optional": {
                "start_image": ("IMAGE",),
                "clip_vision_output": ("CLIP_VISION_OUTPUT",),
            },
        }

    RETURN_TYPES = ("CONDITIONING", "CONDITIONING", "LATENT")
    RETURN_NAMES = ("positive", "negative", "latent")
    FUNCTION = "execute"
    CATEGORY = "Pictoer"

    def execute(
        self,
        positive,
        negative,
        vae,
        width,
        height,
        length,
        batch_size,
        motion_amplitude=1.15,
        noise_strength=0.0,
        start_image=None,
        clip_vision_output=None,
    ):
        out_latent = _empty_latent(vae, batch_size, length, height, width)
        latent_t = out_latent["samples"].shape[2]

        if start_image is not None:
            start_image = start_image[:1]
            start_image = comfy.utils.common_upscale(
                start_image.movedim(-1, 1), width, height, "bilinear", "center"
            ).movedim(1, -1)

            image = (
                torch.ones(
                    (length, height, width, start_image.shape[-1]),
                    device=start_image.device,
                    dtype=start_image.dtype,
                )
                * 0.5
            )
            image[0] = start_image[0]

            concat_latent_image = vae.encode(image[:, :, :, :3])
            base = concat_latent_image[:, :, 0:1]
            rest = concat_latent_image[:, :, 1:]
            rest = _amplify_from_base(rest, base, motion_amplitude, noise_strength)
            concat_latent_image = torch.cat([base, rest], dim=2)

            mask = torch.ones(
                (1, 1, latent_t, concat_latent_image.shape[-2], concat_latent_image.shape[-1]),
                device=start_image.device,
                dtype=start_image.dtype,
            )
            mask[:, :, 0] = 0.0

            positive = node_helpers.conditioning_set_values(
                positive, {"concat_latent_image": concat_latent_image, "concat_mask": mask}
            )
            negative = node_helpers.conditioning_set_values(
                negative, {"concat_latent_image": concat_latent_image, "concat_mask": mask}
            )

            ref_latent = vae.encode(start_image[:, :, :, :3])
            positive = node_helpers.conditioning_set_values(
                positive, {"reference_latents": [ref_latent]}, append=True
            )
            negative = node_helpers.conditioning_set_values(
                negative, {"reference_latents": [torch.zeros_like(ref_latent)]}, append=True
            )

        if clip_vision_output is not None:
            positive = node_helpers.conditioning_set_values(
                positive, {"clip_vision_output": clip_vision_output}
            )
            negative = node_helpers.conditioning_set_values(
                negative, {"clip_vision_output": clip_vision_output}
            )

        return (positive, negative, out_latent)


class NINI2VWanMotionFLF:
    """
    WanFirstLastFrameToVideo replacement: keep start/end anchors, amplify mid-frame
    concat latents relative to start (brightness-protected).
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "positive": ("CONDITIONING",),
                "negative": ("CONDITIONING",),
                "vae": ("VAE",),
                "width": ("INT", {"default": 832, "min": 16, "max": 4096, "step": 16}),
                "height": ("INT", {"default": 480, "min": 16, "max": 4096, "step": 16}),
                "length": ("INT", {"default": 81, "min": 1, "max": 4096, "step": 4}),
                "batch_size": ("INT", {"default": 1, "min": 1, "max": 4096}),
                "motion_amplitude": (
                    "FLOAT",
                    {"default": 1.15, "min": 1.0, "max": 2.0, "step": 0.05},
                ),
                "noise_strength": (
                    "FLOAT",
                    {"default": 0.0, "min": 0.0, "max": 0.3, "step": 0.01},
                ),
            },
            "optional": {
                "start_image": ("IMAGE",),
                "end_image": ("IMAGE",),
                "clip_vision_start_image": ("CLIP_VISION_OUTPUT",),
                "clip_vision_end_image": ("CLIP_VISION_OUTPUT",),
            },
        }

    RETURN_TYPES = ("CONDITIONING", "CONDITIONING", "LATENT")
    RETURN_NAMES = ("positive", "negative", "latent")
    FUNCTION = "execute"
    CATEGORY = "Pictoer"

    def execute(
        self,
        positive,
        negative,
        vae,
        width,
        height,
        length,
        batch_size,
        motion_amplitude=1.15,
        noise_strength=0.0,
        start_image=None,
        end_image=None,
        clip_vision_start_image=None,
        clip_vision_end_image=None,
    ):
        out_latent = _empty_latent(vae, batch_size, length, height, width)
        latent_t = out_latent["samples"].shape[2]

        if start_image is not None:
            start_image = comfy.utils.common_upscale(
                start_image[:length].movedim(-1, 1), width, height, "bilinear", "center"
            ).movedim(1, -1)
        if end_image is not None:
            end_image = comfy.utils.common_upscale(
                end_image[-length:].movedim(-1, 1), width, height, "bilinear", "center"
            ).movedim(1, -1)

        image = torch.ones((length, height, width, 3)) * 0.5
        mask = torch.ones((1, 1, latent_t * 4, out_latent["samples"].shape[-2], out_latent["samples"].shape[-1]))

        if start_image is not None:
            image[: start_image.shape[0]] = start_image
            mask[:, :, : start_image.shape[0] + 3] = 0.0

        if end_image is not None:
            image[-end_image.shape[0] :] = end_image
            mask[:, :, -end_image.shape[0] :] = 0.0

        if start_image is not None or end_image is not None:
            device = (
                start_image.device
                if start_image is not None
                else end_image.device  # type: ignore[union-attr]
            )
            dtype = (
                start_image.dtype
                if start_image is not None
                else end_image.dtype  # type: ignore[union-attr]
            )
            image = image.to(device=device, dtype=dtype)
            mask = mask.to(device=device, dtype=dtype)

            concat_latent_image = vae.encode(image[:, :, :, :3])

            # Amplify mid latent frames relative to start; keep first/last latent slots.
            if concat_latent_image.shape[2] > 2 and (float(motion_amplitude) > 1.0 or float(noise_strength) > 0.0):
                base = concat_latent_image[:, :, 0:1]
                mid = concat_latent_image[:, :, 1:-1]
                last = concat_latent_image[:, :, -1:]
                mid = _amplify_from_base(mid, base, motion_amplitude, noise_strength)
                concat_latent_image = torch.cat([base, mid, last], dim=2)

            mask = mask.view(1, mask.shape[2] // 4, 4, mask.shape[3], mask.shape[4]).transpose(1, 2)
            positive = node_helpers.conditioning_set_values(
                positive, {"concat_latent_image": concat_latent_image, "concat_mask": mask}
            )
            negative = node_helpers.conditioning_set_values(
                negative, {"concat_latent_image": concat_latent_image, "concat_mask": mask}
            )

            if start_image is not None:
                ref_latent = vae.encode(start_image[:1, :, :, :3])
                positive = node_helpers.conditioning_set_values(
                    positive, {"reference_latents": [ref_latent]}, append=True
                )
                negative = node_helpers.conditioning_set_values(
                    negative, {"reference_latents": [torch.zeros_like(ref_latent)]}, append=True
                )

        clip_vision_output = None
        if clip_vision_start_image is not None:
            clip_vision_output = clip_vision_start_image
        if clip_vision_end_image is not None:
            if clip_vision_output is not None:
                states = torch.cat(
                    [
                        clip_vision_output.penultimate_hidden_states,
                        clip_vision_end_image.penultimate_hidden_states,
                    ],
                    dim=-2,
                )
                clip_vision_output = comfy.clip_vision.Output()
                clip_vision_output.penultimate_hidden_states = states
            else:
                clip_vision_output = clip_vision_end_image

        if clip_vision_output is not None:
            positive = node_helpers.conditioning_set_values(
                positive, {"clip_vision_output": clip_vision_output}
            )
            negative = node_helpers.conditioning_set_values(
                negative, {"clip_vision_output": clip_vision_output}
            )

        return (positive, negative, out_latent)


NODE_CLASS_MAPPINGS["NINI2VWanMotionI2V"] = NINI2VWanMotionI2V
NODE_CLASS_MAPPINGS["NINI2VWanMotionFLF"] = NINI2VWanMotionFLF
NODE_DISPLAY_NAME_MAPPINGS["NINI2VWanMotionI2V"] = "NIN I2V Wan Motion (I2V)"
NODE_DISPLAY_NAME_MAPPINGS["NINI2VWanMotionFLF"] = "NIN I2V Wan Motion (FLF)"
