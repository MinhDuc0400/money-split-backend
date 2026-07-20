# Split Money — Backend API

REST + WebSocket API for the Split Money expense splitting application. Built with NestJS and PostgreSQL; deployed to Railway with automatic migrations on startup.

**Live:** `https://splitmoney-production.up.railway.app` (set your Railway URL here)  
**API Docs:** `/docs` (Swagger UI, available in all environments)

---

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | NestJS 11 (TypeScript) |
| Database | PostgreSQL via Prisma 7 |
| Real-time | Socket.IO 4 |
| Auth | JWT + Passport + Google OAuth 2.0 |
| Validation | class-validator / class-transformer |
| Password hashing | bcrypt |
| API docs | Swagger / OpenAPI |

---

## Features

- **Expense CRUD** — create, update, delete expenses with per-member split tracking
- **Debt simplification algorithm** — computes the minimum set of payments needed to settle a group, regardless of how many expenses exist
- **Real-time events** — emits Socket.IO events (`expense_created`, `expense_updated`, `expense_deleted`, `settlement_updated`, `member_joined`, `group_updated`) to all room members on every mutation
- **Multi-currency balances** — per-currency net balance computed for each member
- **Guest member settlement** — registered users can mark a non-registered member's cash debt as received
- **Cursor-based pagination** — transaction history uses stable base64 cursors (`{ date, id }`) for consistent infinite scroll

---

## Debt Simplification Algorithm

The settlement endpoint (`GET /groups/:id/settlements`) runs a graph-reduction algorithm:

1. Compute each member's net balance (positive = owed money, negative = owes money) across all expenses and prior settlements.
2. Separate members into creditors and debtors.
3. Greedily match the largest debtor against the largest creditor, recording a payment, until all balances reach zero.

This guarantees the minimum number of transactions needed to settle the group.

---

## Getting Started

### Prerequisites

- Node.js 20+
- PostgreSQL database

### Install

```bash
npm install
```

### Environment Variables

Create a `.env` file:

```env
# Database
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/splitmoney?schema=public"

# JWT
JWT_SECRET="your-secret-key"
JWT_EXPIRES_IN="7d"

# Google OAuth
GOOGLE_CLIENT_ID="your-google-client-id"
GOOGLE_CLIENT_SECRET="your-google-client-secret"
GOOGLE_CALLBACK_URL="http://localhost:3000/auth/google/callback"

# App
PORT=3000
NODE_ENV="development"
FRONTEND_URL="http://localhost:5173"
```

### Run

```bash
# Apply migrations and start
npx prisma migrate dev
npm run start:dev

# Production build
npm run build
npm run start:prod
```

Swagger UI is available at `http://localhost:3000/docs`.

---

## API Reference

All protected routes require `Authorization: Bearer <token>`.

### Auth

| Method | Path | Description |
|---|---|---|
| `POST` | `/auth/register` | Register with email + password |
| `POST` | `/auth/login` | Login, returns JWT |
| `GET` | `/auth/google` | Initiate Google OAuth flow |
| `GET` | `/auth/google/callback` | Google OAuth callback |
| `GET` | `/auth/apple` | Initiate Apple Sign In flow |
| `POST` | `/auth/apple/callback` | Apple Sign In callback (form_post) |

### Groups

| Method | Path | Description |
|---|---|---|
| `POST` | `/groups` | Create a group |
| `POST` | `/groups/join` | Join by invite code |
| `GET` | `/groups` | List your groups |
| `GET` | `/groups/:id` | Group detail (members, balances) |
| `PATCH` | `/groups/:id` | Update name / currency |
| `DELETE` | `/groups/:id` | Delete group (owner only) |
| `DELETE` | `/groups/:id/leave` | Leave group (with balance check) |
| `POST` | `/groups/:id/guests` | Add a guest member |

### Expenses

| Method | Path | Description |
|---|---|---|
| `POST` | `/groups/:id/expenses` | Create expense |
| `PATCH` | `/groups/:id/expenses/:expenseId` | Update expense |
| `DELETE` | `/groups/:id/expenses/:expenseId` | Delete expense |
| `GET` | `/groups/:id/transactions` | Paginated history (`?cursor=&limit=20`) |
| `GET` | `/groups/:id/balances` | All member balances |
| `GET` | `/groups/:id/balances/me` | Your balance in the group |
| `GET` | `/groups/:id/settlements` | Suggested settlement payments |

### Settlements

| Method | Path | Description |
|---|---|---|
| `POST` | `/groups/:id/settle-up` | Record a manual settlement |
| `POST` | `/groups/:id/settlements` | Partial settlement between two members |
| `POST` | `/groups/:id/settlements/settle-all` | Settle all debts in one action |
| `POST` | `/groups/:id/settle-guest` | Mark guest's cash as received |

---

## Database Schema

```
User            — id, email, passwordHash?, googleId?, name, avatarUrl
Group           — id, name, inviteCode (8-char), currency, createdBy
GroupMember     — id, groupId, userId?, name, avatarUrl, role
Expense         — id, groupId, description, amount, payerId, splitType, date
ExpenseSplit    — id, expenseId, memberId, amount, paid
Settlement      — id, groupId, payerId, payeeId, amount, currency, date
```

---

## Deployment (Railway)

The app writes `prisma.config.mjs` at startup from `DATABASE_URL` and runs `prisma migrate deploy` before `bootstrap()`. This works around the Railway/nixpacks constraint where source files are excluded from the runtime image.

**Railway environment variables to set:**

```
DATABASE_URL       (from Railway Postgres add-on — use internal URL)
JWT_SECRET
JWT_EXPIRES_IN     7d
NODE_ENV           production
FRONTEND_URL       https://your-vercel-app.vercel.app
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
GOOGLE_CALLBACK_URL    https://your-railway-backend.up.railway.app/auth/google/callback
APPLE_CLIENT_ID        Your Apple Service ID (e.g. com.yourcompany.splitmoney)
APPLE_TEAM_ID          Your Apple Developer Team ID
APPLE_KEY_ID           Your Apple Key ID (from the .p8 file)
APPLE_PRIVATE_KEY      Contents of your .p8 file (with \n for newlines)
APPLE_CALLBACK_URL     https://your-railway-backend.up.railway.app/auth/apple/callback
```

**Start command (Railway dashboard):** `node dist/main`

---

## Project Structure

```
src/
├── auth/           # JWT strategy, Google OAuth, guards
├── balances/       # Per-member balance computation
├── events/         # Socket.IO gateway + RedisIoAdapter
├── exchange-rates/ # Currency conversion
├── expenses/       # Expense CRUD + transaction history
├── groups/         # Group + guest member management
├── helpers/        # Shared utilities
├── prisma/         # PrismaService module
├── settlements/    # Debt simplification algorithm + settlement recording
└── main.ts         # App bootstrap + runtime migration
```

---

## Author

**Duc Nguyen Minh** — Frontend Developer  
[linkedin.com/in/ducnguyenminh0400](https://www.linkedin.com/in/ducnguyenminh0400/) · ducnm.job@gmail.com
