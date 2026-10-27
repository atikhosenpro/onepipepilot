declare global {
  namespace Express {
    interface Request {
      admin?: { id: number; username: string; sessionHash: string; csrfToken: string };
      apiKey?: { id: string; label: string };
    }
  }
}
export {};
