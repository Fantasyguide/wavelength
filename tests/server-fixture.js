"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

const password = "isolated-controller-password";

function configure() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wl-server-test-"));
  process.env.WL_CONFIG = path.join(dir, "config.json");
  process.env.WL_AUTH_SESSIONS = path.join(dir, "sessions.json");
  fs.writeFileSync(process.env.WL_CONFIG, JSON.stringify({ password }));
  process.once("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
}

async function login(base, value = password) {
  const response = await fetch(base + "/api/auth", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: value })
  });
  assert.equal(response.status, 200, "test controller authenticates");
  return response.headers.get("set-cookie").split(";")[0];
}

async function loginController(page, value = password) {
  await page.click("#btn-role-controller");
  await page.waitForSelector("#auth-modal:not(.hidden)");
  await page.type("#auth-password", value);
  await page.click("#btn-auth");
  await page.waitForFunction(() => document.getElementById("auth-modal").classList.contains("hidden") &&
    document.getElementById("conn-badge").textContent.includes("已连接"));
}

module.exports = { configure, login, loginController, password };
