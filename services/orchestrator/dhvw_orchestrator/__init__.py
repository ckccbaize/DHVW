"""DHVW 编排器（PC 侧）：设备 ↔ PC 的 /dhvw 通道、事件入库、摘要与记忆查询。

职责边界见 docs/ARM-CORE-INTEGRATION.md：世界/生活/心情状态归 ARM，本服务只做
「接收 ACK、摘要落地、记忆向量库、pc:action 执行、显现闸门」。
"""

from __future__ import annotations

import os
from pathlib import Path

APP_ID = "dhvw-orchestrator"


def data_dir() -> Path:
    """与外壳一致的数据目录：环境变量优先，其次 %APPDATA%/DigitalHuman/data。"""
    override = os.environ.get("DHVW_DATA_DIR")
    if override:
        path = Path(override)
    else:
        base = os.environ.get("APPDATA") or str(Path.home() / "AppData" / "Roaming")
        path = Path(base) / "DigitalHuman" / "data"
    path.mkdir(parents=True, exist_ok=True)
    return path


def service_version() -> str:
    return "0.1.0"
