// anylist-js is loaded from the git submodule by relative path, so its runtime
// dependencies are declared in our package.json. Fail if they drift apart.
import { readFileSync } from "fs";

const root = JSON.parse(readFileSync("package.json", "utf8")).dependencies;
const sub = JSON.parse(readFileSync("anylist-js/package.json", "utf8")).dependencies;

const mismatches = Object.entries(sub).filter(([name, range]) => root[name] !== range);
for (const [name, range] of mismatches) {
  console.error(`${name}: anylist-js wants "${range}", package.json has "${root[name] ?? "(missing)"}"`);
}
process.exit(mismatches.length ? 1 : 0);
