# 本地推理引擎与模型目录 (`PC/local_ai`)

本目录为 DHVW PC 端本地 `llama.cpp` 推理引擎与 GGUF 模型的固定根目录（二进制与 `.gguf` 权重文件均已加入 `.gitignore`，不会进入仓库）。

## 目录结构

```text
PC/local_ai/
├─ llama/                                                       # 放置 llama-server.exe 及所需 CUDA/CPU DLL
└─ models/
   └─ NVIDIA-Nemotron-3.5-Bolt-E4B-Uncensored-AD-Q4_K_M-00001-of-00001.gguf
```

- 模型也可直接在 PC 端「信息 → 组件 → 本地大模型 Nemotron-3.5-Bolt-E4B」点击 **一键下载** 自动落盘到 `models/`。
- 如需自定义位置，可设置环境变量 `DHVW_LOCAL_AI` 指向包含 `llama/` 与 `models/` 的目录。
- 实测调优启动参数（`RTX 5070 12GB + gemma4 E4B`）：
  `-ngl 99 --flash-attn on --jinja -c 32768 --cache-type-k f16 --cache-type-v f16 -b 2048 -ub 512 -t 6 -np 1 --temp 1.0 --top-p 0.95 --top-k 64`
