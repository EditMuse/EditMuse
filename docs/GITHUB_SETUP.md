# GitHub Repository Setup Guide

Complete guide on what files and folders to upload to GitHub for EditMuse.

---

## ✅ Files & Folders TO Upload (Include)

### Core Application Files
```
✅ app/                          # All application code
✅ extensions/                  # Theme app extension (blocks, assets)
✅ prisma/                      # Database schema and migrations
   ✅ schema.prisma
   ✅ migrations/              # All migration files
✅ scripts/                     # Build scripts (guard-blocks.cjs, etc.)
✅ docs/                        # Documentation files
```

### Configuration Files
```
✅ package.json                 # Dependencies and scripts
✅ package-lock.json            # Lock file (or yarn.lock/pnpm-lock.yaml)
✅ shopify.app.toml            # Shopify app configuration
✅ shopify.web.toml             # (if exists)
✅ vite.config.ts               # Build configuration
✅ tsconfig.json                # TypeScript configuration
✅ .gitignore                   # Git ignore rules
✅ README.md                    # Project documentation
✅ .cursorrules                 # (optional) Cursor AI rules
```

### Documentation
```
✅ docs/                        # All documentation
   ✅ POSTGRES_SETUP.md
   ✅ PRODUCTION_REQUIREMENTS.md
   ✅ COST_BREAKDOWN.md
   ✅ PROFIT_ANALYSIS.md
   ✅ CUSTOMER_ACQUISITION.md
   ✅ PROFIT_LOSS.md
   ✅ COMPETITIVE_ANALYSIS.md
   ✅ IMPROVEMENT_STRATEGY.md
   ✅ POP_THEME_BRANDING.md
   ✅ GITHUB_SETUP.md (this file)
```

### Other Important Files
```
✅ .github/                     # GitHub workflows (if any)
✅ CHATGPT_CODEBASE_SUMMARY.md  # (optional) Codebase summary
✅ CHATGPT_FILE_LIST.md         # (optional) File list
✅ DEPLOYMENT_GUIDE.md          # (if exists)
```

---

## ❌ Files & Folders NOT TO Upload (Exclude)

### Environment & Secrets
```
❌ .env                         # NEVER commit - contains secrets
❌ .env.local                   # Local environment variables
❌ .env.production              # Production secrets
❌ .env.*                       # Any .env files
```

### Dependencies
```
❌ node_modules/                # Installed packages (reinstall with npm install)
❌ .pnp/                        # Yarn PnP (if using Yarn)
❌ .pnp.js                      # Yarn PnP (if using Yarn)
```

### Build Output
```
❌ build/                       # Compiled output (regenerated on build)
❌ dist/                        # Distribution files
❌ .next/                       # Next.js build (if applicable)
❌ .vite/                       # Vite cache
```

### Database Files
```
❌ *.sqlite                     # SQLite database files
❌ *.sqlite3                    # SQLite database files
❌ *.db                         # Database files
❌ prisma/dev.sqlite            # Development database
❌ prisma/*.sqlite              # Any SQLite files
```

### IDE & Editor Files
```
❌ .vscode/                     # VS Code settings (optional - can include if team uses)
❌ .idea/                       # IntelliJ/WebStorm settings
❌ *.swp                        # Vim swap files
❌ *.swo                        # Vim swap files
❌ *~                           # Backup files
❌ .DS_Store                     # macOS system file
❌ Thumbs.db                    # Windows system file
```

### Logs & Temporary Files
```
❌ *.log                        # Log files
❌ logs/                        # Log directory
❌ .npm/                        # npm cache
❌ .cache/                      # Cache directories
❌ tmp/                         # Temporary files
❌ temp/                        # Temporary files
```

### Shopify CLI Files
```
❌ .shopify/                    # Shopify CLI cache/config (if exists)
```

### Testing & Coverage
```
❌ coverage/                    # Test coverage reports
❌ .nyc_output/                 # NYC coverage
❌ .coverage/                   # Coverage files
```

