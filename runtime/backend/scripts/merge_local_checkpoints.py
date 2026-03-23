#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


class CheckpointMergeError(RuntimeError):
    pass


def _now_stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def _safe_json(data: Any) -> str:
    return json.dumps(data, ensure_ascii=False, indent=2)


def _resolve_weight_files(model_root: Path) -> tuple[str, list[Path]]:
    safetensor_index = model_root / "model.safetensors.index.json"
    if safetensor_index.exists():
        payload = json.loads(safetensor_index.read_text(encoding="utf-8"))
        weight_map = payload.get("weight_map") or {}
        files = sorted({model_root / str(name) for name in weight_map.values() if str(name).strip()})
        if files:
            return "safetensors", files
    safetensor_files = sorted(model_root.glob("*.safetensors"))
    if safetensor_files:
        return "safetensors", safetensor_files

    bin_index = model_root / "pytorch_model.bin.index.json"
    if bin_index.exists():
        payload = json.loads(bin_index.read_text(encoding="utf-8"))
        weight_map = payload.get("weight_map") or {}
        files = sorted({model_root / str(name) for name in weight_map.values() if str(name).strip()})
        if files:
            return "pytorch-bin", files
    bin_files = sorted(model_root.glob("*.bin"))
    if bin_files:
        return "pytorch-bin", bin_files
    raise CheckpointMergeError(f"No supported checkpoint weights were found in {model_root}.")


def _copy_supporting_files(base_root: Path, output_root: Path) -> list[str]:
    copied: list[str] = []
    skip_names = {
        "model.safetensors",
        "model.safetensors.index.json",
        "pytorch_model.bin",
        "pytorch_model.bin.index.json",
    }
    skip_suffixes = {".safetensors", ".bin"}
    for item in base_root.iterdir():
        if item.name in skip_names or item.suffix.lower() in skip_suffixes:
            continue
        target = output_root / item.name
        if item.is_dir():
            if item.name.startswith("__pycache__"):
                continue
            shutil.copytree(item, target, dirs_exist_ok=True)
            copied.append(str(target))
        elif item.is_file():
            shutil.copy2(item, target)
            copied.append(str(target))
    return copied


def _load_tensor_stack() -> tuple[Any, Any, Any]:
    try:
        import torch  # type: ignore
    except Exception as exc:  # pragma: no cover - environment-specific
        raise CheckpointMergeError(
            "Tensor-level checkpoint merging requires torch. Install torch in the runtime environment first."
        ) from exc
    try:
        from safetensors.torch import load_file as safe_load_file, save_file as safe_save_file  # type: ignore
    except Exception:  # pragma: no cover - environment-specific
        safe_load_file = None
        safe_save_file = None
    return torch, safe_load_file, safe_save_file


def _load_state_dict(model_root: Path, weight_format: str, weight_files: list[Path], *, torch_mod: Any, safe_load_file: Any) -> dict[str, Any]:
    state: dict[str, Any] = {}
    for file_path in weight_files:
        if weight_format == "safetensors":
            if safe_load_file is None:
                raise CheckpointMergeError(
                    "Tensor-level safetensors merging requires the safetensors package. Install safetensors in the runtime environment first."
                )
            shard = safe_load_file(str(file_path), device="cpu")
        else:
            shard = torch_mod.load(str(file_path), map_location="cpu")
            if isinstance(shard, dict) and "state_dict" in shard and isinstance(shard["state_dict"], dict):
                shard = shard["state_dict"]
        if not isinstance(shard, dict):
            raise CheckpointMergeError(f"Unsupported checkpoint payload in {file_path}. Expected a state_dict object.")
        for name, value in shard.items():
            state[str(name)] = value
    if not state:
        raise CheckpointMergeError(f"No tensor state was loaded from {model_root}.")
    return state


