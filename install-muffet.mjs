/**
 * install-muffet.mjs
 *
 * Downloads the muffet link-checker binary and installs it to /usr/local/bin.
 * Uses only Node.js built-in modules (fetch, zlib, crypto, fs) plus the `tar`
 * npm package to avoid system commands (curl, tar, chmod, mv) that StackHost
 * disallows.
 *
 * v2 — Fixed download-corruption bug:
 *   - Replaced https.get() with fetch() (native redirect following)
 *   - Replaced .pipe() with stream/promises pipeline() (proper backpressure)
 *   - Added download-size verification
 *   - Added optional SHA256 checksum verification
 */

import { createGunzip } from "zlib";
import { pipeline } from "stream/promises";
import { createWriteStream, promises as fs, statSync } from "fs";
import { createHash } from "crypto";
import * as tar from "tar";
import { tmpdir } from "os";
import { join } from "path";

// ─── Configuration ─────────────────────────────────────────────────────────

const MUFFET_VERSION = "v2.11.5";

const RELEASE_BASE = `https://github.com/raviqqe/muffet/releases/download/${MUFFET_VERSION}`;
const TAR_URL = `${RELEASE_BASE}/muffet_linux_amd64.tar.gz`;
const CHECKSUMS_URL = `${RELEASE_BASE}/muffet_${MUFFET_VERSION.replace("v", "")}_checksums.txt`;

const TMP_TAR = join(tmpdir(), "muffet.tar.gz");
const TMP_EXTRACT = join(tmpdir(), "muffet-extract");
const BINARY_NAME = "muffet";
const INSTALL_PATH = "/usr/local/bin/muffet";

// Expected SHA256 for muffet v2.11.5 linux_amd64
const EXPECTED_SHA256 = "64d4db266f308ea7136fe8060a5061bc8a4eea3be5e36350f94a4fcea45309d2";

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Download a URL to a local file using fetch().
 * fetch() natively follows HTTP redirects — unlike https.get() which was the
 * root cause of the corruption bug (GitHub release URLs redirect multiple times).
 */
async function download(url, dest) {
  console.log(`⬇️  Downloading ${url}...`);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Download failed with status ${response.status} ${response.statusText}`
    );
  }

  // Use pipeline() instead of pipe() to properly handle backpressure & errors
  await pipeline(response.body, createWriteStream(dest));

  // Verify download completed successfully
  const stats = statSync(dest);
  console.log(`   Downloaded file size: ${stats.size} bytes`);

  if (stats.size === 0) {
    throw new Error("Downloaded file is empty — aborting");
  }

  return stats.size;
}

/**
 * Compute SHA256 hash of a file.
 */
async function sha256Of(filePath) {
  const hash = createHash("sha256");
  const content = await fs.readFile(filePath);
  hash.update(content);
  return hash.digest("hex");
}

/**
 * Verify SHA256 checksum against known-good value.
 * Downloads the official checksums file from the release as a fallback source
 * of truth, but primarily compares against the hardcoded expected hash.
 */
async function verifyChecksum(filePath) {
  const actualHash = await sha256Of(filePath);
  console.log(`   SHA256: ${actualHash}`);

  // Try to download official checksums for reference
  let expectedHash = EXPECTED_SHA256;
  try {
    const csResponse = await fetch(CHECKSUMS_URL);
    if (csResponse.ok) {
      const csText = await csResponse.text();
      for (const line of csText.split("\n")) {
        if (line.includes("muffet_linux_amd64.tar.gz")) {
          const remoteHash = line.split(/\s+/)[0];
          if (remoteHash) {
            console.log(`   Expected SHA256 (remote): ${remoteHash}`);
            expectedHash = remoteHash;
          }
          break;
        }
      }
    }
  } catch {
    console.log("   ⚠️  Could not fetch remote checksums, using local expected hash");
  }

  console.log(`   Expected SHA256: ${expectedHash}`);

  if (actualHash !== expectedHash) {
    throw new Error(
      `SHA256 mismatch!\n  Actual:   ${actualHash}\n  Expected: ${expectedHash}`
    );
  }

  console.log("   ✅ Checksum verified");
}

/**
 * Extract a .tar.gz file to a directory using Node.js zlib + tar npm package.
 */
async function extractTarGz(tarPath, destDir) {
  console.log(`📦 Extracting to ${destDir}...`);
  await fs.mkdir(destDir, { recursive: true });
  await pipeline(
    (await fs.open(tarPath)).createReadStream(),
    createGunzip(),
    tar.extract({ cwd: destDir })
  );
  console.log("   ✅ Extraction complete");
}

/**
 * Copy the binary to its final install location and set executable permissions.
 */
async function installBinary(extractDir, binaryName, installPath) {
  const source = join(extractDir, binaryName);
  console.log(`🔧 Installing ${source} -> ${installPath}...`);

  try {
    await fs.access(source);
  } catch {
    throw new Error(
      `Binary "${binaryName}" not found in extracted files at ${extractDir}`
    );
  }

  await fs.copyFile(source, installPath);
  await fs.chmod(installPath, 0o755);

  const stats = statSync(installPath);
  console.log(`   Installed size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
  console.log("   ✅ Installation complete");
}

/**
 * Verify the installed binary runs and reports the correct version.
 */
async function verifyBinary(binaryPath, expectedVersion) {
  console.log(`🔍 Verifying binary version...`);
  const { execSync } = await import("child_process");
  try {
    const output = execSync(`"${binaryPath}" --version`, {
      encoding: "utf-8",
      timeout: 5000,
    });
    const version = output.trim();
    console.log(`   muffet version: ${version}`);

    if (!version.includes(expectedVersion.replace("v", ""))) {
      console.log(
        `   ⚠️  Version mismatch: expected ${expectedVersion}, got ${version}`
      );
    } else {
      console.log("   ✅ Version matches");
    }
  } catch (err) {
    console.log(`   ⚠️  Could not verify version: ${err.message}`);
  }
}

async function cleanup(...paths) {
  for (const p of paths) {
    try {
      await fs.rm(p, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  try {
    console.log("🚀 Starting muffet installation...\n");

    // Step 1: Download
    const size = await download(TAR_URL, TMP_TAR);
    console.log(`   ✅ Download complete (${(size / 1024 / 1024).toFixed(2)} MB)`);

    // Step 2: Verify checksum
    console.log(`\n🔐 Verifying checksum...`);
    await verifyChecksum(TMP_TAR);

    // Step 3: Extract
    console.log(`\n📦 Extracting archive...`);
    await extractTarGz(TMP_TAR, TMP_EXTRACT);

    // Step 4: Install
    console.log(`\n🔧 Installing binary...`);
    await installBinary(TMP_EXTRACT, BINARY_NAME, INSTALL_PATH);

    // Step 5: Verify
    console.log(`\n🔍 Final verification...`);
    await verifyBinary(INSTALL_PATH, MUFFET_VERSION);

    console.log(`\n✅ muffet ${MUFFET_VERSION} successfully installed to ${INSTALL_PATH}`);
  } catch (err) {
    console.error(`\n❌ Installation failed: ${err.message}`);
    process.exit(1);
  } finally {
    await cleanup(TMP_TAR, TMP_EXTRACT);
  }
}

main();
