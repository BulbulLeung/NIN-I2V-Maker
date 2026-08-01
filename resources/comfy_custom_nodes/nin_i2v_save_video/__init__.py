"""
NIN I2V Maker — direct multi-codec video save (no H264 intermediate).
Encodes IMAGE batches straight to H264 / H265 / AV1 / VP9 / ProRes via PyAV.
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


NODE_CLASS_MAPPINGS["NINI2VSaveVideo"] = NINI2VSaveVideo
NODE_DISPLAY_NAME_MAPPINGS["NINI2VSaveVideo"] = "NIN I2V Save Video"
