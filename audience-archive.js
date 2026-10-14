"use strict";

var fs = require("fs");
var path = require("path");

// One writer per server; complete round records are retained until an append succeeds.
function createArchive(filePath, options) {
  options = options || {};
  var report = options.report || console.error;
  var queue = [];
  var writing = null;
  var retry = null;
  var closed = false;
  var failed = false;

  async function append(line) {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    var file = await fs.promises.open(filePath, "a+", 0o600);
    var size;
    try {
      size = (await file.stat()).size;
      await file.writeFile(line, "utf8");
      await file.sync();
    } catch (error) {
      // An interrupted write must not leave half a JSON line ahead of the retry.
      if (size !== undefined) await file.truncate(size).catch(function () {});
      throw error;
    } finally {
      await file.close();
    }
  }

  function flush() {
    if (writing) return writing;
    clearTimeout(retry);
    retry = null;
    writing = (async function () {
      while (queue.length) {
        try {
          await append(queue[0]);
          queue.shift();
          failed = false;
        } catch (error) {
          if (!failed) report("QQ 作答记录写入失败，已保留在内存并将重试：" + error.message);
          failed = true;
          break;
        }
      }
    })().finally(function () {
      writing = null;
      if (queue.length && !closed) {
        retry = setTimeout(flush, options.retryMs || 5000);
        retry.unref();
      }
    });
    return writing;
  }

  function enqueue(record) {
    queue.push(JSON.stringify(record) + "\n");
    void flush();
  }

  async function close() {
    closed = true;
    clearTimeout(retry);
    await flush();
    if (queue.length) report("QQ 作答记录仍有 " + queue.length + " 轮未落盘，退出进程将丢失这些待重试记录");
  }

  return { enqueue: enqueue, flush: flush, close: close, pending: function () { return queue.length; } };
}

module.exports = createArchive;
