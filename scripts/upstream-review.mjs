// Summarizes what upstream changed since the merge base, flagging the things
// AGENTS.md says to scrutinize. Prints Markdown.
// Usage: node scripts/upstream-review.mjs <repo-dir> <base-ref> <upstream-ref>
import { execFileSync } from "child_process";

const [repo, baseRef, upstreamRef] = process.argv.slice(2);
if (!repo || !baseRef || !upstreamRef) {
  console.error("usage: upstream-review.mjs <repo-dir> <base-ref> <upstream-ref>");
  process.exit(2);
}

const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 64 << 20 });
const show = (ref, path) => {
  try { return git("show", `${ref}:${path}`); } catch { return null; }
};

const mergeBase = git("merge-base", baseRef, upstreamRef).trim();
// Files this fork deleted on purpose; upstream changes to them never land here
const tree = (ref) => new Set(git("ls-tree", "-r", "--name-only", ref).split("\n").filter(Boolean));
const ours = tree(baseRef);
const deletedHere = [...tree(mergeBase)].filter((f) => !ours.has(f));
const skip = (f) => deletedHere.includes(f);
const range = `${mergeBase}..${upstreamRef}`;
const out = [];
const section = (title, lines) => {
  out.push(`### ${title}`, "", ...(lines.length ? lines : ["_None._"]), "");
};

section("Commits", git("log", "--no-merges", "--format=- `%h` %s (%an, %as)", range).trim().split("\n").filter(Boolean));
section("Files changed", ["```", git("diff", "--stat=100", mergeBase, upstreamRef).trim(), "```"]);

// Dependencies declared in package.json
const deps = (json) => {
  const p = json ? JSON.parse(json) : {};
  const all = {};
  for (const kind of ["dependencies", "optionalDependencies", "devDependencies"]) {
    for (const [name, range] of Object.entries(p[kind] ?? {})) all[`${name} (${kind})`] = range;
  }
  return all;
};
const beforeDeps = deps(show(mergeBase, "package.json"));
const afterDeps = deps(show(upstreamRef, "package.json"));
const depLines = [];
for (const key of new Set([...Object.keys(beforeDeps), ...Object.keys(afterDeps)])) {
  if (beforeDeps[key] !== afterDeps[key]) {
    depLines.push(`- ${key}: \`${beforeDeps[key] ?? "(none)"}\` → \`${afterDeps[key] ?? "(removed)"}\``);
  }
}
section("⚠️ package.json dependency changes", depLines);

// Resolved packages in the lockfile, including transitive ones
const lockPackages = (json) => {
  const lock = json ? JSON.parse(json) : {};
  const pkgs = new Map();
  for (const [path, info] of Object.entries(lock.packages ?? {})) {
    if (!path) continue;
    const name = info.name ?? path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
    pkgs.set(`${name}@${info.version}`, { name, version: info.version, hasInstallScript: !!info.hasInstallScript });
  }
  return pkgs;
};
const beforeLock = lockPackages(show(mergeBase, "package-lock.json"));
const afterLock = lockPackages(show(upstreamRef, "package-lock.json"));
const added = [...afterLock.keys()].filter((k) => !beforeLock.has(k)).sort();
section(`Lockfile: ${added.length} new package versions`, added.length > 60
  ? [`- ${added.slice(0, 60).join(", ")}, … (${added.length - 60} more)`]
  : added.map((k) => `- ${k}`));

// Install scripts not covered by our allowScripts (strict-allow-scripts would fail on these)
const ourAllow = JSON.parse(show(baseRef, "package.json") ?? "{}").allowScripts ?? {};
const covered = (p) => `${p.name}@${p.version}` in ourAllow || p.name in ourAllow;
const scriptLines = [...afterLock.values()]
  .filter((p) => p.hasInstallScript && !covered(p))
  .map((p) => `- ${p.name}@${p.version}`);
section("⚠️ Install scripts not covered by our allowScripts", scriptLines);

// Added lines only: new hosts and risky APIs
const addedLines = git("diff", "--unified=0", mergeBase, upstreamRef, "--", ".", ":(exclude)package-lock.json", ":(exclude)*.md")
  .split("\n");
let file = "";
const hosts = new Set();
const risky = [];
const riskyPattern = /child_process|\beval\s*\(|new Function|\brequire\(['"]vm['"]\)|from ['"](node:)?vm['"]|process\.env|writeFile|\bfetch\s*\(|https?\.(get|request)\s*\(|WebSocket|password|token|secret|credential/i;
for (const line of addedLines) {
  if (line.startsWith("+++ b/")) { file = line.slice(6); continue; }
  if (!line.startsWith("+") || line.startsWith("+++") || skip(file)) continue;
  for (const m of line.matchAll(/(?:https?|wss?):\/\/([a-z0-9.-]+)/gi)) hosts.add(m[1].toLowerCase());
  if (riskyPattern.test(line) && risky.length < 80) risky.push(`- \`${file}\`: \`${line.slice(1).trim().slice(0, 160).replace(/`/g, "'")}\``);
}
section("⚠️ Hosts in added lines", [...hosts].sort().map((h) => `- ${h}`));
section("⚠️ Added lines touching sensitive APIs (credentials, network, fs, env, dynamic code)", risky);

// Build, CI and supply-chain surface
const sensitivePaths = git("diff", "--name-status", mergeBase, upstreamRef).trim().split("\n")
  .filter((l) => !skip(l.split("\t").pop()))
  .filter((l) => /\t(\.github\/|Dockerfile|docker-compose|Makefile|\.npmrc|\.gitmodules|scripts\/|manifest\.json|package\.json|mise\.toml|anylist-js$)/.test(l))
  .map((l) => `- \`${l.replace(/\t/g, " ")}\``);
section("⚠️ CI, build, and supply-chain files", sensitivePaths);

if (deletedHere.length) {
  out.push(`_Ignored upstream changes to files this fork deleted: ${deletedHere.map((f) => `\`${f}\``).join(", ")}._`, "");
}
console.log(out.join("\n"));
