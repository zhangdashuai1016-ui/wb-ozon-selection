import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { stopApiProcess } from "./helpers/api-process-lifecycle.mjs";

function fakeProcess(onSignal) {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.signals = [];
  child.kill = (signal) => {
    child.signals.push(signal);
    onSignal?.(child, signal);
    return true;
  };
  return child;
}

function assertListenersRemoved(child) {
  assert.equal(child.listenerCount("exit"), 0);
  assert.equal(child.listenerCount("error"), 0);
}

test("API process cleanup waits for graceful exit and removes its listeners", async () => {
  const child = fakeProcess();
  let completed = false;
  const cleanup = stopApiProcess(child).then(() => { completed = true; });
  await Promise.resolve();
  assert.equal(completed, false);
  assert.deepEqual(child.signals, ["SIGTERM"]);
  child.emit("exit", 0, null);
  await cleanup;
  assert.equal(completed, true);
  assertListenersRemoved(child);
});

test("API process cleanup accepts an already successful exit but exposes an earlier crash", async () => {
  const child = fakeProcess();
  child.exitCode = 0;
  await stopApiProcess(child);
  assert.deepEqual(child.signals, []);
  child.exitCode = 1;
  await assert.rejects(stopApiProcess(child), /API_PROCESS_EXIT_FAILED/);
  assertListenersRemoved(child);
});

test("API process cleanup accepts SIGTERM exit but rejects another signal", async () => {
  const child = fakeProcess((process, signal) => process.emit("exit", null, signal));
  await stopApiProcess(child);
  assertListenersRemoved(child);
  child.signalCode = "SIGSEGV";
  await assert.rejects(stopApiProcess(child), /API_PROCESS_EXIT_FAILED/);
});

test("API process cleanup uses SIGKILL after a timeout and still fails the test", async () => {
  const child = fakeProcess((process, signal) => {
    if (signal === "SIGKILL") process.emit("exit", null, signal);
  });
  await assert.rejects(stopApiProcess(child, { timeoutMs: 5, killTimeoutMs: 20 }), /API_PROCESS_SHUTDOWN_TIMEOUT/);
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
  assertListenersRemoved(child);
});

test("API process cleanup has a bounded wait even when SIGKILL cannot produce an exit event", async () => {
  const child = fakeProcess();
  await assert.rejects(stopApiProcess(child, { timeoutMs: 5, killTimeoutMs: 5 }), /API_PROCESS_SHUTDOWN_TIMEOUT/);
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
  assertListenersRemoved(child);
});

test("API process cleanup reports signal failures and child errors", async () => {
  const rejectedSignal = fakeProcess();
  rejectedSignal.kill = () => false;
  await assert.rejects(stopApiProcess(rejectedSignal), /API_PROCESS_SIGNAL_FAILED/);
  assertListenersRemoved(rejectedSignal);
  const failure = new Error("fixture failure");
  const childError = fakeProcess((child) => child.emit("error", failure));
  await assert.rejects(stopApiProcess(childError), { message: "API_PROCESS_CLEANUP_FAILED", cause: failure });
  assertListenersRemoved(childError);
});

test("API process cleanup rejects invalid timeout configuration before signaling", async () => {
  const child = fakeProcess();
  await assert.rejects(stopApiProcess(child, { timeoutMs: 0 }), /API_PROCESS_CLEANUP_INVALID_TIMEOUT/);
  assert.deepEqual(child.signals, []);
});
