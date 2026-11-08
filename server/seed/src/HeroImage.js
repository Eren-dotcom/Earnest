/**
 * Hero image component for the sample project.
 *
 * NOTE: this file ships in a deliberately unfinished state. The hero image is
 * meaningful content, but it declares an empty `alt` attribute, so screen
 * reader users get nothing. Fixing that is the goal of the demo task.
 */
export function renderHeroImage({ src = './assets/hero.svg' } = {}) {
  return `<figure class="hero">
  <img class="hero__image" src="${src}" alt="">
  <figcaption class="hero__caption">A workshop table with a laptop and a plant.</figcaption>
</figure>`;
}

export const meta = {
  name: 'HeroImage',
  description: 'Renders the landing page hero image.',
};
