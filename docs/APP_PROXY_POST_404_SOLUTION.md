# Shopify App Proxy POST 404 Solution

## Problem Summary

- **GET requests work**: `/apps/editmuse` returns 200 ✅
- **POST requests fail**: `/apps/editmuse/session/start` returns 404 from Shopify ❌
- **Billing works** when Proxy URL is base URL only
- **Billing breaks** when Proxy URL includes `/apps/editmuse`

## Root Cause

Shopify app proxy has inconsistent behavior with POST requests depending on Proxy URL configuration:

1. **Base URL only** (`https://editmuse.onrender.com`):
   - Shopify forwards: `{shop}.myshopify.com/apps/editmuse/session/start` → `https://editmuse.onrender.com/apps/editmuse/session/start` ✅
   - BUT: POST requests may return 404 (Shopify not forwarding POST correctly)
   - Billing routes work (not proxied)

2. **With subpath** (`https://editmuse.onrender.com/apps/editmuse`):
   - Shopify may strip prefix/subpath and forward incorrectly
   - Billing routes may break (unrelated to proxy, but configuration issue)

## Solution: Use Base URL + Ensure Routes Handle Full Path

### Step 1: Configure Proxy URL in Shopify Partners

1. Go to **Shopify Partners** → **Your App** → **App setup** → **App proxy**
2. Set:
   - **Prefix**: `apps`
   - **Subpath**: `editmuse`
   - **Proxy URL**: `https://editmuse.onrender.com` (BASE URL ONLY - no `/apps/editmuse`)
3. Click **Save**
4. Wait 3-5 minutes for Shopify to sync
5. **Uninstall and reinstall** the app on your dev store

### Step 2: Verify Routes Are Correct

Routes should handle the full path `/apps/editmuse/session/start`:

- ✅ `app/routes/apps.editmuse._index.tsx` → `/apps/editmuse`
- ✅ `app/routes/apps.editmuse.session.start.tsx` → `/apps/editmuse/session/start`
- ✅ `app/routes/apps.editmuse.ping.tsx` → `/apps/editmuse/ping`

### Step 3: Test POST Request

After reinstall, test in browser console:

```javascript
fetch('/apps/editmuse/session/start', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  credentials: 'same-origin',
  body: JSON.stringify({ experienceId: 'test' })
}).then(r => {
  console.log('Status:', r.status);
  console.log('URL:', r.url);
  return r.text();
}).then(text => console.log('Response:', text));
```

### Step 4: Check Render Logs

If POST still returns 404, check Render logs. You should see:
- `[App Proxy] ========== POST REQUEST RECEIVED ==========` if request reaches Render
- If you don't see this, Shopify isn't forwarding POST

## Alternative: If Base URL Doesn't Work

If base URL still doesn't work for POST, try:

1. **Proxy URL**: `https://editmuse.onrender.com/apps/editmuse`
2. Create alternative routes that handle stripped paths:
   - `app/routes/session.start.tsx` (if Shopify strips `/apps/editmuse`)
   - But this breaks billing, so not recommended

## Why This Happens

Shopify app proxy documentation is ambiguous about POST request handling. Some developers report:
- POST requests require signature parameter
- POST requests may need CORS preflight (OPTIONS) handler
- Shopify may not forward POST requests correctly in some configurations

## Current Status

- ✅ GET requests work
- ✅ Routes are correctly configured
- ✅ OPTIONS handler added for CORS
- ⚠️ POST requests still return 404 (Shopify not forwarding)

## Next Steps

1. Redeploy with enhanced logging
2. Test POST request after reinstall
3. Check Render logs for "POST REQUEST RECEIVED"
4. If still 404, contact Shopify support about POST forwarding

