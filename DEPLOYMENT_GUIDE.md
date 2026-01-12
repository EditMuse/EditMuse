# Shopify Theme App Extension - Deployment Guide

## Pre-Deployment Checklist

### 1. Verify All Files Are Up to Date
- ✅ All Theme Editor settings are properly wired in `editmuse_concierge.liquid`
- ✅ No references to old Experience DB-driven config (removed)
- ✅ CSS and JS files are using current implementation
- ✅ No unused functions or dead code

### 2. Test Locally First
```bash
# Start dev server
npm run dev

# Test in Shopify Theme Editor
# - Open your development store
# - Go to Online Store > Themes > Customize
# - Add/edit the EditMuse Concierge block
# - Verify all settings work correctly
```

## Deployment Steps

### Step 1: Build and Deploy Extension

```bash
# Navigate to project root
cd edit-muse

# Deploy the extension (this pushes to Shopify)
shopify app deploy
```

**OR** if you want to deploy just the extension:

```bash
# Deploy only the theme extension
shopify app deploy --only=extensions/editmuse-concierge
```

### Step 2: Force Cache Clear (Critical!)

After deploying, you **MUST** clear caches to ensure old files aren't used:

#### Option A: Via Shopify CLI (Recommended)
```bash
# This will prompt you to select the theme
shopify theme push --only=extensions/editmuse-concierge --force
```

#### Option B: Manual Cache Clear
1. Go to your Shopify Admin
2. Navigate to **Online Store > Themes**
3. Click **Actions** on your active theme
4. Select **Edit code**
5. In the file browser, find `extensions/editmuse-concierge/`
6. Delete and re-add the extension (or use Shopify's "Revert" if available)

#### Option C: Version Bump (Automatic Cache Busting)
The Liquid template already uses cache busting:
```liquid
<link rel="stylesheet" href="{{ em_css }}?v={{ block.id }}">
<script src="{{ em_js }}?v={{ block.id }}" defer></script>
```

However, for a **complete refresh**, you can:
1. Update the extension version in `shopify.extension.toml` (change the `uid`)
2. Or manually add a timestamp to asset URLs temporarily

### Step 3: Verify Deployment

1. **Check Extension Status**
   ```bash
   shopify app info
   ```

2. **Test in Theme Editor**
   - Open Theme Customizer
   - Add the EditMuse Concierge block
   - Change settings and verify they apply immediately
   - Check browser console for errors

3. **Test on Storefront**
   - Visit your storefront
   - Open browser DevTools (F12)
   - Check Network tab for asset loading
   - Verify no 404 errors for CSS/JS files
   - Test the concierge modal functionality

### Step 4: Hard Refresh Browser Cache

Even after Shopify cache is cleared, browsers may cache old files:

**For Testing:**
- Chrome/Edge: `Ctrl+Shift+R` (Windows) or `Cmd+Shift+R` (Mac)
- Firefox: `Ctrl+F5` (Windows) or `Cmd+Shift+R` (Mac)
- Safari: `Cmd+Option+R`

**For End Users:**
- The `?v={{ block.id }}` query param helps, but major changes may require:
  - Updating the block ID (remove and re-add the block)
  - Or adding a timestamp to asset URLs

## Troubleshooting

### Old Files Still Loading?

1. **Check Asset URLs**
   - Open browser DevTools > Network tab
   - Look for CSS/JS file requests
   - Verify they have the `?v=` query parameter
   - Check the file timestamps match your deployment

2. **Force Asset Regeneration**
   ```liquid
   {# Temporarily add timestamp to force refresh #}
   {% assign cache_bust = 'now' | date: '%s' %}
   <link rel="stylesheet" href="{{ em_css }}?v={{ cache_bust }}">
   ```

3. **Remove and Re-add Block**
   - In Theme Editor, delete the EditMuse block
   - Save theme
   - Re-add the block
   - This generates new block IDs and forces fresh asset loading

### Settings Not Updating?

1. **Check Theme Editor Events**
   - Open browser console
   - Look for `[EditMuse]` debug logs
   - Verify `initEditMuseBlock` is being called
   - Check that data attributes are updating

2. **Verify Liquid Output**
   - In Theme Editor, inspect the block HTML
   - Verify `data-em-*` attributes are present
   - Check CSS variables in the `style` attribute

3. **Check CSS Selectors**
   - Ensure CSS classes match what Liquid outputs
   - Verify CSS variables are being used correctly

## Best Practices

### 1. Version Control
- Always commit changes before deploying
- Tag releases in git for easy rollback
- Keep deployment notes

### 2. Staging Environment
- Test on a development store first
- Use Shopify's theme preview feature
- Test with different themes if possible

### 3. Gradual Rollout
- Deploy to a test theme first
- Verify everything works
- Then deploy to production theme

### 4. Monitoring
- Check browser console for errors
- Monitor Shopify app logs
- Set up error tracking if possible

## Quick Reference Commands

```bash
# Deploy extension
shopify app deploy

# Deploy only extension (faster)
shopify app deploy --only=extensions/editmuse-concierge

# Check deployment status
shopify app info

# View extension files
shopify app generate extension

# Test locally
npm run dev

# Check for linting errors
npm run lint
```

## Post-Deployment Verification Checklist

- [ ] Extension appears in Theme Editor
- [ ] All block settings are visible and editable
- [ ] Settings changes apply immediately in preview
- [ ] CSS files load with correct version query param
- [ ] JS files load with correct version query param
- [ ] No console errors in browser DevTools
- [ ] Modal opens and functions correctly
- [ ] All design tokens (colors, radius, etc.) apply correctly
- [ ] Progress bar and close button visibility works
- [ ] Brand styles (pop/minimal/luxe) are visually distinct
- [ ] Modal styles (centered/sheet) work correctly
- [ ] Option styles (pills/cards) display correctly
- [ ] Sticky navigation works when enabled

## Rollback Plan

If something goes wrong:

1. **Revert via Git**
   ```bash
   git log  # Find previous working commit
   git checkout <commit-hash>
   shopify app deploy
   ```

2. **Remove Extension**
   - Go to Theme Editor
   - Remove the EditMuse block
   - Save theme

3. **Contact Support**
   - Shopify Partner Support
   - Check Shopify Community forums

