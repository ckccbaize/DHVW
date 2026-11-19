// 光照档位：端侧与视图共用的唯一映射（避免两处各写一份）。

export function lightFor(phase, weather) {
  if (weather === "rain" || weather === "storm") return "rain";
  if (weather === "snow") return "snow";
  if (weather === "fog") return "day";
  switch (phase) {
    case "sleep":
    case "night":
      return "night";
    case "wake":
      return "dawn";
    case "evening":
      return "dusk";
    default:
      return "day";
  }
}
