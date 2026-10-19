"use strict";

const assert = require("node:assert/strict");
const { mock: clockMock } = require("node:test");
const { connectSatori, normalizeConfig, normalizeEvent } = require("../satori.js");
const { waitFor, mockSatori, message } = require("./qq-test-helpers.js");

(async () => {
  const mock = await mockSatori();
  let client;
  try {
    const source = message("10001", "g67%");
    const normalized = normalizeEvent(source);
    assert.equal(normalized.nickname, "群名片10001");
    assert.equal(normalized.sentAt, source.message.created_at);
    assert.equal(normalized.eventAt, source.timestamp);
    assert.equal(normalized.avatarUrl, "", "insecure avatar falls back to public QQ HTTPS avatar");
    assert.equal(normalizeEvent({ ...source, login: undefined, platform: "llonebot", self_id: "90001" }).userId, "10001");
    assert.equal(normalizeEvent({ ...source, member: null, user: { id: "1", nick: "用户昵称", name: "用户名" } }).nickname, "用户昵称");
    assert.equal(normalizeEvent({ ...source, member: null }).nickname, "昵称10001");
    assert.equal(normalizeEvent({ ...source, user: { id: "1", avatar: "https://q1.qlogo.cn/g?b=qq&nk=1&s=100" } }).avatarUrl,
      "https://q1.qlogo.cn/g?b=qq&nk=1&s=100");
    for (const value of [null, {}, { ...source, type: "message-updated" },
      { ...source, channel: { type: 1, id: "123456789" } },
      { ...source, login: { platform: "discord" } }, { ...source, user: { id: "90001" } },
      { ...source, user: { id: "1", is_bot: true } }]) assert.equal(normalizeEvent(value), null);

    // Advance protocol heartbeat intervals without waiting 30 real seconds. WS I/O stays real.
    clockMock.timers.enable({ apis: ["setInterval"] });
    const events = [];
    const statuses = [];
    client = connectSatori(normalizeConfig({ enabled: true, groupId: "123456789", url: mock.url, token: mock.token }),
      event => events.push(event), () => statuses.push(client.connected()));
    await waitFor(() => client.connected(), "Satori READY with LLBot online login");
    assert.deepEqual(mock.identifies[0], { token: mock.token });
    mock.send({ op: 0, body: source });
    await waitFor(() => events.length === 1, "normalized message delivery");
    mock.connections.at(-1).send("{bad json");
    mock.send(null);
    mock.send({ op: 0, body: null });

    mock.send({ op: 0, body: { type: "login-updated", login: { sn: 1, status: 0 } } });
    await waitFor(() => !client.connected(), "offline login is reflected without socket disconnect");
    mock.send({ op: 0, body: { type: "login-updated", login: mock.login } });
    await waitFor(() => client.connected(), "login returns online");

    clockMock.timers.tick(10000);
    await waitFor(() => mock.pings === 1, "protocol PING");
    await new Promise(r => setTimeout(r, 25));
    mock.replyPong = false;
    clockMock.timers.tick(10000);
    await waitFor(() => mock.pings === 2, "missed heartbeat request");
    clockMock.timers.tick(10000);
    await waitFor(() => !client.connected(), "missing PONG disconnects");
    mock.replyPong = true;
    await waitFor(() => mock.identifies.length === 2 && client.connected(), "automatic reconnect");
    assert.equal(mock.identifies[1].sn, source.sn, "resume uses last event sequence");
    assert.ok(statuses.includes(false) && statuses.includes(true));

    mock.send({ op: 0, body: { ...source, sn: undefined, id: 50 } });
    await waitFor(() => events.length === 2, "legacy sequence event");
    mock.connections.at(-1).terminate();
    await waitFor(() => mock.identifies.length === 3 && client.connected(), "reconnect after transport failure");
    assert.equal(mock.identifies[2].sn, 50);
    client.stop();
    await waitFor(() => !client.connected(), "client stop");
    client = undefined;

    mock.rejectAuth = true;
    client = connectSatori(normalizeConfig({ enabled: true, groupId: "123456789", url: mock.url, token: "wrong" }),
      () => assert.fail("unauthenticated event delivered"), () => {});
    await waitFor(() => mock.identifies.length >= 4, "invalid token is sent for authentication");
    await new Promise(r => setTimeout(r, 25));
    assert.equal(client.connected(), false);
    client.stop();
    console.log("SATORI PROTOCOL TEST PASSED");
  } finally {
    if (client) client.stop();
    clockMock.timers.reset();
    await mock.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
