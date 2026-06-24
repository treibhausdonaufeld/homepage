// @ts-check
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
  // Used for canonical URLs, sitemaps and Open Graph tags.
  // This assumes the custom domain treibhausdonaufeld.at (see public/CNAME).
  site: 'https://treibhausdonaufeld.at',

  // If you DON'T use a custom domain and instead publish at
  // https://treibhausdonaufeld.github.io/homepage/, then:
  //   1. remove public/CNAME
  //   2. set:  site: 'https://treibhausdonaufeld.github.io',
  //   3. add:  base: '/homepage',
});
