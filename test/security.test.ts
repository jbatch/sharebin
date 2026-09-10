import { afterEach, describe, expect, it } from "vitest";
import type { FastifyRequest } from "fastify";
import { requireOrigin } from "../src/server/security.js";

const originalNodeEnv = process.env.NODE_ENV;

function request(method: string, origin?: string, host = "localhost:8080", url = "/api/login"): FastifyRequest {
  return {
    url,
    method,
    headers: { origin, host }
  } as FastifyRequest;
}

afterEach(() => {
  process.env.NODE_ENV = originalNodeEnv;
});

describe("origin checks", () => {
  it("allows private LAN origins in development for mobile testing", () => {
    process.env.NODE_ENV = "development";
    expect(requireOrigin(request("POST", "http://192.168.20.16:3000"), "http://localhost:8080")).toBe(true);
    expect(requireOrigin(request("POST", "http://10.0.0.12:3000"), "http://localhost:8080")).toBe(true);
    expect(requireOrigin(request("POST", "http://172.20.1.4:3000"), "http://localhost:8080")).toBe(true);
  });

  it("allows an HTTPS development proxy when it matches app base url", () => {
    process.env.NODE_ENV = "development";
    expect(requireOrigin(request("POST", "https://dev.jbat.ch"), "https://dev.jbat.ch")).toBe(true);
  });

  it("allows opaque-origin posts only for the PWA share target", () => {
    process.env.NODE_ENV = "production";
    expect(requireOrigin(request("POST", "null", "dev.jbat.ch", "/share"), "https://dev.jbat.ch")).toBe(true);
    expect(requireOrigin(request("POST", "null", "dev.jbat.ch", "/api/login"), "https://dev.jbat.ch")).toBe(false);
  });

  it("keeps production origin checks strict", () => {
    process.env.NODE_ENV = "production";
    expect(requireOrigin(request("POST", "http://192.168.20.16:3000"), "http://localhost:8080")).toBe(false);
    expect(requireOrigin(request("POST", "https://share.example"), "https://share.example")).toBe(true);
  });
});
