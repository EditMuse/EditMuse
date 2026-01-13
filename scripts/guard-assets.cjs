#!/usr/bin/env node

/**
 * Guard script to verify extension assets referenced in Liquid blocks exist
 * Fails CI/deploy if referenced asset files are missing
 */

const fs = require('fs');
const path = require('path');

const EXTENSION_DIR = path.join(__dirname, '..', 'extensions', 'editmuse-concierge');
const ASSETS_DIR = path.join(EXTENSION_DIR, 'assets');
const BLOCKS_DIR = path.join(EXTENSION_DIR, 'blocks');

console.log('[guard-assets] Checking extension assets...');

// Read all Liquid block files
const blockFiles = fs.readdirSync(BLOCKS_DIR).filter(f => f.endsWith('.liquid'));

if (blockFiles.length === 0) {
  console.error('[guard-assets] ❌ No Liquid block files found in', BLOCKS_DIR);
  process.exit(1);
}

console.log(`[guard-assets] Found ${blockFiles.length} block file(s):`, blockFiles.join(', '));

// Extract asset references from Liquid files
const assetReferences = new Set();

blockFiles.forEach(blockFile => {
  const blockPath = path.join(BLOCKS_DIR, blockFile);
  const content = fs.readFileSync(blockPath, 'utf8');
  
  // Match patterns like: {{ 'filename.js' | asset_url | script_tag }}
  // or: {{ 'filename.css' | asset_url | stylesheet_tag }}
  const assetPattern = /['"]([^'"]+\.(js|css))['"]\s*\|\s*asset_url/g;
  let match;
  
  while ((match = assetPattern.exec(content)) !== null) {
    const assetName = match[1];
    assetReferences.add(assetName);
    console.log(`[guard-assets] Found asset reference in ${blockFile}: ${assetName}`);
  }
});

if (assetReferences.size === 0) {
  console.warn('[guard-assets] ⚠️  No asset references found in block files');
} else {
  console.log(`[guard-assets] Found ${assetReferences.size} unique asset reference(s)`);
}

// Check if referenced assets exist
const missingAssets = [];
const existingAssets = [];

assetReferences.forEach(assetName => {
  const assetPath = path.join(ASSETS_DIR, assetName);
  if (fs.existsSync(assetPath)) {
    existingAssets.push(assetName);
    console.log(`[guard-assets] ✅ Asset exists: ${assetName}`);
  } else {
    missingAssets.push(assetName);
    console.error(`[guard-assets] ❌ Asset missing: ${assetName} (expected at ${assetPath})`);
  }
});

// Report results
if (missingAssets.length > 0) {
  console.error('\n[guard-assets] ❌ BUILD FAILED: Missing assets referenced in Liquid blocks:');
  missingAssets.forEach(asset => {
    console.error(`  - ${asset} (referenced in blocks, but file not found in assets/)`);
  });
  console.error('\n[guard-assets] Please ensure all referenced assets exist in:', ASSETS_DIR);
  process.exit(1);
}

console.log(`\n[guard-assets] ✅ All ${existingAssets.length} referenced asset(s) exist!`);
console.log('[guard-assets] Asset files:', existingAssets.join(', '));

