// 事件环形缓冲：上限 2000 条，满则覆盖最旧并计数（§10.7.6 / §2.4）。

export function createRingBuffer(capacity = 2000) {
  if (!(capacity > 0)) throw new Error("capacity 必须 > 0");
  const items = [];
  let dropped = 0;

  return {
    get capacity() {
      return capacity;
    },
    get size() {
      return items.length;
    },
    get dropped() {
      return dropped;
    },
    push(item) {
      if (items.length >= capacity) {
        items.shift();
        dropped += 1;
      }
      items.push(item);
      return dropped;
    },
    toArray() {
      return items.slice();
    },
    /** 取最早的一批（回流用），不删除。 */
    peek(n = 200) {
      return items.slice(0, n);
    },
    clear() {
      items.length = 0;
    },
  };
}
