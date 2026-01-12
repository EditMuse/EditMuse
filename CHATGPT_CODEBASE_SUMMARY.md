# EditMuse Codebase Summary for ChatGPT

## Overview
This is a Shopify App that provides AI-powered product recommendations through a Theme App Extension. The app uses OpenAI (gpt-4o-mini) to rank products based on user quiz/chat responses.

---

## 1. Server/App Logic (Mandatory)

### App Proxy Routes (Main Entry Points)

#### `app/routes/apps.editmuse.session.start.tsx` (POST `/apps/editmuse/session/start`)
**Purpose**: Main App Proxy endpoint that receives Theme Extension submissions, creates sessions, fetches products, and initiates AI ranking.

**Key Functions**:
- Validates HMAC signature via `validateAppProxySignature`
- Parses `experienceId`, `resultCount`, `answers` from request body
- Creates/upserts Shop record
- Resolves Experience (provided ID or default)
- Creates `ConciergeSession` with `createConciergeSession`
- Tracks `SESSION_STARTED` usage event
- Fetches products via `fetchShopifyProducts` (REST API)
- Filters products: ARCHIVED/DRAFT status, excludedTags, inStockOnly, price/budget range
- Builds candidates array (max 200) for AI ranking
- Calls `rankProductsWithAI` with userIntent, candidates, resultCount, shopId, sessionToken
- Ensures final handles list has exactly `min(resultCountUsed, candidates.length)` handles
- Saves results with `saveConciergeResult`
- Returns JSON with `sessionId`, `redirectTo` path

**Important Logic**:
- Budget parsing: extracts `priceMin`/`priceMax` from answers (supports "under-50", "50-100", "500-plus" formats)
- Product filtering happens BEFORE AI ranking
- Results are saved immediately after ranking (no second AI call needed)

#### `app/routes/apps.editmuse.session.tsx` (GET `/apps/editmuse/session`)
**Purpose**: Retrieves session results, either from saved `ConciergeResult` or performs AI ranking on-the-fly.

**Key Functions**:
- Loads session by `sid` token
- Validates HMAC signature (optional - allows storefront direct calls)
- Checks if `ConciergeResult` exists:
  - **If exists**: Uses saved handles in exact order, skips AI ranking
  - **If not exists**: Proceeds with AI ranking (with same filtering logic as start route)
- Fetches products via `fetchShopifyProductsGraphQL` (GraphQL API - richer data)
- Applies same filters: status, excludedTags, inStockOnly, price range
- Returns products mapped to saved/ranked handle order

**Important Logic**:
- Never calls AI if `ConciergeResult` exists (prevents duplicate charges)
- Price filtering happens BEFORE AI ranking
- Returns empty results if 0 candidates after filtering

### Session Management

#### `app/models/concierge.server.ts`
**Functions**:
- `createConciergeSession({ shopId, experienceId, resultCount, answersJson })`: Creates session, returns publicToken
- `saveConciergeResult({ sessionToken, productHandles, productIds, reasoning })`: Saves ranked handles, marks session COMPLETE
- `getConciergeSessionByToken(sessionToken)`: Loads session with relations (messages, result, shop, experience)
- `addConciergeMessage({ sessionToken, role, text, imageUrl })`: Adds chat message to session

### Product Fetching Pipeline

#### `app/shopify-admin.server.ts`
**Functions**:
- `getAccessTokenForShop(shopDomain)`: Gets online access token from Session table
- `getOfflineAccessTokenForShop(shopDomain)`: Gets offline access token from Session table
- `fetchShopifyProducts({ shopDomain, accessToken, limit, collectionIds })`: REST API fetch
  - Returns: `handle`, `title`, `image`, `price`, `priceAmount`, `currencyCode`, `tags`, `available`, `status`
  - Supports collection filtering
  - Price conversion logic (handles cents vs major units)
- `fetchShopifyProductsGraphQL({ shopDomain, accessToken, limit, collectionIds })`: GraphQL API fetch
  - Returns: Same fields + `productType`, `vendor`, `description`, `url`
  - Richer data for AI ranking
  - Supports collection filtering via GraphQL IDs

