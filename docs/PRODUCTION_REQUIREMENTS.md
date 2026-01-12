# EditMuse Production Requirements

Complete list of all subscriptions, services, platforms, and dependencies needed to run EditMuse as a production Shopify app.

---

## 🔴 Required (Cannot Run Without)

### 1. Shopify Partners Account (FREE)
**What**: Shopify app development account  
**Cost**: FREE  
**Why Needed**: 
- Create and manage Shopify apps
- OAuth authentication with merchant stores
- Access to Shopify Admin API and GraphQL
- App listing in Shopify App Store (when published)

**How to Get**:
- Sign up at [partners.shopify.com](https://partners.shopify.com)
- Create a new app in your Partner Dashboard
- Get `SHOPIFY_API_KEY` and `SHOPIFY_API_SECRET`

**Required API Scopes** (already configured in `shopify.app.toml`):
- `read_products` - Fetch products from Shopify
- `write_products` - Product operations (if needed)
- `read_orders` - Access order data via webhooks
- `write_app_proxy` - App Proxy functionality

---

### 2. PostgreSQL Database (Required for Production)
**What**: Database for storing sessions, shops, experiences, billing data  
**Cost**: FREE tier available (3GB storage)  
**Why Needed**:
- Store OAuth sessions (Shop authentication tokens)
- Store shop data, experiences, concierge sessions
- Store subscription/billing data
- Store usage events and credits

**Recommended Providers**:
1. **Neon** (Recommended) - Serverless PostgreSQL
   - Free tier: 3GB storage, no time limit
   - Cost after free: ~$19/month
   - [neon.tech](https://neon.tech)

2. **Supabase** (Alternative)
   - Free tier: 500MB database, 2GB bandwidth/month
   - Cost after free: ~$25/month
   - [supabase.com](https://supabase.com)

3. **Railway** (If deploying there)
   - Free tier: $5 credit/month
   - PostgreSQL addon: ~$5/month
   - [railway.app](https://railway.app)

**Setup**: See `docs/POSTGRES_SETUP.md` for detailed instructions

---

### 3. Hosting/Deployment Platform (Required)
**What**: Server to run your Node.js app  
**Cost**: FREE tier available ($0-20/month)  
**Why Needed**:
- Run the React Router server
- Handle HTTP requests from Shopify
- Process App Proxy requests
- Serve the embedded admin app

**Recommended Options**:

1. **Railway** ⭐ (Easiest)
   - Free tier: $5 credit/month
   - Cost: ~$5-20/month after free tier
   - Simple deployment, integrated PostgreSQL
   - [railway.app](https://railway.app)

2. **Render** (Good for beginners)
   - Free tier: Slow cold starts, sleeps after inactivity
   - Cost: ~$7/month (Starter plan, no cold starts)
   - [render.com](https://render.com)

3. **Fly.io** (Good performance)
   - Free tier: 3 shared-cpu VMs
   - Cost: ~$5-15/month
   - [fly.io](https://fly.io)

4. **Google Cloud Run** (Enterprise-grade)
   - Free tier: 2 million requests/month
   - Cost: Pay-per-use after free tier
   - [cloud.google.com/run](https://cloud.google.com/run)

**Important**: Your hosting must:
- Support HTTPS (SSL certificates)
- Support environment variables
- Support persistent processes (not just serverless functions)
- Allow custom domains (or provide stable subdomain)

---

### 4. OpenAI API Account (Required for AI Features)
**What**: AI service for product ranking  
**Cost**: Pay-per-use (~$0.15-1.50 per 1M tokens)  
**Why Needed**:
- Rank products based on user quiz/chat responses
- Generate product recommendations
- Improve user experience with AI-powered matching

**Model Used**: `gpt-4o-mini` (default, most cost-effective)
- Input: ~$0.15 per 1M tokens
- Output: ~$0.60 per 1M tokens

**Estimated Monthly Cost**:
- **Small app** (100 requests/day): ~$5-15/month
- **Medium app** (1,000 requests/day): ~$50-150/month
- **Large app** (10,000 requests/day): ~$500-1,500/month

**Note**: AI ranking can be disabled via `FEATURE_AI_RANKING=false` env var (app will use fallback ranking)

**How to Get**:
- Sign up at [platform.openai.com](https://platform.openai.com)
- Add payment method
- Get API key
- Set `OPENAI_API_KEY` environment variable

**Cost Optimization**:
- Uses `gpt-4o-mini` (cheapest OpenAI model)
- Implements 5-minute cooldown per session (prevents duplicate charges)
- Falls back to deterministic ranking if AI fails

---

## 🟡 Optional (Recommended for Production)

### 5. Custom Domain (Optional but Recommended)
**What**: Your own domain name (e.g., `app.editmuse.com`)  
**Cost**: ~$10-15/year  
**Why Needed**:
- Professional appearance
- Better branding
- More stable than platform subdomains

**Providers**:
- [Namecheap](https://www.namecheap.com) - ~$10/year
- [Cloudflare](https://cloudflare.com) - ~$10/year (includes free DNS + SSL)
- [Google Domains](https://domains.google) - ~$12/year

**Note**: Most hosting platforms provide free subdomains (e.g., `editmuse.railway.app`), so custom domain is optional.

---

### 6. Monitoring & Analytics (Optional)
**What**: Application monitoring and error tracking  
**Cost**: FREE tier available  
**Why Needed**:
- Track errors and performance
- Monitor API usage
- Alert on issues

**Recommended**:
- **Sentry** - Error tracking (free tier: 5K events/month)
- **LogRocket** - Session replay (free tier: 1K sessions/month)
- **Datadog** - Full observability (14-day trial)

**Note**: Most hosting platforms (Railway, Render) include basic logging.

---

## 📋 Complete Cost Breakdown

### Minimum (Free Tier - Good for Testing)
- **Shopify Partners**: $0
- **PostgreSQL (Neon free tier)**: $0
- **Hosting (Railway free tier)**: $0 (with $5 credit)
- **OpenAI API**: ~$0-10/month (low usage)
- **Custom Domain**: $0 (use platform subdomain)

**Total: ~$0-10/month**

---

### Recommended Production Setup
- **Shopify Partners**: $0
- **PostgreSQL (Neon)**: $0-19/month (free tier or paid)
- **Hosting (Railway)**: $5-20/month
- **OpenAI API**: $10-100/month (varies by usage)
- **Custom Domain**: $1/month (~$12/year)

**Total: ~$16-140/month** (depending on usage)

---

### Enterprise/High Traffic
- **Shopify Partners**: $0
- **PostgreSQL (Neon paid)**: $19+/month
- **Hosting (Railway/GCP)**: $50-200/month
- **OpenAI API**: $100-1000+/month
- **Custom Domain**: $1/month
- **Monitoring**: $0-50/month

**Total: ~$170-1,270+/month**

---

## 🔧 Environment Variables Required

All of these must be set in your hosting platform:

### Required (App won't work without these)
```env
SHOPIFY_API_KEY=your_api_key_from_partners_dashboard
SHOPIFY_API_SECRET=your_api_secret_from_partners_dashboard
SCOPES=read_products,write_products,read_orders,write_app_proxy
SHOPIFY_APP_URL=https://your-app-url.com
DATABASE_URL=postgresql://user:password@host:5432/database
```

### Optional (AI Features)
```env
OPENAI_API_KEY=sk-... (required if using AI ranking)
OPENAI_MODEL=gpt-4o-mini (default, can change)
FEATURE_AI_RANKING=true (set to "false" to disable AI)
```

### Optional (Advanced)
```env
NODE_ENV=production
HOST=0.0.0.0
PORT=3000
SHOP_CUSTOM_DOMAIN=yourcustomdomain.com (if using custom shop domains)
```

---

## 📦 What's Already Included (No Extra Cost)

### Shopify Billing API
- **Cost**: FREE (built into Shopify)
- **What**: Handles subscription payments from merchants
- **Why**: Your app already uses this for billing (recurring charges, usage records)

### Shopify App Proxy
- **Cost**: FREE (built into Shopify)
- **What**: Routes storefront requests to your app
- **Why**: Required for Theme App Extension to work

### Shopify Webhooks
- **Cost**: FREE (built into Shopify)
- **What**: Real-time events from Shopify
- **Configured**: `app/scopes_update`, `app/uninstalled`, `orders/create`, `carts/create`, `checkouts/create`

---

## 🚀 Getting Started Checklist

- [ ] Create Shopify Partners account
- [ ] Create and configure app in Partner Dashboard
- [ ] Get `SHOPIFY_API_KEY` and `SHOPIFY_API_SECRET`
- [ ] Choose PostgreSQL provider (Neon recommended)
- [ ] Set up PostgreSQL database
- [ ] Get `DATABASE_URL` connection string
- [ ] Choose hosting platform (Railway recommended)
- [ ] Deploy app to hosting platform
- [ ] Set environment variables in hosting platform
- [ ] (Optional) Sign up for OpenAI API
- [ ] (Optional) Set `OPENAI_API_KEY`
- [ ] (Optional) Buy custom domain
- [ ] Configure custom domain (if purchased)
- [ ] Test app in development store
- [ ] Submit app for Shopify App Store review (when ready)

---

## 📚 Additional Resources

- **Shopify App Requirements**: [shopify.dev/docs/apps/store/requirements](https://shopify.dev/docs/apps/store/requirements)
- **Deployment Guide**: `docs/POSTGRES_SETUP.md`
- **Troubleshooting**: `docs/DEV_TROUBLESHOOTING.md`
- **Shopify Partners**: [partners.shopify.com](https://partners.shopify.com)

---

## 💡 Cost Optimization Tips

1. **Start with free tiers** - All services offer generous free tiers
2. **Monitor OpenAI usage** - Track API costs and optimize prompts
3. **Use platform subdomains** - Skip custom domain initially
4. **Scale gradually** - Upgrade only when you hit limits
5. **Disable AI if not needed** - Set `FEATURE_AI_RANKING=false` to save OpenAI costs
6. **Use connection pooling** - Reduces database connection costs

---

## ❓ Questions?

- Check `docs/POSTGRES_SETUP.md` for database setup
- Check `docs/DEV_TROUBLESHOOTING.md` for common issues
- Shopify Docs: [shopify.dev/docs/apps](https://shopify.dev/docs/apps)

