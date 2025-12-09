#!/usr/bin/env node

/*
 * Injects the latest git commit ID into static asset placeholders and prepares
 * a deployable `dist/` directory. Run this script in your CI/CD pipeline before
 * publishing to GitHub Pages:
 *
 *   - uses: actions/checkout@v4
 *   - name: Build static site
 *     run: node scripts/set-version.js
 *   - uses: actions/upload-pages-artifact@v3
 *     with:
 *       path: dist
 *
 * Optionally provide APP_VERSION or rely on GITHUB_SHA.
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DIST = path.join(ROOT, "dist");
const PLACEHOLDER = "__APP_VERSION__";
const SOURCE_FILES = [
  "index.html",
  "app.js",
  "styles.css",
  "manifest.webmanifest",
  "service-worker.js",
  "icon.svg",
];

function resolveVersion() {
  if (process.env.APP_VERSION) {
    return process.env.APP_VERSION.trim();
  }
  if (process.env.GITHUB_SHA) {
    return process.env.GITHUB_SHA.slice(0, 7);
  }
  try {
    return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch (err) {
    console.warn("Unable to read git commit, defaulting to dev");
    return "dev";
  }
}

function copyWithVersion(file, version) {
  const sourcePath = path.join(ROOT, file);
  const destPath = path.join(DIST, file);
  const destDir = path.dirname(destPath);
  fs.mkdirSync(destDir, { recursive: true });
  let contents = fs.readFileSync(sourcePath);
  if (typeof contents !== "string" && Buffer.isBuffer(contents)) {
    contents = contents.toString("utf8");
  }
  if (typeof contents === "string") {
    contents = contents.replace(new RegExp(PLACEHOLDER, "g"), version);
  }
  fs.writeFileSync(destPath, contents);
}

function main() {
  const version = resolveVersion();
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });
  SOURCE_FILES.forEach((file) => copyWithVersion(file, version));
  console.log(`Prepared dist/ with version ${version}`);
}

main();
