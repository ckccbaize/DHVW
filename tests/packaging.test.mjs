import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  toCrlfText,
  toLfText,
  assertAsciiBat,
  renderTemplate,
  zipBuffer,
} from "../tools/packaging.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("toCrlfText：LF/CRLF/BOM 都归一成 CRLF，不留孤立 LF", () => {
  assert.equal(toCrlfText("a\nb"), "a\r\nb");
  assert.equal(toCrlfText("a\r\nb"), "a\r\nb");
  assert.equal(toCrlfText("\uFEFFa\nb"), "a\r\nb");
  const mixed = toCrlfText("a\r\nb\nc");
  assert.equal(mixed, "a\r\nb\r\nc");
  assert.equal([...mixed.matchAll(/(?<!\r)\n/g)].length, 0);
});

test("toLfText：CRLF 归一回 LF，去 BOM", () => {
  assert.equal(toLfText("a\r\nb"), "a\nb");
  assert.equal(toLfText("\uFEFFa\r\nb"), "a\nb");
});

test("assertAsciiBat：纯 ASCII + 全 CRLF 放行", () => {
  const ok = "@echo off\r\necho hi\r\n";
  assert.equal(assertAsciiBat(ok), ok);
});

test("assertAsciiBat：拒绝孤立 LF（cmd.exe 会错位整行）", () => {
  assert.throws(() => assertAsciiBat("@echo off\necho hi\n"), /孤立 LF/);
});

test("assertAsciiBat：拒绝非 ASCII（中文注释曾导致 'llama-server' 不是内部或外部命令）", () => {
  assert.throws(() => assertAsciiBat("@echo off\r\nrem 默认端口 18080\r\n"), /非 ASCII/);
  assert.throws(() => assertAsciiBat("@echo off\r\necho 「x」\r\n"), /非 ASCII/);
});

test("renderTemplate：替换全部占位符", () => {
  assert.equal(renderTemplate("v{{A}} / {{B}}", { A: 1, B: "x" }), "v1 / x");
});

test("renderTemplate：缺变量报错并列出名字", () => {
  assert.throws(() => renderTemplate("{{MISSING_A}}", {}), /MISSING_A/);
});

test("renderTemplate：同值多次出现都要替换", () => {
  assert.equal(renderTemplate("{{A}}{{A}}", { A: "z" }), "zz");
});

test("zipBuffer：写入后可被标准工具解析，且保留权限位", () => {
  const buf = zipBuffer([
    { name: "pkg/", mode: 0o40755, data: Buffer.alloc(0) },
    { name: "pkg/run.sh", mode: 0o100755, data: "#!/bin/sh\necho ok\n" },
    { name: "pkg/data.txt", mode: 0o100644, data: "hello".repeat(50) },
  ]);
  assert.equal(buf.readUInt32LE(0), 0x04034b50, "本地头签名");
  assert.equal(buf.readUInt32LE(buf.length - 22), 0x06054b50, "EOCD 签名");
  const tmp = path.join(ROOT, ".tmp", `zip-test-${process.pid}.zip`);
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  fs.writeFileSync(tmp, buf);
  const listed = fs.readFileSync(tmp);
  // EOCD 里记录条目数
  assert.equal(listed.readUInt16LE(listed.length - 22 + 10), 3);
  fs.rmSync(tmp, { force: true });
});

test("start-windows.bat 模板：纯 ASCII + CRLF（发布包直接从这里来）", () => {
  const raw = fs.readFileSync(path.join(ROOT, "packaging", "pc", "start-windows.bat"), "utf8");
  const bat = toCrlfText(raw);
  assert.doesNotThrow(() => assertAsciiBat(bat));
  assert.match(bat, /dhvw-shell-windows-amd64\.exe/);
  assert.match(bat, /__health/);
});

test("start-unix.sh 模板：LF 换行，且不引用 bat 专属语法", () => {
  const raw = fs.readFileSync(path.join(ROOT, "packaging", "pc", "start-unix.sh"), "utf8");
  const sh = toLfText(raw);
  assert.ok(!sh.includes("\r"), "sh 不能带 CR（Linux 会报 $'\\r': command not found）");
  assert.match(sh, /^#!\/bin\/sh/);
  assert.match(sh, /__health/);
});

test("PC 包 README 模板：占位符齐全，渲染后无残留", () => {
  const tpl = fs.readFileSync(path.join(ROOT, "packaging", "pc", "README.txt"), "utf8");
  const keys = [...tpl.matchAll(/\{\{([A-Z0-9_]+)\}\}/g)].map((m) => m[1]);
  assert.ok(keys.length > 0, "模板应含占位符");
  const vars = Object.fromEntries([...new Set(keys)].map((k) => [k, "X"]));
  const out = renderTemplate(tpl, vars);
  assert.ok(!/\{\{[A-Z0-9_]+\}\}/.test(out));
});
