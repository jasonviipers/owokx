import { execSync } from "node:child_process";
import fs from "node:fs";

function run(command) {
  return execSync(command, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

run("git config core.hooksPath .githooks");

if (process.platform !== "win32" && fs.existsSync(".githooks/pre-commit")) {
  fs.chmodSync(".githooks/pre-commit", 0o755);
}

console.log("Git hooks configured: core.hooksPath=.githooks");
