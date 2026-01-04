### Project Review: SplitMoney Backend

This document provides a comprehensive review of the backend architecture, features, and implementation details for the SplitMoney application.

Last updated: 2026-01-03 23:15

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
*   **Expense Model**: Tracks financial transactions with support for multiple split types (Even, Exact, Percent, Shares) and rounding discrepancy management.
*   **ExpenseSplit Model**: Details the exact breakdown of each expense per member.
*   **Settlement Model**: Tracks payments between members to balance debts, supporting soft-deletes.

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

#### ✅ Database Schema Foundation
*   Designed and implemented a robust relational schema in `schema.prisma` that supports complex expense splitting and multi-group management.
*   Configured PostgreSQL as the primary data store.

---

### 5. Future Roadmap
1.  **RESTful APIs**: Complete the implementation of Group and Expense CRUD endpoints.
2.  **WebSockets**: Real-time updates when expenses are added or edited by other group members.
3.  **API Documentation**: Integrate Swagger (OpenAPI) for interactive API documentation.
4.  **Unit & E2E Testing**: Add Jest tests for Auth and Business logic services.
