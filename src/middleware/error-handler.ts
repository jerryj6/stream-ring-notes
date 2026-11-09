import { Request, Response, NextFunction } from "express";

export class ServiceError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof ServiceError) {
    res.status(err.status).json({ error: err.code, message: err.message });
    return;
  }

  // Body-parser errors can contain the submitted bytes. Keep them out of logs and responses.
  const status = typeof err === "object" && err !== null && "status" in err ? err.status : undefined;
  if (status === 400 || status === 413 || status === 415) {
    res.status(status).json({ error: "invalid_request" });
    return;
  }
  res.status(500).json({ error: "internal_error", message: "The operation could not be completed." });
}
