// @ts-check
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
  // Published at https://treibhausdonaufeld.github.io/homepage/ (project page).
  // `base` makes Astro emit asset URLs under /homepage/; internal links and
  // public assets are prefixed with import.meta.env.BASE_URL in the templates.
  site: 'https://treibhausdonaufeld.github.io',
  base: '/homepage',

  // To switch to the custom domain treibhausdonaufeld.at later:
  //   1. add a public/CNAME file containing: treibhausdonaufeld.at
  //   2. set:    site: 'https://treibhausdonaufeld.at',
  //   3. remove: base: '/homepage',
  // The BASE_URL-based links below then collapse to '/' automatically.
});
