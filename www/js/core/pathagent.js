// PathAgent：位置模型照 ai-town（PROJECT-PLAN §2.6.4）。
// 下行只给 moveTo{path, speed, t0}，前端本地插值；state:overview 只带 pos_checksum 纠偏。
// 纯函数 + 可变 agent 对象，主线程与测试共用。

/** 速度：0.35s/格（§2.6.4）。 */
export const DEFAULT_SPEED = 1 / 0.35;

export function createAgent(x = 1, y = 1) {
  return {
    gx: x,
    gy: y,
    px: x + 0.5,
    py: y + 0.5,
    dir: { x: 0, y: 1 },
    state: "idle", // idle | walk | act
    frame: 0,
    path: [],
    target: null,
    act: null,
    actTtl: 0,
    speed: DEFAULT_SPEED,
  };
}

/** 下发移动意图。path 不含起点；返回是否接受。 */
export function moveTo(agent, path, { act = null, speed = agent.speed } = {}) {
  if (!Array.isArray(path) || path.length === 0) return false;
  agent.path = path.map((p) => [p[0], p[1]]);
  agent.target = agent.path[agent.path.length - 1].slice();
  agent.speed = speed;
  agent.act = act;
  agent.state = "walk";
  agent.actTtl = 0;
  return true;
}

/** 推进 dt 秒。返回 'arrived' 表示本帧到达终点。 */
export function step(agent, dt) {
  if (!(dt > 0)) return null;
  let arrived = null;

  if (agent.state === "walk" && agent.path.length) {
    let budget = agent.speed * dt;
    let guard = 0;
    while (budget > 0 && agent.path.length && guard++ < 64) {
      const [tx, ty] = agent.path[0];
      const cx = tx + 0.5;
      const cy = ty + 0.5;
      const dx = cx - agent.px;
      const dy = cy - agent.py;
      const d = Math.hypot(dx, dy);
      if (d > 1e-6) {
        if (Math.abs(dx) >= Math.abs(dy)) agent.dir = { x: Math.sign(dx), y: 0 };
        else agent.dir = { x: 0, y: Math.sign(dy) };
      }
      if (d <= budget) {
        agent.px = cx;
        agent.py = cy;
        agent.gx = tx;
        agent.gy = ty;
        agent.path.shift();
        budget -= d;
      } else {
        agent.px += (dx / d) * budget;
        agent.py += (dy / d) * budget;
        budget = 0;
      }
      agent.frame += dt * 8;
    }
    if (!agent.path.length) {
      agent.state = "act";
      agent.actTtl = 2;
      arrived = "arrived";
    }
  } else if (agent.state === "act") {
    agent.actTtl -= dt;
    if (agent.actTtl <= 0) {
      agent.state = "idle";
      agent.act = null;
    }
  }
  return arrived;
}

/**
 * 位置纠偏：只在偏差 >1 格时吸附（§2.6.4）。
 * 行走中不吸附（本地插值优先），避免画面抖动。
 */
export function applyChecksum(agent, x, y) {
  if (agent.state === "walk") return false;
  if (Math.hypot(agent.gx - x, agent.gy - y) <= 1) return false;
  agent.gx = x;
  agent.gy = y;
  agent.px = x + 0.5;
  agent.py = y + 0.5;
  agent.path = [];
  agent.target = null;
  agent.state = "idle";
  return true;
}

/** 切场景：位置落在目标门锚点邻格，朝向保留（§9 门锚点续接）。 */
export function placeAt(agent, x, y, dir = agent.dir) {
  agent.gx = x;
  agent.gy = y;
  agent.px = x + 0.5;
  agent.py = y + 0.5;
  agent.path = [];
  agent.target = null;
  agent.state = "idle";
  agent.act = null;
  agent.actTtl = 0;
  agent.dir = { ...dir };
}

/** 渲染用：行走帧索引（0..2 循环），静止固定 0。 */
export function walkFrame(agent) {
  if (agent.state !== "walk") return 0;
  return Math.floor(agent.frame) % 3;
}
