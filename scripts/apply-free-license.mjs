#!/usr/bin/env node
/**
 * Apply the free license replacement over src/license.ts.
 * Run this after pulling upstream changes to keep the fork free (no license checks, Max plan).
 *
 * Usage: node scripts/apply-free-license.mjs
 * Or:    npm run apply-free-license
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const patchFile = path.join(root, "patches", "license.ts");
const targetFile = path.join(root, "src", "license.ts");

if (!fs.existsSync(patchFile)) {
  console.error("Missing patches/license.ts. Cannot apply free license.");
  process.exit(1);
}

fs.copyFileSync(patchFile, targetFile);
console.log("Applied free license: src/license.ts replaced with patches/license.ts");
console.log("Run this again after pulling upstream to keep the fork free.");