**Filtering Logic** (applied in both routes):
1. Status filter: Exclude `ARCHIVED` and `DRAFT`
2. Excluded tags: Filter products with matching tags (case-insensitive)
3. In-stock only: Filter by `available` flag
4. Price/budget range: Filter by `priceMin`/`priceMax` parsed from answers
5. Deduplication: Remove duplicates by handle

### AI Ranking Module

#### `app/models/ai-ranking.server.ts`
**Functions**:
- `isAIRankingEnabled()`: Checks `FEATURE_AI_RANKING` env var and `OPENAI_API_KEY`
- `getOpenAIModel()`: Returns `OPENAI_MODEL` or defaults to `"gpt-4o-mini"`
- `rankProductsWithAI(userIntent, candidates, resultCount, shopId?, sessionToken?)`: Main ranking function
  - Builds product list string for prompt (max 200 candidates)
  - Constructs system prompt with JSON schema requirements
  - Calls OpenAI API with `response_format: { type: "json_object" }`
  - Validates response structure and handles
  - **Charge Prevention**: Checks `session.chargedAt`:
    - If `null`: Set to now, proceed with charging
    - If `now - chargedAt < 5 minutes`: Skip charging
    - Else: Update `chargedAt` to now, charge
  - Tracks `AI_RANKING_EXECUTED` event with `creditsBurned` computed via `computeCreditsBurned`
  - Returns `{ rankedHandles: string[], reasoning: string }` or `null`
- `fallbackRanking(candidates, resultCount)`: Simple sort by available first, then handle

**Prompt Structure**:
- System prompt: Instructions for ranking, JSON schema requirements, handle validation rules
- User prompt: Shopper intent + candidate product list (handle, title, tags, type, vendor, price, description, availability)
- Response format: `{ ranked_handles: string[], reasoning: string }`

**Safety Features**:
- 30s timeout protection
- JSON schema validation
- Handle existence validation (case-insensitive matching)
- Fallback to non-AI sorting on failure

### App Proxy Utilities

#### `app/app-proxy.server.ts`
**Functions**:
- `validateAppProxySignature(query, secret)`: Validates HMAC SHA256 signature per Shopify spec
  - Removes signature from params
  - Builds sorted param strings: `key=value1,value2`
  - Sorts lexicographically, joins with no separators
  - Computes HMAC-SHA256 hex digest
  - Timing-safe comparison
- `getShopFromAppProxy(query)`: Extracts shop domain from query params

---

## 2. Database Layer (Mandatory)

### Schema: `prisma/schema.prisma`

**Models**:

#### `Session` (Shopify session storage)
- `id`, `shop`, `state`, `isOnline`, `scope`, `expires`, `accessToken`, `userId`, etc.

#### `Shop`
- `id` (cuid), `domain` (unique), `accessToken`, `trialStartedAt`, `trialEndsAt`
- Relations: `experiences`, `conciergeSessions`, `subscription`, `usageEvents`

#### `Experience`
- `id` (cuid), `shopId`, `name`, `mode` ("quiz"|"chat"|"hybrid"), `resultCount` (8|12|16)
- `includedCollections` (JSON array), `excludedTags` (JSON array), `inStockOnly` (boolean)
- `isDefault` (boolean), `questionsJson` (JSON array)
- Relations: `conciergeSessions`

#### `ConciergeSession`
- `id` (cuid), `publicToken` (unique, base64url), `shopId`, `experienceId` (nullable)
- `status` (COLLECTING|PROCESSING|COMPLETE|FAILED), `resultCount` (default 8)
- `answersJson` (JSON array), `chargedAt` (DateTime nullable - for charge prevention)
- Relations: `messages`, `result`

#### `ConciergeMessage`
- `id` (cuid), `sessionId`, `role` (USER|ASSISTANT|SYSTEM), `text`, `imageUrl`

#### `ConciergeResult`
- `id` (cuid), `sessionId` (unique), `productHandles` (JSON array), `productIds` (JSON nullable), `reasoning` (string nullable)

