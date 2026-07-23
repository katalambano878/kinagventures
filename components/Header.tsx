'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import MiniCart from './MiniCart';
import { useCart } from '@/context/CartContext';
import { supabase } from '@/lib/supabase';
import { useCMS } from '@/context/CMSContext';

interface SearchResult {
  id: string;
  slug: string;
  name: string;
  price: number;
  image: string;
  category: string;
}

const NAV_LINKS = [
  { label: 'Shop',                  href: '/shop',          icon: 'ri-store-2-line' },
  { label: 'Categories',            href: '/categories',    icon: 'ri-folder-2-line' },
  { label: 'Available Goods',       href: '/preorders',     icon: 'ri-map-pin-2-line', special: true },
  { label: 'Shipping Fees',         href: '/shipping-fees', icon: 'ri-truck-line' },
  { label: 'About',                 href: '/about',         icon: 'ri-information-line' },
  { label: 'Contact',               href: '/contact',       icon: 'ri-mail-line' },
];

const QUICK_LINKS = [
  { label: 'New Arrivals',    href: '/shop',          icon: 'ri-sparkling-line' },
  { label: 'Available Goods', href: '/preorders',     icon: 'ri-map-pin-2-line' },
  { label: 'Categories',      href: '/categories',    icon: 'ri-folder-2-line' },
  { label: 'Shipping Fees',   href: '/shipping-fees', icon: 'ri-truck-line' },
];

const ANNOUNCEMENTS = [
  '✈  Premium goods sourced directly from China — trusted quality',
  '🇬🇭  Available Goods in Ghana — browse items ready to ship',
  '📦  Preorders take 6–8 weeks · Available Goods ship faster',
  '💬  Questions? Our support team is ready to help',
];

