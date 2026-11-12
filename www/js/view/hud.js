// HUD：角标 / 连接点 / 时钟 / Agent 卡 / 端侧产出计数（§10.4）。
// 角标是"世界档位"唯一可见痕迹；主机不可达时 Agent 卡整卡变灰。

export function createHud({ root, store, onLongPress }) {
  const tierEl = root.querySelector("#tierBadge");
  const dotEl = root.querySelector("#connDot");
  const connEl = root.querySelector("#connText");
  const clockEl = root.querySelector("#clock");
  const cardEl = root.querySelector("#agentCard");
  const cardBody = root.querySelector("#agentCardBody");
  const assetEl = root.querySelector("#assetCounts");
  const fpsEl = root.querySelector("#fps");
  const menu = root.querySelector("#menu");

  let menuOpen = false;

  function render(state) {
    const tier = state.tier;
    tierEl.textContent = tier === "host" ? "世界·主机" : tier === "edge" ? "世界·本地" : "";
    tierEl.className = "tier" + (tier === "host" ? " host" : tier === "edge" ? " edge" : " idle");

    const up = state.conn === "up";
    dotEl.className = "dot" + (up ? " up" : " off");
    connEl.textContent = up ? "主机在线" : "主机未连接";

    const c = state.clock || {};
    const hh = Math.floor((c.minute || 0) / 60);
    const mm = Math.floor((c.minute || 0) % 60);
    clockEl.textContent = `第 ${c.day || 1} 天 ${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;

    cardEl.classList.toggle("offline", !up);
    if (!up) {
      cardBody.textContent = "主机未连接";
    } else if (!state.agentCard) {
      cardBody.textContent = "未接入";
    } else {
      const a = state.agentCard;
      cardBody.textContent = `${a.platform || "agent"} · ${a.task || "-"} · ${a.state || "-"}`;
    }

    const a = state.assets || { scene: 0, plot: 0, bg: 0 };
    assetEl.textContent = `场景 ${a.scene} / 剧情 ${a.plot} / 背景 ${a.bg}`;
  }

  function setFps(fps) {
    fpsEl.textContent = `${fps} fps`;
  }

  function toggleMenu(force) {
    menuOpen = force === undefined ? !menuOpen : !!force;
    menu.hidden = !menuOpen;
  }

  // 长按空白出菜单（§10.4 交互）
  let pressTimer = null;
  const target = root.querySelector("#stage");
  target.addEventListener("pointerdown", () => {
    clearTimeout(pressTimer);
    pressTimer = setTimeout(() => {
      toggleMenu(true);
      onLongPress && onLongPress();
    }, 600);
  });
  const cancel = () => clearTimeout(pressTimer);
  target.addEventListener("pointerup", cancel);
  target.addEventListener("pointermove", cancel);
  target.addEventListener("pointercancel", cancel);

  menu.addEventListener("click", (e) => {
    if (e.target === menu) toggleMenu(false);
  });

  return { render, setFps, toggleMenu, get menuOpen() { return menuOpen; } };
}
