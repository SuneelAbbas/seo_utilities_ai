/**
 * install-muffet.mjs
 *
 * Downloads the muffet link-checker binary and installs it to /usr/local/bin.
 * Uses only Node.js built-in modules (https, zlib, fs) plus the `tar` npm package
 * to avoid system commands (curl, tar, chmod, mv) that StackHost disallows.
 */

import https from "https";
import { createGunzip } from "zlib";
import { pipeline } from "stream/promises";
import { createWriteStream, promises as fs } from "fs";
import * as tar from "tar";
import { tmpdir } from "os";
import { join } from "path";

const MUFFET_URL =
  "https://github.com/raviqqe/muffet/releases/latest/download/muffet_linux_amd64.tar.gz";
const TMP_TAR = join(tmpdir(), "muffet.tar.gz");
const TMP_EXTRACT = join(tmpdir(), "muffet-extract");
const BINARY_NAME = "muffet";
const INSTALL_PATH = "/usr/local/bin/muffet";

async function download(url, dest) {
  console.log(`⬇️  Downloading muffet from ${url}...`);
  await new Promise((resolve, reject) => {
    https.get(url, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        // Follow redirect
        https.get(response.headers.location, (res2) => {
          const file = createWriteStream(dest);
          res2.pipe(file);
          file.on("finish", () => file.close(resolve));
        }).on("error", reject);
      } else if (response.statusCode !== 200) {
        reject(new Error(`Download failed with status ${response.statusCode}`));
      } else {
        const file = createWriteStream(dest);
        response.pipe(file);
        file.on("finish", () => file.close(resolve));
      }
    }).on("error", reject);
  });
  console.log("✅ Download complete");
}

async function extractTarGz(tarPath, destDir) {
  console.log(`📦 Extracting ${tarPath} to ${destDir}...`);
  await fs.mkdir(destDir, { recursive: true });
  await pipeline(
    (await fs.open(tarPath)).createReadStream(),
    createGunzip(),
    tar.extract({ cwd: destDir })
  );
  console.log("✅ Extraction complete");
}

async function installBinary(extractDir, binaryName, installPath) {
  const source = join(extractDir, binaryName);
  console.log(`🔧 Installing ${source} -> ${installPath}...`);
  
  // Ensure the source binary exists
  try {
    await fs.access(source);
  } catch {
    throw new Error(`Binary "${binaryName}" not found in extracted files at ${extractDir}`);
  }
  
  // Copy binary to install location
  await fs.copyFile(source, installPath);
  // Make executable (chmod +x equivalent)
  await fs.chmod(installPath, 0o755);
  console.log("✅ Installation complete");
}

async function cleanup(...paths) {
  for (const p of paths) {
    try {
      await fs.rm(p, { recursive: true, force: true });
    } catch { /* ignore */ }
  }
}

async function main() {
  try {
    console.log("🚀 Starting muffet installation...\n");
    
    await download(MUFFET_URL, TMP_TAR);
    await extractTarGz(TMP_TAR, TMP_EXTRACT);
    await installBinary(TMP_EXTRACT, BINARY_NAME, INSTALL_PATH);
    
    console.log("\n✅ muffet successfully installed to", INSTALL_PATH);
    
    // Verify installation
    console.log("\n🔍 Verifying installation...");
    const stats = await fs.stat(INSTALL_PATH);
    console.log(`   Size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
    console.log(`   Mode: ${stats.mode.toString(8)}`);
  } catch (err) {
    console.error("\n❌ Installation failed:", err.message);
    process.exit(1);
  } finally {
    await cleanup(TMP_TAR, TMP_EXTRACT);
  }
}

main();
