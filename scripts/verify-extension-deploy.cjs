#!/usr/bin/env node

/**
 * Deploy-time verification script for Theme App Extension assets
 * 
 * This script verifies that:
 * 1. All asset_url references in Liquid blocks match actual asset files
 * 2. All assets referenced in blocks exist in the assets/ directory
 * 3. No assets are excluded by .shopifyignore patterns
 * 
 * Run this before deploying: npm run verify:extension
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const EXTENSION_DIR = path.join(__dirname, '..', 'extensions', 'editmuse-concierge');
const ASSETS_DIR = path.join(EXTENSION_DIR, 'assets');
const BLOCKS_DIR = path.join(EXTENSION_DIR, 'blocks');
const SHOPIFYIGNORE_PATH = path.join(EXTENSION_DIR, '.shopifyignore');

console.log('[verify-extension-deploy] Verifying extension deployment package...\n');

// Step 1: Check extension structure
if (!fs.existsSync(EXTENSION_DIR)) {
  console.error(`[verify-extension-deploy] ❌ Extension directory not found: ${EXTENSION_DIR}`);
  process.exit(1);
}

if (!fs.existsSync(ASSETS_DIR)) {
  console.error(`[verify-extension-deploy] ❌ Assets directory not found: ${ASSETS_DIR}`);
  process.exit(1);
}

if (!fs.existsSync(BLOCKS_DIR)) {
  console.error(`[verify-extension-deploy] ❌ Blocks directory not found: ${BLOCKS_DIR}`);
  process.exit(1);
}

console.log('[verify-extension-deploy] ✅ Extension structure valid');

// Step 2: Read .shopifyignore patterns (if exists)
const ignorePatterns = [];
if (fs.existsSync(SHOPIFYIGNORE_PATH)) {
  const ignoreContent = fs.readFileSync(SHOPIFYIGNORE_PATH, 'utf8');
  ignoreContent.split('\n').forEach(line => {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      ignorePatterns.push(trimmed);
    }
  });
  console.log(`[verify-extension-deploy] Found ${ignorePatterns.length} ignore pattern(s) in .shopifyignore`);
} else {
  console.log('[verify-extension-deploy] No .shopifyignore file found (all files will be included)');
}

// Step 3: Get all actual asset files
const actualAssets = fs.readdirSync(ASSETS_DIR)
  .filter(file => {
    const filePath = path.join(ASSETS_DIR, file);
    const stat = fs.statSync(filePath);
    return stat.isFile();
  })
  .map(file => ({
    name: file,
    path: path.join(ASSETS_DIR, file),
    relativePath: `assets/${file}`
  }));

console.log(`[verify-extension-deploy] Found ${actualAssets.length} asset file(s) in assets/ directory`);

// Step 4: Check if any assets are excluded by .shopifyignore
const excludedAssets = [];
actualAssets.forEach(asset => {
  // Check if asset matches any ignore pattern
  const isExcluded = ignorePatterns.some(pattern => {
    // Simple pattern matching (supports * wildcard)
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
    return regex.test(asset.name) || regex.test(asset.relativePath) || regex.test(`assets/${asset.name}`);
  });
  
  if (isExcluded) {
    excludedAssets.push(asset.name);
  }
});

if (excludedAssets.length > 0) {
  console.error(`\n[verify-extension-deploy] ❌ ERROR: Assets excluded by .shopifyignore:`);
  excludedAssets.forEach(asset => {
    console.error(`  - ${asset}`);
  });
  console.error('\n[verify-extension-deploy] These assets will NOT be deployed!');
  console.error('[verify-extension-deploy] Update .shopifyignore to allow these files.');
  process.exit(1);
}

// Step 5: Extract asset references from Liquid blocks
const blockFiles = fs.readdirSync(BLOCKS_DIR).filter(f => f.endsWith('.liquid'));
if (blockFiles.length === 0) {
  console.error(`[verify-extension-deploy] ❌ No Liquid block files found in ${BLOCKS_DIR}`);
  process.exit(1);
}

console.log(`[verify-extension-deploy] Found ${blockFiles.length} block file(s): ${blockFiles.join(', ')}`);

const assetReferences = new Set();
blockFiles.forEach(blockFile => {
  const blockPath = path.join(BLOCKS_DIR, blockFile);
  const content = fs.readFileSync(blockPath, 'utf8');
  
  // Match patterns like: {{ 'filename.js' | asset_url | script_tag }}
  // or: {{ 'filename.css' | asset_url | stylesheet_tag }}
  const assetPattern = /['"]([^'"]+\.(js|css|png|jpg|jpeg|gif|svg|woff|woff2|ttf|eot))['"]\s*\|\s*asset_url/g;
  let match;
  
  while ((match = assetPattern.exec(content)) !== null) {
    const assetName = match[1];
    assetReferences.add(assetName);
    console.log(`[verify-extension-deploy] Found asset reference in ${blockFile}: ${assetName}`);
  }
});

if (assetReferences.size === 0) {
  console.warn('[verify-extension-deploy] ⚠️  No asset references found in block files');
} else {
  console.log(`[verify-extension-deploy] Found ${assetReferences.size} unique asset reference(s)`);
}

// Step 6: Verify all referenced assets exist
const missingAssets = [];
const existingAssets = [];
const assetMap = new Map(actualAssets.map(a => [a.name, a]));

assetReferences.forEach(assetName => {
  const asset = assetMap.get(assetName);
  if (asset) {
    existingAssets.push(assetName);
    console.log(`[verify-extension-deploy] ✅ Asset exists: ${assetName}`);
  } else {
    missingAssets.push(assetName);
    console.error(`[verify-extension-deploy] ❌ Asset missing: ${assetName} (referenced but not found in assets/)`);
  }
});

// Step 7: Check for unreferenced assets (optional warning)
const referencedAssetNames = new Set(assetReferences);
const unreferencedAssets = actualAssets.filter(a => !referencedAssetNames.has(a.name));
if (unreferencedAssets.length > 0) {
  console.log(`\n[verify-extension-deploy] ℹ️  ${unreferencedAssets.length} asset(s) not referenced in blocks (will still be deployed):`);
  unreferencedAssets.forEach(asset => {
    console.log(`  - ${asset.name}`);
  });
}

// Step 8: Final report
console.log('\n[verify-extension-deploy] ========================================');
if (missingAssets.length > 0) {
  console.error('[verify-extension-deploy] ❌ DEPLOYMENT VERIFICATION FAILED');
  console.error('\n[verify-extension-deploy] Missing assets referenced in Liquid blocks:');
  missingAssets.forEach(asset => {
    console.error(`  - ${asset}`);
  });
  console.error('\n[verify-extension-deploy] These assets must exist in:', ASSETS_DIR);
  console.error('[verify-extension-deploy] Deployment will fail or assets will 404 on CDN.');
  process.exit(1);
}

console.log('[verify-extension-deploy] ✅ DEPLOYMENT VERIFICATION PASSED');
console.log(`[verify-extension-deploy] All ${existingAssets.length} referenced asset(s) exist and will be deployed.`);
console.log('[verify-extension-deploy] Asset files:', existingAssets.join(', '));
console.log('[verify-extension-deploy] ========================================\n');

