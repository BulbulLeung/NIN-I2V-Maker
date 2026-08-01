"""
NIN I2V Maker — ComfyUI custom nodes.
- NINI2VLoadVideo: decode video file from Comfy input/ to IMAGE batch via PyAV
- NINI2VSaveVideo: encode IMAGE batches to H264 / H265 / AV1 / VP9 / ProRes via PyAV
- NINI2VColorMatch: Reinhard LAB color match (start image → decoded frames)
"""

from __future__ import annotations

import json
import os
from fractions import Fraction
from typing import Any

import folder_paths
import numpy as np
import torch


NODE_CLASS_MAPPINGS: dict[str, type] = {}
NODE_DISPLAY_NAME_MAPPINGS: dict[str, str] = {}


def _ext_for(fmt: str, codec: str) -> str:
    fmt = (fmt or "auto").lower()
    codec = (codec or "h264").lower()
    if codec == "vp9" and fmt in ("auto", "mp4"):
        return "webm"
    if codec == "prores":
        return "mov" if fmt in ("auto", "mp4") else fmt
    if fmt == "webm":
        return "webm"
    if fmt == "mkv":
        return "mkv"
    if fmt in ("auto", "mp4"):
        return "mp4"
    return fmt


def _open_kwargs(path: str, fmt: str, codec: str) -> dict[str, Any]:
    ext = _ext_for(fmt, codec)
    kwargs: dict[str, Any] = {"mode": "w"}
    if ext == "mp4":
        kwargs["format"] = "mp4"
        kwargs["options"] = {"movflags": "use_metadata_tags"}
    elif ext == "webm":
        kwargs["format"] = "webm"
    elif ext == "mkv":
        kwargs["format"] = "matroska"
    elif ext == "mov":
        kwargs["format"] = "mov"
        kwargs["options"] = {"movflags": "use_metadata_tags"}
    return kwargs


def _stream_codec_name(codec: str) -> str:
    c = (codec or "h264").lower()
    return {
        "h264": "h264",
        "h265": "libx265",
        "hevc": "libx265",
        "av1": "libsvtav1",
        "vp9": "libvpx-vp9",
        "prores": "prores_ks",
        "auto": "h264",
    }.get(c, "h264")


def _apply_codec_options(stream: Any, codec: str, bit_depth: int, crf: float) -> None:
    c = (codec or "h264").lower()
    crf_i = int(max(0, min(63, round(float(crf)))))
    ten = int(bit_depth) >= 10

    if c in ("h264", "auto"):
        stream.pix_fmt = "yuv420p10le" if ten else "yuv420p"
        stream.options = {"crf": str(min(51, crf_i)), "preset": "medium"}
        if ten:
            stream.options["profile"] = "high10"
    elif c in ("h265", "hevc"):
        stream.pix_fmt = "yuv420p10le" if ten else "yuv420p"
        stream.options = {"crf": str(min(51, crf_i)), "preset": "medium"}
        try:
            stream.codec_context.codec_tag = "hvc1"
        except Exception:
            pass
    elif c == "av1":
        stream.pix_fmt = "yuv420p10le" if ten else "yuv420p"
        stream.bit_rate = 0
        stream.options = {"crf": str(crf_i), "preset": "6"}
    elif c == "vp9":
        stream.pix_fmt = "yuv420p10le" if ten else "yuv420p"
        stream.bit_rate = 0
        stream.options = {"crf": str(crf_i), "row-mt": "1"}
    elif c == "prores":
        # ProRes 422 HQ-ish; always 10-bit family
        stream.pix_fmt = "yuv422p10le"
        stream.options = {"profile": "3"}
    else:
        stream.pix_fmt = "yuv420p"
        stream.options = {"crf": str(min(51, crf_i))}


