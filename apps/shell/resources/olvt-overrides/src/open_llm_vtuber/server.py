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
  } catch (e) {}
})();
</script>
<script src="./dhvw-arm.js" defer></script>"""

DHVW_STYLE_TAG = '<link rel="stylesheet" href="./dhvw-cel.css" />'


class CORSStaticFiles(StarletteStaticFiles):
    """Static files handler that adds CORS and DHVW framing headers."""

    async def get_response(self, path: str, scope):
        response = await super().get_response(path, scope)
        response.headers["Access-Control-Allow-Origin"] = "*"
        response.headers["Access-Control-Allow-Methods"] = "GET, OPTIONS"
        response.headers["Access-Control-Allow-Headers"] = "*"
        if path.endswith(".js"):
            response.headers["Content-Type"] = "application/javascript"
        norm = (path or "").strip("/")
        if norm in ("dhvw-cel.css", "dhvw-arm.js"):
            response.headers["Cache-Control"] = "no-store"
        return response


class FrontendStaticFiles(CORSStaticFiles):
    """Injects runtime wsUrl/baseUrl and DHVW Cel UI overrides into index.html."""

    async def get_response(self, path: str, scope):
        response = await super().get_response(path, scope)
        norm = (path or "").strip("/")
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
