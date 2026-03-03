import type { Request, Response, NextFunction } from "express";
import "express-session";

export function isAuthenticated(req: Request, res: Response, next: NextFunction) {
  if (req.session.user) {
    return next();
  }

  // Return JSON 401 for API routes instead of redirect
  if (req.originalUrl.startsWith("/api")) {
    return res.status(401).json({ error: "Authentication required" });
  }

  req.session.returnTo = req.originalUrl;
  return res.redirect("/login");
}
