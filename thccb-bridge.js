// Private, durable remote work. No HTTP wait is allowed in the local game queue.
"use strict";
const fs = require("fs");
const path = require("path");

class ThccbBridge {
  constructor({ file, config, changed }) {
    this.file = file;
    this.config = config;
    this.changed = changed;
    this.jobs = [];
    this.busy = new Set();
    this.requests = new Set();
    this.health = { status: "checking", checked_at: null };
    this.conflict = null;
    this.storageError = "";
    this.stopped = false;
    try {
      const saved = JSON.parse(fs.readFileSync(file, "utf8"));
      if (saved.version !== 1 || !Array.isArray(saved.jobs) || saved.jobs.some(job =>
        !job || typeof job.key !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(job.key) ||
        !["active", "orphan", "result", "cancel"].includes(job.desired) || typeof job.status !== "string"))
        throw new Error("Invalid journal");
      this.jobs = saved.jobs;
      for (const job of this.jobs) {
        if (job.desired === "active") job.desired = "orphan";
        job.recovering = job.desired === "result";
        job.nextAt = 0;
      }
    } catch (e) {
      if (e.code !== "ENOENT") {
        this.corrupt = true;
        this.storageError = "联动记录无法读取，请保留记录文件并检查权限或文件内容。";
      }
    }
    this.timer = setInterval(() => this.work(), 1000);
    this.timer.unref();
  }

  save() {
    if (this.corrupt) throw new Error(this.storageError);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = this.file + ".tmp";
      const fd = fs.openSync(tmp, "w", 0o600);
      try { fs.writeFileSync(fd, JSON.stringify({ version: 1, jobs: this.jobs })); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      fs.renameSync(tmp, this.file);
      const dir = fs.openSync(path.dirname(this.file), "r");
      try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
      this.storageError = "";
    } catch (e) {
      this.storageError = "联动记录保存失败；取消任务仅在内存中，请勿重启服务，修复文件权限后重试。";
      throw new Error(this.storageError);
    }
  }

  emit() { if (!this.stopped) this.changed(); }
  pending() { return this.jobs.filter(j => !j.terminal && j.desired !== "active"); }
  blocked() { return !!(this.storageError || this.conflict || this.pending().length); }
  diagnostics() {
    const relevant = this.jobs.filter(j => j.desired !== "active");
    const visible = relevant.filter(j => !j.terminal).concat(relevant.filter(j => j.terminal).slice(-10));
    return visible.map(j => ({
      round_key: j.key, status: j.status, desired: j.desired, terminal: !!j.terminal,
      error: j.error || "", summary: j.summary || null,
      left_label: j.payload && j.payload.left_label, right_label: j.payload && j.payload.right_label
    }));
  }

