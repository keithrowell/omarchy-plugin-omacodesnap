import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(resolve(ROOT, "manifest.json"), "utf8"));

test("manifest.json has the required Omarchy plugin fields", () => {
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.id, "com.keithrowell.omacodesnap");
  assert.equal(manifest.name, "OmaCodeSnap");
  // The manifest is the only place the version is written (a bump is one
  // edit, then a `v<version>` tag on the merge): check the shape, not a
  // pinned string, and make sure nothing else has grown a second copy.
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/, "version is plain semver");
  const readme = readFileSync(resolve(ROOT, "README.md"), "utf8");
  assert.doesNotMatch(readme, /\bv?\d+\.\d+\.\d+\b/, "README repeats no version number; manifest.json is the single source");
  assert.equal(manifest.license, "MIT");
  assert.equal(typeof manifest.author, "string");
  assert.ok(manifest.author.length > 0);
  assert.equal(typeof manifest.description, "string");
  assert.ok(manifest.description.length > 0);
  // ADR-0003: the marketplace's validator requires a non-empty `kinds`
  // array, each with a matching `entryPoints` file that actually exists.
  assert.deepEqual(manifest.kinds, ["service"]);
  assert.deepEqual(manifest.entryPoints, { service: "app/Service.qml" });
  assert.equal(manifest.keepLoaded, true);
  assert.ok(existsSync(resolve(ROOT, manifest.entryPoints.service)));
});