def _merge_state_dicts(base_state: dict[str, Any], secondary_state: dict[str, Any], *, alpha: float, method: str, torch_mod: Any) -> tuple[dict[str, Any], dict[str, Any]]:
    if method not in {"linear", "lerp"}:
        raise CheckpointMergeError(f"Unsupported merge method '{method}'.")
    merged: dict[str, Any] = {}
    compatible_tensor_count = 0
    skipped_tensor_count = 0
    merged_names: list[str] = []
    skipped_names: list[str] = []

    for name, base_value in base_state.items():
        other_value = secondary_state.get(name)
        if other_value is None:
            merged[name] = base_value
            continue
        if not torch_mod.is_tensor(base_value) or not torch_mod.is_tensor(other_value):
            merged[name] = base_value
            skipped_tensor_count += 1
            skipped_names.append(name)
            continue
        if tuple(base_value.shape) != tuple(other_value.shape):
            merged[name] = base_value
            skipped_tensor_count += 1
            skipped_names.append(name)
            continue
        candidate = other_value.to(dtype=base_value.dtype, device=base_value.device)
        merged[name] = base_value.mul(1.0 - alpha).add(candidate.mul(alpha))
        compatible_tensor_count += 1
        merged_names.append(name)

    metadata = {
        "compatible_tensor_count": compatible_tensor_count,
        "skipped_tensor_count": skipped_tensor_count,
        "merged_tensor_names": merged_names[:64],
        "skipped_tensor_names": skipped_names[:64],
        "base_tensor_count": len(base_state),
        "secondary_tensor_count": len(secondary_state),
    }
    return merged, metadata


