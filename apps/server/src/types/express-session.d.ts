import "express-session";

declare module "express-session" {
  interface SessionData {
    user?: {
      username: string;
      firstName?: string;
      lastName?: string;
      isAdmin?: boolean;
    };
    userId?: string;
    returnTo?: string;
  }
}
