export interface RequestUser {
  id: string;
  email: string;
  name: string;
  avatarUrl?: string;
}

declare global {
  namespace Express {
    interface User extends RequestUser {}
  }
}
