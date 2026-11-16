"""本地中文句向量编码器（ONNX Runtime + tokenizers，零运行期联网）。

模型：BAAI/bge-small-zh-v1.5（512 维，CLS 池化 + L2 归一化）。
找不到模型或运行时依赖时优雅降级（available=False），不阻塞服务启动。
"""

from __future__ import annotations

import os
import threading
from pathlib import Path

DIM = 512
MODEL_NAME = "bge-small-zh-v1.5"
MAX_LENGTH = 512

#: 运行时依赖：没有 sqlite-vec 就只剩字面检索，没有 onnxruntime/tokenizers 就没有向量
DEPS = {
    "onnxruntime": "onnxruntime",
    "tokenizers": "tokenizers",
    "numpy": "numpy",
    "sqlite_vec": "sqlite-vec",
}


def runtime_versions() -> dict[str, str | None]:
    """已安装依赖的版本；None = 没装（顺序与 DEPS 一致）。"""
    from importlib import metadata

    out: dict[str, str | None] = {}
    for mod, dist in DEPS.items():
        try:
            out[mod] = metadata.version(dist)
        except Exception:
            out[mod] = None
    return out


def find_model_dir(data_root: Path | None = None) -> Path | None:
    """按环境变量 → 用户数据目录 → 随包资源目录查找离线模型。"""
    candidates: list[Path] = []
    env_dir = os.environ.get("DHVW_EMBED_MODEL_DIR", "").strip()
    if env_dir:
        candidates.append(Path(env_dir))
    if data_root is not None:
        candidates.append(data_root.parent / "models" / MODEL_NAME)
    pkg_root = Path(__file__).resolve().parents[3]
    candidates.append(pkg_root / "models" / MODEL_NAME)
    candidates.append(pkg_root / "apps" / "shell" / "resources" / "models" / MODEL_NAME)
    for path in candidates:
        if (path / "model.onnx").is_file() and (path / "tokenizer.json").is_file():
            return path
    return None


class LocalEmbedder:
    def __init__(self, model_dir: Path | None = None, data_root: Path | None = None) -> None:
        self.model_dir = model_dir or find_model_dir(data_root)
        self._lock = threading.Lock()
        self._sess = None
        self._tok = None
        self._input_names: set[str] = set()
        self._failed = False
        self.error: str | None = None

    @property
    def available(self) -> bool:
        if self._failed or self.model_dir is None:
            return False
        if self._sess is not None:
            return True
        return self._ensure_loaded()

    def _ensure_loaded(self) -> bool:
        with self._lock:
            if self._sess is not None:
                return True
            if self._failed or self.model_dir is None:
                return False
            try:
                import onnxruntime as ort
                from tokenizers import Tokenizer

                tok = Tokenizer.from_file(str(self.model_dir / "tokenizer.json"))
                tok.enable_truncation(max_length=MAX_LENGTH)
                tok.enable_padding(pad_id=0, pad_token="[PAD]")
                sess = ort.InferenceSession(
                    str(self.model_dir / "model.onnx"),
                    providers=["CPUExecutionProvider"],
                )
                self._tok = tok
                self._sess = sess
                self._input_names = {i.name for i in sess.get_inputs()}
                return True
            except Exception as err:
                self._failed = True
                self.error = str(err)
                return False

    def encode(self, texts: list[str], batch_size: int = 32) -> list[list[float]]:
        """批量编码为 512 维 L2 归一化向量。"""
        if not texts or not self._ensure_loaded():
            return []
        import numpy as np

        assert self._tok is not None and self._sess is not None
        out_vecs: list[list[float]] = []
        for start in range(0, len(texts), batch_size):
            chunk = texts[start : start + batch_size]
            with self._lock:
                encs = self._tok.encode_batch(chunk)
                feeds: dict[str, np.ndarray] = {
                    "input_ids": np.array([e.ids for e in encs], dtype=np.int64),
                    "attention_mask": np.array([e.attention_mask for e in encs], dtype=np.int64),
                }
                if "token_type_ids" in self._input_names:
                    feeds["token_type_ids"] = np.array([e.type_ids for e in encs], dtype=np.int64)
                hidden = self._sess.run(None, feeds)[0]
            cls = hidden[:, 0, :].astype(np.float32)
            norms = np.linalg.norm(cls, axis=1, keepdims=True)
            norms = np.where(norms == 0.0, 1.0, norms)
            normed = cls / norms
            out_vecs.extend(normed.tolist())
        return out_vecs

    def encode_one(self, text: str) -> list[float] | None:
        vecs = self.encode([text])
        return vecs[0] if vecs else None