export default function Header() {
  const pathname = usePathname() || '';

  const [isMobileMenuOpen, setIsMobileMenuOpen]   = useState(false);
  const [isSearchOpen,     setIsSearchOpen]        = useState(false);
  const [searchQuery,      setSearchQuery]         = useState('');
  const [searchResults,    setSearchResults]       = useState<SearchResult[]>([]);
  const [searchLoading,    setSearchLoading]       = useState(false);
  const [wishlistCount,    setWishlistCount]       = useState(0);
  const [user,             setUser]                = useState<any>(null);
  const [logoError,        setLogoError]           = useState(false);
  const [scrolled,         setScrolled]            = useState(false);
  const [announcementIdx,  setAnnouncementIdx]     = useState(0);
  const [announcementOn,   setAnnouncementOn]      = useState(true);

  const searchInputRef  = useRef<HTMLInputElement>(null);
  const searchTimerRef  = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { cartCount, isCartOpen, setIsCartOpen } = useCart();
  const { getSetting }                           = useCMS();

  const siteName    = getSetting('site_name') || 'KINAG VENTURES';
  const siteLogo    = '/logo-kinag.png';
  const rawHeight   = Number.parseInt(getSetting('header_logo_height') || '32', 10);
  const logoHeight  = Number.isFinite(rawHeight) ? Math.min(56, Math.max(24, rawHeight)) : 32;

  /* ── scroll shadow ────────────────────────────────────── */
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 6);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  /* ── announcement rotation ───────────────────────────── */
  useEffect(() => {
    if (!announcementOn) return;
    const t = setInterval(
      () => setAnnouncementIdx((i) => (i + 1) % ANNOUNCEMENTS.length),
      4500,
    );
    return () => clearInterval(t);
  }, [announcementOn]);

  /* ── wishlist + auth ─────────────────────────────────── */
  useEffect(() => {
    const sync = () => {
      const wl = JSON.parse(localStorage.getItem('wishlist') || '[]');
      setWishlistCount(wl.length);
    };
    sync();
    window.addEventListener('wishlistUpdated', sync);
    supabase.auth.getSession().then(({ data: { session } }) => setUser(session?.user ?? null));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, s) => setUser(s?.user ?? null));
    return () => { window.removeEventListener('wishlistUpdated', sync); subscription.unsubscribe(); };
  }, []);

  /* ── search ──────────────────────────────────────────── */
  const fetchSearchResults = useCallback(async (q: string) => {
    const trimmed = q.trim();
    if (!trimmed) { setSearchResults([]); setSearchLoading(false); return; }
    setSearchLoading(true);
    try {
      const { data } = await supabase
        .from('products')
        .select('id, slug, name, price, categories!inner(name), product_images!product_id(url, position)')
        .ilike('name', `%${trimmed}%`)
        .limit(8);
      setSearchResults(
        (data || []).map((p: any) => ({
          id:       p.id,
          slug:     p.slug,
          name:     p.name,
          price:    p.price,
          image:    p.product_images?.[0]?.url || '/placeholder.png',
          category: p.categories?.name || '',
        })),
      );
    } catch { setSearchResults([]); }
    finally   { setSearchLoading(false); }
  }, []);

  const handleSearchInput = useCallback((value: string) => {
    setSearchQuery(value);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    if (!value.trim()) { setSearchResults([]); setSearchLoading(false); return; }
    setSearchLoading(true);
    searchTimerRef.current = setTimeout(() => fetchSearchResults(value), 250);
  }, [fetchSearchResults]);

  useEffect(() => () => { if (searchTimerRef.current) clearTimeout(searchTimerRef.current); }, []);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchQuery.trim()) window.location.href = `/shop?search=${encodeURIComponent(searchQuery)}`;
  };

  const closeAll = () => {
    setIsMobileMenuOpen(false);
    setIsSearchOpen(false);
    setSearchQuery('');
    setSearchResults([]);
  };

  /* ── render ──────────────────────────────────────────── */
  return (
    <>
      {/* ── Announcement bar ─────────────────────────────── */}
      {announcementOn && (
        <div className="bg-primary text-white text-[11px] tracking-wide py-2 px-4 flex items-center justify-center relative">
          <p className="transition-opacity duration-500 text-center text-white/90">
            {ANNOUNCEMENTS[announcementIdx]}
          </p>
          <button
            type="button"
            onClick={() => setAnnouncementOn(false)}
            className="absolute right-4 top-1/2 -translate-y-1/2 text-white/50 hover:text-white transition-colors"
            aria-label="Dismiss"
          >
            <i className="ri-close-line text-sm" />
          </button>
        </div>
      )}

      {/* ── Main header ──────────────────────────────────── */}
      <header
        className={`bg-white sticky top-0 z-50 transition-shadow duration-300 ${
          scrolled
            ? 'shadow-[0_2px_24px_rgba(0,0,0,0.09)]'
            : 'border-b border-gray-100'
        }`}
      >
        <div className="max-w-7xl mx-auto px-4 sm:px-6">
          <div className="flex items-center justify-between h-16">

            {/* ── Left: hamburger + logo ─── */}
            <div className="flex items-center gap-2.5 min-w-0">
              <button
                type="button"
                className="lg:hidden p-2 -ml-1.5 rounded-lg text-gray-600 hover:text-gray-900 hover:bg-gray-50 transition-colors"
                onClick={() => setIsMobileMenuOpen(true)}
                aria-label="Open menu"
              >
                <i className="ri-menu-line text-xl" />
              </button>
              <Link href="/" className="flex items-center shrink-0" aria-label={`${siteName} home`}>
                {!logoError ? (
                  <img
                    src={siteLogo}
                    alt={siteName}
                    className="w-auto object-contain"
                    style={{ height: `${logoHeight}px` }}
                    onError={() => setLogoError(true)}
                  />
                ) : (
                  <span className="text-lg font-bold tracking-tight text-gray-900">{siteName}</span>
                )}
              </Link>
            </div>

            {/* ── Center: desktop nav ───── */}
            <nav className="hidden lg:flex items-center gap-0.5" aria-label="Main navigation">
              {NAV_LINKS.map((link) => {
                const isActive = pathname.startsWith(link.href);

                if (link.special) {
                  return (
                    <Link
                      key={link.href}
                      href={link.href}
                      className={`flex items-center gap-1.5 px-3.5 py-1.5 mx-1 rounded-full text-[13px] font-semibold transition-all duration-200 ${
                        isActive
                          ? 'bg-amber-100 text-amber-900 shadow-sm'
                          : 'bg-amber-50 text-amber-700 hover:bg-amber-100 hover:text-amber-900 hover:shadow-sm'
                      }`}
                    >
                      <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse shrink-0" />
                      {link.label}
                    </Link>
                  );
                }

                return (
                  <Link
                    key={link.href}
                    href={link.href}
                    className={`relative px-3 py-2 text-[13px] font-medium rounded-lg transition-colors duration-200 ${
                      isActive
                        ? 'text-gray-900 bg-gray-50'
                        : 'text-gray-600 hover:text-gray-900 hover:bg-gray-50'
                    }`}
                  >
                    {link.label}
                    {isActive && (
                      <span className="absolute bottom-1 left-3 right-3 h-[2px] bg-gray-900 rounded-full" />
                    )}
                  </Link>
                );
              })}
            </nav>

            {/* ── Right: action icons ───── */}
            <div className="flex items-center gap-0.5">
              {/* Search */}
              <button
                type="button"
                className="p-2.5 rounded-lg text-gray-500 hover:text-gray-900 hover:bg-gray-50 transition-colors"
                onClick={() => setIsSearchOpen(true)}
                aria-label="Search"
              >
                <i className="ri-search-line text-[19px]" />
              </button>

              {/* Wishlist */}
              <Link
                href="/wishlist"
                className="relative p-2.5 rounded-lg text-gray-500 hover:text-gray-900 hover:bg-gray-50 transition-colors"
                aria-label={wishlistCount > 0 ? `Wishlist, ${wishlistCount} items` : 'Wishlist'}
              >
                <i className="ri-heart-line text-[19px]" />
                {wishlistCount > 0 && (
                  <span className="absolute top-1.5 right-1 min-w-[16px] h-4 px-0.5 bg-primary text-white text-[9px] font-bold rounded-full flex items-center justify-center">
                    {wishlistCount}
                  </span>
                )}
              </Link>

              {/* Account (desktop) */}
              <Link
                href={user ? '/account' : '/auth/login'}
                className="hidden sm:flex p-2.5 rounded-lg text-gray-500 hover:text-gray-900 hover:bg-gray-50 transition-colors"
                aria-label={user ? 'Account' : 'Log in'}
              >
                <i className={`${user ? 'ri-user-fill' : 'ri-user-line'} text-[19px]`} />
              </Link>

              {/* Cart */}
              <div className="relative">
                <button
                  type="button"
                  className="relative p-2.5 rounded-lg text-gray-500 hover:text-gray-900 hover:bg-gray-50 transition-colors"
                  onClick={() => setIsCartOpen(!isCartOpen)}
                  aria-label={cartCount > 0 ? `Cart, ${cartCount} items` : 'Cart'}
                  aria-expanded={isCartOpen}
                  aria-controls="mini-cart"
                >
                  <i className="ri-shopping-bag-line text-[19px]" />
                  {cartCount > 0 && (
                    <span className="absolute top-1.5 right-1 min-w-[16px] h-4 px-0.5 bg-primary text-white text-[9px] font-bold rounded-full flex items-center justify-center">
                      {cartCount}
                    </span>
                  )}
                </button>
                <MiniCart isOpen={isCartOpen} onClose={() => setIsCartOpen(false)} />
              </div>
            </div>

          </div>
        </div>
      </header>

      {/* ── Search overlay ───────────────────────────────────── */}
      {isSearchOpen && (
        <div
          className="fixed inset-0 z-[60] flex flex-col bg-white/95 backdrop-blur-md"
          role="dialog"
          aria-modal="true"
          aria-label="Search"
        >
          <div className="max-w-2xl mx-auto w-full px-4 sm:px-6 pt-8">
            {/* Input row */}
            <div className="flex items-center gap-3 bg-gray-50 border border-gray-200 rounded-2xl px-5 py-3.5 focus-within:border-gray-400 focus-within:shadow-sm transition-all">
              <i className="ri-search-line text-xl text-gray-400 shrink-0" />
              <form onSubmit={handleSearch} className="flex-1">
                <input
                  ref={searchInputRef}
                  type="search"
                  value={searchQuery}
                  onChange={(e) => handleSearchInput(e.target.value)}
                  placeholder="Search products..."
                  className="w-full text-base text-gray-900 bg-transparent focus:outline-none placeholder:text-gray-400"
                  autoFocus
                  autoComplete="off"
                />
              </form>
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => { handleSearchInput(''); searchInputRef.current?.focus(); }}
                  className="p-1 text-gray-400 hover:text-gray-600 transition-colors"
                  aria-label="Clear"
                >
                  <i className="ri-close-circle-fill text-lg" />
                </button>
              )}
            </div>

            <button
              type="button"
              onClick={() => { setIsSearchOpen(false); setSearchQuery(''); setSearchResults([]); }}
              className="mt-3 flex items-center gap-1.5 text-sm text-gray-400 hover:text-gray-700 transition-colors"
            >
              <i className="ri-arrow-left-line text-base" /> Close search
            </button>
          </div>

          {/* Results area */}
          <div className="max-w-2xl mx-auto w-full px-4 sm:px-6 mt-6 flex-1 overflow-y-auto pb-10">
            {/* Loading */}
            {searchLoading && searchQuery.trim() && (
              <div className="flex items-center justify-center gap-2.5 py-14 text-gray-400">
                <i className="ri-loader-4-line animate-spin text-2xl" />
                <span className="text-sm">Searching...</span>
              </div>
            )}

            {/* Results */}
            {!searchLoading && searchQuery.trim() && searchResults.length > 0 && (
              <>
                <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-widest mb-4">
                  {searchResults.length} result{searchResults.length !== 1 ? 's' : ''} found
                </p>
                <ul className="space-y-1">
                  {searchResults.map((product) => (
                    <li key={product.id}>
                      <Link
                        href={`/product/${product.slug}`}
                        className="flex items-center gap-4 p-3 rounded-xl hover:bg-gray-50 transition-colors group"
                        onClick={closeAll}
                      >
                        <div className="w-14 h-14 rounded-xl overflow-hidden bg-gray-100 shrink-0">
                          <img
                            src={product.image}
                            alt={product.name}
                            className="w-full h-full object-cover object-top group-hover:scale-105 transition-transform duration-300"
                          />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-semibold text-gray-900 truncate">{product.name}</p>
                          {product.category && <p className="text-xs text-gray-400 mt-0.5">{product.category}</p>}
                        </div>
                        <div className="text-right shrink-0">
                          <p className="text-sm font-bold text-gray-900">GH₵{product.price.toLocaleString()}</p>
                          <p className="text-[11px] text-gray-400 mt-0.5">View →</p>
                        </div>
                      </Link>
                    </li>
                  ))}
                </ul>
                <Link
                  href={`/shop?search=${encodeURIComponent(searchQuery)}`}
                  className="mt-4 flex items-center justify-center gap-2 w-full py-3 rounded-xl text-sm font-semibold text-gray-900 border-2 border-gray-200 hover:border-gray-900 hover:bg-gray-900 hover:text-white transition-all duration-200"
                  onClick={closeAll}
                >
                  <i className="ri-search-line" /> View all results for &ldquo;{searchQuery}&rdquo;
                </Link>
              </>
            )}

            {/* No results */}
            {!searchLoading && searchQuery.trim() && searchResults.length === 0 && (
              <div className="py-16 text-center">
                <div className="w-16 h-16 bg-gray-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
                  <i className="ri-search-line text-3xl text-gray-300" />
                </div>
                <p className="text-gray-800 font-semibold">No results for &ldquo;{searchQuery}&rdquo;</p>
                <p className="text-sm text-gray-400 mt-1.5">Try a different keyword or browse below</p>
                <Link
                  href="/shop"
                  className="inline-flex items-center gap-2 mt-6 px-6 py-2.5 bg-gray-900 text-white text-sm font-semibold rounded-full hover:bg-gray-800 transition-colors"
                  onClick={closeAll}
                >
                  <i className="ri-store-2-line" /> Browse all products
                </Link>
              </div>
            )}

            {/* Empty state — quick links */}
            {!searchQuery.trim() && (
              <div>
                <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-widest mb-4">Quick links</p>
                <div className="grid grid-cols-2 gap-2.5">
                  {QUICK_LINKS.map((q) => (
                    <Link
                      key={q.href}
                      href={q.href}
                      className="flex items-center gap-3 px-4 py-3.5 rounded-xl bg-gray-50 hover:bg-gray-100 transition-colors"
                      onClick={closeAll}
                    >
                      <i className={`${q.icon} text-base text-gray-500`} />
                      <span className="text-sm font-medium text-gray-700">{q.label}</span>
                    </Link>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Mobile menu ──────────────────────────────────────── */}
      {isMobileMenuOpen && (
        <div className="fixed inset-0 z-[100] lg:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            onClick={() => setIsMobileMenuOpen(false)}
          />

          {/* Drawer */}
          <div className="absolute inset-y-0 left-0 w-full max-w-[300px] bg-white shadow-2xl flex flex-col">
            {/* Drawer header */}
            <div className="flex items-center justify-between px-5 h-16 border-b border-gray-100 shrink-0">
              <Link href="/" onClick={() => setIsMobileMenuOpen(false)}>
                {!logoError ? (
                  <img
                    src={siteLogo}
                    alt={siteName}
                    className="h-8 w-auto object-contain"
                    onError={() => setLogoError(true)}
                  />
                ) : (
                  <span className="font-bold text-gray-900 text-sm">{siteName}</span>
                )}
              </Link>
              <button
                type="button"
                onClick={() => setIsMobileMenuOpen(false)}
                className="w-9 h-9 flex items-center justify-center rounded-lg text-gray-500 hover:text-gray-900 hover:bg-gray-100 transition-colors"
                aria-label="Close menu"
              >
                <i className="ri-close-line text-xl" />
              </button>
            </div>

            {/* Nav links */}
            <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-0.5" aria-label="Mobile navigation">
              {/* Home */}
              <Link
                href="/"
                className={`flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-colors ${
                  pathname === '/'
                    ? 'bg-gray-100 text-gray-900 font-semibold'
                    : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
                }`}
                onClick={() => setIsMobileMenuOpen(false)}
              >
                <i className={`ri-home-line text-base w-5 text-center ${pathname === '/' ? 'text-gray-900' : 'text-gray-400'}`} />
                Home
              </Link>

              {NAV_LINKS.map((link) => {
                const isActive = pathname.startsWith(link.href);

                if (link.special) {
                  return (
                    <Link
                      key={link.href}
                      href={link.href}
                      className="flex items-center justify-between px-4 py-3 rounded-xl bg-amber-50 hover:bg-amber-100 transition-colors"
                      onClick={() => setIsMobileMenuOpen(false)}
                    >
                      <span className="flex items-center gap-3">
                        <span className="w-5 flex justify-center">
                          <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
                        </span>
                        <span className="text-sm font-semibold text-amber-800">{link.label}</span>
                      </span>
                      <i className="ri-arrow-right-s-line text-amber-500" />
                    </Link>
                  );
                }

                return (
                  <Link
                    key={link.href}
                    href={link.href}
                    className={`flex items-center justify-between px-4 py-3 rounded-xl text-sm font-medium transition-colors ${
                      isActive
                        ? 'bg-gray-100 text-gray-900 font-semibold'
                        : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
                    }`}
                    onClick={() => setIsMobileMenuOpen(false)}
                  >
                    <span className="flex items-center gap-3">
                      <i className={`${link.icon} text-base w-5 text-center ${isActive ? 'text-gray-900' : 'text-gray-400'}`} />
                      {link.label}
                    </span>
                    <i className={`ri-arrow-right-s-line text-sm ${isActive ? 'text-gray-600' : 'text-gray-300'}`} />
                  </Link>
                );
              })}
            </nav>

            {/* Drawer footer */}
            <div className="border-t border-gray-100 px-3 py-4 space-y-0.5 shrink-0">
              <Link
                href={user ? '/account' : '/auth/login'}
                className="flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium text-gray-600 hover:bg-gray-50 hover:text-gray-900 transition-colors"
                onClick={() => setIsMobileMenuOpen(false)}
              >
                <i className={`${user ? 'ri-user-fill' : 'ri-user-line'} text-base w-5 text-center text-gray-400`} />
                {user ? 'My Account' : 'Log In / Sign Up'}
              </Link>
              <Link
                href="/wishlist"
                className="flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium text-gray-600 hover:bg-gray-50 hover:text-gray-900 transition-colors"
                onClick={() => setIsMobileMenuOpen(false)}
              >
                <i className="ri-heart-line text-base w-5 text-center text-gray-400" />
                Wishlist
                {wishlistCount > 0 && (
                  <span className="ml-auto bg-gray-100 text-gray-700 text-xs font-bold px-2 py-0.5 rounded-full">
                    {wishlistCount}
                  </span>
                )}
              </Link>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
