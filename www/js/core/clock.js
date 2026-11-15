// 时钟：游戏内时间（day/minute）+ 设备/主机偏移。
// 设备时钟会漂，端侧只追加事件，回连后按 clock_offset 回填 t_corrected（§10.7.6）。

export const MINUTES_PER_DAY = 1440;

export function createClock({ day = 1, minute = 8 * 60, offsetMs = 0 } = {}) {
  let d = Number.isFinite(Number(day)) ? Number(day) : 1;
  let m = Number.isFinite(Number(minute)) ? Number(minute) : 8 * 60;

  return {
    get day() {
      return d;
    },
    get minute() {
      return m;
    },
    get offsetMs() {
      return offsetMs;
    },
    set(day, minute) {
      if (!Number.isFinite(day) || !Number.isFinite(minute)) return false;
      d = day;
      m = minute;
      return true;
    },
    /**
     * 只允许向前校准。主机回显的 clock 可能比端侧旧，
     * 直接 set 会让时间倒退，所以外部同步一律走这里。
     */
    setForward(day, minute) {
      if (!Number.isFinite(day) || !Number.isFinite(minute)) return false;
      if (day < d || (day === d && minute <= m)) return false;
      d = day;
      m = minute;
      return true;
    },
    /** 推进分钟（可为小数），自动跨天。 */
    advance(mins) {
      if (!(mins > 0)) return;
      m += mins;
      while (m >= MINUTES_PER_DAY) {
        m -= MINUTES_PER_DAY;
        d += 1;
      }
    },
    /** 用主机时间校准偏移；tServer 与 deviceNow 都是毫秒时间戳。 */
    setOffsetFromServer(tServer, deviceNow = Date.now()) {
      if (!Number.isFinite(tServer)) return offsetMs;
      offsetMs = tServer - deviceNow;
      return offsetMs;
    },
    /** 校正后的当前时间戳（端侧事件写 t_corrected 用）。 */
    correctedNow(deviceNow = Date.now()) {
      return deviceNow + offsetMs;
    },
    hhmm() {
      const h = Math.floor(m / 60);
      const mm = Math.floor(m % 60);
      return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
    },
    snapshot() {
      return { day: d, minute: m, offsetMs };
    },
  };
}

/** 时段划分（端侧作息，§7）。 */
export function phaseOf(minute) {
  if (minute >= 23 * 60 || minute < 7 * 60) return "sleep";
  if (minute < 8 * 60) return "wake";
  if (minute < 11 * 60) return "morning";
  if (minute < 13 * 60) return "noon";
  if (minute < 18 * 60) return "afternoon";
  if (minute < 22 * 60) return "evening";
  return "night";
}
