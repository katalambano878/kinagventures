'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { supabase } from '@/lib/supabase';
import { useCMS } from '@/context/CMSContext';
import ProductCard, { type ColorVariant, getColorHex } from '@/components/ProductCard';
import CategoryCard from '@/components/CategoryCard';
import AnimatedSection, { AnimatedGrid } from '@/components/AnimatedSection';
import { usePageTitle } from '@/hooks/usePageTitle';
import { motion, AnimatePresence } from 'framer-motion';
import { HERO_SLIDES_HOME, type HeroSlide } from '@/lib/hero-images';

export default function Home() {
  usePageTitle('');
  const { getSetting, getActiveBanners } = useCMS();
  const [featuredProducts, setFeaturedProducts] = useState<any[]>([]);
  const [categories, setCategories] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchData() {
      try {
        const { data: productsData, error: productsError } = await supabase
          .from('products')
          .select('*, product_variants(*), product_images(*)')
          .eq('status', 'active')
          .eq('featured', true)
          .order('created_at', { ascending: false })
          .limit(8);

        if (productsError) throw productsError;
        setFeaturedProducts(productsData || []);

        const { data: categoriesData, error: categoriesError } = await supabase
          .from('categories')
          .select('id, name, slug, image_url, metadata')
          .eq('status', 'active')
          .order('name');

        if (categoriesError) throw categoriesError;

        const featuredCategories = (categoriesData || []).filter(
          (cat: any) => cat.metadata?.featured === true
        );
        setCategories(featuredCategories.slice(0, 6));
      } catch (error) {
        console.error('Error fetching data:', error);
      } finally {
        setLoading(false);
      }
    }

    fetchData();
  }, []);

  // ── CMS-driven config ────────────────────────────────────────────
  const heroHeadline = getSetting('hero_headline') || 'Quality imports. Unbeatable prices.';
  const heroSubheadline =
    getSetting('hero_subheadline') ||
    'Premium goods sourced from China — for homes, businesses, and resellers.';
  // Hero images from lib/hero-images.ts
  const HERO_SLIDES: HeroSlide[] = HERO_SLIDES_HOME;
  const HERO_INTERVAL_MS = 3000;
  const [heroIndex,    setHeroIndex]    = useState(0);
  const [heroProgress, setHeroProgress] = useState(0);
  const progressRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const goToSlide = useCallback((idx: number) => {
    setHeroIndex(idx);
    setHeroProgress(0);
  }, []);

  const goPrev = useCallback(() => goToSlide((heroIndex - 1 + HERO_SLIDES.length) % HERO_SLIDES.length), [heroIndex, HERO_SLIDES.length, goToSlide]);
  const goNext = useCallback(() => goToSlide((heroIndex + 1) % HERO_SLIDES.length), [heroIndex, HERO_SLIDES.length, goToSlide]);

  useEffect(() => {
    setHeroProgress(0);
    const TICK = 40;
    const step = (TICK / HERO_INTERVAL_MS) * 100;
    if (progressRef.current) clearInterval(progressRef.current);
    progressRef.current = setInterval(() => {
      setHeroProgress((p) => {
        if (p >= 100) { clearInterval(progressRef.current!); return 100; }
        return p + step;
      });
    }, TICK);
    const autoAdv = setTimeout(() => goNext(), HERO_INTERVAL_MS);
    return () => { clearInterval(progressRef.current!); clearTimeout(autoAdv); };
  }, [heroIndex]);
  const currentSlide = HERO_SLIDES[heroIndex];
  const isFlashSale = currentSlide?.theme === 'flash-sale';
  const heroPrimaryText = getSetting('hero_primary_btn_text');
  const heroPrimaryLink = getSetting('hero_primary_btn_link') || '/shop';
  const heroSecondaryText = getSetting('hero_secondary_btn_text');
  const heroSecondaryLink = getSetting('hero_secondary_btn_link') || '/about';
  const heroTagText = getSetting('hero_tag_text');
  const heroBadgeLabel = getSetting('hero_badge_label');
  const heroBadgeText = getSetting('hero_badge_text');
  const heroBadgeSubtext = getSetting('hero_badge_subtext');

  const features = [
    {
      icon: 'ri-shield-check-line',
      title: getSetting('feature1_title') || 'Verified quality',
      desc: getSetting('feature1_desc') || 'Quality-checked goods sourced directly from trusted China factories — no fakes, no surprises.',
    },
    {
      icon: 'ri-truck-line',
      title: getSetting('feature2_title') || 'Delivery & pickup',
      desc: getSetting('feature2_desc') || 'Fast, reliable delivery across Ghana — or pick up from our Kasoa store whenever it suits you.',
    },
    {
      icon: 'ri-price-tag-3-line',
      title: getSetting('feature3_title') || 'Wholesale & retail',
      desc: getSetting('feature3_desc') || 'Buy a single item or stock up in bulk — unbeatable prices for homes, businesses, and resellers.',
    },
  ];

  const siteName = getSetting('site_name') || 'KINAG VENTURES';
  const importsBannerImage = getSetting('imports_banner_image') || '/imports-banner.webp';

  const stat1Title = getSetting('hero_stat1_title');
  const stat1Desc = getSetting('hero_stat1_desc');
  const stat2Title = getSetting('hero_stat2_title');
  const stat2Desc = getSetting('hero_stat2_desc');
  const stat3Title = getSetting('hero_stat3_title');
  const stat3Desc = getSetting('hero_stat3_desc');

  const activeBanners = getActiveBanners('top');

  const renderBanners = () => {
    if (activeBanners.length === 0) return null;
    return (
      <div className="bg-primary text-white py-2 overflow-hidden relative z-50">
        <div className="flex animate-marquee whitespace-nowrap">
          {activeBanners.concat(activeBanners).map((banner, index) => (
            <span key={index} className="mx-8 text-sm font-medium tracking-wide flex items-center">
              {banner.title}
            </span>
          ))}
        </div>
      </div>
    );
  };

  return (
    <main className="flex-col items-center justify-between min-h-screen bg-white">
      {renderBanners()}

      {/* ── Hero Section ─────────────────────────────────────────── */}
      <section className="relative w-full h-[88vh] sm:h-[90vh] lg:h-screen overflow-hidden bg-black" aria-label="Hero">

        {/* Pre-load all slides */}
        <div className="sr-only" aria-hidden>
          {HERO_SLIDES.map((slide) => <img key={`preload-${slide.src}`} src={slide.src} alt="" />)}
        </div>

        {/* Slide images */}
        <AnimatePresence initial={false} mode="sync">
          <motion.div
            key={heroIndex}
            initial={{ opacity: 0, scale: 1.04 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            transition={{ opacity: { duration: 0.65, ease: 'easeInOut' }, scale: { duration: 0.65, ease: 'easeOut' } }}
            className="absolute inset-0"
          >
            <img
              src={currentSlide.src}
              className="w-full h-full object-cover"
              style={{ objectPosition: currentSlide.objectPosition || 'center top' }}
              alt={currentSlide.headline || `Slide ${heroIndex + 1}`}
            />
          </motion.div>
        </AnimatePresence>

        {/* Gradients — heavy left-to-right for desktop readability, bottom-up always */}
        <div
          className={`absolute inset-0 pointer-events-none ${
            isFlashSale
              ? 'bg-gradient-to-r from-black/90 via-black/60 to-black/30'
              : 'bg-gradient-to-r from-black/85 via-black/50 to-black/15'
          }`}
          aria-hidden
        />
        <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent pointer-events-none" aria-hidden />

        {/* Flash sale ribbon */}
        <AnimatePresence>
          {isFlashSale && (
            <motion.div
              key="flash-ribbon"
              initial={{ opacity: 0, x: 30 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 30 }}
              transition={{ duration: 0.4, ease: 'easeOut' }}
              className="absolute top-24 sm:top-28 right-0 z-20 pointer-events-none"
            >
              <div className="bg-gradient-to-r from-rose-600 via-pink-600 to-rose-500 text-white pl-5 pr-6 py-2 rounded-l-full shadow-2xl flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-white animate-pulse" />
                <span className="text-xs sm:text-sm font-extrabold tracking-[0.2em] uppercase">Flash Sale</span>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── Left-aligned content ───────────────────── */}
        <div className="relative z-10 h-full flex flex-col justify-end lg:justify-center">
          <div className="max-w-7xl mx-auto w-full px-6 sm:px-10 lg:px-16 pb-20 sm:pb-24 lg:pb-0 pt-28 lg:pt-0">

            <AnimatePresence mode="wait">
              <motion.div
                key={`hero-content-${heroIndex}`}
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 20 }}
                transition={{ duration: 0.5, ease: 'easeOut' }}
                className="max-w-2xl"
              >
                {/* Slide counter — desktop only */}
                <div className="hidden lg:flex items-center gap-3 mb-8">
                  <span className="text-white/35 text-xs font-mono tracking-[0.25em]">
                    {String(heroIndex + 1).padStart(2, '0')} / {String(HERO_SLIDES.length).padStart(2, '0')}
                  </span>
                  <div className="w-12 h-px bg-white/20" />
                </div>

                {/* Badge pill */}
                <p
                  className={`text-[11px] font-bold tracking-[0.28em] uppercase mb-5 inline-flex items-center gap-2 px-4 py-1.5 rounded-full backdrop-blur-sm ${
                    isFlashSale
                      ? 'text-white bg-rose-500/30 border border-rose-300/30'
                      : 'text-white/75 border border-white/20 bg-white/5'
                  }`}
                >
                  <span className={`w-1.5 h-1.5 rounded-full animate-pulse ${isFlashSale ? 'bg-rose-300' : 'bg-primary-light'}`} />
                  {currentSlide.badge || heroTagText || 'KINAG VENTURES — Quality Imports'}
                </p>

                {/* Headline — font size scales down for longer headlines */}
                {(() => {
                  const headlineText = currentSlide.headline || heroHeadline;
                  const isLong = headlineText.length > 50;
                  return (
                    <h1
                      className={`text-white leading-[1.08] mb-5 drop-shadow-xl font-serif ${
                        isFlashSale
                          ? 'text-3xl sm:text-4xl lg:text-5xl uppercase tracking-tight'
                          : isLong
                          ? 'text-2xl sm:text-3xl lg:text-4xl xl:text-[2.75rem]'
                          : 'text-4xl sm:text-5xl lg:text-6xl xl:text-[4.5rem]'
                      }`}
                    >
                      {headlineText}
                    </h1>
                  );
                })()}

                {/* Subheadline */}
                <p className={`text-sm sm:text-base leading-relaxed mb-8 font-light max-w-md ${isFlashSale ? 'text-rose-50/80' : 'text-white/70'}`}>
                  {currentSlide.subheadline || heroSubheadline}
                </p>

                {/* CTAs */}
                <div className="flex flex-wrap gap-3 mb-10 lg:mb-12">
                  <Link
                    href={currentSlide.ctaHref || heroPrimaryLink || '/shop'}
                    className={`inline-flex items-center gap-2 px-7 py-3.5 rounded-full font-bold text-sm transition-all hover:scale-105 shadow-xl ${
                      isFlashSale
                        ? 'bg-gradient-to-r from-rose-600 via-pink-600 to-rose-500 hover:from-rose-700 hover:via-pink-700 hover:to-rose-600 text-white shadow-rose-900/40'
                        : 'bg-white text-gray-900 hover:bg-gray-100 shadow-black/20'
                    }`}
                  >
                    {currentSlide.ctaText || heroPrimaryText || 'Shop Now'}
                    <i className="ri-arrow-right-line" />
                  </Link>
                  {!isFlashSale && (
                    <Link
                      href={heroSecondaryLink || '/preorders'}
                      className="inline-flex items-center gap-2 px-7 py-3.5 rounded-full font-semibold text-sm border border-white/30 bg-white/10 backdrop-blur-sm text-white hover:bg-white/20 transition-all"
                    >
                      {heroSecondaryText || 'Available Goods'}
                    </Link>
                  )}
                </div>

                {/* Trust micro-badges */}
                {!isFlashSale && (
                  <div className="flex flex-wrap gap-5">
                    {[
                      { icon: 'ri-global-line',        text: stat1Title || 'Direct Import' },
                      { icon: 'ri-shield-check-line',  text: stat2Title || 'Verified Quality' },
                      { icon: 'ri-price-tag-3-line',   text: stat3Title || 'Best Prices' },
                    ].map((b) => (
                      <span key={b.text} className="flex items-center gap-1.5 text-white/60 text-xs font-medium">
                        <i className={`${b.icon} text-primary-light text-sm`} />
                        {b.text}
                      </span>
                    ))}
                  </div>
                )}
              </motion.div>
            </AnimatePresence>

          </div>
        </div>

        {/* ── Slide dots ─────────────────────────────── */}
        <div className="absolute bottom-7 left-6 sm:left-10 lg:left-16 z-10 flex items-center gap-2">
          {HERO_SLIDES.map((slide, i) => (
            <button
              key={i}
              type="button"
              onClick={() => goToSlide(i)}
              className={`transition-all duration-300 rounded-full ${
                i === heroIndex
                  ? isFlashSale ? 'w-7 h-2 bg-rose-400' : 'w-7 h-2 bg-white'
                  : 'w-2 h-2 bg-white/30 hover:bg-white/60'
              }`}
              aria-label={`Go to slide ${i + 1}`}
            />
          ))}
        </div>

        {/* ── Progress bar ───────────────────────────── */}
        <div className="absolute bottom-0 left-0 right-0 z-10 h-[2px] bg-white/10">
          <div
            className={`h-full transition-none ${isFlashSale ? 'bg-rose-400/70' : 'bg-white/50'}`}
            style={{ width: `${heroProgress}%` }}
          />
        </div>

      </section>

      {/* ── Categories Section ──────────────────────────────────── */}
      <section className="py-16 sm:py-24 bg-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6">

          {/* Header */}
          <AnimatedSection className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-5 mb-8 sm:mb-12">
            <div>
              <span className="flex items-center gap-2.5 text-[11px] font-bold tracking-[0.22em] uppercase text-primary mb-3">
                <span className="w-7 h-px bg-primary" /> Shop by Category
              </span>
              <h2 className="text-3xl sm:text-4xl lg:text-5xl font-bold text-primary-dark leading-tight">
                Find what you need
              </h2>
              <p className="text-gray-500 mt-3 max-w-md leading-relaxed">
                Browse our most-loved aisles and stock up on everyday essentials.
              </p>
            </div>
            <Link
              href="/categories"
              className="self-start sm:self-auto inline-flex items-center gap-2 bg-primary text-white text-sm font-semibold px-5 py-3 rounded-full hover:bg-primary-dark transition-colors shrink-0"
            >
              Browse full catalogue <i className="ri-arrow-right-line" />
            </Link>
          </AnimatedSection>

          {/* Category cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-5">
            {categories.slice(0, 4).map((category, index) => (
              <CategoryCard
                key={category.id}
                name={category.name}
                slug={category.slug}
                image={category.image || category.image_url}
                index={index}
              />
            ))}
          </div>

        </div>
      </section>

      {/* Featured Products */}
      <section className="py-24 bg-stone-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <AnimatedSection className="text-center mb-16">
            <span className="text-gray-500 font-bold tracking-widest uppercase text-xs mb-3 block">New Arrivals</span>
            <h2 className="font-serif text-4xl md:text-5xl text-gray-900 mb-4">Featured Products</h2>
            <p className="text-gray-600 text-lg max-w-2xl mx-auto font-light">Handpicked favorites just for you.</p>
          </AnimatedSection>

          {loading ? (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
              {[...Array(4)].map((_, i) => (
                <div key={i} className="animate-pulse">
                  <div className="bg-gray-200 aspect-[3/4] rounded-2xl mb-4"></div>
                  <div className="h-4 bg-gray-200 rounded w-3/4 mb-2"></div>
                  <div className="h-4 bg-gray-200 rounded w-1/2"></div>
                </div>
              ))}
            </div>
          ) : (
            <AnimatedGrid className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6 lg:gap-8">
              {featuredProducts.map((product) => {
                const variants = product.product_variants || [];
                const hasVariants = variants.length > 0;
                const minVariantPrice = hasVariants ? Math.min(...variants.map((v: any) => v.price || product.price)) : undefined;
                const totalVariantStock = hasVariants ? variants.reduce((sum: number, v: any) => sum + (v.quantity || 0), 0) : 0;
                const effectiveStock = hasVariants ? totalVariantStock : product.quantity;

                const colorVariants: ColorVariant[] = [];
                const seenColors = new Set<string>();
                // Pull colors from metadata.product_options.color (new system)
                const metaColors = (product.metadata?.product_options?.color?.values || []) as string[];
                for (const c of metaColors) {
                  const [cName, cHex] = c.split('|');
                  if (cName && cHex && !seenColors.has(cName.toLowerCase().trim())) {
                    seenColors.add(cName.toLowerCase().trim());
                    colorVariants.push({ name: cName.trim(), hex: cHex });
                  }
                }
                // Fallback: legacy colors from variant option2
                for (const v of variants) {
                  const colorName = (v as any).option2;
                  if (colorName && !seenColors.has(colorName.toLowerCase().trim())) {
                    const hex = getColorHex(colorName);
                    if (hex) {
                      seenColors.add(colorName.toLowerCase().trim());
                      colorVariants.push({ name: colorName.trim(), hex });
                    }
                  }
                }

                return (
                  <ProductCard
                    key={product.id}
                    id={product.id}
                    slug={product.slug}
                    name={product.name}
                    price={product.price}
                    originalPrice={product.compare_at_price}
                    image={product.product_images?.[0]?.url || 'https://via.placeholder.com/400x500'}
                    rating={product.rating_avg || 5}
                    reviewCount={product.review_count || 0}
                    badge={product.featured ? 'Featured' : undefined}
                    inStock={effectiveStock > 0}
                    maxStock={effectiveStock || 50}
                    moq={product.moq || 1}
                    hasVariants={hasVariants}
                    minVariantPrice={minVariantPrice}
                    colorVariants={colorVariants}
                    brand={product.brand || product.vendor}
                    isPreorder={!!(product.metadata?.is_preorder ?? product.metadata?.preorder_shipping)}
                    preorderEta={product.metadata?.preorder_shipping || undefined}
                  />
                );
              })}
            </AnimatedGrid>
          )}

          <div className="text-center mt-20">
            <Link
              href="/shop"
              className="inline-flex items-center justify-center bg-primary text-white px-12 py-5 rounded-full font-bold text-lg hover:bg-primary-dark transition-all shadow-xl hover:shadow-2xl hover:-translate-y-1"
            >
              Shop All Products
            </Link>
          </div>
        </div>
      </section>

    {/* Why customers stay with us */}
    <section className="py-16 sm:py-24 bg-white border-t border-gray-100">
      <div className="max-w-7xl mx-auto px-4 sm:px-6">

        {/* Header */}
        <AnimatedSection className="text-center max-w-2xl mx-auto mb-12 sm:mb-14">
          <span className="inline-flex items-center justify-center text-[11px] font-bold tracking-[0.28em] uppercase text-primary mb-3">
            Why customers stay with us
          </span>
          <h2 className="text-3xl sm:text-4xl lg:text-5xl font-bold text-primary-dark leading-tight">
            Your trusted import partner
          </h2>
          <p className="text-gray-500 mt-4 leading-relaxed">
            Verified, quality products sourced directly from China — electronics, appliances,
            home goods and more, available wholesale and retail with reliable delivery across Ghana.
          </p>
        </AnimatedSection>

        {/* Feature cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-5 sm:gap-6">
          {features.map((feature, i) => (
            <AnimatedSection
              key={i}
              delay={i * 0.1}
              className="group relative overflow-hidden rounded-2xl border border-gray-100 bg-gradient-to-br from-white to-primary-soft p-7 sm:p-8 hover:shadow-lg hover:shadow-primary/10 transition-all duration-500"
            >
              <div className="mb-5 inline-flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-primary-dark text-white shadow-sm shadow-primary/30">
                <i className={`${feature.icon} text-xl`}></i>
              </div>
              <h3 className="font-bold text-primary-dark mb-2 text-lg">{feature.title}</h3>
              <p className="text-gray-500 text-sm leading-relaxed">{feature.desc}</p>
            </AnimatedSection>
          ))}
        </div>

        {/* CTA banner */}
        <AnimatedSection delay={0.2} className="mt-8 sm:mt-10">
          <div className="relative overflow-hidden rounded-2xl sm:rounded-3xl bg-gradient-to-br from-primary-dark via-primary to-accent">
            <div className="grid grid-cols-1 md:grid-cols-2 items-stretch">
              <div className="p-8 sm:p-10 lg:p-12 flex flex-col justify-center">
                <span className="text-[11px] font-bold tracking-[0.28em] uppercase text-white/60 mb-4">
                  Shop with {siteName}
                </span>
                <h3 className="text-2xl sm:text-3xl lg:text-4xl font-bold text-white leading-tight">
                  Quality imports, without breaking the bank.
                </h3>
                <p className="text-white/70 mt-4 leading-relaxed max-w-md">
                  Whether it&apos;s for your home, your business, or to resell — order wholesale
                  or retail and let us deliver right across Ghana.
                </p>
                <div className="mt-7 flex flex-wrap gap-3">
                  <Link
                    href="/shop"
                    className="inline-flex items-center gap-2 bg-white text-primary-dark text-sm font-semibold px-6 py-3 rounded-full hover:bg-gray-100 transition-colors"
                  >
                    Start shopping <i className="ri-arrow-right-up-line" />
                  </Link>
                  <Link
                    href="/auth/signup"
                    className="inline-flex items-center gap-2 border border-white/30 text-white text-sm font-semibold px-6 py-3 rounded-full hover:bg-white/10 transition-colors"
                  >
                    Create an account
                  </Link>
                </div>
              </div>
              <div className="relative min-h-[240px] md:min-h-full">
                <img
                  src={importsBannerImage}
                  alt="Quality imported goods ready for delivery across Ghana"
                  className="absolute inset-0 h-full w-full object-cover"
                />
              </div>
            </div>
          </div>
        </AnimatedSection>

      </div>
    </section>
    </main>
  );
}
