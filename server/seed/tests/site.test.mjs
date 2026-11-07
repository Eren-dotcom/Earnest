import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderHeroImage, meta as heroMeta } from '../src/HeroImage.js';
import { renderNavbar, meta as navMeta } from '../src/Navbar.js';

// These are the sample project's own regression tests. They must keep passing
// after any agent change. They deliberately do NOT assert the task goal --
// goal completion is verified separately by Earnest.

test('hero component renders an image with the layout class intact', () => {
  const html = renderHeroImage();
  assert.match(html, /class="hero__image"/, 'hero image keeps its layout class');
  assert.match(html, /class="hero"/, 'hero figure keeps its layout class');
});

test('hero component exposes a caption for sighted users', () => {
  const html = renderHeroImage();
  assert.match(html, /<figcaption[^>]*>[^<]+<\/figcaption>/, 'figcaption has text');
});

test('navbar renders every primary link', () => {
  const html = renderNavbar();
  for (const href of ['#home', '#projects', '#about']) {
    assert.ok(html.includes(`href="${href}"`), `navbar links to ${href}`);
  }
});

test('navbar marks the current page for assistive technology', () => {
  const html = renderNavbar({ current: 'projects' });
  assert.match(html, /aria-current="page"/, 'current link is announced');
  assert.match(html, /aria-label="Primary"/, 'nav landmark is labelled');
});

test('navbar links remain real anchors, so keyboard access is preserved', () => {
  const html = renderNavbar();
  const anchors = html.match(/<a\s/g) ?? [];
  assert.equal(anchors.length, 3, 'three keyboard-focusable anchors');
  assert.doesNotMatch(html, /onclick=/, 'no click-only handlers replace anchors');
});

test('component modules keep their public names', () => {
  assert.equal(heroMeta.name, 'HeroImage');
  assert.equal(navMeta.name, 'Navbar');
});
