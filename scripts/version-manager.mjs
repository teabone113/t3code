#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(new URL("..", import.meta.url).pathname);

const desktopVersionFiles = [
  "apps/server/package.json",
  "apps/web/package.json",
  "apps/desktop/package.json",
];

const brandingFile = "apps/web/src/branding.ts";
const releaseVersionPattern = /export const APP_RELEASE_VERSION = "([^"]+)";/;
const iosVersionPattern = /export const IOS_SHELL_VERSION = "([^"]+)";/;
const iosPackageFile = "apps/mobile/package.json";
const iosXcodeProjectFile = "apps/mobile/ios/App/App.xcodeproj/project.pbxproj";
const iosMarketingVersionPattern = /MARKETING_VERSION = ([^;]+);/g;

function readJson(path) {
  return JSON.parse(readFileSync(resolve(repoRoot, path), "utf8"));
}

function writeJson(path, value) {
  writeFileSync(resolve(repoRoot, path), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readReleaseVersion() {
  const brandingSource = readFileSync(resolve(repoRoot, brandingFile), "utf8");
  const match = brandingSource.match(releaseVersionPattern);
  if (!match?.[1]) {
    throw new Error(`Unable to read APP_RELEASE_VERSION from ${brandingFile}`);
  }
  return match[1];
}

function readVersionState() {
  return {
    release: readReleaseVersion(),
    ios: readJson(iosPackageFile).version,
  };
}

function assertVersion(value) {
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value)) {
    throw new Error(`Invalid version '${value}'. Expected semantic version like 0.0.6`);
  }
}

function setReleaseVersion(nextVersion) {
  assertVersion(nextVersion);

  for (const path of desktopVersionFiles) {
    const pkg = readJson(path);
    pkg.version = nextVersion;
    writeJson(path, pkg);
  }

  const brandingPath = resolve(repoRoot, brandingFile);
  const brandingSource = readFileSync(brandingPath, "utf8");
  if (!releaseVersionPattern.test(brandingSource)) {
    throw new Error(`Unable to update APP_RELEASE_VERSION in ${brandingFile}`);
  }
  writeFileSync(
    brandingPath,
    brandingSource.replace(releaseVersionPattern, `export const APP_RELEASE_VERSION = "${nextVersion}";`),
    "utf8",
  );
}

function toIosShellVersion(nextVersion) {
  const parts = nextVersion.split(".");
  if (parts.length < 3) {
    throw new Error(`Invalid iOS version '${nextVersion}'. Expected semantic version like 0.0.14`);
  }
  const [major, minor, patchAndRest] = parts;
  const patch = patchAndRest.split(/[-+]/)[0] ?? patchAndRest;
  const patchNumber = Number.parseInt(patch, 10);
  if (!Number.isFinite(patchNumber)) {
    throw new Error(`Invalid iOS version '${nextVersion}'.`);
  }
  return `${major}.${minor}.${patchNumber.toString().padStart(3, "0")}`;
}

function setIosVersion(nextVersion) {
  assertVersion(nextVersion);

  const mobilePackage = readJson(iosPackageFile);
  mobilePackage.version = nextVersion;
  writeJson(iosPackageFile, mobilePackage);

  const brandingPath = resolve(repoRoot, brandingFile);
  const brandingSource = readFileSync(brandingPath, "utf8");
  if (!iosVersionPattern.test(brandingSource)) {
    throw new Error(`Unable to update IOS_SHELL_VERSION in ${brandingFile}`);
  }
  writeFileSync(
    brandingPath,
    brandingSource.replace(iosVersionPattern, `export const IOS_SHELL_VERSION = "${toIosShellVersion(nextVersion)}";`),
    "utf8",
  );

  const xcodeProjectPath = resolve(repoRoot, iosXcodeProjectFile);
  const xcodeProjectSource = readFileSync(xcodeProjectPath, "utf8");
  const updatedXcodeProjectSource = xcodeProjectSource.replace(
    iosMarketingVersionPattern,
    `MARKETING_VERSION = ${nextVersion};`,
  );
  if (
    updatedXcodeProjectSource === xcodeProjectSource &&
    !xcodeProjectSource.includes(`MARKETING_VERSION = ${nextVersion};`)
  ) {
    throw new Error(`Unable to update MARKETING_VERSION in ${iosXcodeProjectFile}`);
  }
  writeFileSync(xcodeProjectPath, updatedXcodeProjectSource, "utf8");
}

function printVersionState() {
  const state = readVersionState();
  console.log(`release=${state.release}`);
  console.log(`ios=${state.ios}`);
}

function main() {
  const [, , command, ...rest] = process.argv;

  if (!command || command === "get") {
    printVersionState();
    return;
  }

  if (command === "set-release") {
    const nextVersion = rest[0] ?? process.env.VERSION;
    if (!nextVersion) {
      throw new Error(
        "Missing VERSION. Usage: node scripts/version-manager.mjs set-release 0.0.6",
      );
    }
    setReleaseVersion(nextVersion);
    printVersionState();
    return;
  }

  if (command === "set-ios") {
    const nextVersion = rest[0] ?? process.env.VERSION;
    if (!nextVersion) {
      throw new Error("Missing VERSION. Usage: node scripts/version-manager.mjs set-ios 0.0.14");
    }
    setIosVersion(nextVersion);
    printVersionState();
    return;
  }

  throw new Error(`Unknown command '${command}'. Expected 'get', 'set-release', or 'set-ios'.`);
}

main();
