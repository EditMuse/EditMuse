# Setting Up a Stable Tunnel URL for Development

## Problem
Every time you restart `shopify app dev`, you get a new Cloudflare tunnel URL, which means you have to update the Shopify Partners dashboard App Proxy URL each time.

## Solution: Use a Stable Tunnel Service

### Option 1: Use ngrok (Easiest - Free Tier Available)

**Step 1: Sign up for ngrok**
1. Go to https://ngrok.com
2. Sign up for a free account
3. Get your authtoken from the dashboard

**Step 2: Install ngrok**
```bash
# Windows (using Chocolatey)
choco install ngrok

# Or download from https://ngrok.com/download
```

**Step 3: Authenticate ngrok**
```bash
ngrok config add-authtoken YOUR_AUTH_TOKEN
```

**Step 4: Start ngrok tunnel (in a separate terminal)**
```bash
# Start ngrok pointing to your local dev server port
# Replace 3000 with your actual React Router port (check shopify app dev output)
ngrok http 3000
```

**Step 5: Get your stable ngrok URL**
- ngrok will show you a URL like: `https://abc123.ngrok-free.app`
- This URL stays the same as long as ngrok is running

**Step 6: Use the stable URL with Shopify CLI**
```bash
shopify app dev --tunnel-url=https://abc123.ngrok-free.app
```

**Step 7: Update Shopify Partners Dashboard**
- Go to your app → App setup → App proxy
- Set Proxy URL to: `https://abc123.ngrok-free.app` (without /apps/editmuse)
- Set Subpath prefix: `apps`
- Set Subpath: `editmuse`
- Save

**Step 8: Update shopify.app.toml**
```toml
[app_proxy]
url = "https://abc123.ngrok-free.app"
subpath = "editmuse"
prefix = "apps"

[build]
automatically_update_urls_on_dev = false  # Prevent auto-updates
```

**Note:** With ngrok free tier, you get a random URL each time. For a **truly stable URL**, you need ngrok paid plan ($8/month) which gives you a custom domain.

---

### Option 2: Cloudflare Tunnel with Account (Free & Stable)

**Step 1: Sign up for Cloudflare**
1. Go to https://dash.cloudflare.com
2. Sign up for a free account

**Step 2: Install cloudflared**
```bash
# Windows - download from https://github.com/cloudflare/cloudflared/releases
# Or use winget:
winget install --id Cloudflare.cloudflared
```

**Step 3: Login to Cloudflare**
```bash
cloudflared tunnel login
```

**Step 4: Create a named tunnel**
```bash
cloudflared tunnel create editmuse-dev
```

**Step 5: Create a config file**
Create `~/.cloudflared/config.yml` (or `C:\Users\YourName\.cloudflared\config.yml` on Windows):

```yaml
tunnel: <tunnel-id-from-step-4>
credentials-file: C:\Users\YourName\.cloudflared\<tunnel-id>.json

ingress:
  - hostname: editmuse-dev.yourdomain.com  # Replace with your domain
    service: http://localhost:3000
  - service: http_status:404
```

**Step 6: Add DNS record**
```bash
cloudflared tunnel route dns editmuse-dev editmuse-dev.yourdomain.com
```

**Step 7: Start the tunnel**
```bash
cloudflared tunnel run editmuse-dev
```

**Step 8: Use with Shopify CLI**
```bash
shopify app dev --tunnel-url=https://editmuse-dev.yourdomain.com
```

**Note:** This requires you to have a domain. If you don't have one, use Option 1 (ngrok) instead.

---

### Option 3: Use ngrok with Custom Domain (Paid - Most Stable)

If you want the most stable setup without managing your own domain:

1. Sign up for ngrok paid plan ($8/month)
2. Configure a custom domain in ngrok dashboard
3. Use that domain with `--tunnel-url` flag
4. The URL never changes

---

## Quick Setup Script (ngrok)

Create a file `start-dev.bat` (Windows) or `start-dev.sh` (Mac/Linux):

**Windows (`start-dev.bat`):**
```batch
@echo off
echo Starting ngrok tunnel...
start "ngrok" cmd /k "ngrok http 3000"
timeout /t 5
echo Starting Shopify app dev...
shopify app dev --tunnel-url=https://YOUR_NGROK_URL.ngrok-free.app
```

**Mac/Linux (`start-dev.sh`):**
```bash
#!/bin/bash
echo "Starting ngrok tunnel..."
ngrok http 3000 &
sleep 5
echo "Starting Shopify app dev..."
shopify app dev --tunnel-url=https://YOUR_NGROK_URL.ngrok-free.app
```

---

## Recommended Approach

For **quick development** (URL changes but easy to update):
- Use the default Cloudflare tunnel
- Update Shopify Partners dashboard when URL changes
- Takes 30 seconds each time

For **stable development** (URL never changes):
- Use ngrok with paid plan ($8/month) for custom domain
- Or use Cloudflare Tunnel with your own domain (free)

---

## Troubleshooting

### "Tunnel URL not reachable"
- Make sure ngrok/cloudflared is running
- Check that the port matches your dev server port
- Verify the URL is accessible in your browser

### "App proxy still returns 404"
- Wait 10-20 seconds after updating Shopify Partners dashboard
- Clear browser cache
- Check that Subpath is set to `editmuse` (not empty)

### "Tunnel disconnects"
- Check your internet connection
- Restart ngrok/cloudflared
- For ngrok free tier, there are connection limits

