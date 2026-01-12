#!/usr/bin/env node

/**
 * Guard script to prevent duplicate block files in Theme App Extension.
 * 
 * This script ensures ONLY these 3 block files exist:
 * - editmuse_launcher.liquid
 * - editmuse_concierge.liquid
 * - editmuse_results.liquid
 * 
 * If any other .liquid files are found, the script exits with code 1.
 */

const fs = require('fs');
const path = require('path');

const BLOCKS_DIR = path.join(__dirname, '..', 'extensions', 'editmuse-concierge', 'blocks');
const ALLOWED_FILES = new Set([
  'editmuse_concierge.liquid',
  'editmuse_results.liquid'
]);

function guardBlocks() {
  console.log('[guard-blocks] Checking blocks directory...');
  console.log('[guard-blocks] Allowed files (exactly 2):', Array.from(ALLOWED_FILES).join(', '));

  if (!fs.existsSync(BLOCKS_DIR)) {
    console.error(`[guard-blocks] ERROR: Blocks directory not found: ${BLOCKS_DIR}`);
    process.exit(1);
  }

  const files = fs.readdirSync(BLOCKS_DIR);
  const liquidFiles = files.filter(f => f.endsWith('.liquid'));

  console.log(`[guard-blocks] Found ${liquidFiles.length} .liquid file(s):`, liquidFiles.join(', '));

  const extraFiles = liquidFiles.filter(f => !ALLOWED_FILES.has(f));

  if (extraFiles.length > 0) {
    console.error('\n[guard-blocks] ❌ ERROR: Extra block files detected!');
    console.error('[guard-blocks] The following files are NOT allowed:');
    extraFiles.forEach(f => {
      console.error(`  - ${f}`);
    });
    console.error('\n[guard-blocks] Only these 2 files are allowed:');
    Array.from(ALLOWED_FILES).forEach(f => {
      console.error(`  - ${f}`);
    });
    console.error('\n[guard-blocks] Please delete the extra files or modify existing blocks instead.');
    process.exit(1);
  }

  // Check that all required files exist
  const missingFiles = Array.from(ALLOWED_FILES).filter(f => !liquidFiles.includes(f));
  if (missingFiles.length > 0) {
    console.error('\n[guard-blocks] ⚠️  WARNING: Missing required block files:');
    missingFiles.forEach(f => {
      console.error(`  - ${f}`);
    });
    console.error('[guard-blocks] All 2 required blocks must exist.');
  }

  if (liquidFiles.length !== 2) {
    console.error(`\n[guard-blocks] ❌ ERROR: Expected exactly 2 block files, found ${liquidFiles.length}`);
    process.exit(1);
  }

  console.log('[guard-blocks] ✅ All block files are valid!');
  console.log(`[guard-blocks] Found exactly ${liquidFiles.length} block file(s).`);
}

guardBlocks();

