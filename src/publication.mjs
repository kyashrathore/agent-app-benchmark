import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
const PROTECTED_PREFIXES = ["registry/", "results/", "schemas/"];

export async function validateAppendOnly(baseRevision) {
  if (!/^[0-9a-f]{40}$/.test(baseRevision ?? "")) throw new Error("A full 40-character base revision is required.");
  const { stdout } = await execute("git", ["diff", "--name-status", "-z", `${baseRevision}...HEAD`], { encoding: "buffer", maxBuffer: 8 * 1024 * 1024 });
  const tokens = stdout.toString("utf8").split("\0").filter(Boolean);
  const entries = [];
  for (let index = 0; index < tokens.length;) {
    const status = tokens[index++];
    const pathCount = /^[RC]/.test(status) ? 2 : 1;
    const paths = tokens.slice(index, index + pathCount);
    index += pathCount;
    entries.push({ status, paths });
  }
  validateAppendOnlyEntries(entries);
  return entries;
}

export function validateAppendOnlyEntries(entries) {
  const violations = [];
  for (const entry of entries) {
    for (const file of entry.paths) {
      if (PROTECTED_PREFIXES.some((prefix) => file.startsWith(prefix)) && entry.status !== "A") {
        violations.push(`${entry.status} ${file}`);
      }
    }
  }
  if (violations.length > 0) throw new Error(`Public artifacts are append-only; create a new version or result path instead:\n${violations.join("\n")}`);
  return true;
}
