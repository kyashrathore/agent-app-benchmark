import path from "node:path";
import { fileURLToPath } from "node:url";
import { realpath } from "node:fs/promises";

export const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function resolveInside(root, candidate, label = "path") {
  const absoluteRoot = path.resolve(root);
  const absolute = path.resolve(absoluteRoot, candidate);
  if (absolute !== absoluteRoot && !absolute.startsWith(`${absoluteRoot}${path.sep}`)) {
    throw new Error(`${label} escapes its allowed root.`);
  }
  return absolute;
}

export async function resolveRealFileInside(root, candidate, label = "path") {
  const lexical = resolveInside(root, candidate, label);
  const [realRoot, realFile] = await Promise.all([realpath(root), realpath(lexical)]);
  if (realFile !== realRoot && !realFile.startsWith(`${realRoot}${path.sep}`)) throw new Error(`${label} escapes its allowed root through a symbolic link.`);
  return realFile;
}
