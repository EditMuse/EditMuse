# PostgreSQL Setup Guide

This guide will help you set up PostgreSQL for your EditMuse app. We recommend **Neon** (serverless PostgreSQL) or **Supabase** for Shopify apps.

## Quick Comparison

### 🚀 Neon (Recommended for Modern Apps)
✅ **Serverless PostgreSQL**: Auto-scales, pay per use  
✅ **Generous free tier**: 3GB storage, no time limit  
✅ **Branching**: Create database branches for testing (like git)  
✅ **Modern**: Built for serverless/serverless-friendly apps  
✅ **Easy setup**: 2-minute setup, great UI  
✅ **Best for**: Modern apps, serverless deployments, Shopify apps

### 🔥 Supabase (Great Alternative)
✅ **Full platform**: Database + auth + storage + realtime  
✅ **Free tier**: 500MB database, 2GB bandwidth/month  
✅ **Easy setup**: Get a database in 5 minutes  
✅ **Great for Shopify apps**: Used by many production apps  
✅ **Best for**: If you need additional features beyond just database

### 🚂 Railway (If Already Using Railway)
✅ **Integrated**: Easy if you're deploying on Railway  
✅ **Simple**: One-click PostgreSQL addon  
✅ **Same dashboard**: Database + app together  
✅ **Best for**: If you're already using Railway for deployment

## Our Recommendation: Neon

For a Shopify app, **Neon** is our top pick because:
- Serverless architecture matches Shopify app patterns
- Generous free tier with no time limits
- Excellent performance
- Easy to use
- Great developer experience

# Option 1: Neon (Recommended) 🚀

## Step 1: Create a Neon Account

1. Go to [neon.tech](https://neon.tech)
2. Click **"Sign Up"**
3. Sign up with GitHub (easiest) or email
4. Verify your email if needed

## Step 2: Create a New Project

1. Click **"Create a project"**
2. Fill in the form:
   - **Name**: `editmuse-production` (or your preferred name)
   - **Region**: Choose closest to your deployment region
   - **PostgreSQL version**: Latest (recommended)
3. Click **"Create project"**
4. Database is ready instantly! ⚡

## Step 3: Get Your Connection String

1. In your Neon project dashboard, you'll see **"Connection string"** right away
2. Click **"Copy"** to copy the connection string (it looks like: `postgres://username:password@ep-xxxxx.us-east-2.aws.neon.tech/neondb`)
3. The connection string is ready to use - no password replacement needed!

Example connection string:
```
postgres://username:password@ep-cool-darkness-123456.us-east-2.aws.neon.tech/neondb
```

---

# Option 2: Supabase 🔥

## Step 1: Create a Supabase Account

1. Go to [supabase.com](https://supabase.com)
2. Click **"Start your project"** or **"Sign up"**
3. Sign up with GitHub (easiest) or email
4. Verify your email if needed

## Step 2: Create a New Project

1. Click **"New Project"**
2. Fill in the form:
   - **Name**: `editmuse-production` (or your preferred name)
   - **Database Password**: Generate a strong password (save it!)
   - **Region**: Choose closest to your deployment region
   - **Pricing Plan**: Select **"Free"** (perfect to start)
3. Click **"Create new project"**
4. Wait 2-3 minutes for database to be provisioned

## Step 3: Get Your Connection String

1. In your Supabase project dashboard, go to **Settings** → **Database**
2. Scroll down to **"Connection string"**
3. Under **"URI"**, copy the connection string (it looks like: `postgresql://postgres:[YOUR-PASSWORD]@db.xxxxx.supabase.co:5432/postgres`)
4. Replace `[YOUR-PASSWORD]` with the database password you created in Step 2

Example connection string:
```
postgresql://postgres:yourpassword123@db.abcdefghijk.supabase.co:5432/postgres
```

---

# Option 3: Railway 🚂

## Step 1: Create a Railway Account

1. Go to [railway.app](https://railway.app)
2. Sign up with GitHub
3. Create a new project

## Step 2: Add PostgreSQL

1. Click **"New"** → **"Database"** → **"Add PostgreSQL"**
2. Railway automatically creates the database
3. Go to **"Variables"** tab
4. Copy the `DATABASE_URL` value (it's already set up!)

That's it! Railway handles everything automatically.

---

# All Providers: Add DATABASE_URL to Your Environment

## Step 4: Add DATABASE_URL to Your Environment

Add the connection string to your `.env` file:

```env
DATABASE_URL=postgresql://postgres:yourpassword123@db.abcdefghijk.supabase.co:5432/postgres
```

**Important**: 
- Never commit your `.env` file to git
- The `.env` file should already be in `.gitignore`

## Step 5: Run Prisma Migrations

Once `DATABASE_URL` is set, run:

```bash
# Generate Prisma client
npx prisma generate

# Push schema to database (for initial setup)
npx prisma db push
```

Or for production:

```bash
# Create migration
npx prisma migrate dev --name init

# Apply migrations (production)
npx prisma migrate deploy
```

## Step 6: Verify Setup

1. Check that your tables were created:
   - In Supabase dashboard, go to **Table Editor**
   - You should see tables: `Session`, `Shop`, `Experience`, etc.

2. Test your app:
   ```bash
   npm run dev
   ```

## Why We Recommend Neon for Shopify Apps

1. **Serverless Architecture**: Matches Shopify app patterns perfectly
2. **No Cold Starts**: Instant connections (unlike some serverless DBs)
3. **Generous Free Tier**: 3GB storage, no time limits, perfect for starting out
4. **Database Branching**: Create branches for testing (like git branches!) - great for development
5. **Modern & Fast**: Built from the ground up for modern apps
6. **Easy Migration**: Simple to move to paid plans when you scale

## When to Use Each Provider

- **Neon**: Best for modern apps, serverless deployments, when you want the latest tech
- **Supabase**: Best if you might need auth, storage, or realtime features later
- **Railway**: Best if you're already deploying on Railway (integrated experience)

## Troubleshooting

### Connection Error
- **Check password**: Make sure `[YOUR-PASSWORD]` in connection string matches your database password
- **Check network**: Ensure your deployment platform can reach Supabase (usually works out of the box)
- **Check SSL**: Supabase requires SSL. Prisma handles this automatically, but if issues occur, add `?sslmode=require` to connection string

### Migration Issues
- If you get "database does not exist": Connection string might be wrong
- If you get "permission denied": Password is incorrect
- If you get "relation already exists": You may have run migrations twice - check if tables exist in Supabase dashboard

### Local Development
For local development, you can:
- Use the same Supabase database (simplest)
- Set up a local PostgreSQL instance
- Use Docker: `docker run -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres`

## Next Steps

1. ✅ Database is set up
2. ✅ Connection string is configured
3. ✅ Migrations are run
4. 🚀 Deploy your app with `DATABASE_URL` environment variable set

## Security Notes

- ⚠️ **Never commit** `.env` files
- ⚠️ **Rotate passwords** if accidentally exposed
- ⚠️ **Use connection pooling** for production (Supabase provides this)
- ⚠️ **Enable row-level security** in Supabase if you have multi-tenant concerns (Prisma handles this at app level for your use case)

## Support

- [Supabase Documentation](https://supabase.com/docs)
- [Prisma PostgreSQL Guide](https://www.prisma.io/docs/concepts/database-connectors/postgresql)
- [Shopify App Best Practices](https://shopify.dev/docs/apps/best-practices)

