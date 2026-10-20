import test from "node:test";
import assert from "node:assert/strict";
import { IMAGE_MATCH_CHANNEL, OZON_IMAGE_MATCH_CHANNEL, OZON_PAGE_READ_CHANNEL, SUPPLIER_CAPTURE_CHANNEL } from "../src/captureStart.js";
import { INTAKE_BRIDGE_ACTIVE_POLL_MS, INTAKE_BRIDGE_IDLE_POLL_MS, createIntakeJobBridge, intakeStartChannel } from "../src/intakeJobBridge.js";

const settle = () => new Promise(resolve => setImmediate(resolve));
const pendingQueue = (captureId, kind = "supplier_capture") => ({ items: [{ stage: "reading_source" }], pendingStart: { captureId, kind } });
const emptyQueue = () => ({ items: [], pendingStart: null });
function deferred() {
  let resolve, reject;
  const promise = new Promise((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}
function fixture(t, { readQueue = async () => emptyQueue(), signal = async () => ({ accepted: true, code: "" }), onAck = async () => {} } = {}) {
  const reads = [], signals = [], acks = [], errors = [], delays = [], timers = new Map();
  let timerId = 0;
  const bridge = createIntakeJobBridge({
    readQueue: options => { reads.push(options); return readQueue(options, reads.length); },
    signal: (captureId, page, channel) => { signals.push({ captureId, page, channel }); return signal(captureId, page, channel); },
    onAck: (ack, options) => { acks.push({ ack, options }); return onAck(ack, options); },
    onError: error => errors.push(error),
    setTimer: (callback, delay) => { delays.push(delay); timers.set(++timerId, callback); return timerId; },
    clearTimer: id => timers.delete(id)
  });
  t.after(() => bridge.stop());
  function takeTimer() {
    assert.equal(timers.size, 1, "only one future queue read may be scheduled");
    const [id, callback] = timers.entries().next().value;
    timers.delete(id);
    return callback;
  }
  return { bridge, reads, signals, acks, errors, delays, timers, takeTimer };
}

test("开始信号只使用作业自己的通道，队列读取和结果处理必须明确配置", () => {
  assert.equal(intakeStartChannel("supplier_capture"), SUPPLIER_CAPTURE_CHANNEL);
  assert.equal(intakeStartChannel("supplier_image_match"), IMAGE_MATCH_CHANNEL);
  assert.equal(intakeStartChannel("ozon_image_match"), OZON_IMAGE_MATCH_CHANNEL);
  assert.equal(intakeStartChannel("ozon_page_read"), OZON_PAGE_READ_CHANNEL);
  assert.equal(intakeStartChannel("seerfar_web"), null);
  assert.throws(() => createIntakeJobBridge({}), /INTAKE_BRIDGE_QUEUE_READER_REQUIRED/);
  assert.throws(() => createIntakeJobBridge({ readQueue: async () => emptyQueue() }), /INTAKE_BRIDGE_RESULT_HANDLERS_REQUIRED/);
  for (const missing of ["onAck", "onError"]) {
    const options = { readQueue: async () => emptyQueue(), onAck() {}, onError() {} };
    delete options[missing];
    assert.throws(() => createIntakeJobBridge(options), /INTAKE_BRIDGE_RESULT_HANDLERS_REQUIRED/);
  }
});

test("每个作业只递一次并保存真实回执，有待执行工作才用忙碌轮询节奏", async t => {
  const queues = [pendingQueue("SCJ-1"), pendingQueue("SCJ-1"), pendingQueue("IMJ-1", "supplier_image_match"),
    pendingQueue("OMJ-2", "ozon_image_match"), pendingQueue("OPJ-3", "ozon_page_read"), emptyQueue()];
  const f = fixture(t, { readQueue: async () => { assert.ok(queues.length > 0); return queues.shift(); },
    signal: async captureId => ({ accepted: captureId === "SCJ-1", code: captureId === "SCJ-1" ? "" : "capture_busy" }) });
  f.bridge.start(); await settle();
  for (let round = 0; round < 5; round++) await f.takeTimer()();
  assert.deepEqual(f.signals.map(({ captureId, page, channel }) => [captureId, page, channel.request]), [
    ["SCJ-1", undefined, SUPPLIER_CAPTURE_CHANNEL.request], ["IMJ-1", undefined, IMAGE_MATCH_CHANNEL.request],
    ["OMJ-2", undefined, OZON_IMAGE_MATCH_CHANNEL.request], ["OPJ-3", undefined, OZON_PAGE_READ_CHANNEL.request]
  ]);
  assert.deepEqual(f.acks.map(({ ack }) => ack), [
    { captureId: "SCJ-1", kind: "supplier_capture", accepted: true, code: "" },
    { captureId: "IMJ-1", kind: "supplier_image_match", accepted: false, code: "capture_busy" },
    { captureId: "OMJ-2", kind: "ozon_image_match", accepted: false, code: "capture_busy" },
    { captureId: "OPJ-3", kind: "ozon_page_read", accepted: false, code: "capture_busy" }
  ]);
  assert.deepEqual(f.delays, [...Array(5).fill(INTAKE_BRIDGE_ACTIVE_POLL_MS), INTAKE_BRIDGE_IDLE_POLL_MS]);
  for (const { options } of f.acks) assert.equal(options.signal, f.reads[0].signal);
  assert.equal(f.reads[0].signal.aborted, false);
  assert.deepEqual(f.errors, []);
  f.bridge.stop();
  assert.equal(f.reads[0].signal.aborted, true);
  assert.equal(f.timers.size, 0);
});

test("退出发生在读队列期间：中止读取，迟到的作业不发信号也不写回执", async t => {
  for (const outcome of ["resolve", "reject"]) await t.test(outcome, async subtest => {
    const read = deferred();
    const f = fixture(subtest, { readQueue: () => read.promise });
    f.bridge.start();
    assert.equal(f.reads.length, 1);
    const { signal } = f.reads[0];
    f.bridge.stop(); assert.equal(signal.aborted, true);
    if (outcome === "resolve") read.resolve(pendingQueue("SCJ-after-logout"));
    else read.reject(new Error("synthetic cancelled queue read"));
    await settle();
    assert.deepEqual([f.signals.length, f.acks.length, f.timers.size], [0, 0, 0]);
    assert.deepEqual(f.errors, [], "intentional cancellation is not a new technical failure");
  });
});

test("退出发生在已发信号等待结果期间：迟到结果不能再写回执", async t => {
  const sent = deferred();
  const f = fixture(t, { readQueue: async () => pendingQueue("SCJ-before-logout"), signal: () => sent.promise });
  f.bridge.start(); await settle();
  assert.equal(f.signals.length, 1); assert.equal(f.acks.length, 0);
  f.bridge.stop(); assert.equal(f.reads[0].signal.aborted, true);
  sent.resolve({ accepted: true, code: "" }); await settle();
  assert.deepEqual([f.acks.length, f.timers.size, f.errors.length], [0, 0, 0]);
});

test("写回执期间退出会中止同一轮请求，迟到失败不续跑", async t => {
  const acknowledged = deferred();
  const f = fixture(t, { readQueue: async () => pendingQueue("SCJ-ack-pending"), onAck: () => acknowledged.promise });
  f.bridge.start(); await settle();
  assert.equal(f.acks.length, 1); assert.equal(f.acks[0].options.signal, f.reads[0].signal);
  f.bridge.stop(); assert.equal(f.acks[0].options.signal.aborted, true);
  acknowledged.reject(new Error("synthetic cancelled acknowledgement")); await settle();
  assert.deepEqual([f.reads.length, f.signals.length, f.acks.length, f.timers.size], [1, 1, 1, 0]);
  assert.deepEqual(f.errors, []);
});

test("队列、信号或回执失败必须原样报告并停止，只有显式 start 才开始下一受控轮", async t => {
  for (const phase of ["queue", "signal", "ack"]) await t.test(phase, async subtest => {
    const failure = new Error(`synthetic ${phase} failure`);
    const f = fixture(subtest, {
      readQueue: async (options, index) => {
        if (phase === "queue" && index === 1) throw failure;
        return pendingQueue(index === 1 ? "SCJ-failed-round" : "SCJ-new-controlled-round");
      },
      signal: async captureId => { if (phase === "signal" && captureId === "SCJ-failed-round") throw failure; return { accepted: true, code: "" }; },
      onAck: async ack => { if (phase === "ack" && ack.captureId === "SCJ-failed-round") throw failure; }
    });
    f.bridge.start(); await settle();
    assert.deepEqual(f.errors, [failure]); assert.equal(f.reads[0].signal.aborted, true);
    assert.equal(f.reads.length, 1); assert.equal(f.signals.length, phase === "queue" ? 0 : 1);
    assert.equal(f.acks.length, phase === "ack" ? 1 : 0); assert.equal(f.timers.size, 0);
    const failedCounts = [f.reads.length, f.signals.length, f.acks.length];
    await settle();
    assert.deepEqual([f.reads.length, f.signals.length, f.acks.length], failedCounts, "failure cannot schedule an automatic retry");
    f.bridge.start(); await settle();
    assert.equal(f.reads.length, 2); assert.notEqual(f.reads[1].signal, f.reads[0].signal);
    assert.equal(f.reads[1].signal.aborted, false);
    assert.equal(f.signals.at(-1).captureId, "SCJ-new-controlled-round");
    assert.equal(f.acks.at(-1).ack.captureId, "SCJ-new-controlled-round");
    assert.deepEqual(f.errors, [failure]); assert.equal(f.timers.size, 1);
  });
});

test("回执失败后显式重开也不重发同一作业的信号或旧回执", async t => {
  const failure = new Error("synthetic acknowledgement outcome unknown");
  const f = fixture(t, { readQueue: async () => pendingQueue("SCJ-no-replay"), onAck: async () => { throw failure; } });
  f.bridge.start(); await settle(); f.bridge.start(); await settle();
  assert.deepEqual([f.reads.length, f.signals.length, f.acks.length], [2, 1, 1]);
  assert.deepEqual(f.errors, [failure]); assert.equal(f.timers.size, 1);
});

test("读取未结束时重复 start 或重入 tick 都不能并发读取", async t => {
  const secondRead = deferred(); let active = 0, maximum = 0;
  const f = fixture(t, { readQueue: async (options, index) => {
    active++; maximum = Math.max(maximum, active);
    try { return index === 2 ? await secondRead.promise : emptyQueue(); } finally { active--; }
  } });
  f.bridge.start(); f.bridge.start(); await settle(); assert.equal(f.reads.length, 1);
  const callback = f.takeTimer(); const tick = callback(); await callback(); f.bridge.start();
  assert.equal(f.reads.length, 2); assert.equal(f.timers.size, 0);
  secondRead.resolve(emptyQueue()); await tick;
  assert.equal(maximum, 1); assert.equal(f.timers.size, 1); assert.deepEqual(f.errors, []);
});

test("退出后立刻显式重开：等旧异步操作结束后读新轮，不停死、不并发、不采用旧结果", async t => {
  for (const phase of ["queue", "signal"]) await t.test(phase, async subtest => {
    const outstanding = deferred(); let active = 0, maximum = 0;
    const f = fixture(subtest, {
      readQueue: async (options, index) => {
        active++; maximum = Math.max(maximum, active);
        try { return phase === "queue" && index === 1 ? await outstanding.promise : pendingQueue(index === 1 ? "SCJ-old" : "SCJ-new"); }
        finally { active--; }
      },
      signal: captureId => phase === "signal" && captureId === "SCJ-old" ? outstanding.promise : Promise.resolve({ accepted: true, code: "" })
    });
    f.bridge.start(); await settle(); f.bridge.stop(); f.bridge.start();
    const cancelledSignal = f.reads[0].signal; assert.equal(cancelledSignal.aborted, true);
    if (phase === "queue") outstanding.resolve(pendingQueue("SCJ-old")); else outstanding.resolve({ accepted: true, code: "" });
    await settle();
    assert.equal(f.reads.length, 1, "the cancelled operation must settle before its replacement reads");
    assert.equal(f.delays.at(-1), 0, "the explicit replacement runs on the next turn, without a polling delay");
    await f.takeTimer()();
    assert.equal(f.reads.length, 2, "the explicit replacement round must eventually start"); assert.equal(maximum, 1);
    assert.notEqual(f.reads[1].signal, cancelledSignal); assert.equal(f.reads[1].signal.aborted, false);
    assert.deepEqual(f.acks.map(({ ack }) => ack.captureId), ["SCJ-new"]);
    assert.equal(f.signals.filter(item => item.captureId === "SCJ-old").length, phase === "queue" ? 0 : 1);
    assert.equal(f.signals.filter(item => item.captureId === "SCJ-new").length, 1);
    assert.equal(f.timers.size, 1); assert.deepEqual(f.errors, []);
  });
});
