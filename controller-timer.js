"use strict";

const { randomUUID } = require("node:crypto");

// One clock drives play, follower displays and expiry. Server deadlines are
// used only after the owner stops reporting, never to race a healthy owner.
class ControllerTimer {
  constructor(state, { now = Date.now, monotonicNow = () => performance.now(), readyWaitMs = 30000,
    reportWaitMs = 6000, graceMs = 1500 } = {}) {
    this.state = state;
    this.now = now;
    this.readyWaitMs = readyWaitMs;
    this.monotonicNow = monotonicNow;
    this.reportWaitMs = reportWaitMs;
    this.graceMs = graceMs;
    this.serial = null;
    this.lastOwner = null;
    this.lastReportAt = null;
  }

  sync(ownerId) {
    const s = this.state;
    if (!s.timerKind) {
      s.timerSync = null;
      this.serial = null;
      return;
    }
    if (this.serial === s.timerSerial) return;
    this.serial = s.timerSerial;
    this.lastReportAt = null;
    if (ownerId) this.lastOwner = ownerId;
    s.timerSync = {
      id: randomUUID(), ownerId: ownerId || null, durationMs: s.timerDurationMs,
      status: ownerId ? "waiting" : "running", readyBy: ownerId ? this.now() + this.readyWaitMs : null,
      source: ownerId ? "controller" : "server", elapsedMs: null, expired: false
    };
    if (ownerId) s.timerEnd = null;
  }

  matches(body, ownerId) {
    const timer = this.state.timerSync;
    return timer && ownerId && timer.ownerId === ownerId && timer.id === body.timerId &&
      Number.isFinite(body.elapsedMs) && body.elapsedMs >= 0;
  }

  report(body, ownerId) {
    if (!this.matches(body, ownerId)) return false;
    const timer = this.state.timerSync;
    if (timer.source !== "controller" || timer.expired || !["started", "progress", "expired"].includes(body.type)) return false;
    if (body.type === "expired" && body.elapsedMs < timer.durationMs + this.graceMs) return false;
    if (timer.elapsedMs !== null && body.elapsedMs <= timer.elapsedMs) return false;
    timer.status = "running";
    timer.elapsedMs = body.elapsedMs;
    timer.expired = body.type === "expired";
    this.lastReportAt = this.monotonicNow();
    this.state.timerEnd = this.now() + timer.durationMs - Math.min(body.elapsedMs, timer.durationMs + this.graceMs);
    return true;
  }

  due(now = this.now()) {
    const timer = this.state.timerSync;
    if (timer && timer.source === "controller" && !timer.expired) return false;
    return this.state.timerEnd !== null && this.state.timerEnd + this.graceMs <= now;
  }

  fallback() {
    const timer = this.state.timerSync;
    if (!timer || timer.source !== "controller") return false;
    if (timer.status === "waiting") {
      if (this.now() < timer.readyBy) return false;
      timer.status = "running";
      this.state.timerEnd = this.now() + timer.durationMs;
    } else {
      if (timer.expired || this.lastReportAt === null || this.monotonicNow() - this.lastReportAt < this.reportWaitMs) return false;
    }
    timer.source = "server";
    return true;
  }
}

module.exports = ControllerTimer;
