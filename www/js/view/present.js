// 显现视图：主机依赖态（PROJECT-PLAN §10.5）。
// 四级前置的判定在 app.js（主机可达 → TTS → Live2D → 世界已停）；这里只负责渲染与退出。
// Live2D 模型未交付时走 A10 允许的降级：静态立绘 + 字幕继续。

export function createPresent({ root, store, onExit }) {
  const bg = root.querySelector(".present-bg");
  const portrait = root.querySelector(".present-portrait");
  const subtitle = root.querySelector(".present-subtitle");
  const hint = root.querySelector(".present-hint");
  const name = root.querySelector(".present-name");
  let openedAt = 0;
  let lastInteract = 0;

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
    get idleMs() {
      return lastInteract ? performance.now() - lastInteract : 0;
    },
    open({ backgroundUrl = null, live2d = false, tts = false } = {}) {
      setBackground(backgroundUrl);
      root.hidden = false;
      openedAt = performance.now();
      lastInteract = openedAt;
      name.textContent = "她";
      subtitle.textContent = "";
      portrait.hidden = !!live2d;
      hint.textContent = live2d
        ? tts
          ? ""
          : "语音未就绪，先文字聊"
        : "Live2D 资源未就绪 · 静态立绘模式";
    },
    close() {
      root.hidden = true;
      subtitle.textContent = "";
      lastInteract = 0;
    },
    say(text) {
      subtitle.textContent = text;
      lastInteract = performance.now();
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