class NINI2VSaveVideo:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
                "fps": ("FLOAT", {"default": 16.0, "min": 1.0, "max": 120.0, "step": 0.01}),
                "filename_prefix": ("STRING", {"default": "video/NINI2V"}),
                "format": (["auto", "mp4", "webm", "mkv"], {"default": "mp4"}),
                "codec": (["h264", "h265", "av1", "vp9", "prores"], {"default": "h264"}),
                "bit_depth": ([8, 10], {"default": 8}),
                "crf": ("FLOAT", {"default": 23.0, "min": 0.0, "max": 63.0, "step": 1.0}),
            },
            "optional": {
                "filename_suffix": ("STRING", {"default": ""}),
            },
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    RETURN_TYPES = ()
    FUNCTION = "save_video"
    OUTPUT_NODE = True
    CATEGORY = "NIN I2V Maker"
    DESCRIPTION = "Encode IMAGE frames directly to H264/H265/AV1/VP9/ProRes (no H264 intermediate)."

    def save_video(
        self,
        images: torch.Tensor,
        fps: float,
        filename_prefix: str,
        format: str,
        codec: str,
        bit_depth: int,
        crf: float,
        filename_suffix: str = "",
        prompt: Any = None,
        extra_pnginfo: Any = None,
    ):
        import av

        if images is None or images.shape[0] == 0:
            raise ValueError("NINI2VSaveVideo: no frames to encode")

        height = int(images.shape[1])
        width = int(images.shape[2])
        full_output_folder, filename, counter, subfolder, filename_prefix = folder_paths.get_save_image_path(
            filename_prefix,
            folder_paths.get_output_directory(),
            width,
            height,
        )
        format = str(format)
        codec = str(codec)
        ext = _ext_for(format, codec)
        suffix = str(filename_suffix or "").strip()
        if suffix and not suffix.startswith(("_", "-")):
            suffix = "_" + suffix
        if suffix:
            file = f"{filename}_{counter:05}{suffix}.{ext}"
        else:
            file = f"{filename}_{counter:05}_.{ext}"
        out_path = os.path.join(full_output_folder, file)

        frame_rate = Fraction(round(float(fps) * 1000), 1000)
        ten = int(bit_depth) >= 10
        codec_name = _stream_codec_name(codec)

        open_kwargs = _open_kwargs(out_path, format, codec)
        with av.open(out_path, **open_kwargs) as output:
            # Optional workflow metadata
            if prompt is not None:
                output.metadata["prompt"] = json.dumps(prompt)
            if extra_pnginfo is not None and isinstance(extra_pnginfo, dict):
                for k, v in extra_pnginfo.items():
                    try:
                        output.metadata[str(k)] = json.dumps(v)
                    except Exception:
                        pass

            stream = output.add_stream(codec_name, rate=frame_rate)
            stream.width = width
            stream.height = height
            _apply_codec_options(stream, codec, int(bit_depth), float(crf))

            for i in range(images.shape[0]):
                frame_t = images[i]
                if ten:
                    img = (
                        (frame_t.float() * 65535)
                        .clamp(0, 65535)
                        .cpu()
                        .numpy()
                        .astype(np.uint16)
                    )
                    video_frame = av.VideoFrame.from_ndarray(img, format="rgb48le")
                else:
                    img = (frame_t * 255).clamp(0, 255).byte().cpu().numpy()
                    video_frame = av.VideoFrame.from_ndarray(img, format="rgb24")
                video_frame = video_frame.reformat(format=stream.pix_fmt)
                for packet in stream.encode(video_frame):
                    output.mux(packet)

            for packet in stream.encode(None):
                output.mux(packet)

        results = [{"filename": file, "subfolder": subfolder, "type": "output", "format": ext}]
        return {"ui": {"videos": results}}


