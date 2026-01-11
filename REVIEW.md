### Project Review: SplitMoney Backend

This document provides a comprehensive review of the backend architecture, features, and implementation details for the SplitMoney application.

Last updated: 2026-01-11 14:30

---

### 1. Technology Stack
*   **Framework**: NestJS (TypeScript)
*   **Database**: PostgreSQL
*   **ORM**: Prisma
*   **Authentication**: Passport.js (JWT & Google OAuth2)
*   **Configuration**: NestJS Config (@nestjs/config)
*   **Language**: TypeScript

---

### 2. Core Features

#### 🔐 Authentication & Authorization
*   **Google OAuth2**: Integrated Google Sign-In for a seamless user experience.
*   **JWT Strategy**: Secure stateless authentication using JSON Web Tokens.
*   **Unified User Management**: Automatically creates or links local user accounts upon successful Google login.
*   **Metadata in Tokens**: JWT tokens include user's name and avatar URL to reduce frontend API calls.

#### 🏗️ Database Architecture (Prisma)
*   **User Model**: Stores user profiles, Google IDs, and authentication metadata.
*   **Group Model**: Represents a shared space for expenses, supporting multiple currencies.
*   **GroupMember Model**: Junction table managing user-to-group relationships, supporting both registered users and guest names.
*   **Expense Model**: Tracks financial transactions with support for multiple split types (Even, Exact, Percent, Shares) and rounding discrepancy management. Now supports multiple payers.
*   **ExpensePayer Model**: Allows multiple members to pay for a single expense.
*   **ExpenseSplit Model**: Details the exact breakdown of each expense per member, storing original shares/percentages.
*   **Settlement Model**: Tracks payments between members to balance debts, with status management (Pending, Completed, Rejected).

#### ⚙️ Modular Design
*   **Auth Module**: Encapsulates all authentication logic, strategies, and controllers.
*   **Prisma Module**: Provides a global, injectable Prisma service for database access.
*   **Config Management**: Centralized environment variable management via `.env` and `ConfigService`.

---

### 3. Implementation Details

#### 🔄 Authentication Flow
1.  **Initiation**: Frontend redirects to `/auth/google`.
2.  **Handshake**: `GoogleStrategy` handles the OAuth2 flow with Google's servers.
3.  **Validation**: `AuthService.validateGoogleUser` finds or creates the user in the PostgreSQL database.
4.  **Token Generation**: `AuthService.generateToken` creates a JWT signed with a secret key, containing user claims.
5.  **Redirection**: `AuthController` redirects the user back to the frontend (`FRONTEND_URL`) with the JWT as a query parameter.

#### 🛠️ Code Quality
*   **Type Safety**: Comprehensive use of DTOs (Data Transfer Objects) and TypeScript interfaces.
*   **Separation of Concerns**: Logic is divided between Controllers (HTTP handling) and Services (Business logic).
*   **Scalability**: The modular architecture allows for easy addition of new features like "Groups" or "Expenses" APIs.

---

### 4. Recent Improvements

#### ✅ Integrated Google OAuth2 with Frontend
*   Updated `AuthController` to support dynamic redirects via `FRONTEND_URL`.
*   Modified `AuthService` to include `name` and `picture` in the JWT payload.
*   Verified compatibility with the React frontend's `AuthCallback` and route guards.

#### ✅ Database Schema Enhancements
*   Refined the relational schema to support multiple payers per expense.
*   Enhanced split tracking to preserve original split logic (shares, percentages).
*   Introduced settlement status to track the lifecycle of debt repayments.
*   Ensured consistent database mapping for all fields.

#### ✅ Group Expenses & Transactions
*   Implemented `ExpensesModule` for managing group finances.
*   **Create Expense**: Supports multiple payers and various split types (Even, Exact, Percentage, Shares).
*   **Transaction History**: Provides a unified, chronological feed of both expenses and debt settlements within a group.
*   **Membership Security**: Ensured that only verified group members can record expenses or view history.

#### ✅ Type Safety & Strong Typing
*   **Explicit Return Types**: All Controller and Service methods now have explicit return types (`Promise<T>`), improving code readability and maintainability.
*   **Dedicated Interfaces**: Created `expense-calculation.interface.ts` and `expense-responses.type.ts` to define the shape of complex internal logic and API responses.
*   **Prisma Integration**: Leveraged Prisma-generated types across the `Groups` and `Expenses` modules.
*   **Precise Data Mapping**: Explicitly mapping Prisma `Decimal` types to `number` in API responses to ensure consistency.
*   **Detailed Payer Information**: Enhanced `TransactionHistoryItem` and `ExpenseResponse` to include comprehensive payer details (ID, name, and amount), ensuring clear visibility of who paid for each expense.

#### ✅ Expense Management (CRUD)
*   **Update Expense**: Implemented a robust "reverse and reapply" logic for editing expenses. It ensures that balances and debts are correctly adjusted by first undoing the old expense's effects and then applying the new ones within a single atomic transaction.
*   **Delete Expense**: Implemented soft-delete for expenses, which also triggers a full reversal of its financial impact on member balances and group debts.
*   **Integer Cent Math**: All financial calculations are performed using integer cents to prevent floating-point rounding errors and ensure exact balancing.

#### ✅ Settle Up (Debt Settlement)
*   **Individual Settlements**: Added `POST /groups/:groupId/settlements` to record payments between two specific group members. This automatically updates their balances and reduces/reverses any existing debt between them.
*   **Minimal Settlement Transfers**: Implemented a `SettlementsService` that computes the most efficient way to balance all group debts using a greedy algorithm.
*   **Automated Balancing**: The `POST /groups/:groupId/settle-up` endpoint automatically creates `COMPLETED` settlement records, zeros out all `MemberBalance` records, and clears all outstanding `Debt` records within a single atomic transaction.
*   **Multi-Currency Support**: Safely handles settlements across different currencies, ensuring that each currency balances independently.
*   **Data Consistency**: Validates that all group balances sum to exactly zero before performing any settlement operations to guard against data corruption or rounding discrepancies.

---

### 5. Future Roadmap
1.  **WebSockets**: Real-time updates when expenses are added or edited by other group members.
2.  **API Documentation**: Integrate Swagger (OpenAPI) for interactive API documentation.
3.  **Unit & E2E Testing**: Add Jest tests for Auth and Business logic services.
