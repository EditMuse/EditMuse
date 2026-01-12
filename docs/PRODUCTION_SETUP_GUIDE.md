# Complete Production Setup Guide
## GitHub + Render + Neon

This guide walks you through setting up EditMuse for production using:
- **GitHub**: Code repository
- **Render**: Hosting platform
- **Neon**: PostgreSQL database

---

## Prerequisites Checklist

- [x] Shopify Partners account
- [x] OpenAI account
- [ ] GitHub account (create at https://github.com)
- [ ] Render account (create at https://render.com)
- [ ] Neon account (create at https://neon.tech)

---

## Step 1: Set Up GitHub Repository

### 1.1 Create GitHub Account (if needed)
1. Go to https://github.com
2. Sign up for a free account
3. Verify your email

### 1.2 Create New Repository
1. Click the **"+"** icon → **"New repository"**
2. Repository name: `editmuse` (or your preferred name)
3. Description: "EditMuse - AI-powered product recommendation Shopify app"
4. Visibility: **Private** (recommended) or Public
5. **DO NOT** initialize with README, .gitignore, or license (we already have these)
6. Click **"Create repository"**

### 1.3 Push Your Code to GitHub

**First time setup:**
```bash
# Make sure you're in your project directory
cd C:\Users\amir_\Documents\editmuse\edit-muse

# Initialize git if not already done
git init

# Add all files (except those in .gitignore)
git add .

# Create initial commit
git commit -m "Initial commit - EditMuse production ready"

# Add GitHub remote (replace YOUR_USERNAME with your GitHub username)
git remote add origin https://github.com/YOUR_USERNAME/editmuse.git

# Push to GitHub
git branch -M main
git push -u origin main
```

**Verify:**
- Go to your GitHub repository
- You should see all your files
- Check that `.env` is NOT visible (it should be in `.gitignore`)

---

## Step 2: Set Up Neon PostgreSQL Database

### 2.1 Create Neon Account
1. Go to https://neon.tech
2. Click **"Sign Up"**
3. Sign up with GitHub (recommended) or email
4. Verify your email if needed

### 2.2 Create Database Project
1. Click **"Create a project"**
2. Project name: `editmuse-production`
3. Region: Choose closest to your Render region (e.g., `US East (Ohio)` or `US West (Oregon)`)
4. PostgreSQL version: **15** (or latest)
5. Click **"Create project"**

### 2.3 Get Connection String
1. After project creation, you'll see a connection string like:
   ```
   postgresql://username:password@ep-xxx-xxx.us-east-2.aws.neon.tech/neondb?sslmode=require
   ```
2. **Copy this connection string** - you'll need it for Render
3. Click **"Connection Details"** to see:
   - Host
   - Database name
   - User
   - Password
   - Port (usually 5432)

### 2.4 Test Connection (Optional)
You can test the connection locally:
```bash
# Update your .env file temporarily
DATABASE_URL=postgresql://username:password@ep-xxx-xxx.us-east-2.aws.neon.tech/neondb?sslmode=require

# Run Prisma migrations
npx prisma migrate deploy

# Or push schema
npx prisma db push
```

**Important:** Don't commit your `.env` file! This is just for testing.

---

## Step 3: Set Up Render Hosting

### 3.1 Create Render Account
1. Go to https://render.com
2. Click **"Get Started for Free"**
3. Sign up with GitHub (recommended - easier integration)
4. Authorize Render to access your GitHub repositories

### 3.2 Create Web Service
1. In Render dashboard, click **"New +"** → **"Web Service"**
2. Connect your GitHub repository:
   - Select **"Connect GitHub"** if not already connected
   - Find and select your `editmuse` repository
   - Click **"Connect"**

### 3.3 Configure Web Service
Fill in the following:

**Basic Settings:**
- **Name**: `editmuse-production`
- **Region**: Choose closest to your users (e.g., `Oregon (US West)` or `Ohio (US East)`)
- **Branch**: `main` (or your default branch)
- **Root Directory**: Leave empty (or `./` if needed)
- **Runtime**: `Node`
- **Build Command**: `npm install && npm run build`
- **Start Command**: `npm run start:prod` (runs migrations then starts server)

**Advanced Settings:**
- **Instance Type**: `Free` (for starting) or `Starter` ($7/month) for better performance
- **Auto-Deploy**: `Yes` (deploys on every push to main)

### 3.4 Add Environment Variables
Click **"Environment"** tab and add these variables:

**Required:**
```env
NODE_ENV=production
SHOPIFY_API_KEY=your_shopify_api_key
SHOPIFY_API_SECRET=your_shopify_api_secret
SCOPES=read_products,write_products,read_orders,write_app_proxy
SHOPIFY_APP_URL=https://editmuse-production.onrender.com
DATABASE_URL=postgresql://username:password@ep-xxx-xxx.us-east-2.aws.neon.tech/neondb?sslmode=require
```

**OpenAI (Required for AI features):**
```env
OPENAI_API_KEY=sk-your-openai-api-key
OPENAI_MODEL=gpt-4o-mini
FEATURE_AI_RANKING=true
```

**Optional:**
```env
PORT=3000
HOST=0.0.0.0
```

**Where to get values:**
- `SHOPIFY_API_KEY` and `SHOPIFY_API_SECRET`: Shopify Partners Dashboard → Your App → API credentials
- `DATABASE_URL`: From Neon (Step 2.3)
- `OPENAI_API_KEY`: From OpenAI dashboard → API keys
- `SHOPIFY_APP_URL`: Will be `https://your-service-name.onrender.com` (Render will show this after first deploy)

### 3.5 Create Database (Render PostgreSQL - Optional)
**Note:** We're using Neon, but Render also offers PostgreSQL. You can use Render's database if you prefer, but Neon is recommended for better performance and free tier.

If you want to use Render's database instead:
1. Click **"New +"** → **"PostgreSQL"**
2. Name: `editmuse-db`
3. Database: `editmuse`
4. User: `editmuse_user`
5. Region: Same as your web service
6. Plan: `Free` (512 MB) or `Starter` ($7/month, 1 GB)
7. Click **"Create Database"**
8. Copy the **Internal Database URL** from the dashboard
9. Use this as your `DATABASE_URL` in environment variables

---

## Step 4: Run Database Migrations

### 4.1 Deploy to Render First
1. Click **"Create Web Service"** in Render
2. Wait for the first deployment to complete (may take 5-10 minutes)
3. Note the service URL: `https://editmuse-production.onrender.com`

### 4.2 Run Migrations via Render Shell
1. In Render dashboard, go to your web service
2. Click **"Shell"** tab
3. Run:
   ```bash
   npx prisma migrate deploy
   ```
   Or if using `db push`:
   ```bash
   npx prisma db push
   ```

### 4.3 Verify Database
1. Go to Neon dashboard
2. Click **"SQL Editor"**
3. Run:
   ```sql
   SELECT table_name FROM information_schema.tables 
   WHERE table_schema = 'public';
   ```
4. You should see tables: `Shop`, `Subscription`, `Experience`, `ConciergeSession`, etc.

---

## Step 5: Update Shopify App Configuration

### 5.1 Update App URLs in Shopify Partners
1. Go to https://partners.shopify.com
2. Navigate to your app → **"App setup"**
3. Update these URLs:

**App URL:**
```
https://editmuse-production.onrender.com
```

**Allowed redirection URL(s):**
```
https://editmuse-production.onrender.com/auth/callback
```

### 5.2 Configure App Proxy
1. In Shopify Partners → Your App → **"App setup"** → **"App proxy"**
2. Fill in:
   - **Subpath prefix**: `apps`
   - **Subpath**: `editmuse`
   - **Proxy URL**: `https://editmuse-production.onrender.com`
3. Click **"Save"**

### 5.3 Update shopify.app.toml
Update your local `shopify.app.toml`:

```toml
application_url = "https://editmuse-production.onrender.com"

[auth]
redirect_urls = [ "https://editmuse-production.onrender.com" ]

[app_proxy]
url = "https://editmuse-production.onrender.com"
subpath = "editmuse"
prefix = "apps"
```

**Commit and push:**
```bash
git add shopify.app.toml
git commit -m "Update production URLs"
git push
```

---

## Step 6: Configure Webhooks

### 6.1 Update Webhook URLs
In Shopify Partners → Your App → **"Webhooks"**:

Update all webhook URLs to:
```
https://editmuse-production.onrender.com/webhooks/[webhook-name]
```

For example:
- `https://editmuse-production.onrender.com/webhooks/app/scopes_update`
- `https://editmuse-production.onrender.com/webhooks/app/uninstalled`
- `https://editmuse-production.onrender.com/webhooks/orders/create`
- etc.

### 6.2 Test Webhooks (Optional)
1. In Shopify Partners → Webhooks
2. Click **"Send test"** for each webhook
3. Check Render logs to verify they're received

---

## Step 7: Update Prisma Schema for Production

### 7.1 Ensure PostgreSQL Provider
Check `prisma/schema.prisma`:

```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
```

If it says `sqlite`, change it to `postgresql`.

### 7.2 Generate Prisma Client
```bash
npx prisma generate
```

---

## Step 8: Test Production Deployment

### 8.1 Install App on Test Store
1. Go to your Shopify Partners dashboard
2. Click **"Test on development store"**
3. Install your app
4. Test the concierge widget
5. Test billing/subscription flow
6. Test AI ranking

### 8.2 Monitor Logs
1. In Render dashboard → Your service → **"Logs"** tab
2. Watch for errors
3. Check for successful requests

### 8.3 Monitor Database
1. In Neon dashboard → **"SQL Editor"**
2. Run queries to verify data:
   ```sql
   SELECT COUNT(*) FROM "Shop";
   SELECT COUNT(*) FROM "Experience";
   ```

---

## Step 9: Set Up Custom Domain (Optional)

### 9.1 Get Custom Domain
1. Purchase domain from Namecheap, GoDaddy, etc.
2. Or use a subdomain you already own

### 9.2 Configure in Render
1. In Render dashboard → Your service → **"Settings"**
2. Scroll to **"Custom Domains"**
3. Click **"Add Custom Domain"**
4. Enter your domain: `app.editmuse.com` (example)
5. Follow DNS instructions:
   - Add CNAME record: `app` → `editmuse-production.onrender.com`
   - Or A record: Point to Render's IP (shown in instructions)

### 9.3 Update Shopify URLs
1. Update `SHOPIFY_APP_URL` in Render environment variables
2. Update Shopify Partners dashboard URLs
3. Update `shopify.app.toml`
4. Redeploy

---

## Step 10: Set Up Monitoring (Optional but Recommended)

### 10.1 Render Metrics
- Render provides basic metrics in dashboard
- Monitor: CPU, Memory, Request count, Response times

### 10.2 Add Health Check Endpoint
Create `app/routes/health.tsx`:

```typescript
export const loader = async () => {
  return Response.json({ 
    status: "ok", 
    timestamp: new Date().toISOString() 
  });
};
```

### 10.3 Set Up Uptime Monitoring
- Use services like UptimeRobot (free)
- Monitor: `https://editmuse-production.onrender.com/health`
- Get alerts if service goes down

---

## Troubleshooting

### Database Connection Issues
**Error:** `Can't reach database server`
- Check `DATABASE_URL` in Render environment variables
- Verify Neon database is running
- Check firewall/network settings in Neon

**Error:** `relation "Shop" does not exist`
- Run migrations: `npx prisma migrate deploy` in Render Shell
- Or: `npx prisma db push` in Render Shell

### App Not Loading
**Error:** `404 Not Found`
- Check `SHOPIFY_APP_URL` matches Render service URL
- Verify Shopify Partners dashboard URLs are updated
- Check Render logs for errors

### Webhooks Not Working
**Error:** Webhooks not received
- Verify webhook URLs in Shopify Partners dashboard
- Check Render logs for incoming requests
- Ensure webhook routes exist in your app

### Build Failures
**Error:** Build command failed
- Check Render build logs
- Verify `package.json` has correct scripts
- Ensure all dependencies are in `package.json`

---

## Cost Summary

### Free Tier (Starting Out)
- **GitHub**: Free (unlimited private repos)
- **Render**: Free (with limitations: spins down after 15 min inactivity)
- **Neon**: Free (3 GB storage, 0.5 GB RAM)
- **OpenAI**: Pay-as-you-go (~$0.15 per 1M tokens for gpt-4o-mini)
- **Total**: ~$0-10/month (just OpenAI usage)

### Recommended Production (Small Scale)
- **GitHub**: Free
- **Render**: Starter plan ($7/month) - always on, better performance
- **Neon**: Free tier (upgrade to $19/month when needed)
- **OpenAI**: ~$10-50/month (depending on usage)
- **Total**: ~$17-76/month

---

## Next Steps

1. ✅ Set up GitHub repository
2. ✅ Set up Neon database
3. ✅ Set up Render hosting
4. ✅ Configure environment variables
5. ✅ Run database migrations
6. ✅ Update Shopify app URLs
7. ✅ Test production deployment
8. ✅ Monitor and optimize

---

## Support Resources

- **Render Docs**: https://render.com/docs
- **Neon Docs**: https://neon.tech/docs
- **Shopify App Development**: https://shopify.dev/docs/apps
- **Prisma Docs**: https://www.prisma.io/docs

---

## Quick Reference: Environment Variables Checklist

Copy this checklist when setting up Render:

```env
✅ NODE_ENV=production
✅ SHOPIFY_API_KEY=...
✅ SHOPIFY_API_SECRET=...
✅ SCOPES=read_products,write_products,read_orders,write_app_proxy
✅ SHOPIFY_APP_URL=https://editmuse-production.onrender.com
✅ DATABASE_URL=postgresql://... (from Neon)
✅ OPENAI_API_KEY=sk-...
✅ OPENAI_MODEL=gpt-4o-mini
✅ FEATURE_AI_RANKING=true
✅ PORT=3000
✅ HOST=0.0.0.0
```

---

**You're all set!** Your app should now be running in production. 🚀

