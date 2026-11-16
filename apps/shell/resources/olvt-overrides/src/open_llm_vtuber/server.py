"""
Open-LLM-VTuber Server (DHVW override)
======================================
在原版 FastAPI 静态托管基础上，为 frontend/index.html 注入运行时地址引导脚本：
1. 让前端自动把 localStorage 的 wsUrl / baseUrl 对准当前访问的动态端口或网关 /ws/olvt；
2. 添加 /health 健康检查与 iframe 嵌入放行响应头，供 ARM 端总观 ⇄ 显现安全内嵌。
"""

import os
import shutil

from fastapi import FastAPI
from starlette.middleware.cors import CORSMiddleware
from starlette.responses import HTMLResponse, Response
from starlette.staticfiles import StaticFiles as StarletteStaticFiles

from .routes import init_client_ws_route, init_webtool_routes, init_proxy_route
from .service_context import ServiceContext
from .config_manager.utils import Config

DHVW_BOOTSTRAP_SCRIPT = """<script>
(function () {
  try {
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    var underGateway = location.pathname.indexOf('/olvt') === 0;
    var base = underGateway ? (location.origin + '/olvt') : location.origin;
    var ws = underGateway
      ? (proto + '//' + location.host + '/ws/olvt' + location.search)
      : (proto + '//' + location.host + '/client-ws');
    localStorage.setItem('wsUrl', JSON.stringify(ws));
    localStorage.setItem('baseUrl', JSON.stringify(base));
    localStorage.removeItem('micOn');

    var trackedCtx = [];
    var NativeAC = window.AudioContext || window.webkitAudioContext;
    if (NativeAC) {
      var WrappedAC = function () {
        var ctx = arguments.length ? new NativeAC(arguments[0]) : new NativeAC();
        trackedCtx.push(ctx);
        return ctx;
      };
      WrappedAC.prototype = NativeAC.prototype;
      if (Object.setPrototypeOf) Object.setPrototypeOf(WrappedAC, NativeAC);
      window.AudioContext = WrappedAC;
      if (window.webkitAudioContext) window.webkitAudioContext = WrappedAC;
      var resumeAll = function () {
        for (var i = 0; i < trackedCtx.length; i++) {
          var c = trackedCtx[i];
          if (c && c.state === 'suspended' && typeof c.resume === 'function') {
            try { c.resume().catch(function () {}); } catch (e) {}
          }
        }
      };
      ['pointerdown', 'click', 'touchstart', 'keydown'].forEach(function (ev) {
        window.addEventListener(ev, resumeAll, { capture: true, passive: true });
      });
    }
  } catch (e) {}
})();
</script>
<script src="./dhvw-arm.js" defer></script>"""

DHVW_STYLE_TAG = '<link rel="stylesheet" href="./dhvw-cel.css" />'
_DHVW_PATCHED_ASSETS: dict[str, bytes] = {}


def _patch_olvt_main_bundle(rel_path: str) -> bytes | None:
    """Apply Live2D multi-mask RT, clear, and RAF loop fixes to OLVT's main bundle."""
    cached = _DHVW_PATCHED_ASSETS.get(rel_path)
    if cached is not None:
        return cached
    fs_path = os.path.join("frontend", rel_path)
    if not os.path.isfile(fs_path):
        return None
    with open(fs_path, "r", encoding="utf-8") as f:
        text = f.read()
    # 1. Auto-size multi-render-texture count when clipping masks exceed default 36 (32 per RT)
    text = text.replace(
        "this._clippingContextListForMask.pushBack(_)),_.addClippedDrawable(a),this._clippingContextListForDraw.pushBack(_)}}findSameClip(o,s)",
        "this._clippingContextListForMask.pushBack(_)),_.addClippedDrawable(a),this._clippingContextListForDraw.pushBack(_)}"
        "this._clippingContextListForMask.getSize()>36&&s<=1&&("
        "this._renderTextureCount=Math.ceil(this._clippingContextListForMask.getSize()/32),"
        "this._clearedFrameBufferFlags=new csmVector(this._renderTextureCount))"
        "}findSameClip(o,s)",
        1,
    )
    # 2. Clear color buffer with transparent alpha alongside depth buffer to prevent ghosting
    text = text.replace(
        "gl.clearColor(0,0,0,1),gl.enable(gl.DEPTH_TEST),gl.depthFunc(gl.LEQUAL),gl.clear(gl.DEPTH_BUFFER_BIT)",
        "gl.clearColor(0,0,0,0),gl.enable(gl.DEPTH_TEST),gl.depthFunc(gl.LEQUAL),gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT)",
        1,
    )
    # 3. Guard duplicate LAppDelegate.run() requestAnimationFrame loops across model reloads
    text = text.replace(
        "release(){this._textureManager.release(),",
        "release(){this._running=!1,this._textureManager.release(),",
        1,
    )
    text = text.replace(
        "run(){const o=()=>{if(s_instance!=null){",
        "run(){if(this._running)return;this._running=!0;const o=()=>{if(s_instance!=null){",
        1,
    )
    data = text.encode("utf-8")
    _DHVW_PATCHED_ASSETS[rel_path] = data
    return data