#### `Subscription`
- `id` (cuid), `shopId` (unique), `planTier` (TRIAL|BASIC|STARTER|PRO)
- `shopifySubscriptionId`, `shopifyChargeId`, `status`, `currentPeriodStart`, `currentPeriodEnd`

#### `UsageEvent`
- `id` (cuid), `shopId`, `eventType` (SESSION_STARTED|AI_RANKING_EXECUTED)
- `metadata` (JSON string), `creditsBurned` (Float, default 0), `createdAt`

**Enums**:
- `PlanTier`: TRIAL, BASIC, STARTER, PRO
- `ConciergeSessionStatus`: COLLECTING, PROCESSING, COMPLETE, FAILED
- `ConciergeRole`: USER, ASSISTANT, SYSTEM
- `UsageEventType`: SESSION_STARTED, AI_RANKING_EXECUTED

**Migrations**: Located in `prisma/migrations/` (8 migrations total)

**Database Client**: `app/db.server.ts` - Exports Prisma client singleton

---

## 3. Theme App Extension (Mandatory)

### Location: `extensions/editmuse-concierge/`

### Blocks

#### `blocks/editmuse_concierge.liquid`
**Purpose**: Main interactive widget (quiz/chat/hybrid modes) with button trigger

**Key Features**:
- V2 Design Tokens system (brand styles: pop, minimal, luxe)
- Customizable colors, spacing, radius, fonts, shadows, overlays
- Button customization (variant, size, radius, colors)
- Modal style (centered/bottom_sheet)
- Experience settings: `experience_id`, `start_mode`, `result_count`, `button_label`, `open_on_load`
- Renders `<editmuse-concierge>` custom element
- Loads `editmuse-concierge.css` and `editmuse-concierge.js`

**Schema**: Extensive settings for design tokens, buttons, UX, experience config

#### `blocks/editmuse_results.liquid`
**Purpose**: Displays product recommendations

**Key Features**:
- Same V2 Design Tokens as concierge block
- Results layout (grid/list), columns (desktop/mobile), card style
- Shows/hides reasoning and price
- Custom heading, CTA text
- Renders results container with loading/error/empty states
- Loads `editmuse-results.css` and `editmuse-results.js`

**Schema**: Design tokens + results-specific settings

### Assets

#### `assets/editmuse-concierge.js` (~2941 lines)
**Purpose**: Frontend JavaScript for concierge modal/widget

**Key Features**:
- Custom element: `<editmuse-concierge>`
- Preset system (pop, minimal, luxe brand styles)
- Quiz mode: Multi-step form with questions/answers
- Chat mode: Chat interface with message history
- Hybrid mode: Quiz then chat
- App Proxy integration: POSTs to `/apps/editmuse/session/start`
- Session management: Stores `sessionId` in sessionStorage
- Redirects to results page after submission
- Theme Editor support: Re-initializes on section load

**Important Functions**:
- `readBlockConfig(rootEl)`: Reads design tokens from data attributes
- `applyPreset(config, preset)`: Applies brand style preset
- `submitQuiz()`: POSTs answers to App Proxy, handles redirect
- `sendChatMessage()`: Sends chat message, updates UI

#### `assets/editmuse-results.js` (~531 lines)
**Purpose**: Frontend JavaScript for results page

**Key Features**:
- Loads session results from `/apps/editmuse/session?sid=...`
- Renders product grid with images, titles, prices
- Shows reasoning in collapsible details element
- Handles loading/error/empty states
- Detects fallback mode vs AI mode for reasoning display
- Theme Editor support

**Important Functions**:
- `getSessionId()`: Extracts from URL params or sessionStorage
- `loadResults()`: Fetches results from App Proxy
- `renderProducts(products)`: Renders product cards
- `showReasoning(reasoning, mode, error, productCount)`: Displays reasoning with AI/fallback detection

#### CSS Files
- `assets/editmuse-concierge.css`: Styles for modal, quiz, chat UI
- `assets/editmuse-results.css`: Styles for results grid, cards, reasoning

