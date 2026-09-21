import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { brandAsset, brandHead } from '../src/brand.ts';

test('installable dashboard serves a manifest and an app icon through the brand allowlist', () => {
  const manifestAsset = brandAsset('/brand/manifest.webmanifest');
  expect(manifestAsset?.type).toBe('application/manifest+json');
  const manifest = JSON.parse(manifestAsset!.body.toString('utf8'));

  expect(manifest.name).toBe('Qoopia');
  expect(manifest.display).toBe('standalone');
  expect(manifest.start_url).toBe('/dashboard');
  expect(manifest.icons.length).toBeGreaterThan(0);

  // Every declared icon must actually be served, at the declared type.
  for (const icon of manifest.icons) {
    const served = brandAsset(icon.src);
    expect(served).toBeDefined();
    expect(served!.type).toBe(icon.type);
    expect(served!.body.length).toBeGreaterThan(0);
  }
  // An installable icon needs a maskable variant or Android crops it.
  expect(manifest.icons.some((i: { purpose?: string }) => i.purpose === 'maskable')).toBe(true);

  // The head must reference both, or the browser never discovers them.
  expect(brandHead).toContain('rel="manifest"');
  expect(brandHead).toContain('rel="apple-touch-icon"');

  // The standalone dashboard has its own head; keep it in sync.
  const dashboard = readFileSync(new URL('../src/public/dashboard.html', import.meta.url), 'utf8');
  expect(dashboard).toContain('rel="manifest"');
  expect(dashboard).toContain('rel="apple-touch-icon"');

  // The allowlist stays an allowlist.
  expect(brandAsset('/brand/../http.ts')).toBeUndefined();
  expect(brandAsset('/brand/unknown.png')).toBeUndefined();
  expect(brandAsset('/dashboard')).toBeUndefined();
});