---

## 📋 Pre-Upload Checklist

Before uploading to GitHub, ensure:

### 1. ✅ Environment Variables Template
Create a `.env.example` file (without secrets):
```env
# Shopify App Configuration
SHOPIFY_API_KEY=your_api_key_here
SHOPIFY_API_SECRET=your_api_secret_here
SHOPIFY_APP_URL=https://your-app-url.com

# Database
DATABASE_URL=postgresql://user:password@host:port/database

# OpenAI (Optional)
OPENAI_API_KEY=your_openai_key_here
OPENAI_MODEL=gpt-4o-mini
FEATURE_AI_RANKING=true

# Node Environment
NODE_ENV=production
```

### 2. ✅ Verify .gitignore is Complete
Your `.gitignore` should include:
```
# Environment
.env
.env.local
.env.*.local

# Dependencies
node_modules/

# Database
*.sqlite
*.sqlite3
*.db
prisma/dev.sqlite

# Build
build/
dist/
.vite/

# Logs
*.log
logs/

# IDE
.vscode/
.idea/
*.swp
*.swo

# OS
.DS_Store
Thumbs.db

# Cache
.cache/
.npm/
```

### 3. ✅ Remove Sensitive Data
- ✅ No API keys in code
- ✅ No passwords in code
- ✅ No `.env` files
- ✅ No database files
- ✅ No personal tokens

### 4. ✅ Documentation is Updated
- ✅ README.md has setup instructions
- ✅ Environment variables documented
- ✅ Installation steps clear

---

## 🚀 GitHub Upload Steps

### Option 1: Using GitHub CLI
```bash
# Initialize git (if not already)
git init

# Add all files (respects .gitignore)
git add .

# Commit
git commit -m "Initial commit: EditMuse Shopify App"

# Create repository on GitHub, then:
git remote add origin https://github.com/yourusername/editmuse.git
git branch -M main
git push -u origin main
```

### Option 2: Using GitHub Desktop
1. Open GitHub Desktop
2. File → Add Local Repository
3. Select your project folder
4. Review changes (should exclude .env, node_modules, etc.)
5. Commit with message
6. Publish to GitHub

### Option 3: Manual Upload via GitHub Web
1. Create new repository on GitHub
2. Don't initialize with README
3. Upload files manually (but this is tedious for large projects)

---

## 📁 Recommended Repository Structure

```
editmuse/
├── .github/                    # GitHub workflows (optional)
│   └── workflows/              # CI/CD workflows
├── app/                        # ✅ Application code
│   ├── routes/                 # React Router routes
│   ├── models/                 # Server-side models
│   └── ...
├── extensions/                 # ✅ Theme app extension
│   └── editmuse-concierge/
│       ├── blocks/             # Liquid blocks
│       └── assets/             # JS/CSS files
├── prisma/                     # ✅ Database schema
│   ├── schema.prisma
│   └── migrations/             # Migration history
├── scripts/                    # ✅ Build scripts
├── docs/                       # ✅ Documentation
├── .gitignore                  # ✅ Git ignore rules
├── package.json                # ✅ Dependencies
├── package-lock.json           # ✅ Lock file
├── shopify.app.toml            # ✅ Shopify config
├── vite.config.ts              # ✅ Build config
├── tsconfig.json               # ✅ TypeScript config
├── README.md                   # ✅ Project README
└── .env.example                # ✅ Environment template (create this!)
```

---

## 🔒 Security Checklist

Before pushing to GitHub:

- [ ] ✅ No `.env` files committed
- [ ] ✅ No API keys in code
- [ ] ✅ No passwords in code
- [ ] ✅ No database files committed
- [ ] ✅ `.gitignore` is complete
- [ ] ✅ `.env.example` created (template only)
- [ ] ✅ README has setup instructions
- [ ] ✅ No personal tokens/secrets

---

