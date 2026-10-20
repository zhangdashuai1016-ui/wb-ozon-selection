import test from "node:test";
import assert from "node:assert/strict";
import { api } from "../src/api.js";

const settle = () => new Promise(resolve => setImmediate(resolve));
const acknowledgement = { captureId: "SCJ-synthetic-api", kind: "supplier_capture", accepted: true, code: "" };

test("录入 API 把同一个取消信号交给队列和回执请求，路径和写入体不变", async t => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push({ url, options });
    return Response.json({ synthetic: true });
  });
  const controller = new AbortController();
  assert.deepEqual(await api.getIntakeQueue({ signal: controller.signal }), { synthetic: true });
  assert.deepEqual(await api.getIntakeQueue({ bridge: true, signal: controller.signal }), { synthetic: true });
  assert.deepEqual(await api.reportIntakeStart(acknowledgement, { signal: controller.signal }), { synthetic: true });
  assert.deepEqual(requests.map(request => request.url), ["/api/intake/queue", "/api/intake/queue?bridge=1", "/api/intake/start-ack"]);
  for (const { options } of requests) assert.equal(options.signal, controller.signal);
  assert.equal(requests[2].options.method, "POST");
  assert.deepEqual(JSON.parse(requests[2].options.body), acknowledgement);
  assert.equal(requests[2].options.headers["Content-Type"], "application/json");
});

test("队列和回执的未完成请求可由退出取消，取消异常原样返回且不重发", async t => {
  for (const operation of ["queue", "ack"]) await t.test(operation, async subtest => {
    const requests = [];
    subtest.mock.method(globalThis, "fetch", (url, options) => {
      requests.push({ url, options });
      return new Promise((resolve, reject) => {
        assert.ok(options.signal instanceof AbortSignal);
        options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
      });
    });
    const controller = new AbortController();
    const pending = operation === "queue" ? api.getIntakeQueue({ bridge: true, signal: controller.signal })
      : api.reportIntakeStart(acknowledgement, { signal: controller.signal });
    const reason = new DOMException("synthetic logout cancellation", "AbortError");
    const rejected = assert.rejects(pending, error => error === reason);
    controller.abort(reason);
    await rejected;
    await settle();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].options.signal.aborted, true);
    assert.equal(requests[0].url, operation === "queue" ? "/api/intake/queue?bridge=1" : "/api/intake/start-ack");
  });
});

test("回执 HTTP 失败保留状态码和服务端错误，不变成成功也不自动重试", async t => {
  let requests = 0;
  const body = { code: "SYNTHETIC_ACK_REVISION_CONFLICT", message: "合成回执版本冲突" };
  t.mock.method(globalThis, "fetch", async () => { requests++; return Response.json(body, { status: 409 }); });
  await assert.rejects(api.reportIntakeStart(acknowledgement, { signal: new AbortController().signal }), error => {
    assert.equal(error.status, 409);
    assert.equal(error.message, body.message);
    assert.deepEqual(error.body, body);
    return true;
  });
  await settle();
  assert.equal(requests, 1);
});
