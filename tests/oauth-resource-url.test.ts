import { expect, test } from "bun:test";
import { env } from "../src/utils/env.ts";
import { oauthResource, validateOAuthResource, wellKnownProtectedResource } from "../src/auth/oauth.ts";

test("the advertised MCP resource is the one token requests must name, whatever the PUBLIC_URL form", () => {
  const saved = env.PUBLIC_URL;
  try {
    for (const url of ["https://mcp.example.test", "https://mcp.example.test/"]) {
      env.PUBLIC_URL = url;
      const advertised = wellKnownProtectedResource().resource;
      expect(advertised).toBe("https://mcp.example.test/mcp");
      expect(validateOAuthResource(advertised)).toBe(oauthResource());
    }
  } finally {
    env.PUBLIC_URL = saved;
  }
});
