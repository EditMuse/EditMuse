# Render URL Update Checklist

## ✅ Files Updated

1. **`.env` file** - ✅ You updated this
   - `SHOPIFY_APP_URL=https://editmuse-z8wu.onrender.com`

2. **`shopify.app.toml`** - ✅ Updated
   - `application_url = "https://editmuse-z8wu.onrender.com"`
   - `redirect_urls` updated to new URL
   - `app_proxy.url` updated to new URL

## 📋 Manual Steps Required

### 1. Update Render Environment Variables

Go to Render Dashboard → Your Service → Environment Variables:
- **`SHOPIFY_APP_URL`** → `https://editmuse-z8wu.onrender.com`

### 2. Update Shopify Partners Dashboard

#### App URL:
1. Go to: https://partners.shopify.com
2. Navigate to: Your App → **"App setup"**
3. Update **"App URL":**
   - From: `https://editmuse.onrender.com` (or old Railway URL)
   - To: `https://editmuse-z8wu.onrender.com`

#### Redirect URLs:
4. In same section, update **"Redirect URLs":**
   - Remove old URLs
   - Add: `https://editmuse-z8wu.onrender.com`
   - Add: `https://editmuse-z8wu.onrender.com/auth/callback`

#### App Proxy:
5. Scroll to **"App proxy"** section
6. Update **"Proxy URL":**
   - To: `https://editmuse-z8wu.onrender.com` (BASE URL ONLY - no `/apps/editmuse`)
   - (Keep subpath prefix: `apps`, subpath: `editmuse`)
   - Shopify will automatically append the full path when proxying requests

### 3. Redeploy on Render

After updating all URLs:
1. Go to Render Dashboard
2. Your Service → **"Manual Deploy"**
3. Select latest commit
4. Deploy

### 4. Wait and Test

1. **Wait 2-3 minutes** after deploying
2. **Clear browser cache**
3. **Test the app:**
   - Try accessing the app in Shopify admin
   - Try fetching questions in storefront
   - Check Render logs for any errors

---

## Quick Checklist

- [ ] `.env` updated with new URL ✅ (You did this)
- [ ] `shopify.app.toml` updated ✅ (I did this)
- [ ] Render environment variables updated
- [ ] Shopify Partners App URL updated
- [ ] Shopify Partners Redirect URLs updated
- [ ] Shopify Partners App Proxy URL updated
- [ ] Render service redeployed
- [ ] Waited 2-3 minutes
- [ ] Cleared browser cache
- [ ] Tested app access
- [ ] Tested question fetching

---

## Important Notes

- **App Proxy URL in Shopify Partners** should be: `https://editmuse-z8wu.onrender.com` (BASE URL ONLY - Shopify appends the path)
- **Environment Variable in Render** should be: `https://editmuse-z8wu.onrender.com` (base URL only)
- **Shopify Partners App URL** should be: `https://editmuse-z8wu.onrender.com` (base URL only)

---

## After Updates

Once everything is updated, you should:
1. See logs in Render when accessing the app
2. See logs in Render when fetching questions (`[App Proxy] POST /apps/editmuse/session/start`)
3. Questions should load successfully in the storefront modal

