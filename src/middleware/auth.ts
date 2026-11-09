import { Request, Response, NextFunction } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const provided = req.get("Authorization")?.match(/^Bearer ([A-Za-z0-9_-]+)$/i)?.[1];
  const hash = (key: string) => createHash("sha256").update(key).digest();

  if (!config.apiKey || !provided || !timingSafeEqual(hash(provided), hash(config.apiKey))) {
    res.status(401).json({ error: "unauthorized", message: "A valid bearer API key is required." });
    return;
  }

  next();
}
