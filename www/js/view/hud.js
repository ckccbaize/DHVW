// HUD：角标 / 连接点 / 时钟 / Agent 卡 / 端侧产出计数（§10.4）。
// 角标是"世界档位"唯一可见痕迹；主机不可达时 Agent 卡整卡变灰。

import { weekdayInfo } from "../core/clock.js";

function todayMmDd() {
  const d = new Date();
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function createHud({ root, store }) {
  const tierEl = root.querySelector("#tierBadge");
  const dotEl = root.querySelector("#connDot");
  const connEl = root.querySelector("#connText");
  const clockEl = root.querySelector("#clock");
  const cardEl = root.querySelector("#agentCard");
  const cardBody = root.querySelector("#agentCardBody");
  const assetEl = root.querySelector("#assetCounts");
  const fpsEl = root.querySelector("#fps");
  const dock = root.querySelector("#dock");

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
    const mmdd = c.date ? String(c.date).slice(5) : todayMmDd();
    const wk = c.weekdayName || weekdayInfo().weekdayName;
    clockEl.textContent = `第 ${c.day || 1} 天 · ${mmdd} ${wk} ${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;

    cardEl.classList.toggle("offline", !up);
    if (!up) {
      cardEl.hidden = false;
      cardBody.textContent = "主机未连接";
    } else {
      const a = state.agentCard;
      const hasAgent = a && (a.platform || a.task || a.state);
      cardEl.hidden = !hasAgent;
      if (hasAgent) cardBody.textContent = `${a.platform || "agent"} · ${a.task || "-"} · ${a.state || "-"}`;
    }

    const a = state.assets || { scene: 0, plot: 0, bg: 0 };
    const scenes = Number.isFinite(state.sceneCount) ? state.sceneCount : a.scene;
    assetEl.textContent = `场景 ${scenes} / 剧情 ${a.plot} / 背景 ${a.bg}`;
  }

  function setFps(fps) {
    fpsEl.textContent = `${fps} fps`;
  }

  function toggleMenu(force) {
    menuOpen = force === undefined ? !menuOpen : !!force;
    if (!dock) return;
    dock.classList.toggle("open", menuOpen);
    dock.setAttribute("aria-hidden", menuOpen ? "false" : "true");
  }

  return { render, setFps, toggleMenu, get menuOpen() { return menuOpen; } };
}
