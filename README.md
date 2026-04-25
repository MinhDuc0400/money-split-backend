# SplitMoney Backend API

Backend API for the SplitMoney expense splitting application built with NestJS, PostgreSQL, and Prisma.

## Tech Stack

- **Framework**: NestJS (TypeScript)
- **Database**: PostgreSQL
- **ORM**: Prisma
- **Authentication**: JWT + Passport
- **Validation**: class-validator
- **Password Hashing**: bcrypt

## Prerequisites

- Node.js 20.19+ or 22.12+
- PostgreSQL database (local or cloud)
- npm or yarn

## Getting Started

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment Variables

Create a `.env` file in the backend directory (you can copy `.env.example` if it exists, or use the values below):

```env
# Database
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/splitmoney?schema=public"

# JWT Authentication
JWT_SECRET="your-super-secret-jwt-key-change-this-in-production"
JWT_EXPIRES_IN="7d"

# Google OAuth
GOOGLE_CLIENT_ID="your-google-client-id"
GOOGLE_CLIENT_SECRET="your-google-client-secret"
GOOGLE_CALLBACK_URL="http://localhost:3000/auth/google/callback"

# Application
PORT=3000
NODE_ENV="development"
FRONTEND_URL="http://localhost:5173"
```

### 3. Set Up Database and Server

Ensure you have a PostgreSQL database running locally, then:

1. Run database migrations:
   ```bash
   npx prisma generate
   npx prisma migrate dev --name init
   ```

2. Start the application:
   ```bash
   npm run start:dev
   ```

#### (Optional) View Data

You can use Prisma Studio to view and edit your data in a browser:

```bash
npx prisma studio
```

### 4. Run the Application

```bash
# Development mode
npm run start:dev

# Production mode
npm run build
npm run start:prod
```

The API will be available at `http://localhost:3000`

## Database Schema

### Users
- User authentication and profile information
- Fields: id, email, passwordHash (optional), googleId (optional), name, avatarUrl, createdAt, updatedAt

### Groups
- Expense groups (e.g., "Trip 2024", "Roommates")
- Fields: id, name, inviteCode (8-char unique code), currency, createdBy, createdAt, updatedAt

### GroupMembers
- Junction table linking users to groups
- Supports non-registered members
- Fields: id, groupId, userId (nullable), name, avatarUrl, role, joinedAt

### Expenses
- Individual expense records
- Fields: id, groupId, description, amount, payerId, splitType, date, createdAt, updatedAt

### ExpenseSplits
- Breakdown of who owes what for each expense
- Fields: id, expenseId, memberId, amount, paid

### Updating the Schema (Without losing data)

If you modify `prisma/schema.prisma`, **do not** use `migrate reset` unless you want to delete everything. Instead, run:

```bash
# This creates a new migration file and applies it to your existing database
npx prisma migrate dev --name descriptive_change_name
```

## API Endpoints

### Authentication

#### Register
```http
POST /auth/register
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "password123",
  "name": "John Doe"
}
```

Response:
```json
{
  "user": {
    "id": "uuid",
    "email": "user@example.com",
    "name": "John Doe",
    "avatarUrl": "https://..."
  },
  "token": "jwt-token"
}
```

#### Login
```http
POST /auth/login
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "password123"
}
```

Response: Same as register

#### Google Login
1. Navigate to `http://localhost:3000/auth/google` in your browser.
2. After successful login, Google will redirect to `/auth/google/callback`.
3. The callback will return the user object and JWT token.

```http
GET /auth/google
```

```http
GET /auth/google/callback
```

### Protected Routes

All routes below require authentication. Include the JWT token in the Authorization header:

```http
Authorization: Bearer <your-jwt-token>
```

### Groups

- `POST /groups` - Create a new group (returns `inviteCode`)
- `POST /groups/join` - Join a group by `inviteCode`
- `GET /groups` - List user's groups
- `GET /groups/:id` - Get group details (includes members)
- `PATCH /groups/:id` - Update group name/currency
- `DELETE /groups/:id` - Soft delete group (Owner only)

### Members (To Be Implemented)

- `POST /groups/:groupId/members` - Add member to group
- `GET /groups/:groupId/members` - List group members
- `PATCH /groups/:groupId/members/:id` - Update member
- `DELETE /groups/:groupId/members/:id` - Remove member

### Expenses (To Be Implemented)

- `POST /groups/:groupId/expenses` - Create expense
- `GET /groups/:groupId/expenses` - List expenses
- `GET /groups/:groupId/expenses/:id` - Get expense details
- `PATCH /groups/:groupId/expenses/:id` - Update expense
- `DELETE /groups/:groupId/expenses/:id` - Delete expense

### Settlements (To Be Implemented)

- `GET /groups/:groupId/settlements` - Get optimized settlement transactions

## Development

### Prisma Commands

```bash
# Generate Prisma Client after schema changes
npx prisma generate

# Create a new migration
npx prisma migrate dev --name migration_name

# Apply migrations in production
npx prisma migrate deploy

# Reset database (WARNING: deletes all data)
npx prisma migrate reset

# Open Prisma Studio
npx prisma studio
```

### Testing

```bash
# Unit tests
npm run test

# E2E tests
npm run test:e2e

# Test coverage
npm run test:cov
```

## Deployment

### Railway / Render / Fly.io

1. Create a new project and connect your repository
2. Add a PostgreSQL database addon
3. Set environment variables:
   - `DATABASE_URL` (from database addon)
   - `JWT_SECRET` (generate a secure random string)
   - `JWT_EXPIRES_IN` (e.g., "7d")
   - `NODE_ENV` ("production")
   - `FRONTEND_URL` (your frontend URL)

4. Build command: `npm run build`
5. Start command: `npm run start:prod`

### Database Migration on Deploy

Add this to your build script or run manually after deployment:

```bash
npx prisma migrate deploy
```

## Project Structure

```
backend/
├── prisma/
│   └── schema.prisma          # Database schema
├── src/
│   ├── auth/                  # Authentication module
│   │   ├── dto/              # Data transfer objects
│   │   ├── guards/           # Auth guards
│   │   ├── strategies/       # Passport strategies
│   │   ├── auth.controller.ts
│   │   ├── auth.service.ts
│   │   └── auth.module.ts
│   ├── prisma/               # Prisma service
│   │   ├── prisma.service.ts
│   │   └── prisma.module.ts
│   ├── app.module.ts         # Root module
│   └── main.ts               # Application entry point
├── .env                      # Environment variables
├── package.json
└── tsconfig.json
```

## Next Steps

1. Implement Members module with CRUD operations
2. Implement Expenses module with CRUD operations
3. Implement Settlements calculation endpoint
4. Add comprehensive error handling
5. Write unit and integration tests
6. Set up CI/CD pipeline
7. Deploy to production

## License

MIT
