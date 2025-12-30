# Development Troubleshooting

## Environment Variables

### Correct `.env` Format

Your `.env` file should follow this format. **Do NOT include quotes around values:**

```env
SHOPIFY_API_KEY=your_api_key_here
SHOPIFY_API_SECRET=your_secret_here
SCOPES=write_products
SHOPIFY_APP_URL=https://your-cloudflare-url.trycloudflare.com
PORT=3000
HOST=0.0.0.0
```

### Common Mistakes

❌ **WRONG:**
```env
SHOPIFY_APP_URL="https://something.trycloudflare.com"  # Quotes not needed
HOST="https://something.trycloudflare.com"  # HOST should be hostname only
HOSTNAME="https://something.trycloudflare.com"  # HOSTNAME should be hostname only
```

✅ **CORRECT:**
```env
SHOPIFY_APP_URL=https://something.trycloudflare.com  # Full URL with protocol
HOST=0.0.0.0  # Hostname/IP only (for server binding)
PORT=3000
```

### Environment Variable Roles

- **`SHOPIFY_APP_URL`**: Must be a full URL with protocol (e.g., `https://...`). Used for OAuth redirects and app configuration.
- **`HOST`**: Should be a hostname or IP address only (e.g., `0.0.0.0`, `127.0.0.1`, `localhost`). Used for server binding.
- **`PORT`**: Port number only (e.g., `3000`).

### DNS Resolution Error (ENOTFOUND)

If you see an error like:
```
getaddrinfo ENOTFOUND https://something.trycloudflare.com
```

This means a full URL is being passed to DNS lookup instead of a hostname. Check:

1. Your `.env` file - ensure `HOST` and `HOSTNAME` do NOT contain `https://`
2. The app validates `SHOPIFY_APP_URL` on startup and will show clear errors if invalid
3. Run `npm run build` to catch configuration errors early

### Startup Validation

On server boot, the app logs:
- `SHOPIFY_APP_URL` (as provided)
- Parsed origin (full URL)
- Parsed hostname (extracted from URL)

If `SHOPIFY_APP_URL` is missing or invalid, the server will throw a clear error with instructions.

## Running the App

### First Time Setup

```cmd
npm ci
npx prisma generate
```

### Development

```cmd
shopify app dev --reset
```

The `--reset` flag ensures environment variables are properly loaded.

### Production Build

```cmd
npm run build
npm run start:prod
```

## Database

### Local Development

The app uses SQLite for local development. Database files are automatically ignored by git:
- `prisma/dev.sqlite`
- `prisma/*.db`
- `*.sqlite`

### Migrations

```cmd
npx prisma migrate dev
```

For production:
```cmd
npm run migrate:deploy
```

## App Proxy Testing

After running `shopify app dev --reset`, test the App Proxy endpoint:

```
https://{your-store-domain}/apps/editmuse/ping
```

This should return: `{"ok":true,"route":"ping"}`

