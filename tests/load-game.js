"use strict";

const fs = require("node:fs");
const path = require("node:path");
const config = require("../target-sampling-config.js");
const source = fs.readFileSync(path.join(__dirname, "..", "game.js"), "utf8");

// Isolated file configuration, without changing the live config or module cache.
module.exports = function loadGame(overrides = {}) {
  const engine = { exports: {} };
  new Function("module", "require", source)(engine, name => {
    if (name !== "./target-sampling-config.js") throw new Error("Unexpected dependency: " + name);
    return Object.assign({}, config, overrides);
  });
  return engine.exports;
};
