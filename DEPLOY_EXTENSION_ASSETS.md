# Fix: Theme App Extension Assets 404 on Shopify CDN

## Problem
All Theme App Extension assets return 404 on Shopify CDN:
- `assets/editmuse-concierge.js` 404
- `assets/editmuse-concierge.css` 404
- `assets/editmuse-results.js` 404

## Root Cause
Shopify CLI is not packaging the `assets/` folder during deployment.

## Solution

### 1. Verify Extension Configuration

✅ **Extension Type**: Confirmed `type = "theme"` in `extensions/editmuse-concierge/shopify.extension.toml`

✅ **Folder Structure**: Confirmed correct structure:
```
extensions/editmuse-concierge/
├── assets/          ✅ (contains .js, .css, .png files)
├── blocks/          ✅ (contains .liquid files)
├── locales/         ✅
├── snippets/         ✅
└── shopify.extension.toml
```

### 2. Ensure Assets Are Not Ignored

Created `.shopifyignore` file in extension directory that only excludes build artifacts:
```
extensions/editmuse-concierge/.shopifyignore
```

### 3. Update Shopify CLI

```bash
npm install -g @shopify/cli@latest
```

### 4. Deploy Extension with Assets

**Option A: Deploy entire app (recommended for production)**
```bash
# From project root
shopify app deploy
```

**Option B: Deploy only the extension (faster for testing)**
```bash
# From project root
shopify app deploy --only=extensions/editmuse-concierge
```

### 5. Release the App Version

After deployment, you must release the version:

```bash
# List app versions
shopify app versions list

# Release the latest version
shopify app versions release --version=<VERSION_ID>
```

Or release via Partners Dashboard:
1. Go to https://partners.shopify.com
2. Navigate to your app
3. Go to "App versions"
4. Find the latest version and click "Release"

### 6. Verify Assets Are Deployed

After release, check the CDN URLs:
- `https://cdn.shopify.com/extensions/{EXTENSION_ID}/editmuse-{VERSION}/assets/editmuse-concierge.js`
- `https://cdn.shopify.com/extensions/{EXTENSION_ID}/editmuse-{VERSION}/assets/editmuse-concierge.css`

You can find the extension ID and version in:
- Partners Dashboard → Your App → Extensions
- Or in the deployment logs

## Troubleshooting

### If assets still 404 after deployment:

1. **Check CLI version**:
   ```bash
   shopify version
   ```
   Should be 3.88.1 or later.

2. **Verify files exist locally**:
   ```bash
   ls -la extensions/editmuse-concierge/assets/
   ```

3. **Check deployment logs**:
   Look for messages about assets being packaged.

4. **Force new version**:
   Update the `uid` in `shopify.extension.toml` to force a new version:
   ```toml
   uid = "new-unique-id-here"
   ```

5. **Clear Shopify cache**:
   - Remove and re-add the extension block in Theme Editor
   - Or update the extension version (change `uid`)

## Expected Result

After successful deployment and release:
- ✅ Assets accessible on Shopify CDN
- ✅ `asset_url` filter works in Liquid blocks
- ✅ No 404 errors in browser console
- ✅ Extension blocks render correctly