def _rgb_to_lab(rgb: torch.Tensor) -> torch.Tensor:
    """RGB [..., 3] in 0–1 → LAB (D65 / sRGB)."""
    rgb = rgb.clamp(0.0, 1.0)
    # sRGB → linear
    mask = rgb > 0.04045
    linear = torch.where(mask, ((rgb + 0.055) / 1.055).pow(2.4), rgb / 12.92)
    # linear RGB → XYZ (sRGB D65)
    m = torch.tensor(
        [
            [0.4124564, 0.3575761, 0.1804375],
            [0.2126729, 0.7151522, 0.0721750],
            [0.0193339, 0.1191920, 0.9503041],
        ],
        device=rgb.device,
        dtype=rgb.dtype,
    )
    xyz = torch.matmul(linear, m.T)
    # XYZ → Lab (D65 white)
    white = torch.tensor([0.95047, 1.0, 1.08883], device=rgb.device, dtype=rgb.dtype)
    xyz_n = xyz / white
    eps = 216.0 / 24389.0
    kappa = 24389.0 / 27.0
    f = torch.where(xyz_n > eps, xyz_n.pow(1.0 / 3.0), (kappa * xyz_n + 16.0) / 116.0)
    L = 116.0 * f[..., 1] - 16.0
    a = 500.0 * (f[..., 0] - f[..., 1])
    b = 200.0 * (f[..., 1] - f[..., 2])
    return torch.stack([L, a, b], dim=-1)


def _lab_to_rgb(lab: torch.Tensor) -> torch.Tensor:
    """LAB → RGB [..., 3] in 0–1 (D65 / sRGB)."""
    L = lab[..., 0]
    a = lab[..., 1]
    b = lab[..., 2]
    fy = (L + 16.0) / 116.0
    fx = a / 500.0 + fy
    fz = fy - b / 200.0
    eps = 216.0 / 24389.0
    kappa = 24389.0 / 27.0

    def f_inv(t: torch.Tensor) -> torch.Tensor:
        t3 = t.pow(3)
        return torch.where(t3 > eps, t3, (116.0 * t - 16.0) / kappa)

    white = torch.tensor([0.95047, 1.0, 1.08883], device=lab.device, dtype=lab.dtype)
    xyz = torch.stack([f_inv(fx), f_inv(fy), f_inv(fz)], dim=-1) * white
    m_inv = torch.tensor(
        [
            [3.2404542, -1.5371385, -0.4985314],
            [-0.9692660, 1.8760108, 0.0415560],
            [0.0556434, -0.2040259, 1.0572252],
        ],
        device=lab.device,
        dtype=lab.dtype,
    )
    linear = torch.matmul(xyz, m_inv.T).clamp(0.0, None)
    # linear → sRGB
    mask = linear > 0.0031308
    rgb = torch.where(mask, 1.055 * linear.pow(1.0 / 2.4) - 0.055, 12.92 * linear)
    return rgb.clamp(0.0, 1.0)


def _resize_image_bhwc(img: torch.Tensor, height: int, width: int) -> torch.Tensor:
    """Nearest/bilinear resize IMAGE tensor [B,H,W,C] → [B,height,width,C]."""
    if img.shape[1] == height and img.shape[2] == width:
        return img
    # NCHW for interpolate
    nchw = img.movedim(-1, 1)
    out = torch.nn.functional.interpolate(
        nchw, size=(height, width), mode="bilinear", align_corners=False
    )
    return out.movedim(1, -1)


