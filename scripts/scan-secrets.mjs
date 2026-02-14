import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const args = new Set(process.argv.slice(2));
const stagedOnly = args.has("--staged");

const repoRoot = process.cwd();
const bannedTrackedFiles = new Set([".env", ".dev.vars", "dashboard/.env", "dashboard/.env.local"]);
const ignoredPaths = [
  ".env.example",
  "wrangler.example.jsonc",
  "pnpm-lock.yaml",
  "dashboard/pnpm-lock.yaml",
  "package-lock.json",
  "dashboard/package-lock.json",
];
const ignoredPrefixes = [".git/", ".agents/", ".trae/", ".wrangler/", "docs/", "node_modules/", "dashboard/node_modules/"];

const patterns = [
  { name: "Private key", regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: "GitHub token", regex: /\bgh[opsu]_[A-Za-z0-9]{30,}\b/ },
  { name: "OpenAI key", regex: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: "AWS access key", regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "Google API key", regex: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "Slack token", regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
];

function run(command) {
  return execSync(command, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function listAllFilesRecursive(rootDir, base = "") {
  const dir = path.join(rootDir, base);
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "dist" || entry.name === "build") {
        continue;
      }
      files.push(...listAllFilesRecursive(rootDir, rel));
      continue;
    }
    files.push(rel);
  }
  return files;
}

function listFiles() {
  try {
    if (stagedOnly) {
      const out = run("git diff --cached --name-only --diff-filter=ACMR");
      return { files: out ? out.split(/\r?\n/).filter(Boolean) : [], usingGit: true };
    }
    const out = run("git ls-files");
    return { files: out ? out.split(/\r?\n/).filter(Boolean) : [], usingGit: true };
  } catch {
    return { files: listAllFilesRecursive(repoRoot), usingGit: false };
  }
}

function shouldIgnore(relPath) {
  if (ignoredPaths.some((p) => relPath === p)) return true;
  if (bannedTrackedFiles.has(relPath)) return true;
  if (ignoredPrefixes.some((prefix) => relPath.startsWith(prefix))) return true;
  if (relPath.includes("/dist/") || relPath.includes("/build/")) return true;
  return false;
}

function isLikelyPlaceholder(line) {
  return /your_|example|placeholder|generate_/i.test(line);
}

const { files, usingGit } = listFiles();
const findings = [];

for (const relPath of files) {
  if (usingGit && bannedTrackedFiles.has(relPath)) {
    findings.push({ file: relPath, reason: "Tracked secret file is not allowed." });
    continue;
  }
  if (shouldIgnore(relPath)) continue;

  const abs = path.join(repoRoot, relPath);
  if (!fs.existsSync(abs)) continue;

  let content;
  try {
    content = fs.readFileSync(abs, "utf8");
  } catch {
    continue;
  }

  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const pattern of patterns) {
      if (!pattern.regex.test(line)) continue;
      if (isLikelyPlaceholder(line)) continue;
      findings.push({
        file: relPath,
        reason: `${pattern.name} at line ${i + 1}`,
      });
    }
  }
}

if (findings.length > 0) {
  console.error("Secret scan failed. Potential secrets detected:");
  for (const finding of findings) {
    console.error(`- ${finding.file}: ${finding.reason}`);
  }
  process.exit(1);
}

console.log(`Secret scan passed (${stagedOnly ? "staged files" : "tracked files"}).`);
