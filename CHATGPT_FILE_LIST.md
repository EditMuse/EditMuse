# EditMuse - File List for ChatGPT

## Critical Files (Read These First)

### 1. Server/App Logic (Mandatory)

**App Proxy Routes**:
- `app/routes/apps.editmuse.session.start.tsx` - POST endpoint (creates session, AI ranking)
- `app/routes/apps.editmuse.session.tsx` - GET endpoint (loads results)

**Core Models**:
- `app/models/ai-ranking.server.ts` - OpenAI integration, prompt building, charge prevention
- `app/models/concierge.server.ts` - Session creation, result saving
- `app/models/billing.server.ts` - Plan limits, usage tracking, credits calculation
- `app/shopify-admin.server.ts` - Product fetching (REST & GraphQL)
- `app/app-proxy.server.ts` - HMAC signature validation

**Database**:
- `prisma/schema.prisma` - Complete database schema
- `app/db.server.ts` - Prisma client export

### 2. Theme App Extension (Mandatory)

**Blocks**:
- `extensions/editmuse-concierge/blocks/editmuse_concierge.liquid` - Main widget block
- `extensions/editmuse-concierge/blocks/editmuse_results.liquid` - Results block

**Frontend JavaScript**:
- `extensions/editmuse-concierge/assets/editmuse-concierge.js` - Concierge modal logic (~2941 lines)
- `extensions/editmuse-concierge/assets/editmuse-results.js` - Results page logic (~531 lines)

**CSS**:
- `extensions/editmuse-concierge/assets/editmuse-concierge.css` - Concierge styles
- `extensions/editmuse-concierge/assets/editmuse-results.css` - Results styles

**Config**:
- `extensions/editmuse-concierge/shopify.extension.toml` - Extension metadata

### 3. Shopify App Configuration (Mandatory)

- `shopify.app.toml` - App proxy config, webhooks, scopes
- `package.json` - Dependencies, scripts
- `vite.config.ts` - Build configuration

### 4. Billing + Webhooks (If Needed)

**Billing**:
- `app/models/shopify-billing.server.ts` - Shopify billing API integration
- `app/routes/app.billing.tsx` - Billing admin UI

**Webhooks**:
- `app/routes/webhooks.billing.subscription_created.tsx`
- `app/routes/webhooks.billing.subscription_updated.tsx`
- `app/routes/webhooks.app.uninstalled.tsx`
- `app/routes/webhooks.app.scopes_update.tsx`

### 5. Database Migrations (If Needed)

- `prisma/migrations/20251231113216_add_billing_and_usage/migration.sql`
- `prisma/migrations/20251229153441_concierge_sessions/migration.sql`
- `prisma/migrations/20251227205311_add_shop_and_experience_models/migration.sql`
- (Other migrations in `prisma/migrations/`)

---

## Quick Reference by Task

### "How does AI ranking work?"
→ Read: `app/models/ai-ranking.server.ts`

### "How are products fetched from Shopify?"
→ Read: `app/shopify-admin.server.ts`

### "How are sessions created and results saved?"
→ Read: `app/models/concierge.server.ts` + `app/routes/apps.editmuse.session.start.tsx`

### "How are results displayed?"
→ Read: `app/routes/apps.editmuse.session.tsx` + `extensions/editmuse-concierge/assets/editmuse-results.js`

### "How does the frontend widget work?"
→ Read: `extensions/editmuse-concierge/assets/editmuse-concierge.js` + `extensions/editmuse-concierge/blocks/editmuse_concierge.liquid`

### "How does billing/credits work?"
→ Read: `app/models/billing.server.ts` + `app/models/shopify-billing.server.ts`

### "What's the database schema?"
→ Read: `prisma/schema.prisma`

### "How is HMAC validation done?"
→ Read: `app/app-proxy.server.ts`

---

## File Size Notes

- `editmuse-concierge.js` is ~2941 lines - read in chunks if needed
- Most other files are <500 lines and can be read in full

---

## Summary Document

See `CHATGPT_CODEBASE_SUMMARY.md` for complete architecture overview and data flow.

