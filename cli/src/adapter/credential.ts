/** A sign-in aireg stores for an adapter and hands back on connect: a bearer token or a header. */
export type Credential =
  | { type: "bearer"; accessToken: string; refreshToken?: string; expiresAtMs?: number }
  | { type: "apiKey"; header: string; value: string };
