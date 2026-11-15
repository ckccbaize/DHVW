// 显现视图（W30）：优先嵌入 PC/OLVT 的 HTTPS 页面；不可用时降级为静态立绘。
// 四级前置判定在 app.js；这里负责 iframe 加载、超时、退出与消息转发。

export function createPresent({ root, store, onExit }) {
  const bg = root.querySelector(".present-bg");
  const portrait = root.querySelector(".present-portrait");
  const subtitle = root.querySelector(".present-subtitle");
  const hint = root.querySelector(".present-hint");
  const name = root.querySelector(".present-name");
  const frame = root.querySelector(".present-frame");
  let openedAt = 0;
  let lastInteract = 0;
  let iframeUrl = "";
  let iframeLoaded = false;
  let loadTimer = null;
  let pendingReady = null;

  function clearLoadTimer() {
    if (loadTimer) clearTimeout(loadTimer);
    loadTimer = null;
  }

  function fail(reason) {
    clearLoadTimer();
    pendingReady = null;
    if (onExit) onExit(reason);
  }

  if (frame) {
    frame.addEventListener("load", () => {
      if (!iframeUrl) return;
      iframeLoaded = true;
      clearLoadTimer();
      const cb = pendingReady;
      pendingReady = null;
      if (cb) cb();
    });
    frame.addEventListener("error", () => {
      if (iframeUrl) fail("iframe_error");
    });
  }

  function setBackground(url) {
    if (!url) {
      bg.style.background = "linear-gradient(160deg, #1b2230 0%, #2b3547 55%, #131820 100%)";
      return;
    }
    bg.style.background = `center/cover no-repeat url("${url}")`;
  }

  return {
    get isOpen() {
      return !root.hidden;
    },
    get usingIframe() {
      return !!iframeUrl;
    },
    get idleMs() {
      return lastInteract ? performance.now() - lastInteract : 0;
    },
    open({ backgroundUrl = null, iframeUrl: nextUrl = "", live2d = false, tts = false, onReady = null, timeoutMs = 20000 } = {}) {
      root.hidden = false;
      openedAt = performance.now();
      lastInteract = openedAt;

      if (nextUrl) {
        if (nextUrl !== iframeUrl) {
          iframeUrl = nextUrl;
          iframeLoaded = false;
          pendingReady = onReady;
          frame.src = nextUrl;
          frame.hidden = false;
          root.classList.add("iframe-mode");
          clearLoadTimer();
          loadTimer = setTimeout(() => {
            if (!iframeLoaded) fail("iframe_timeout");
          }, timeoutMs);
        } else if (iframeLoaded && onReady) {
          onReady();
        } else {
          pendingReady = onReady;
        }
        return;
      }

      if (iframeUrl) {
        if (onReady) onReady();
        return; // 已在 iframe 模式，忽略背景更新
      }
      setBackground(backgroundUrl);
      name.textContent = "她";
      subtitle.textContent = "";
      portrait.hidden = !!live2d;
      hint.textContent = live2d
        ? tts
          ? ""
          : "语音未就绪，先文字聊"
        : "Live2D 资源未就绪 · 静态立绘模式";
      if (onReady) onReady();
    },
    close() {
      clearLoadTimer();
      pendingReady = null;
      iframeUrl = "";
      iframeLoaded = false;
      if (frame) {
        frame.src = "about:blank";
        frame.hidden = true;
      }
      root.classList.remove("iframe-mode");
      root.hidden = true;
      subtitle.textContent = "";
      lastInteract = 0;
    },
    say(text) {
      subtitle.textContent = text;
      lastInteract = performance.now();
      if (iframeUrl && frame?.contentWindow) {
        try {
          const origin = new URL(iframeUrl).origin;
          frame.contentWindow.postMessage({ type: "dhvw:say", text }, origin);
        } catch {
          /* 跨域失败不影响本地字幕 */
        }
      }
    },
    touch() {
      lastInteract = performance.now();
    },
    /** 90s 无互动自动回总观（§10.5）。 */
    tick(now) {
      if (root.hidden) return false;
      if (now - lastInteract > 90000) {
        onExit && onExit("idle");
        return true;
      }
      return false;
    },
  };
}