class CORSStaticFiles(StarletteStaticFiles):
    """Static files handler that adds CORS and DHVW framing headers."""

    async def get_response(self, path: str, scope):
        response = await super().get_response(path, scope)
        response.headers["Access-Control-Allow-Origin"] = "*"
        response.headers["Access-Control-Allow-Methods"] = "GET, OPTIONS"
        response.headers["Access-Control-Allow-Headers"] = "*"
        if path.endswith(".js"):
            response.headers["Content-Type"] = "application/javascript"
        norm = (path or "").replace("\\", "/").strip("/")
        if norm in ("dhvw-cel.css", "dhvw-arm.js"):
            response.headers["Cache-Control"] = "no-store"
        return response


class FrontendStaticFiles(CORSStaticFiles):
    """Injects runtime wsUrl/baseUrl and DHVW Cel UI overrides into index.html."""

    async def get_response(self, path: str, scope):
        response = await super().get_response(path, scope)
        norm = (path or "").replace("\\", "/").strip("/")
        if norm in ("", ".", "index.html") and response.status_code == 200:
            idx = os.path.join("frontend", "index.html")
            if os.path.isfile(idx):
                with open(idx, "r", encoding="utf-8") as f:
                    html = f.read()
                if "localStorage.setItem('wsUrl'" not in html:
                    html = html.replace("<head>", "<head>\n" + DHVW_BOOTSTRAP_SCRIPT, 1)
                if "dhvw-cel.css" not in html:
                    html = html.replace("</head>", DHVW_STYLE_TAG + "\n</head>", 1)
                return HTMLResponse(
                    html,
                    headers={
                        "Access-Control-Allow-Origin": "*",
                        "Cache-Control": "no-store",
                    },
                )
        if norm.startswith("assets/main-") and norm.endswith(".js") and response.status_code == 200:
            patched = _patch_olvt_main_bundle(norm)
            if patched is not None:
                return Response(
                    content=patched,
                    media_type="application/javascript",
                    headers={
                        "Access-Control-Allow-Origin": "*",
                        "Cache-Control": "no-store",
                    },
                )
        return response


class AvatarStaticFiles(CORSStaticFiles):
    """Avatar files handler with security restrictions and CORS headers."""

    async def get_response(self, path: str, scope):
        allowed_extensions = (".jpg", ".jpeg", ".png", ".gif", ".svg")
        if not any(path.lower().endswith(ext) for ext in allowed_extensions):
            return Response("Forbidden file type", status_code=403)
        return await super().get_response(path, scope)


class WebSocketServer:
    """API server for Open-LLM-VTuber."""

    def __init__(self, config: Config, default_context_cache: ServiceContext = None):
        self.app = FastAPI(title="Open-LLM-VTuber Server")
        self.config = config
        self.default_context_cache = default_context_cache or ServiceContext()

        self.app.add_middleware(
            CORSMiddleware,
            allow_origins=["*"],
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
        )

        @self.app.get("/health")
        async def health() -> dict:
            return {"ok": True, "service": "olvt"}

        self.app.include_router(
            init_client_ws_route(default_context_cache=self.default_context_cache),
        )
        self.app.include_router(
            init_webtool_routes(default_context_cache=self.default_context_cache),
        )

        system_config = config.system_config
        if hasattr(system_config, "enable_proxy") and system_config.enable_proxy:
            host = system_config.host
            port = system_config.port
            server_url = f"ws://{host}:{port}/client-ws"
            self.app.include_router(
                init_proxy_route(server_url=server_url),
            )

        if not os.path.exists("cache"):
            os.makedirs("cache")
        self.app.mount("/cache", CORSStaticFiles(directory="cache"), name="cache")
        self.app.mount("/live2d-models", CORSStaticFiles(directory="live2d-models"), name="live2d-models")
        self.app.mount("/bg", CORSStaticFiles(directory="backgrounds"), name="backgrounds")
        self.app.mount("/avatars", AvatarStaticFiles(directory="avatars"), name="avatars")
        self.app.mount("/web-tool", CORSStaticFiles(directory="web_tool", html=True), name="web_tool")
        self.app.mount("/", FrontendStaticFiles(directory="frontend", html=True), name="frontend")

    async def initialize(self):
        await self.default_context_cache.load_from_config(self.config)

    @staticmethod
    def clean_cache():
        cache_dir = "cache"
        if os.path.exists(cache_dir):
            shutil.rmtree(cache_dir)
            os.makedirs(cache_dir)