## 📝 What Happens After Upload

### 1. Clone Repository
```bash
git clone https://github.com/yourusername/editmuse.git
cd editmuse
```

### 2. Install Dependencies
```bash
npm install
```

### 3. Set Up Environment
```bash
# Copy example file
cp .env.example .env

# Edit .env with your actual values
# (Never commit .env!)
```

### 4. Set Up Database
```bash
# Generate Prisma client
npx prisma generate

# Run migrations (or push schema)
npx prisma migrate dev
# OR
npx prisma db push
```

### 5. Run Development Server
```bash
shopify app dev
```

---

## 🎯 Quick Reference

### Files to ALWAYS Include ✅
- All source code (`app/`, `extensions/`)
- Configuration files (`package.json`, `shopify.app.toml`, `tsconfig.json`)
- Database schema (`prisma/schema.prisma`, `prisma/migrations/`)
- Documentation (`docs/`, `README.md`)
- Build scripts (`scripts/`)
- `.gitignore` file

### Files to NEVER Include ❌
- `.env` files (any environment files)
- `node_modules/` (dependencies)
- `*.sqlite` files (database files)
- `build/` or `dist/` (build output)
- Log files (`*.log`)
- IDE settings (`.vscode/`, `.idea/`)
- OS files (`.DS_Store`, `Thumbs.db`)

---

## 💡 Pro Tips

1. **Use `.env.example`**: Create a template file showing required environment variables (without actual values)

2. **Review Before Commit**: Always run `git status` and `git diff` before committing to ensure no secrets are included

3. **Use GitHub Secrets**: For CI/CD, use GitHub Secrets instead of hardcoding values

4. **Private Repository**: Consider making the repository private initially, especially if it contains business logic

5. **License File**: Add a `LICENSE` file if you want to specify how others can use your code

6. **Contributing Guide**: Add `CONTRIBUTING.md` if you plan to accept contributions

---

## ✅ Final Checklist

Before pushing to GitHub:

- [ ] ✅ `.gitignore` is complete and correct
- [ ] ✅ `.env.example` created (template only, no secrets)
- [ ] ✅ No `.env` files in repository
- [ ] ✅ No `node_modules/` in repository
- [ ] ✅ No database files (`*.sqlite`) in repository
- [ ] ✅ No API keys or secrets in code
- [ ] ✅ README.md has setup instructions
- [ ] ✅ All source code is included
- [ ] ✅ Documentation is included
- [ ] ✅ Configuration files are included

---

## 🚨 Common Mistakes to Avoid

1. ❌ **Committing `.env` files** - Always check `.gitignore` first
2. ❌ **Committing `node_modules/`** - Should be in `.gitignore`
3. ❌ **Committing database files** - SQLite files should never be committed
4. ❌ **Hardcoding API keys** - Use environment variables
5. ❌ **Forgetting `.env.example`** - Help others set up the project

---

## 📚 Additional Resources

- [GitHub Documentation](https://docs.github.com/)
- [Git Ignore Patterns](https://git-scm.com/docs/gitignore)
- [Shopify App Development](https://shopify.dev/docs/apps)

---

## 🎯 Summary

**Upload to GitHub:**
- ✅ All source code (`app/`, `extensions/`)
- ✅ Configuration files (`package.json`, `shopify.app.toml`, etc.)
- ✅ Database schema (`prisma/schema.prisma`, `prisma/migrations/`)
- ✅ Documentation (`docs/`, `README.md`)
- ✅ Build scripts (`scripts/`)
- ✅ `.gitignore` file
- ✅ `.env.example` (template, no secrets)

**Don't Upload:**
- ❌ `.env` files (any environment files with secrets)
- ❌ `node_modules/` (dependencies)
- ❌ `*.sqlite` files (database files)
- ❌ `build/` or `dist/` (build output)
- ❌ Log files, cache files, IDE settings

Your `.gitignore` file should handle most of this automatically!