### Configuration

#### `shopify.extension.toml`
```
name = "editmuse-concierge"
type = "theme"
uid = "e8233274-198f-7aa9-37cf-50fdc4d939a4782b49aa"
```

---

## 4. Shopify App Configuration (Mandatory)

### `shopify.app.toml`
```toml
client_id = "7b6c9f6df8b736639e9f5ff3db8ce680"
name = "EditMuse"
application_url = "https://editmuse-production.up.railway.app"
embedded = true

[app_proxy]
url = "https://editmuse-production.up.railway.app/apps/editmuse"
subpath = "editmuse"
prefix = "apps"

[webhooks]
api_version = "2026-01"
[[webhooks.subscriptions]]
topics = ["app/scopes_update"]
uri = "/webhooks/app/scopes_update"
[[webhooks.subscriptions]]
topics = ["app/uninstalled"]
uri = "/webhooks/app/uninstalled"

[access_scopes]
scopes = "write_products"
```

### `package.json`
- Framework: React Router v7 (Remix-based)
- Key dependencies: `@shopify/shopify-app-react-router`, `@prisma/client`, `react`, `react-router`
- Scripts: `dev`, `build`, `deploy`, `migrate:deploy`, `start:prod`
- Prebuild script: `guard:blocks` (ensures exactly 2 blocks exist)

### `vite.config.ts`
- React Router plugin, TypeScript paths
- Server config: host `127.0.0.1`, origin from `SHOPIFY_APP_URL`
- HMR configuration for localhost and Cloudflare tunnels

---

## 5. Billing + Webhooks (Already Implemented)

### Billing Module

#### `app/models/billing.server.ts`
**Functions**:
- `getOrCreateSubscription(shopId)`: Creates TRIAL subscription if none exists
- `getCurrentPlan(shopId)`: Returns current plan info (checks trial expiration)
- `isInTrial(shopId)`: Checks if shop is in trial period
- `isResultCountAllowed(shopId, resultCount)`: Validates resultCount against plan limits
- `getMaxResultCount(shopId)`: Returns max allowed resultCount for plan
- `computeCreditsBurned(resultCount)`: Computes credits based on result count
  - 1-8 => 1.0
  - 9-12 => 1.5
  - 13-16 => 2.0
  - >16 => round up to nearest 0.5
- `trackUsageEvent(shopId, eventType, metadata?, creditsBurned?)`: Creates UsageEvent record
- `getMonthlyUsage(shopId, year?, month?)`: Aggregates usage events for month
- `getCurrentMonthUsage(shopId)`: Convenience wrapper

**Plan Limits**:
```typescript
PLAN_LIMITS = {
  TRIAL: { resultCount: 8, aiRankingEnabled: true },
  BASIC: { resultCount: 8, aiRankingEnabled: true },
  STARTER: { resultCount: 12, aiRankingEnabled: true },
  PRO: { resultCount: 16, aiRankingEnabled: true },
}
```

**Trial**: 14 days

#### `app/models/shopify-billing.server.ts`
**Functions**:
- `createRecurringCharge(shopDomain, planTier, returnUrl)`: Creates Shopify recurring charge via REST API
- `getActiveCharge(shopDomain)`: Gets active charge for shop
- `updateSubscriptionFromCharge(shopId, shopifyChargeId, shopifySubscriptionId, planTier)`: Updates subscription after charge activation

#### `app/routes/app.billing.tsx`
**Purpose**: Admin UI for billing/plans

**Features**:
- Shows current plan, trial status, usage stats
- Displays upgrade options
- Handles upgrade form submission (creates recurring charge, redirects to Shopify confirmation)

### Webhook Handlers

#### `app/routes/webhooks.billing.subscription_created.tsx`
- Handles `billing/subscription_created` webhook
- Extracts plan tier from charge name/amount
- Updates subscription via `updateSubscriptionFromCharge`

#### `app/routes/webhooks.billing.subscription_updated.tsx`
- Handles `billing/subscription_updated` webhook
- Updates subscription status and plan tier

