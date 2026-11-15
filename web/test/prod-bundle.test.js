import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

test("production bundle strips the ?dev=1 payment bypass", () => {
  const root = path.resolve(import.meta.dirname, "..");
  execFileSync(path.join(root, "node_modules/.bin/vite"), ["build"], {
    cwd: root,
    stdio: "ignore",
  });
  const assets = path.resolve(import.meta.dirname, "../dist/assets");
  const bundles = fs.readdirSync(assets).filter((name) => name.endsWith(".js"));
  assert.ok(bundles.length > 0);
  const source = bundles
    .map((name) => fs.readFileSync(path.join(assets, name), "utf8"))
    .join("\n");
  assert.equal(source.includes("vg-dev-bypass"), false);
  assert.equal(source.includes("?dev=1"), false);
  assert.equal(source.includes('get("dev")'), false);
});
