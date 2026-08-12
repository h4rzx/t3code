import { describe, expect, it } from "vite-plus/test";

import { looksSignedOut } from "./signedOut.ts";

describe("looksSignedOut", () => {
  it("flags common sign-in URLs", () => {
    for (const url of [
      "https://app.adapty.io/login",
      "https://example.com/sign-in",
      "https://example.com/auth/callback",
      "https://accounts.google.com/signin/v2/identifier",
      "https://example.com/users/session/new",
    ]) {
      expect(looksSignedOut({ url, title: "" })).toBe(true);
    }
  });

  it("flags sign-in titles even when the URL looks ordinary", () => {
    for (const title of [
      "Sign in",
      "Log in — Adapty",
      "Sign in to your account",
      "Session expired",
    ]) {
      expect(looksSignedOut({ url: "https://app.adapty.io/overview", title })).toBe(true);
    }
  });

  it("does not flag an authenticated dashboard", () => {
    expect(
      looksSignedOut({
        url: "https://app.adapty.io/overview",
        title: "Overview - Color Analysis - CAPSI",
      }),
    ).toBe(false);
  });

  it("does not flag pages that merely mention login", () => {
    // A false positive tells the user to re-import cookies for no reason.
    for (const page of [
      { url: "https://docs.example.com/api/login", title: "Login API - Docs" },
      { url: "https://example.com/blog/how-to-log-in", title: "How to log in" },
      { url: "https://example.com/settings/login-history", title: "Login history" },
      { url: "https://example.com/help/signin-issues", title: "Sign-in issues - Help" },
    ]) {
      expect(looksSignedOut(page)).toBe(false);
    }
  });

  it("matches whole path segments only", () => {
    expect(looksSignedOut({ url: "https://example.com/plugins", title: "" })).toBe(false);
    expect(looksSignedOut({ url: "https://example.com/blogin", title: "" })).toBe(false);
    expect(looksSignedOut({ url: "https://example.com/authors", title: "" })).toBe(false);
  });

  it("handles missing or malformed input", () => {
    expect(looksSignedOut({ url: null, title: null })).toBe(false);
    expect(looksSignedOut({ url: "not a url", title: "" })).toBe(false);
  });
});
