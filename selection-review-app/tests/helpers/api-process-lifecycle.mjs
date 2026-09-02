function exitError(code, signal) {
  if (code === 0 || (code === null && signal === "SIGTERM")) return null;
  return new Error(`API_PROCESS_EXIT_FAILED: code=${code}, signal=${signal}`);
}

export async function stopApiProcess(child, { timeoutMs = 5000, killTimeoutMs = 1000 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(killTimeoutMs) || killTimeoutMs < 1) {
    throw new Error("API_PROCESS_CLEANUP_INVALID_TIMEOUT");
  }
  if (child.exitCode !== null || child.signalCode !== null) {
    const error = exitError(child.exitCode, child.signalCode);
    if (error) throw error;
    return;
  }

  await new Promise((resolve, reject) => {
    let timer;
    let shutdownTimedOut = false;
    const timeoutError = () => new Error("API_PROCESS_SHUTDOWN_TIMEOUT: SIGTERM did not stop the test server; SIGKILL was required");
    const finish = (error) => {
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("error", onError);
      if (error) reject(error);
      else resolve();
    };
    const onExit = (code, signal) => finish(shutdownTimedOut ? timeoutError() : exitError(code, signal));
    const onError = (error) => finish(new Error("API_PROCESS_CLEANUP_FAILED", { cause: error }));
    const sendSignal = (signal) => {
      try {
        if (!child.kill(signal)) finish(new Error(`API_PROCESS_SIGNAL_FAILED: ${signal}`));
      } catch (error) {
        onError(error);
      }
    };

    child.once("exit", onExit);
    child.once("error", onError);
    timer = setTimeout(() => {
      shutdownTimedOut = true;
      timer = setTimeout(() => finish(timeoutError()), killTimeoutMs);
      sendSignal("SIGKILL");
    }, timeoutMs);
    sendSignal("SIGTERM");
  });
}