#### `app/routes/webhooks.app.uninstalled.tsx`
- Handles `app/uninstalled` webhook
- Cleans up shop data (if needed)

#### `app/routes/webhooks.app.scopes_update.tsx`
- Handles `app/scopes_update` webhook
- Updates app scopes (if needed)

---

## 6. Optional: Prompt + Schema Files

### AI Prompt Schema (in `app/models/ai-ranking.server.ts`)

**System Prompt**:
```
You are a product recommendation assistant for an e-commerce store. Your task is to rank products based on how well they match the shopper's intent.

CRITICAL RULES:
- Return ONLY valid JSON matching the schema
- You MUST use the EXACT handle values from the candidate list (case-sensitive, no modifications)
- Copy handles EXACTLY as shown in the "Handle: ..." field
- Rank products by relevance to user intent (most relevant first)
- Consider: product type, tags, description, price, availability
- Return exactly ${resultCount} products (or fewer if fewer candidates)
- Do NOT include products that don't match the intent
- Do NOT include PII or personal information in reasoning
- Do NOT modify, truncate, or change the handle values in any way

Output schema (MUST be valid JSON):
{
  "ranked_handles": ["exact-handle-1", "exact-handle-2", ...],
  "reasoning": "Brief explanation of why these products were selected"
}
```

**User Prompt Template**:
```
Shopper Intent:
${userIntent || "No specific intent provided"}

Candidate Products (${candidates.length} total):
${productList}

IMPORTANT: Copy the handle values EXACTLY as shown above (e.g., if you see "Handle: my-product-handle", use "my-product-handle" exactly).

Rank the top ${resultCount} products that best match the shopper's intent. Return ONLY the JSON object with ranked_handles array (using exact handles) and reasoning string.
```

**Product List Format** (per candidate):
```
1. Handle: ${handle}
   Title: ${title}
   Tags: ${tags.join(", ") || "none"}
   Type: ${productType || "unknown"}
   Vendor: ${vendor || "unknown"}
   Price: ${price || "unknown"}
   Description: ${description.substring(0, 200)}${description.length > 200 ? "..." : ""}
   Available: ${available ? "yes" : "no"}
```

### Constants

**Result Counts**: 8, 12, 16 (enforced in validation)

**Candidate Cap**: 200 products max (for AI ranking speed)

**Charge Prevention**: 5-minute cooldown between charges for same session

**Credits Calculation**:
- 1-8 results => 1.0 credit
- 9-12 results => 1.5 credits
- 13-16 results => 2.0 credits
- >16 results => round up to nearest 0.5

---

## Key Data Flow

1. **User Interaction** (Theme Extension):
   - User clicks "Ask EditMuse" button → Opens modal
   - User completes quiz or chat → Answers submitted via POST to `/apps/editmuse/session/start`

2. **Session Creation** (`session.start.tsx`):
   - Validates HMAC signature
   - Creates/upserts Shop
   - Resolves Experience (provided or default)
   - Creates ConciergeSession with publicToken
   - Tracks SESSION_STARTED event

3. **Product Fetching & Filtering**:
   - Fetches products from Shopify Admin API (REST or GraphQL)
   - Filters: status (exclude ARCHIVED/DRAFT), excludedTags, inStockOnly, price range
   - Deduplicates by handle
   - Builds candidates array (max 200)

4. **AI Ranking** (`ai-ranking.server.ts`):
   - Builds userIntent from answers
   - Calls OpenAI API with product list and intent
   - Validates response, extracts ranked handles
   - Checks charge prevention (5-minute cooldown)
   - Tracks AI_RANKING_EXECUTED event with creditsBurned
   - Returns ranked handles + reasoning

5. **Result Saving**:
   - Ensures final handles list has exactly `min(resultCount, candidates.length)` handles
   - Tops up with fallback handles if AI returned fewer
   - Saves ConciergeResult with handles and reasoning
   - Marks session as COMPLETE

6. **Results Display** (`session.tsx` GET):
   - Loads session by sid token
   - If ConciergeResult exists: Uses saved handles (no AI call)
   - If not: Performs AI ranking (with same filtering)
   - Maps handles to product objects
   - Returns JSON with products array

