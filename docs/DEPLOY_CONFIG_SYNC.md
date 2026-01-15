# Shopify Deploy Configuration Sync

## Does `shopify app deploy` Update URLs Automatically?

### Short Answer
**YES, but partially** - `shopify app deploy` syncs some configuration from `shopify.app.toml`, but **NOT all URLs**.

### What Gets Updated Automatically ✅

When you run `shopify app deploy`, Shopify CLI syncs the following from `shopify.app.toml`:

1. **Webhooks** - Webhook subscriptions and URIs
2. **Scopes** - Access scopes
3. **App Proxy Configuration** - The `[app_proxy]` section including:
   - `subpath` (e.g., `editmuse`)
   - `prefix` (e.g., `apps`)
   - **BUT**: The `url` field may NOT always sync correctly

### What Does NOT Get Updated Automatically ❌

1. **App URL** (`application_url`) - Must be updated manually in Shopify Partners
2. **Redirect URLs** (`redirect_urls` in `[auth]`) - Must be updated manually in Shopify Partners
3. **App Proxy URL** (`url` in `[app_proxy]`) - **Sometimes syncs, but not reliable**

### The `automatically_update_urls_on_dev` Setting

```toml
[build]
automatically_update_urls_on_dev = true
```

**Important**: This setting **ONLY applies to `shopify app dev`**, NOT to `shopify app deploy`.

- **During dev** (`shopify app dev`): URLs are auto-updated to your dev tunnel
- **During production deploy** (`shopify app deploy`): URLs are NOT auto-updated

---

## Best Practice: Manual Update Workflow

### When Changing URLs (e.g., New Render URL)

1. **Update `shopify.app.toml`** ✅ (Source of truth)
   ```toml
   application_url = "https://editmuse-z8wu.onrender.com"
   
   [auth]
   redirect_urls = [
     "https://editmuse-z8wu.onrender.com",
     "https://editmuse-z8wu.onrender.com/auth/callback"
   ]
   
   [app_proxy]
   url = "https://editmuse-z8wu.onrender.com"
   ```

2. **Manually Update Shopify Partners Dashboard** ⚠️ (Required)
   - Go to: https://partners.shopify.com → Your App → **App setup**
   - Update **App URL**
   - Update **Redirect URLs**
   - Update **App Proxy → Proxy URL**

3. **Deploy** (`shopify app deploy`)
   - This syncs webhooks, scopes, and app proxy subpath/prefix
   - But does NOT reliably sync the URLs above

4. **Verify in Shopify Partners**
   - Check that all URLs match `shopify.app.toml`
   - If not, update manually

---

## Why Manual Update is Required

Shopify CLI's `deploy` command is designed to sync **functional configuration** (webhooks, scopes, proxy structure) but **not operational URLs** (app URL, redirect URLs, proxy URL).

This is intentional because:
- URLs are deployment-specific and may change independently of code
- Multiple environments (dev/staging/prod) may need different URLs
- Manual control prevents accidental URL changes during deployment

---

## Verification Checklist After Deploy

After running `shopify app deploy`, verify these in Shopify Partners:

- [ ] **App URL** matches `application_url` in `shopify.app.toml`
- [ ] **Redirect URLs** match `redirect_urls` in `shopify.app.toml`
- [ ] **App Proxy → Proxy URL** matches `url` in `[app_proxy]` section
- [ ] **App Proxy → Prefix** matches `prefix` in `[app_proxy]` section
- [ ] **App Proxy → Subpath** matches `subpath` in `[app_proxy]` section
- [ ] **Webhooks** are correct (should be synced automatically)
- [ ] **Scopes** are correct (should be synced automatically)

---

## Summary

| Configuration | Auto-synced by `shopify app deploy`? |
|--------------|--------------------------------------|
| Webhooks | ✅ Yes |
| Scopes | ✅ Yes |
| App Proxy → Prefix/Subpath | ✅ Yes |
| App Proxy → URL | ⚠️ Sometimes (not reliable) |
| App URL | ❌ No (manual update required) |
| Redirect URLs | ❌ No (manual update required) |

**Recommendation**: Always manually verify and update URLs in Shopify Partners after changing them in `shopify.app.toml`.

