# OAuth Connection Troubleshooting

## Error: "accounts.shopify.com refused to connect"

This error typically means **Shopify can't reach your Render deployment** during OAuth redirect.

## Quick Checks

### 1. Verify Render Service is Running

1. Go to Render Dashboard
2. Check your service status:
   - Should show **"Live"** or **"Running"**
   - If it shows "Failed" or "Stopped", restart it

### 2. Test Your App URL Manually

Open in browser:
```
https://editmuse-z8wu.onrender.com
```

**Expected:** You should see your app homepage or a login page
**If it fails:** Your Render service isn't responding

### 3. Test OAuth Callback Endpoint

Open in browser:
```
https://editmuse-z8wu.onrender.com/auth/callback
```

**Expected:** Should redirect or show authentication page
**If it fails:** The auth route might not be set up correctly

### 4. Check Render Logs

1. Go to Render Dashboard → Your Service → **Logs**
2. Look for:
   - ✅ `[Sentry] Initialized server-side error tracking` (if Sentry is set up)
   - ✅ `[ENV] SHOPIFY_APP_URL: https://editmuse-z8wu.onrender.com`
   - ✅ No error messages about missing environment variables
   - ❌ Any errors about `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, or `SHOPIFY_APP_URL`

### 5. Verify Environment Variables on Render

**Required variables:**
- ✅ `SHOPIFY_APP_URL` = `https://editmuse-z8wu.onrender.com`
- ✅ `SHOPIFY_API_KEY` = Your API key (should match `client_id` in shopify.app.toml)
- ✅ `SHOPIFY_API_SECRET` = Your API secret
- ✅ `SCOPES` = `read_products,write_products,write_app_proxy,read_orders`
- ✅ `DATABASE_URL` = Your PostgreSQL connection string

**How to check:**
1. Render Dashboard → Your Service → **Environment**
2. Verify all variables are set (no empty values)

### 6. Check if Service is Healthy

Look for in Render logs:
```
✓ built in X.XXs
Prisma schema loaded from prisma/schema.prisma
✔ Generated Prisma Client
```

If you see errors about Prisma or database connection, the service won't work.

---

## Common Issues & Fixes

### Issue 1: Render Service Not Responding

**Symptom:** Can't access `https://editmuse-z8wu.onrender.com` in browser

**Fix:**
1. Check Render dashboard for service status
2. If stopped, click "Manual Deploy" → "Deploy latest commit"
3. Wait 2-3 minutes for deployment to complete
4. Check logs for any startup errors

### Issue 2: Missing Environment Variables

**Symptom:** App starts but OAuth fails, errors in logs about missing variables

**Fix:**
1. Go to Render Dashboard → Environment
2. Verify `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL` are set
3. Re-deploy after adding missing variables

### Issue 3: Database Connection Issues

**Symptom:** Logs show Prisma errors or database connection failures

**Fix:**
1. Verify `DATABASE_URL` is correct in Render
2. Check if database is accessible (not paused)
3. Re-deploy service

### Issue 4: Service Crashes on Startup

**Symptom:** Service shows "Failed" status or keeps restarting

**Fix:**
1. Check Render logs for error messages
2. Common causes:
   - Missing environment variables
   - Database connection errors
   - Build failures
3. Fix the underlying issue and re-deploy

---

## Step-by-Step Debugging

1. **Test basic connectivity:**
   ```
   Open: https://editmuse-z8wu.onrender.com
   ```
   If this doesn't work, your service isn't running.

2. **Check Render logs:**
   - Look for startup messages
   - Look for error messages
   - Verify environment variables are loaded

3. **Try installing again:**
   - Clear browser cache
   - Use incognito mode
   - Try installing the app again

4. **If still failing:**
   - Check Render service health status
   - Verify all environment variables match Shopify Partners config
   - Wait 5-10 minutes after any changes (Shopify/Render caching)

---

## Verification Checklist

- [ ] Render service shows "Live" status
- [ ] Can access `https://editmuse-z8wu.onrender.com` in browser
- [ ] Can access `https://editmuse-z8wu.onrender.com/auth/callback` in browser
- [ ] Render logs show successful startup (no errors)
- [ ] All required environment variables are set in Render
- [ ] `SHOPIFY_APP_URL` matches your Render URL exactly
- [ ] Shopify Partners App URL matches Render URL
- [ ] Shopify Partners Redirect URLs are correct
- [ ] Waited 5-10 minutes after any changes
- [ ] Cleared browser cache / tried incognito mode