def build_checkpoint_merge_manifest(
    *,
    merge_id: str,
    merge_name: str,
    base_path: Path,
    secondary_path: Path,
    output_dir: Path,
    method: str,
    alpha: float,
    dry_run: bool,
    weight_format: str,
    ollama_model_name: str,
    worker_family: str,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    stats = dict(metadata or {})
    compatible_tensor_count = int(stats.get("compatible_tensor_count", 0) or 0)
    skipped_tensor_count = int(stats.get("skipped_tensor_count", 0) or 0)
    base_tensor_count = int(stats.get("base_tensor_count", 0) or 0)
    secondary_tensor_count = int(stats.get("secondary_tensor_count", 0) or 0)
    merge_ready = (compatible_tensor_count > 0) and not dry_run
    summary = (
        f"Prepared tensor-level checkpoint merge for {base_path.name} + {secondary_path.name}."
        if dry_run
        else f"Merged {compatible_tensor_count} compatible tensors from {secondary_path.name} into {base_path.name}."
    )
    return {
        "kind": "assistant-checkpoint-merge",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "merge_id": merge_id,
        "variant_id": merge_id,
        "merge_name": merge_name,
        "variant_name": merge_name,
        "method": method,
        "alpha": alpha,
        "dry_run": dry_run,
        "base_model_path": str(base_path),
        "secondary_model_path": str(secondary_path),
        "base_model_name": base_path.name,
        "secondary_model_name": secondary_path.name,
        "output_dir": str(output_dir),
        "output_model_path": str(output_dir / ("model.safetensors" if weight_format == "safetensors" else "pytorch_model.bin")),
        "output_weight_format": weight_format,
        "ollama_model_name": ollama_model_name,
        "worker_family": worker_family,
        "promotion_policy_default": "manual-promote",
        "rollback_source": str(base_path),
        "compatible_tensor_count": compatible_tensor_count,
        "skipped_tensor_count": skipped_tensor_count,
        "merged_tensor_count": compatible_tensor_count,
        "base_tensor_count": base_tensor_count,
        "secondary_tensor_count": secondary_tensor_count,
        "merge_ready": merge_ready,
        "summary": summary,
        "notes": [
            "Tensor-level merges are intended for compatible checkpoints only.",
            "Benchmark the merged worker in a lab before promotion.",
            "Keep the base checkpoint as the rollback source.",
        ],
        "artifact_paths": [str(output_dir)],
    }


def merge_checkpoint_bundle(
    *,
    base_path: str | Path,
    secondary_path: str | Path,
    output_dir: str | Path,
    merge_name: str = "",
    alpha: float = 0.2,
    method: str = "linear",
    ollama_model_name: str = "",
    dry_run: bool = False,
) -> dict[str, Any]:
    base_root = Path(base_path).expanduser().resolve()
    secondary_root = Path(secondary_path).expanduser().resolve()
    output_root = Path(output_dir).expanduser().resolve()
    if not base_root.exists() or not base_root.is_dir():
        raise CheckpointMergeError(f"Base checkpoint path does not exist: {base_root}")
    if not secondary_root.exists() or not secondary_root.is_dir():
        raise CheckpointMergeError(f"Secondary checkpoint path does not exist: {secondary_root}")
    merge_id = f"{_now_stamp()}-{(merge_name or secondary_root.name).strip().lower().replace(' ', '-') or 'merge'}"
    output_root.mkdir(parents=True, exist_ok=True)

    weight_format, base_weight_files = _resolve_weight_files(base_root)
    secondary_format, secondary_weight_files = _resolve_weight_files(secondary_root)
    if weight_format != secondary_format:
        raise CheckpointMergeError(
            f"Base and secondary checkpoints use different weight formats ({weight_format} vs {secondary_format})."
        )
    worker_family = "deepseek-coder" if base_root.name.lower().startswith("deepseek") else ("qwen3" if base_root.name.lower().startswith("qwen3") else "qwen")
    manifest = build_checkpoint_merge_manifest(
        merge_id=merge_id,
        merge_name=merge_name or f"{base_root.name} x {secondary_root.name}",
        base_path=base_root,
        secondary_path=secondary_root,
        output_dir=output_root,
        method=method,
        alpha=alpha,
        dry_run=dry_run,
        weight_format=weight_format,
        ollama_model_name=ollama_model_name or (
            "gosenderr-deepseek-merged:latest" if worker_family == "deepseek-coder"
            else ("gosenderr-qwen3-merged:latest" if worker_family == "qwen3" else "gosenderr-qwen-merged:latest")
        ),
        worker_family=worker_family,
    )
    manifest_path = output_root / "merge-manifest.json"

    if dry_run:
        manifest["base_weight_files"] = [str(path) for path in base_weight_files]
        manifest["secondary_weight_files"] = [str(path) for path in secondary_weight_files]
        manifest_path.write_text(_safe_json(manifest) + "\n", encoding="utf-8")
        return {
            "ok": True,
            "dry_run": True,
            "summary": manifest["summary"],
            "output_dir": str(output_root),
            "manifest_path": str(manifest_path),
            "checkpoint_merge": manifest,
        }

    torch_mod, safe_load_file, safe_save_file = _load_tensor_stack()
    base_state = _load_state_dict(base_root, weight_format, base_weight_files, torch_mod=torch_mod, safe_load_file=safe_load_file)
    secondary_state = _load_state_dict(secondary_root, secondary_format, secondary_weight_files, torch_mod=torch_mod, safe_load_file=safe_load_file)
    merged_state, metadata = _merge_state_dicts(base_state, secondary_state, alpha=float(alpha), method=method, torch_mod=torch_mod)
    manifest.update(metadata)

    if weight_format == "safetensors":
        if safe_save_file is None:
            raise CheckpointMergeError("Saving a safetensors merge requires the safetensors package.")
        safe_save_file(merged_state, str(output_root / "model.safetensors"))
    else:
        torch_mod.save(merged_state, str(output_root / "pytorch_model.bin"))

    supporting_files = _copy_supporting_files(base_root, output_root)
    manifest["artifact_paths"] = [str(output_root / ("model.safetensors" if weight_format == "safetensors" else "pytorch_model.bin")), *supporting_files]
    manifest["merge_ready"] = True
    manifest_path.write_text(_safe_json(manifest) + "\n", encoding="utf-8")
    return {
        "ok": True,
        "dry_run": False,
        "summary": manifest["summary"],
        "output_dir": str(output_root),
        "manifest_path": str(manifest_path),
        "checkpoint_merge": manifest,
    }


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Merge two local checkpoints at tensor level.")
    parser.add_argument("--base-path", required=True)
    parser.add_argument("--secondary-path", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--merge-name", default="")
    parser.add_argument("--alpha", type=float, default=0.2)
    parser.add_argument("--method", default="linear")
    parser.add_argument("--ollama-model-name", default="")
    parser.add_argument("--dry-run", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    try:
        result = merge_checkpoint_bundle(
            base_path=args.base_path,
            secondary_path=args.secondary_path,
            output_dir=args.output_dir,
            merge_name=args.merge_name,
            alpha=args.alpha,
            method=args.method,
            ollama_model_name=args.ollama_model_name,
            dry_run=args.dry_run,
        )
        print(json.dumps(result))
        return 0
    except CheckpointMergeError as exc:
        print(json.dumps({"ok": False, "error": str(exc)}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