  async request(suffix, method = "GET", body) {
    if (this.stopped) throw new Error("联动已停止");
    const cfg = this.config();
    const controller = new AbortController();
    this.requests.add(controller);
    const timeout = setTimeout(() => controller.abort(), 4000);
    let response;
    try {
      response = await fetch(cfg.base_url + "/api/v1/returned" + suffix, {
        method, redirect: "error", signal: controller.signal,
        headers: { Authorization: "Bearer " + cfg.secret, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      const data = await response.json();
      if (cfg.base_url === this.config().base_url && cfg.secret === this.config().secret)
        this.health = { status: "connected", checked_at: Date.now() };
      if (!response.ok) {
        const hints = { 401: "联动密钥无效", 403: "联动权限不足", 404: "接口或轮次不存在，或 THCCB 未启用联动", 409: "远端轮次状态冲突", 503: "THCCB 暂不可用" };
        const error = new Error("THCCB：" + (hints[response.status] || "请求失败") + "（HTTP " + response.status + "）");
        error.status = response.status;
        throw error;
      }
      return data;
    } catch (e) {
      if (e.status) throw e;
      if (cfg.base_url === this.config().base_url && cfg.secret === this.config().secret)
        this.health = { status: "error", checked_at: Date.now() };
      throw new Error("THCCB 连接失败、超时或响应格式错误；可重试或在管理员菜单关闭联动。");
    } finally {
      clearTimeout(timeout);
      this.requests.delete(controller);
    }
  }

  async capabilities() {
    if (this.capability !== undefined) return this.capability;
    try {
      const data = await this.request("/capabilities");
      this.capability = data.durable_cancel === true && data.round_state === true;
    } catch (e) {
      if (e.status !== 404) throw e;
      // A legacy server cannot prove that an unknown, delayed start was cancelled.
      this.capability = false;
    }
    return this.capability;
  }

  async inspect() {
    const cfg = this.config();
    const data = await this.request("/current");
    if (cfg.base_url !== this.config().base_url || cfg.secret !== this.config().secret) return null;
    if (data && (!data.round_key || !["open", "closed", "settled", "cancelled"].includes(data.status))) throw new Error("THCCB 当前轮次格式错误");
    this.conflict = data && ["open", "closed"].includes(data.status) &&
      !this.jobs.some(j => j.key === data.round_key && !j.terminal) ? {
        round_key: data.round_key, status: data.status, round_number: data.round_number,
        left_label: data.left_label, right_label: data.right_label, team_name: data.team_name
      } : null;
    this.emit();
    return data;
  }

  create(payload) {
    if (this.storageError) throw new Error(this.storageError);
    const job = { key: payload.round_key, payload, status: "starting", desired: "active", nextAt: 0 };
    this.jobs.push(job);
    try { this.save(); } catch (e) { this.jobs.pop(); throw e; }
    return job;
  }

  validate(data, key, statuses) {
    if (!data || data.round_key !== key || !statuses.includes(data.status)) throw new Error("THCCB 返回的轮号或状态不匹配；请重试核对，或关闭联动继续。");
    return data;
  }

  async confirm(job, action, payload, reconcile) {
    if (job.desired === "cancel" || job.terminal) throw new Error("该竞猜已作废");
    if (action === "result") { job.desired = "result"; job.target = payload.target_position; this.save(); }
    const expected = { start: ["open"], close: ["closed"], result: ["settled"] }[action];
    try {
      let data;
      if (reconcile && await this.capabilities()) {
        const remote = await this.request("/rounds/" + encodeURIComponent(job.key) + "/state");
        this.validate(remote, job.key, ["missing", "open", "closed", "settled", "cancelled"]);
        if (expected.includes(remote.status)) data = remote.summary;
        else if (remote.status === "cancelled" || remote.status === "settled") throw new Error("竞猜已结束，无法重试此操作；请作废本轮或关闭联动。");
      }
      if (!data) data = await this.request(action === "start" ? "/rounds/start" : "/rounds/" + encodeURIComponent(job.key) + "/" + action, "POST", payload);
      this.validate(data, job.key, expected);
      if (action === "result" && data.target_position !== payload.target_position) throw new Error("THCCB 已结算答案与本地不符，请作废本轮并核查。");
      // A cancellation can overtake this response. Never revive the old round.
      if (job.desired === "cancel" || job.terminal || this.stopped) return data;
      job.status = action === "result" ? "result" : data.status;
      job.error = "";
      if (action === "result") { job.terminal = true; job.summary = this.moneySummary(data); }
      this.save();
      return data;
    } catch (e) {
      if (job.desired !== "cancel" && !job.terminal) job.error = e.message;
      if (e.status === 409) await this.inspect().catch(() => {});
      throw e;
    } finally { this.emit(); }
  }

  moneySummary(data) {
    return { participant_count: data.participant_count, total_refund: data.total_refund, total_payout: data.total_payout };
  }

  cancel(job) {
    if (!job) return;
    if (job.status === "result" || job.status === "settled") {
      job.status = "rewards_retained"; job.desired = "cancel"; job.terminal = true;
    } else {
      job.desired = "cancel"; job.terminal = false; job.nextAt = 0; job.error = "";
    }
    try { this.save(); } catch (e) { /* Local recovery must still finish. */ }
    this.emit();
    this.work();
  }

  cancelKnown(key) {
    let job = this.jobs.find(j => j.key === key);
    if (!job && this.conflict && this.conflict.round_key === key) {
      job = { key, payload: this.conflict, status: this.conflict.status, desired: "cancel" };
      this.jobs.push(job);
      this.conflict = null;
    }
    if (!job || (job.desired === "active" && !job.terminal)) throw new Error("旧竞猜状态已变化，请刷新后重试");
    this.cancel(job);
  }

  async cleanup(job) {
    let data;
    if (await this.capabilities()) {
      const remote = await this.request("/rounds/" + encodeURIComponent(job.key) + "/abort", "POST");
      this.validate(remote, job.key, ["cancelled", "settled"]);
      data = remote.summary || remote;
    } else {
      const current = await this.inspect();
      if (current && current.round_key === job.key && current.status === "settled") data = current;
      else data = await this.request("/rounds/" + encodeURIComponent(job.key) + "/cancel", "POST");
      this.validate(data, job.key, ["cancelled", "settled"]);
    }
    job.status = data.status === "settled" ? "rewards_retained" : "cancelled";
    job.terminal = true; job.error = ""; job.summary = this.moneySummary(data);
  }

  work() {
    if (this.stopped) return;
    for (const job of this.pending()) {
      if (job.manual || job.desired === "orphan" || (job.desired === "result" && !job.recovering) || this.busy.has(job.key) || job.nextAt > Date.now()) continue;
      this.busy.add(job.key);
      const operation = job.desired === "cancel" ? this.cleanup(job) :
        this.confirm(job, "result", { target_position: job.target }, true);
      operation.catch(e => {
        job.error = e.message;
        job.manual = [401, 403].includes(e.status);
        job.attempts = (job.attempts || 0) + 1;
        job.nextAt = Date.now() + Math.min(60000, 1000 * 2 ** Math.min(job.attempts, 6));
      }).finally(() => {
        this.busy.delete(job.key);
        if (this.stopped) return;
        try { this.save(); } catch (e) {}
        this.emit();
      });
    }
  }

  retry() {
    this.capability = undefined;
    this.save();
    for (const job of this.pending()) { job.nextAt = 0; job.manual = false; }
    this.work();
    return this.inspect();
  }

  stop() {
    this.stopped = true; clearInterval(this.timer);
    for (const request of this.requests) request.abort();
  }
}
module.exports = ThccbBridge;
