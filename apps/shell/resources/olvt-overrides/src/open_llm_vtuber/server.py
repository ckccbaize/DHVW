"""
Open-LLM-VTuber Server (DHVW override)
======================================
在原版 FastAPI 静态托管基础上，为 frontend/index.html 注入运行时地址引导脚本：
1. 让前端自动把 localStorage 的 wsUrl / baseUrl 对准当前访问的动态端口或网关 /ws/olvt；
2. 添加 /health 健康检查与 iframe 嵌入放行响应头，供 ARM 端总观 ⇄ 显现安全内嵌。
"""

import os
import shutil
from contextlib import asynccontextmanager
from uuid import uuid4

from fastapi import FastAPI, APIRouter, Request, WebSocket, WebSocketDisconnect
from starlette.middleware.cors import CORSMiddleware
from starlette.responses import HTMLResponse, JSONResponse, Response
from starlette.staticfiles import StaticFiles as StarletteStaticFiles

from .routes import init_webtool_routes, init_proxy_route
from .service_context import ServiceContext
from .websocket_handler import WebSocketHandler
from .config_manager.utils import Config
from .proactive import ProactiveScheduler

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
    var hasGesture = false;
    var syncSuspendedFlag = function () {
      var anySusp = false;
      for (var i = trackedCtx.length - 1; i >= 0; i--) {
        var c = trackedCtx[i];
        if (!c || c.state === 'closed') {
          trackedCtx.splice(i, 1);
          continue;
        }
        if (c.state === 'suspended') anySusp = true;
      }
      if (document.documentElement) {
        if (anySusp) document.documentElement.setAttribute('data-dhvw-mic-suspended', '1');
        else document.documentElement.removeAttribute('data-dhvw-mic-suspended');
        var mb = document.querySelector('[data-dhvw="mic-btn"]');
        if (mb) mb.setAttribute('title', anySusp ? '点击激活麦克风（等待浏览器解锁音频）' : '麦克风开关');
      }
      return anySusp;
    };
    var tryResume = function (c) {
      if (c && c.state === 'suspended' && typeof c.resume === 'function') {
        try { c.resume().then(syncSuspendedFlag).catch(function () {}); } catch (e) {}
      }
    };
    var resumeAll = function () {
      hasGesture = true;
      for (var i = 0; i < trackedCtx.length; i++) tryResume(trackedCtx[i]);
      syncSuspendedFlag();
    };
    var NativeAC = window.AudioContext || window.webkitAudioContext;
    if (NativeAC) {
      var WrappedAC = function () {
        var ctx = arguments.length ? new NativeAC(arguments[0]) : new NativeAC();
        trackedCtx.push(ctx);
        if (typeof ctx.addEventListener === 'function') {
          ctx.addEventListener('statechange', function () {
            if (hasGesture && ctx.state === 'suspended') tryResume(ctx);
            syncSuspendedFlag();
          });
        }
        tryResume(ctx);
        syncSuspendedFlag();
        return ctx;
      };
      WrappedAC.prototype = NativeAC.prototype;
      if (Object.setPrototypeOf) Object.setPrototypeOf(WrappedAC, NativeAC);
      window.AudioContext = WrappedAC;
      if (window.webkitAudioContext) window.webkitAudioContext = WrappedAC;
      var pendingUnlockClick = false;
      var resumeFromGesture = function (ev) {
        var wasSusp = syncSuspendedFlag();
        var micBtn = ev && ev.target && ev.target.closest ? ev.target.closest('[data-dhvw="mic-btn"]') : null;
        if (wasSusp && micBtn && localStorage.getItem('micOn') === 'true') {
          pendingUnlockClick = true;
          setTimeout(function () { pendingUnlockClick = false; }, 400);
        }
        resumeAll();
      };
      ['pointerdown', 'touchstart', 'keydown'].forEach(function (ev) {
        window.addEventListener(ev, resumeFromGesture, { capture: true, passive: true });
      });
      window.addEventListener('click', function (ev) {
        var wasSusp = syncSuspendedFlag();
        resumeAll();
        var micBtn = ev.target && ev.target.closest ? ev.target.closest('[data-dhvw="mic-btn"]') : null;
        if ((wasSusp || pendingUnlockClick) && micBtn && localStorage.getItem('micOn') === 'true') {
          pendingUnlockClick = false;
          ev.stopPropagation();
          ev.preventDefault();
          return;
        }
        pendingUnlockClick = false;
      }, { capture: true });
    }
    if (underGateway) {
      try {
        var tok = new URLSearchParams(location.search).get('token');
        if (tok) {
          var appendToken = function (u) {
            if (typeof u !== 'string') return u;
            if ((u.indexOf('./libs/') === 0 || u.indexOf('/olvt/libs/') === 0 || u.indexOf('/libs/') === 0) && u.indexOf('token=') === -1) {
              return u + (u.indexOf('?') === -1 ? '?' : '&') + 'token=' + encodeURIComponent(tok);
            }
            return u;
          };
          if (window.AudioWorklet && window.AudioWorklet.prototype && window.AudioWorklet.prototype.addModule) {
            var origAdd = window.AudioWorklet.prototype.addModule;
            window.AudioWorklet.prototype.addModule = function (u, opts) {
              return origAdd.call(this, appendToken(u), opts);
            };
          }
          if (window.fetch) {
            var origFetch = window.fetch;
            window.fetch = function (input, init) {
              if (typeof input === 'string') input = appendToken(input);
              return origFetch.call(this, input, init);
            };
          }
        }
      } catch (e) {}
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
    # 4. Ensure MicVAD.start() resumes its AudioContext if suspended after async getUserMedia
    text = text.replace(
        "this.start=()=>{this.audioNodeVAD.start(),this.listening=!0}",
        "this.start=()=>{this.audioContext&&this.audioContext.state===\"suspended\"&&this.audioContext.resume().catch(()=>{}),this.audioNodeVAD.start(),this.listening=!0}",
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
        # lifespan 里启动调度器：run_server 先 asyncio.run(initialize()) 再 uvicorn.run，
        # 只有 uvicorn 自己的事件循环能承载常驻任务，且在 0.115+ 都不依赖已废弃的 startup 钩子。
        self.app = FastAPI(title="Open-LLM-VTuber Server", lifespan=self._lifespan)
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

        # 自己持有 WebSocketHandler：主动说话调度器需要看到连接与上下文
        self.ws_handler = WebSocketHandler(self.default_context_cache)
        self.proactive = ProactiveScheduler(self.ws_handler)
        self._install_activity_hook()
        self.app.include_router(self._client_ws_router())
        self._install_proactive_routes()
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

    @asynccontextmanager
    async def _lifespan(self, _app: FastAPI):
        self.proactive.start()
        yield

    def _install_activity_hook(self) -> None:
        """任何客户端消息都算“有人在场”：主动说话据此复位节奏。"""
        if getattr(WebSocketHandler, "_dhvw_activity_hooked", False):
            return
        WebSocketHandler._dhvw_activity_hooked = True
        scheduler = self.proactive
        original = WebSocketHandler._route_message

        async def route_with_activity(self, websocket, client_uid, data):
            try:
                scheduler.note_activity(client_uid)
            except Exception:
                pass
            return await original(self, websocket, client_uid, data)

        WebSocketHandler._route_message = route_with_activity

    def _client_ws_router(self) -> APIRouter:
        """等价于上游 init_client_ws_route，但 handler 归实例所有。"""
        router = APIRouter()
        ws_handler = self.ws_handler

        @router.websocket("/client-ws")
        async def websocket_endpoint(websocket: WebSocket):
            await websocket.accept()
            client_uid = str(uuid4())
            try:
                await ws_handler.handle_new_connection(websocket, client_uid)
                await ws_handler.handle_websocket_communication(websocket, client_uid)
            except WebSocketDisconnect:
                await ws_handler.handle_disconnect(client_uid)
            except Exception:
                await ws_handler.handle_disconnect(client_uid)
                raise

        return router

    def _install_proactive_routes(self) -> None:
        scheduler = self.proactive

        @self.app.get("/proactive/state")
        async def proactive_state() -> JSONResponse:
            return JSONResponse(scheduler.state())

        @self.app.post("/proactive/config")
        async def proactive_config(request: Request) -> JSONResponse:
            body = await request.json()
            if isinstance(body, dict) and "config" in body and isinstance(body["config"], dict):
                body = body["config"]
            scheduler.configure(body if isinstance(body, dict) else {})
            return JSONResponse(scheduler.state())

        @self.app.post("/proactive/speak")
        async def proactive_speak() -> JSONResponse:
            """调试用：跳过节奏直接说一次（仍受 enabled / 静默时段约束）。"""
            return JSONResponse(await scheduler.speak_now())

    async def initialize(self):
        await self.default_context_cache.load_from_config(self.config)

    @staticmethod
    def clean_cache():
        cache_dir = "cache"
        if os.path.exists(cache_dir):
            shutil.rmtree(cache_dir)
            os.makedirs(cache_dir)
