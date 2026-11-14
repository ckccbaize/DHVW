import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildRegistry, parseFrontmatter } from "../tools/build-agent.mjs";
import { createRegistryFromData } from "../www/js/core/agent/registry.js";

const ROOT = path.resolve(import.meta.dirname, "..");

test("parseFrontmatter：键值、数组、数字、布尔", () => {
  const { data, body } = parseFrontmatter(
    "---\nname: x\nclass: work\ntools: [a, b]\nmaxTokens: 200\njson: true\n---\n# 正文\n内容\n",
  );
  assert.equal(data.name, "x");
  assert.deepEqual(data.tools, ["a", "b"]);
  assert.equal(data.maxTokens, 200);
  assert.equal(data.json, true);
  assert.match(body, /^# 正文/);
});

test("buildRegistry：仓库内 skills/prompts 合法", async () => {
  const { registry, errors } = await buildRegistry(ROOT);
  assert.deepEqual(errors, []);
  assert.equal(Object.keys(registry.skills).length, 8);
  assert.equal(Object.keys(registry.prompts).length, 11);
  const wake = registry.skills["wake-character"];
  assert.equal(wake.class, "character");
  assert.equal(wake.prompt, "character-wake");
  assert.equal(wake.maxTokens, 200);
  assert.ok(registry.prompts["character-wake"].includes("{{input}}"));
});

test("buildRegistry：坏 skill 报错（缺 prompt / 非法 class）", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dhvw-agent-"));
  await fs.mkdir(path.join(root, "agent", "skills", "bad"), { recursive: true });
  await fs.mkdir(path.join(root, "agent", "prompts"), { recursive: true });
  await fs.writeFile(
    path.join(root, "agent", "skills", "bad", "SKILL.md"),
    "---\nname: bad\ndescription: x\nclass: nope\nprompt: missing\nmaxTokens: 0\ntemperature: 9\ntools: [nope]\noutput: xml\n---\n",
  );
  const { errors } = await buildRegistry(root);
  const msgs = errors.map((e) => e.msg).join(" | ");
  assert.match(msgs, /class/);
  assert.match(msgs, /prompt "missing" 不存在/);
  assert.match(msgs, /maxTokens/);
  assert.match(msgs, /temperature/);
  assert.match(msgs, /未知工具/);
  assert.match(msgs, /output/);
});

test("render：替换变量；缺变量/未知 prompt 抛错", () => {
  const r = createRegistryFromData({
    skills: {},
    prompts: { p: "现在 {{now}}，{{mood}}" },
  });
  assert.equal(r.render("p", { now: "22:00", mood: "calm" }), "现在 22:00，calm");
  assert.throws(() => r.render("p", { now: "22:00" }), /缺少变量 "mood"/);
  assert.throws(() => r.render("nope", {}), /未知 prompt/);
});

test("list/stats：反映注册内容", async () => {
  const { registry } = await buildRegistry(ROOT);
  const r = createRegistryFromData(registry);
  assert.deepEqual(r.stats(), { loaded: true, version: 1, skills: 8, prompts: 11 });
  const names = r.list().map((s) => s.name).sort();
  assert.deepEqual(names, ["behavior-record", "browse-plan", "doctor", "event-pool", "memory-summarize", "plot-writer", "wake", "wake-character"]);
});
