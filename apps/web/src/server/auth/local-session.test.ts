import { describe, expect, it } from "vitest";

import { MemoryCookieJar } from "./cookies";
import {
  clearLocalSession,
  createLocalToken,
  LOCAL_SESSION_COOKIE,
  LOCAL_SESSION_SECONDS,
  readLocalSession,
  refreshLocalSession,
  signLocalToken,
  verifyLocalToken,
  writeLocalSession,
} from "./local-session";

const secret = "a".repeat(48);
const user = { id: "5b8f1c1e-7a44-4d0a-9d6c-3f2a1b0c9d8e", email: "pat@example.com" };
const now = new Date("2026-11-11T12:00:00Z");
const later = (seconds: number) => new Date(now.getTime() + seconds * 1000);

describe("local tokens", () => {
  it("verifies its own tokens", () => {
    const token = createLocalToken(user, "session", secret, now);
    expect(verifyLocalToken(token, secret, "session", now)).toMatchObject({
      sub: user.id,
      email: user.email,
      typ: "session",
    });
  });

  it("rejects a token signed with another secret", () => {
    const token = createLocalToken(user, "session", "b".repeat(48), now);
    expect(verifyLocalToken(token, secret, "session", now)).toBeNull();
  });

  it("rejects a token whose payload was changed", () => {
    const token = createLocalToken(user, "session", secret, now);
    const [body, mac] = token.split(".");
    const payload = JSON.parse(Buffer.from(body ?? "", "base64url").toString()) as { sub: string };
    payload.sub = "00000000-0000-4000-8000-000000000000";
    const forged = `${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${mac}`;
    expect(verifyLocalToken(forged, secret, "session", now)).toBeNull();
  });

  it("rejects an expired token", () => {
    const token = createLocalToken(user, "magic", secret, now);
    expect(verifyLocalToken(token, secret, "magic", later(14 * 60))).not.toBeNull();
    expect(verifyLocalToken(token, secret, "magic", later(15 * 60))).toBeNull();
  });

  it("does not accept a magic-link token as a session, or the other way round", () => {
    const magic = createLocalToken(user, "magic", secret, now);
    const session = createLocalToken(user, "session", secret, now);
    expect(verifyLocalToken(magic, secret, "session", now)).toBeNull();
    expect(verifyLocalToken(session, secret, "magic", now)).toBeNull();
  });

  it("rejects garbage", () => {
    for (const bad of ["", "a", "a.b", "a.b.c", "..", `${"x".repeat(40)}.${"y".repeat(43)}`]) {
      expect(verifyLocalToken(bad, secret, "session", now), bad).toBeNull();
    }
    const unsignedShape = signLocalToken(
      { sub: 1 as unknown as string, email: "x", typ: "session", iat: 0, exp: 9e9 },
      secret,
    );
    expect(verifyLocalToken(unsignedShape, secret, "session", now)).toBeNull();
  });
});

describe("local session cookie", () => {
  it("is written httpOnly and read back as the user", () => {
    const jar = new MemoryCookieJar();
    writeLocalSession(jar, user, { secret, secure: true, now });
    expect(jar.cookies.get(LOCAL_SESSION_COOKIE)?.options).toEqual({
      httpOnly: true,
      sameSite: "lax",
      secure: true,
      path: "/",
      maxAge: LOCAL_SESSION_SECONDS,
    });
    expect(readLocalSession(jar, secret, now)).toEqual(user);
  });

  it("reads nothing from an empty, cleared or expired jar", () => {
    const jar = new MemoryCookieJar();
    expect(readLocalSession(jar, secret, now)).toBeNull();
    writeLocalSession(jar, user, { secret, secure: false, now });
    expect(readLocalSession(jar, secret, later(LOCAL_SESSION_SECONDS + 1))).toBeNull();
    clearLocalSession(jar, false);
    expect(readLocalSession(jar, secret, now)).toBeNull();
  });

  it("is renewed only after half of its lifetime", () => {
    const jar = new MemoryCookieJar();
    writeLocalSession(jar, user, { secret, secure: false, now });
    const original = jar.get(LOCAL_SESSION_COOKIE);

    refreshLocalSession(jar, { secret, secure: false, now: later(3600) });
    expect(jar.get(LOCAL_SESSION_COOKIE)).toBe(original);

    const afterHalf = later(LOCAL_SESSION_SECONDS / 2 + 60);
    refreshLocalSession(jar, { secret, secure: false, now: afterHalf });
    expect(jar.get(LOCAL_SESSION_COOKIE)).not.toBe(original);
    // The renewed session outlives the original one.
    expect(readLocalSession(jar, secret, later(LOCAL_SESSION_SECONDS + 3600))).toEqual(user);
  });

  it("does not create a session when refreshing a jar without one", () => {
    const jar = new MemoryCookieJar({ [LOCAL_SESSION_COOKIE]: "forged.value" });
    refreshLocalSession(jar, { secret, secure: false, now });
    expect(jar.get(LOCAL_SESSION_COOKIE)).toBe("forged.value");
    expect(readLocalSession(jar, secret, now)).toBeNull();
  });
});
