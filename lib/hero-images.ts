/**
 * Hero images from public folder.
 * First 3 = home page slider; rest = other pages' hero sections.
 * Replace with your own images.
 */
export const HERO_IMAGES = [
  // [0-2] Home page hero slider — DO NOT change these (home hero has its own images)
  '/Whisk_a857b7588640cbbad194c0ace9446d59dr.jpeg',
  '/Whisk_wktmlrwmjbzmyqwotijz0ktl3gdo00snlvtmtgj.jpeg',
  '/Whisk_zydnjrzmjfgz1qtotmzy4iwlyitz00sozezntyj.jpeg',
  // [3+] Other pages' hero sections — importation-themed images
  '/hero-about.webp',     // [3] About page hero background
  '/hero-founder.webp',   // [4] About page story / founder portrait
  '/hero-warehouse.webp', // [5] Generic fallback hero
  '/hero-delivery.webp',  // [6] About page CTA background
  '/hero-contact.webp',   // [7] Contact page hero
  '/hero-shop.webp',      // [8] Shop page hero
  '/hero-cart.webp',      // [9] Cart + Wishlist page hero
  '/Whisk_dc59e126b5601208efb499e94a3fe0c7dr.jpeg',
  '/Whisk_43df2319664f338b5834742afe5425cfdr.jpeg',
  '/Whisk_ygzmiz2nhzzn5u2ytmwzkltlxqmn00ym3mmnty2.jpeg',
  '/Whisk_ljmnjrjzwegzhftmte2nifwlkvzy00ynmldntym.jpeg',
  '/Whisk_180a83c4573234b9c054c48f1befa86edr.jpeg',
  '/Whisk_bba3a7f2239cedfb3c04e3b901749434dr.jpeg',
  '/Whisk_5mzyifgohhjzjzjytqwm1ktl0ywn00snhfgztyw.jpeg',
] as const;

/**
 * Per-slide overrides for the home page hero. When `theme` is set, the hero
 * renders themed badge/headline/subheadline/CTA in place of the CMS defaults.
 */
export type HeroSlide = {
  src: string;
  theme?: 'default' | 'flash-sale';
  badge?: string;
  headline?: string;
  subheadline?: string;
  ctaText?: string;
  ctaHref?: string;
  objectPosition?: string;
};

/** Home page slider — uses CMS defaults */
export const HERO_SLIDES_HOME: HeroSlide[] = [
  { src: HERO_IMAGES[0] },
  { src: HERO_IMAGES[1] },
  { src: HERO_IMAGES[2] },
];

/** For other pages' hero sections (remaining 14) */
export const HERO_IMAGES_OTHER_PAGES = HERO_IMAGES.slice(3);
