// 世界状态机（XState v5 版）——W2 spike 的候选 B。
// 三个并行区域：display / conn / tier；跨区域守卫需要把状态镜像进 context。
// 仅用于对比，不进入产物。

export function createWorldMachine(xstate) {
  const { createMachine, assign } = xstate;

  const tierSet = [
    { target: "host", guard: "toHost" },
    { target: "edge", guard: "toEdge" },
    { target: "idle", guard: "toIdle" },
    { actions: "illegal" },
  ];

  return createMachine(
    {
      id: "world",
      type: "parallel",
      context: { display: "overview", conn: "down", tier: "idle", illegal: 0 },
      states: {
        display: {
          initial: "overview",
          states: {
            overview: {
              entry: assign({ display: "overview" }),
              on: {
                PRESENT_REQUEST: [
                  { target: "present", guard: "canPresent" },
                  { actions: "illegal" },
                ],
                PRESENT_EXIT: { actions: "illegal" },
              },
            },
            present: {
              entry: assign({ display: "present" }),
              always: [{ guard: "connDown", target: "overview" }],
              on: {
                PRESENT_EXIT: "overview",
                HOST_LOST: "overview",
                TAKEOVER: "overview",
                PRESENT_REQUEST: { actions: "illegal" },
              },
            },
          },
        },
        conn: {
          initial: "down",
          states: {
            down: {
              on: { HOST_UP: { target: "up", actions: "setUp" } },
            },
            up: {
              on: {
                HOST_DOWN: { target: "down", actions: "setDown" },
                HOST_LOST: { target: "down", actions: "setDown" },
              },
            },
          },
        },
        tier: {
          initial: "idle",
          states: {
            idle: {
              entry: assign({ tier: "idle" }),
              on: {
                WORLD_START: [
                  { target: "host", guard: "canStartWorld" },
                  { actions: "illegal" },
                ],
                EDGE_START: [
                  { target: "edge", guard: "canStartEdge" },
                  { actions: "illegal" },
                ],
                TIER_SET: tierSet,
                WORLD_STOP: { actions: "illegal" },
              },
            },
            host: {
              entry: assign({ tier: "host" }),
              always: [{ guard: "connDown", target: "idle" }],
              on: {
                WORLD_STOP: "idle",
                TAKEOVER: "idle",
                WORLD_START: { actions: "illegal" },
                EDGE_START: { actions: "illegal" },
                TIER_SET: tierSet,
              },
            },
            edge: {
              entry: assign({ tier: "edge" }),
              always: [{ guard: "connUp", target: "idle" }],
              on: {
                WORLD_STOP: "idle",
                TAKEOVER: "idle",
                WORLD_START: { actions: "illegal" },
                EDGE_START: { actions: "illegal" },
                TIER_SET: tierSet,
              },
            },
          },
        },
      },
    },
    {
      guards: {
        canPresent: ({ context }) => context.conn === "up" && context.tier === "idle",
        canStartWorld: ({ context }) => context.conn === "up" && context.tier === "idle",
        canStartEdge: ({ context }) => context.conn === "down" && context.tier === "idle",
        connDown: ({ context }) => context.conn === "down",
        connUp: ({ context }) => context.conn === "up",
        toHost: ({ context, event }) => event.value === "host" && context.conn === "up",
        toEdge: ({ context, event }) => event.value === "edge" && context.conn === "down",
        toIdle: ({ event }) => event.value === "idle",
      },
      actions: {
        setUp: assign({ conn: "up" }),
        setDown: assign({ conn: "down" }),
        illegal: assign({ illegal: ({ context }) => context.illegal + 1 }),
      },
    },
  );
}

/** 把 XState 快照归一成与 reducer 相同的形状，便于对比。 */
export function normalize(snapshot) {
  return {
    display: snapshot.value.display,
    conn: snapshot.value.conn,
    tier: snapshot.value.tier,
    illegal: snapshot.context.illegal,
  };
}
