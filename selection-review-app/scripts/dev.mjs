import { spawn } from "node:child_process";
import process from "node:process";

const children = [
  spawn(process.execPath, ["server.mjs", "--api-only"], { stdio: "inherit" }),
  spawn(process.execPath, ["node_modules/vite/bin/vite.js"], { stdio: "inherit" })
];

let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 200);
}

for (const child of children) {
  child.on("exit", (code) => {
    if (!stopping && code) stop(code);
  });
}

process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
