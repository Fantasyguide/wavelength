"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const createArchive = require("../audience-archive.js");

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wl-qq-archive-"));
  const file = path.join(tmp, "private", "rounds.jsonl");
  let archive;
  try {
    archive = createArchive(file);
    const round = { roundId: "one", nickname: "中文\n换行", submissions: [{ guessPct: 67 }] };
    archive.enqueue(round);
    round.submissions[0].guessPct = 1;
    archive.enqueue({ roundId: "two", submissions: [] });
    await archive.flush();
    await archive.close();
    let lines = fs.readFileSync(file, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(lines.length, 2);
    assert.equal(lines[0].submissions[0].guessPct, 67, "queue owns a snapshot");
    assert.equal(lines[0].nickname, "中文\n换行");
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    archive = createArchive(file);
    archive.enqueue({ roundId: "three" });
    await archive.close();
    lines = fs.readFileSync(file, "utf8").trim().split("\n").map(JSON.parse);
    assert.deepEqual(lines.map(r => r.roundId), ["one", "two", "three"], "restart preserves history");

    const blockedDir = path.join(tmp, "blocked");
    fs.writeFileSync(blockedDir, "a file prevents creating the directory");
    const errors = [];
    archive = createArchive(path.join(blockedDir, "rounds.jsonl"), { retryMs: 20, report: msg => errors.push(msg) });
    archive.enqueue({ roundId: "retry-one" });
    archive.enqueue({ roundId: "retry-two" });
    await archive.flush();
    assert.equal(archive.pending(), 2);
    assert.match(errors[0], /写入失败/);
    fs.unlinkSync(blockedDir);
    const end = Date.now() + 3000;
    while (archive.pending() && Date.now() < end) await new Promise(r => setTimeout(r, 20));
    assert.equal(archive.pending(), 0, "failed writes retry automatically");
    await archive.close();
    lines = fs.readFileSync(path.join(blockedDir, "rounds.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert.deepEqual(lines.map(r => r.roundId), ["retry-one", "retry-two"], "retry retains order without duplicates");
    console.log("AUDIENCE ARCHIVE TEST PASSED");
  } finally {
    if (archive) await archive.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
