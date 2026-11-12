// 虚拟滑动二切开关 + DisplaySwitchSource 抽象（M11-T10 / §10.15）。
// 硬件（GPIO）实现留空：收到 window 事件 'dhvw:gpio' 时按同一逻辑处理。

export function createSwitch({ el, knob, onRequest, isOn }) {
  let on = !!isOn;
  let dragging = false;
  let startX = 0;
  let moved = 0;

  function render() {
    el.classList.toggle("on", on);
    knob.style.transform = on ? "translateX(34px)" : "translateX(0)";
  }

  function request(next) {
    // 由 app 决定是否接受（主机不可达时拒绝并回弹）
    const accepted = onRequest(next);
    if (accepted) {
      on = next;
      render();
    } else {
      el.classList.add("bounce");
      setTimeout(() => el.classList.remove("bounce"), 260);
      render();
    }
    return accepted;
  }

  el.addEventListener("pointerdown", (e) => {
    dragging = true;
    startX = e.clientX;
    moved = 0;
    el.setPointerCapture(e.pointerId);
  });
  el.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    moved = e.clientX - startX;
    knob.style.transform = `translateX(${Math.max(0, Math.min(34, (on ? 34 : 0) + moved))}px)`;
  });
  el.addEventListener("pointerup", () => {
    if (!dragging) return;
    dragging = false;
    if (Math.abs(moved) > 16) request(moved > 0 ? true : false);
    else request(!on);
  });
  el.addEventListener("pointercancel", () => {
    dragging = false;
    render();
  });

  render();

  return {
    get on() {
      return on;
    },
    set(next) {
      on = next;
      render();
    },
    request,
  };
}

/**
 * 事件源抽象：virtual（指针/键盘）与 gpio（硬件中断）。
 * 硬件到位时只需把 gpio 事件接到 onChange，UI 逻辑不变。
 */
export function createSwitchSource({ kind = "virtual", onChange }) {
  if (kind === "gpio") {
    const handler = (e) => onChange(!!e.detail?.on);
    window.addEventListener("dhvw:gpio", handler);
    return { stop: () => window.removeEventListener("dhvw:gpio", handler) };
  }
  const onKey = (e) => {
    if (e.key === "ArrowRight") onChange(true);
    else if (e.key === "ArrowLeft") onChange(false);
  };
  window.addEventListener("keydown", onKey);
  return { stop: () => window.removeEventListener("keydown", onKey) };
}