7. **Frontend Rendering** (`editmuse-results.js`):
   - Fetches results from `/apps/editmuse/session?sid=...`
   - Renders product grid
   - Shows reasoning (AI vs fallback detection)

---

## Environment Variables (Required)

- `SHOPIFY_API_SECRET`: For App Proxy HMAC validation
- `OPENAI_API_KEY`: For AI ranking (optional - feature can be disabled)
- `OPENAI_MODEL`: Model to use (default: "gpt-4o-mini")
- `FEATURE_AI_RANKING`: Feature flag ("false" to disable)
- `SHOPIFY_APP_URL`: App URL for redirects/billing
- Database URL: Configured in Prisma schema (SQLite for dev)

---

## Important Notes

1. **Block Count Enforcement**: Exactly 2 blocks must exist (`editmuse_concierge.liquid`, `editmuse_results.liquid`). Guard script enforces this.

2. **Charge Prevention**: 5-minute cooldown prevents duplicate charges for same session. Uses `chargedAt` field on ConciergeSession.

3. **Saved Results Priority**: If ConciergeResult exists, always use saved handles. Never call AI again for same session.

4. **Product Status Filtering**: ARCHIVED and DRAFT products are excluded at fetch time (before AI ranking).

5. **Price Parsing**: Supports multiple formats: "under-50", "50-100", "500-plus", "$50 - $100", etc.

6. **Fallback Ranking**: Simple sort by available first, then handle (alphabetical).

7. **Credits Tracking**: Credits are computed based on result count and stored in UsageEvent.creditsBurned.

8. **Trial Period**: 14 days, managed via Shop.trialStartedAt and Shop.trialEndsAt.

---

## File Structure Summary

```
app/
├── routes/
│   ├── apps.editmuse.session.start.tsx    # POST: Create session, AI ranking
│   ├── apps.editmuse.session.tsx           # GET: Load results (saved or AI)
│   ├── apps.editmuse.session.results.tsx  # Legacy results endpoint
│   ├── app.billing.tsx                     # Billing admin UI
│   └── webhooks.*.tsx                      # Webhook handlers
├── models/
│   ├── ai-ranking.server.ts                # OpenAI integration
│   ├── billing.server.ts                   # Plan/usage tracking
│   ├── concierge.server.ts                 # Session management
│   └── shopify-billing.server.ts           # Shopify billing API
├── shopify-admin.server.ts                 # Product fetching (REST/GraphQL)
├── app-proxy.server.ts                    # HMAC validation
└── db.server.ts                            # Prisma client

prisma/
├── schema.prisma                           # Database schema
└── migrations/                             # Migration history

extensions/editmuse-concierge/
├── blocks/
│   ├── editmuse_concierge.liquid           # Main widget block
│   └── editmuse_results.liquid             # Results block
├── assets/
│   ├── editmuse-concierge.js               # Frontend concierge logic
│   ├── editmuse-concierge.css              # Concierge styles
│   ├── editmuse-results.js                 # Frontend results logic
│   └── editmuse-results.css                # Results styles
└── shopify.extension.toml                  # Extension config

shopify.app.toml                            # App configuration
package.json                                # Dependencies
vite.config.ts                              # Build config
```

---

## Next Steps for ChatGPT

When implementing new features or debugging:

1. **Check App Proxy routes first** (`session.start.tsx`, `session.tsx`) - these are the main entry points
2. **Review AI ranking logic** (`ai-ranking.server.ts`) - handles OpenAI calls and charge prevention
3. **Check database schema** (`schema.prisma`) - understand data models
4. **Review Theme Extension** (`editmuse-concierge.js`, `editmuse-results.js`) - frontend behavior
5. **Check billing logic** (`billing.server.ts`) - plan limits and usage tracking

For billing/credits questions, see `billing.server.ts` and `UsageEvent` model.
For product fetching questions, see `shopify-admin.server.ts`.
For session management, see `concierge.server.ts`.

