export const SESSION_COOKIE_NAME = "__Host-serviceflow_session";

const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function readSessionCookie(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) {
    return null;
  }

  const matches = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${SESSION_COOKIE_NAME}=`));

  if (matches.length !== 1) {
    return null;
  }

  const cookie = matches[0];

  if (cookie === undefined) {
    return null;
  }

  const token = cookie.slice(SESSION_COOKIE_NAME.length + 1);

  return SESSION_TOKEN_PATTERN.test(token) ? token : null;
}

export function createSessionCookie(token: string, expiresAt: Date): string {
  if (!SESSION_TOKEN_PATTERN.test(token)) {
    throw new Error("Cannot create a session cookie from an invalid token.");
  }

  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));

  return [
    `${SESSION_COOKIE_NAME}=${token}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
    `Expires=${expiresAt.toUTCString()}`,
  ].join("; ");
}

export function clearSessionCookie(): string {
  return [
    `${SESSION_COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
  ].join("; ");
}
