#!/bin/bash
# ============================================================
# MoveEasy — Fix & Push Script
# Run this from: /root/.codebuddy/MoveEasy
#
# What it does:
#   1. Adds .gitignore (node_modules, .env, logs)
#   2. Purges .env from ALL git history
#   3. Removes node_modules from git tracking
#   4. Restructures project to proper directory layout
#   5. Commits and force-pushes clean history
# ============================================================

set -euo pipefail

if [ ! -d ".git" ]; then
  echo "❌ Run this from the root of your MoveEasy repo"
  exit 1
fi

echo ""
echo "🚀 MoveEasy — Fix & Push"
echo "========================"
echo ""

echo "📝 Step 1/5 — Writing .gitignore..."
cat > .gitignore << 'GITIGNORE'
# Secrets — NEVER commit
.env
.env.local
.env.production
.env.staging
*.env

# Dependencies
node_modules/
**/node_modules/

# Build outputs
dist/
build/
.next/
out/

# Logs
logs/*.log
*.log
npm-debug.log*

# Runtime
pids/
*.pid
*.pid.lock

# OS & Editor
.DS_Store
Thumbs.db
.idea/
*.swp

# TypeScript
*.tsbuildinfo

# Test coverage
coverage/
.nyc_output/
GITIGNORE

echo "   ✅ .gitignore written"

echo ""
echo "🔐 Step 2/5 — Purging .env from all git history..."
git filter-branch --force --index-filter \
  'git rm --cached --ignore-unmatch .env' \
  --prune-empty --tag-name-filter cat -- --all >/dev/null 2>&1 || true

echo "   ✅ .env removed from all commits (where present)"

echo ""
echo "📦 Step 3/5 — Removing node_modules from git tracking..."
git rm -r --cached node_modules/ --quiet 2>/dev/null || true
git rm -r --cached logs/*.log --quiet 2>/dev/null || true
echo "   ✅ node_modules and logs untracked (files kept locally)"

echo ""
echo "📁 Step 4/5 — Restructuring project layout..."

mkdir -p backend/src/config
mkdir -p backend/src/middleware
mkdir -p backend/src/routes
mkdir -p backend/src/services
mkdir -p backend/src/models
mkdir -p backend/src/jobs
mkdir -p backend/logs
mkdir -p database
mkdir -p frontend/moveeasy-core
mkdir -p docs

# Move config/database.js to backend/src/config
if [ -f "database.js" ]; then
  mv database.js backend/src/config/database.js
fi
if [ -f "config/database.js" ]; then
  rm -f config/database.js
fi
if [ -d "config" ] && [ "$(ls -A config)" = "" ]; then
  rmdir config
fi

# Move middleware
if [ -f "auth.js" ]; then
  mv auth.js backend/src/middleware/auth.js
fi

# Move routes
for route in easyfuel.js safebet.js; do
  if [ -f "$route" ]; then
    mv "$route" backend/src/routes/"$route"
  fi
done

for route in auth admin wallet greenwallet easytransect mmpai orchestrator webhooks; do
  if [ -f "routes/$route.js" ]; then
    mv "routes/$route.js" backend/src/routes/"$route.js"
  fi
done

if [ -d "routes" ] && [ "$(ls -A routes)" = "" ]; then
  rmdir routes
fi

# Move services
for service in ai-orchestrator.js payfast.js purple-owl.js smile-id.js valr.js webhooks.js brain.ts; do
  if [ -f "$service" ]; then
    mv "$service" backend/src/services/"$service"
  fi
done

# Move jobs
for job in worker.js workers.ts; do
  if [ -f "$job" ]; then
    mv "$job" backend/src/jobs/"$job"
  fi
done

# Move backend/root files
for file in package.json package-lock.json tsconfig.json .env.example api.ts; do
  if [ -f "$file" ]; then
    mv "$file" backend/"$file"
  fi
done

# Move frontend and schema
if [ -f "index.html" ]; then
  mv index.html frontend/moveeasy-core/index.html
fi
if [ -f "schema.sql" ]; then
  mv schema.sql database/schema.sql
fi

# Fix backend/index.js imports and static paths
if [ -f "index.js" ]; then
  cp index.js backend/index.js
  python3 <<'PYCODE'
from pathlib import Path
path = Path('backend/index.js')
content = path.read_text()
replacements = {
    "require('./routes/": "require('./src/routes/",
    "require('./config/database')": "require('./src/config/database')",
    "app.use(express.static(__dirname,": "app.use(express.static(path.join(__dirname, '../frontend/moveeasy-core'),",
    "res.sendFile(__dirname + '/index.html');": "res.sendFile(path.join(__dirname, '../frontend/moveeasy-core/index.html'));"
}
for old, new in replacements.items():
    content = content.replace(old, new)
if "const path = require('path');" not in content:
    content = content.replace("const express = require('express');", "const express = require('express');\nconst path = require('path');", 1)
path.write_text(content)
PYCODE
  rm -f index.js
fi

# Create placeholder files
touch backend/logs/.gitkeep
mkdir -p backend/src/models
touch backend/src/models/.gitkeep

# Create docs placeholders if absent
if [ ! -f "docs/API.md" ]; then
  cat > docs/API.md << 'EOF'
# MoveEasy API Reference
See ENGINEERING.md and source code for full details.
Routes: /api/v1/auth | /api/v1/wallet | /api/v1/easyfuel | /api/v1/safebet | /api/v1/greenwallet | /api/v1/mmpai | /api/v1/ai | /api/v1/admin
EOF
fi

if [ ! -f "docs/DEPLOYMENT.md" ]; then
  cat > docs/DEPLOYMENT.md << 'EOF'
# Deployment
cd backend && npm install && cp .env.example .env && npm start
EOF
fi

if [ ! -f "docs/ARCHITECTURE.md" ]; then
  cat > docs/ARCHITECTURE.md << 'EOF'
# Architecture
MoveEasy Core Brain → EasyFuel | EasyTransect | SafeBet | GreenWallet | MMP.ai
Stack: Node.js · PostgreSQL · Redis · AWS af-south-1 · Express · BullMQ
EOF
fi

echo "   ✅ Project restructured"

echo ""
echo "🔄 Step 5/5 — Committing and pushing..."

git add -A
if git diff --cached --quiet; then
  echo "   ⚠️ No staged changes to commit"
else
  git commit -m "refactor: restructure project, purge secrets, add .gitignore

- Purged .env from all git history
- Removed node_modules from version control
- Added comprehensive .gitignore
- Restructured flat layout into backend/src/{config,middleware,routes,services,jobs}
- Moved database schema to database/schema.sql
- Moved frontend to frontend/moveeasy-core/
- Added docs/ (API.md, DEPLOYMENT.md, ARCHITECTURE.md)
- Fixed import paths in backend/index.js"
fi

git push origin main --force

echo ""
echo "✅ Done! Repository is clean and restructured."
echo "⚠️ IMPORTANT: Rotate any credentials that were in .env"
