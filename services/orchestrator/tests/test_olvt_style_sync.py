from __future__ import annotations

import importlib.util
import sys
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from dhvw_orchestrator.olvt_proxy import detect_repetition_hint, sanitize_proxy_payload  # noqa: E402


def _load_proactive_module():
    """加载 OLVT proactive.py（stub 掉上游包依赖，仅测 _compose_prompt 与状态逻辑）。"""
    repo_root = ROOT.parent.parent.parent
    proactive_path = (
        repo_root
        / "PC"
        / "apps"
        / "shell"
        / "resources"
        / "olvt-overrides"
        / "src"
        / "open_llm_vtuber"
        / "proactive.py"
    )
    pkg = types.ModuleType("open_llm_vtuber")
    conv_pkg = types.ModuleType("open_llm_vtuber.conversations")
    conv_utils = types.ModuleType("open_llm_vtuber.conversations.conversation_utils")
    conv_utils.EMOJI_LIST = ["😊"]
    single_conv = types.ModuleType("open_llm_vtuber.conversations.single_conversation")

    async def _noop(*args, **kwargs):
        return ""

    single_conv.process_single_conversation = _noop
    sys.modules["open_llm_vtuber"] = pkg
    sys.modules["open_llm_vtuber.conversations"] = conv_pkg
    sys.modules["open_llm_vtuber.conversations.conversation_utils"] = conv_utils
    sys.modules["open_llm_vtuber.conversations.single_conversation"] = single_conv
    try:
        import loguru  # noqa: F401
    except ImportError:
        loguru_stub = types.ModuleType("loguru")
        loguru_stub.logger = types.SimpleNamespace(
            info=lambda *a, **k: None,
            warning=lambda *a, **k: None,
            error=lambda *a, **k: None,
            debug=lambda *a, **k: None,
        )
        sys.modules["loguru"] = loguru_stub

    spec = importlib.util.spec_from_file_location("open_llm_vtuber.proactive", proactive_path)
    mod = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(mod)
    return mod


class OlvtStyleSyncTests(unittest.TestCase):
    def test_detects_bland_neutral_cliche_dry_and_particle_repeat(self) -> None:
        msgs = [
            {"role": "system", "content": "人设"},
            {"role": "user", "content": "选麦当劳还是肯德基？"},
            {"role": "assistant", "content": "讲真各有各的好，都挺好的"},
            {"role": "user", "content": "今天有点懒得动"},
            {"role": "assistant", "content": "讲真还是劳逸结合比较重要呀"},
            {"role": "user", "content": "周末想熬夜打游戏"},
            {"role": "assistant", "content": "这个看个人安排吧，别太累呀"},
        ]
        hint = detect_repetition_hint(msgs, is_local=False)
        self.assertIsNotNone(hint)
        assert hint is not None
        self.assertIn("拒绝端水与老好人", hint)
        self.assertIn("上轮刚用过尾音「呀」", hint)
        self.assertIn("严禁复用最近高频词/套话：讲真", hint)
        self.assertIn("本轮节奏", hint)

    def test_detects_dry_replies_and_question_streak(self) -> None:
        msgs = [
            {"role": "system", "content": "人设"},
            {"role": "user", "content": "刚下班"},
            {"role": "assistant", "content": "刚下班打算吃什么？"},
            {"role": "user", "content": "还没想好"},
            {"role": "assistant", "content": "那你想喝奶茶吗？"},
            {"role": "user", "content": "不想喝"},
            {"role": "assistant", "content": "为什么不想喝？"},
        ]
        hint = detect_repetition_hint(msgs, is_local=False)
        self.assertIsNotNone(hint)
        assert hint is not None
        self.assertIn("禁止以问句收尾", hint)
        self.assertIn("语气词太少显得生硬", hint)

    def test_sanitize_bumps_default_cloud_temp_and_skips_extraction(self) -> None:
        chat_payload = {
            "model": "gpt-4o-mini",
            "temperature": 0.7,
            "messages": [
                {"role": "system", "content": "你住在虚拟仓"},
                {"role": "user", "content": "选A还是选B"},
                {"role": "assistant", "content": "都挺好的"},
                {"role": "user", "content": "别敷衍我"},
                {"role": "assistant", "content": "听起来不错，看个人吧"},
            ],
        }
        out, injected = sanitize_proxy_payload(chat_payload, is_local=False)
        self.assertTrue(injected)
        self.assertEqual(out["temperature"], 0.9)
        self.assertIn("[本轮表达微调]", out["messages"][0]["content"])

        extract_payload = {
            "model": "gpt-4o-mini",
            "temperature": 0.1,
            "max_tokens": 300,
            "messages": [{"role": "system", "content": "你是记忆整理助手，只输出 JSON"}],
        }
        ext_out, ext_injected = sanitize_proxy_payload(extract_payload, is_local=False)
        self.assertFalse(ext_injected)
        self.assertEqual(ext_out["temperature"], 0.1)

    def test_proactive_compose_prompt_matches_lively_particle_rules(self) -> None:
        mod = _load_proactive_module()
        handler = types.SimpleNamespace(
            client_connections={}, client_contexts={}, current_conversation_tasks={}
        )
        sched = mod.ProactiveScheduler(handler)
        sched._recent_openers.append("你也太能摸鱼了吧呀")
        prompt = sched._compose_prompt()
        self.assertIn("活泼俏皮有态度", prompt)
        self.assertIn("嘛/呀/吧/咧/哼/切/呗", prompt)
        self.assertIn("上轮用过尾音「呀」", prompt)
        self.assertIn("翻旧账套话", prompt)


if __name__ == "__main__":
    unittest.main()
