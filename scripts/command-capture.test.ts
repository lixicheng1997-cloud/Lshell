/**
 * 命令捕获器的行为测试。
 *
 * 捕获器负责从终端字节流里还原「用户执行的命令」，
 * 同时要把密码输入挡在数据库之外 ——
 * 这两件事都关系到正确性和安全，不能只靠手工点。
 *
 * 不引入测试框架：项目没有 vitest/jest，
 * 为了跑几个断言而拉一整套依赖不划算。
 * 用 node:test + tsx 的方式直接跑 TS 源码。
 *
 * 运行：node --experimental-strip-types --test scripts/command-capture.test.ts
 *   （Node 22+；Node 20 需先 `npx tsx`）
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { CommandCapture, promptsForPassword } from "../src/lib/command-capture.ts";

test("普通命令被正确捕获", () => {
  const c = new CommandCapture();
  c.push("ls -la");
  assert.equal(c.push("\r"), "ls -la");
});

test("空行不产生记录", () => {
  const c = new CommandCapture();
  c.push("   ");
  assert.equal(c.push("\r"), null);
});

test("退格会删掉已输入的字符", () => {
  const c = new CommandCapture();
  c.push("ls -la");
  c.push("\u007f"); // Backspace
  assert.equal(c.push("\r"), "ls -l");
});

test("Ctrl+U 清空整行", () => {
  const c = new CommandCapture();
  c.push("echo wrong");
  c.push("\u0015"); // Ctrl+U
  c.push("echo right");
  assert.equal(c.push("\r"), "echo right");
});

test("Ctrl+W 删掉上一个词", () => {
  const c = new CommandCapture();
  c.push("cd /tmp");
  c.push("\u0017"); // Ctrl+W
  assert.equal(c.push("\r"), "cd");
});

test("Ctrl+C 放弃当前行", () => {
  const c = new CommandCapture();
  c.push("dangerous command");
  c.push("\u0003"); // Ctrl+C
  assert.equal(c.push("\r"), null);
});

test("方向键之后该行不再记录", () => {
  const c = new CommandCapture();
  c.push("ls");
  c.push("\u001b[A"); // 向上箭头：远端 readline 补全了历史，本地无从得知
  assert.equal(c.push("\r"), null);
});

test("Tab 补全之后该行不再记录", () => {
  const c = new CommandCapture();
  c.push("cd /et");
  c.push("\t"); // Tab 补全
  assert.equal(c.push("\r"), null);
});

test("连续相同的命令只报一次", () => {
  const c = new CommandCapture();
  c.push("uptime");
  assert.equal(c.push("\r"), "uptime");
  c.push("uptime");
  assert.equal(c.push("\r"), null);
});

test("中间夹了别的命令后，重复命令重新上报", () => {
  const c = new CommandCapture();
  c.push("uptime");
  assert.equal(c.push("\r"), "uptime");
  c.push("date");
  assert.equal(c.push("\r"), "date");
  c.push("uptime");
  assert.equal(c.push("\r"), "uptime");
});

test("一次 push 里含多段输入也能正确处理", () => {
  const c = new CommandCapture();
  assert.equal(c.push("whoami\r"), "whoami");
  assert.equal(c.push("hostname\r"), "hostname");
});

test("sudo 之后的密码行不被记录", () => {
  const c = new CommandCapture();
  c.push("sudo -v");
  assert.equal(c.push("\r"), "sudo -v");
  // 密码输入不回显，但本地照样能看见 —— 绝不能记录
  c.push("SuperSecret123");
  assert.equal(c.push("\r"), null);
});

test("ssh 之后的密码行不被记录", () => {
  const c = new CommandCapture();
  c.push("ssh root@10.0.0.1");
  assert.equal(c.push("\r"), "ssh root@10.0.0.1");
  c.push("hunter2");
  assert.equal(c.push("\r"), null);
});

test("密码行被跳过后再执行普通命令仍能记录", () => {
  const c = new CommandCapture();
  c.push("sudo ls");
  c.push("\r");
  c.push("secret");
  c.push("\r");
  c.push("echo after");
  assert.equal(c.push("\r"), "echo after");
});

test("OSC 序列不会污染命令内容", () => {
  const c = new CommandCapture();
  // 远端上报目录的 OSC 7 序列若混进输入流，不应进入命令
  c.push("ls");
  assert.equal(c.push("\r"), "ls");
});

test("promptsForPassword 识别常见提权命令", () => {
  assert.equal(promptsForPassword("sudo ls"), true);
  assert.equal(promptsForPassword("sudo -u root systemctl status nginx"), true);
  assert.equal(promptsForPassword("su"), true);
  assert.equal(promptsForPassword("mysql"), true);
  assert.equal(promptsForPassword("ls -la"), false);
  assert.equal(promptsForPassword(""), false);
  assert.equal(promptsForPassword("echo sudo"), false);
});