class NINI2VColorMatch:
    """
    Reinhard et al. color transfer in LAB: match target frames to a reference still.
    Typical I2V use: image_ref = start image, image_target = VAE-decoded video frames.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image_ref": ("IMAGE",),
                "image_target": ("IMAGE",),
                "strength": (
                    "FLOAT",
                    {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01},
                ),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "color_match"
    CATEGORY = "NIN I2V Maker"
    DESCRIPTION = (
        "Match target frame colors to a reference image (Reinhard LAB). "
        "Use the start still as image_ref after VAE decode."
    )

    def color_match(
        self,
        image_ref: torch.Tensor,
        image_target: torch.Tensor,
        strength: float,
    ):
        if image_target is None or image_target.shape[0] == 0:
            raise ValueError("NINI2VColorMatch: image_target is empty")
        if image_ref is None or image_ref.shape[0] == 0:
            raise ValueError("NINI2VColorMatch: image_ref is empty")

        strength = float(max(0.0, min(1.0, strength)))
        if strength <= 0.0:
            return (image_target,)

        device = image_target.device
        dtype = image_target.dtype
        th, tw = int(image_target.shape[1]), int(image_target.shape[2])

        # Use first ref frame; resize to target resolution
        ref = image_ref[0:1].to(device=device, dtype=dtype)
        ref = _resize_image_bhwc(ref, th, tw)

        ref_lab = _rgb_to_lab(ref)
        # Spatial mean/std of reference (1,1,1,3)
        ref_flat = ref_lab.reshape(1, -1, 3)
        ref_mean = ref_flat.mean(dim=1, keepdim=True).reshape(1, 1, 1, 3)
        ref_std = ref_flat.std(dim=1, keepdim=True, unbiased=False).reshape(1, 1, 1, 3).clamp_min(1e-5)

        tgt = image_target.to(device=device, dtype=dtype)
        tgt_lab = _rgb_to_lab(tgt)
        # Per-frame mean/std over H*W
        b = tgt_lab.shape[0]
        tgt_flat = tgt_lab.reshape(b, -1, 3)
        tgt_mean = tgt_flat.mean(dim=1, keepdim=True).reshape(b, 1, 1, 3)
        tgt_std = tgt_flat.std(dim=1, keepdim=True, unbiased=False).reshape(b, 1, 1, 3).clamp_min(1e-5)

        matched_lab = (tgt_lab - tgt_mean) * (ref_std / tgt_std) + ref_mean
        matched = _lab_to_rgb(matched_lab)
        out = tgt * (1.0 - strength) + matched * strength
        return (out.clamp(0.0, 1.0),)


class NINI2VLoadVideo:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "video": ("STRING", {"default": "", "multiline": False}),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("images",)
    FUNCTION = "load_video"
    CATEGORY = "NIN I2V Maker"
    DESCRIPTION = "Decode a video from ComfyUI input/ into an IMAGE batch (RGB float 0–1)."

    def load_video(self, video: str):
        import av

        name = (video or "").strip()
        if not name:
            raise ValueError("NINI2VLoadVideo: video path is empty")

        path = folder_paths.get_annotated_filepath(name)
        if not path or not os.path.isfile(path):
            # Fallback: treat as path under input directory
            candidate = os.path.join(folder_paths.get_input_directory(), name.replace("\\", "/"))
            if os.path.isfile(candidate):
                path = candidate
            else:
                raise FileNotFoundError(f"NINI2VLoadVideo: video not found: {name}")

        frames: list[np.ndarray] = []
        container = av.open(path)
        try:
            stream = next((s for s in container.streams if s.type == "video"), None)
            if stream is None:
                raise ValueError(f"NINI2VLoadVideo: no video stream in {name}")
            for frame in container.decode(stream):
                arr = frame.to_ndarray(format="rgb24")
                if arr is None or arr.size == 0:
                    continue
                frames.append(arr)
        finally:
            container.close()

        if not frames:
            raise ValueError(f"NINI2VLoadVideo: no frames decoded from {name}")

        # Stack to [N,H,W,C] float32 in 0..1
        batch = np.stack(frames, axis=0).astype(np.float32) / 255.0
        images = torch.from_numpy(batch)
        return (images,)


NODE_CLASS_MAPPINGS["NINI2VSaveVideo"] = NINI2VSaveVideo
NODE_CLASS_MAPPINGS["NINI2VColorMatch"] = NINI2VColorMatch
NODE_CLASS_MAPPINGS["NINI2VLoadVideo"] = NINI2VLoadVideo
NODE_DISPLAY_NAME_MAPPINGS["NINI2VSaveVideo"] = "NIN I2V Save Video"
NODE_DISPLAY_NAME_MAPPINGS["NINI2VColorMatch"] = "NIN I2V Color Match"
NODE_DISPLAY_NAME_MAPPINGS["NINI2VLoadVideo"] = "NIN I2V Load Video"
