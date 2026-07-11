'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import LazyImage from './LazyImage';
import { useCart } from '@/context/CartContext';
import { useCMS } from '@/context/CMSContext';
import { formatPrice as formatCurrency } from '@/lib/formatCurrency';

const COLOR_MAP: Record<string, string> = {
  black: '#000000', white: '#FFFFFF', red: '#EF4444', blue: '#3B82F6',
  navy: '#1E3A5F', green: '#22C55E', yellow: '#EAB308', orange: '#F97316',
  pink: '#EC4899', purple: '#A855F7', brown: '#92400E', beige: '#D4C5A9',
  grey: '#6B7280', gray: '#6B7280', cream: '#FFFDD0', teal: '#14B8A6',
  maroon: '#800000', coral: '#FF7F50', burgundy: '#800020', olive: '#808000',
  tan: '#D2B48C', khaki: '#C3B091', charcoal: '#36454F', ivory: '#FFFFF0',
  gold: '#FFD700', silver: '#C0C0C0', rose: '#FF007F', lavender: '#E6E6FA',
  mint: '#98FB98', peach: '#FFDAB9', wine: '#722F37', denim: '#1560BD',
  nude: '#E3BC9A', camel: '#C19A6B', sage: '#BCB88A', rust: '#B7410E',
  mustard: '#FFDB58', plum: '#8E4585', lilac: '#C8A2C8', stone: '#928E85',
  sand: '#C2B280', taupe: '#483C32', mauve: '#E0B0FF', sky: '#87CEEB',
  forest: '#228B22', cobalt: '#0047AB', emerald: '#50C878', scarlet: '#FF2400',
  aqua: '#00FFFF', turquoise: '#40E0D0', indigo: '#4B0082', crimson: '#DC143C',
  magenta: '#FF00FF', cyan: '#00FFFF', chocolate: '#7B3F00', coffee: '#6F4E37',
};

export function getColorHex(colorName: string): string | null {
  const lower = colorName.toLowerCase().trim();
  if (COLOR_MAP[lower]) return COLOR_MAP[lower];
  for (const [key, val] of Object.entries(COLOR_MAP)) {
    if (lower.includes(key)) return val;
  }
  return null;
}

export interface ColorVariant {
  name: string;
  hex: string;
}

interface ProductCardProps {
  id: string;
  slug: string;
  name: string;
  price: number;
  originalPrice?: number;
  image: string;
  rating?: number;
  reviewCount?: number;
  badge?: string;
  inStock?: boolean;
  maxStock?: number;
  moq?: number;
  hasVariants?: boolean;
  minVariantPrice?: number;
  colorVariants?: ColorVariant[];
  brand?: string;
  /** When true, show a Preorder pill at the top instead of Available */
  isPreorder?: boolean;
  /** Optional ETA/ship-by text shown under the Preorder pill (e.g. "Ships in 14 days") */
  preorderEta?: string;
}

export default function ProductCard({
  id,
  slug,
  name,
  price,
  originalPrice,
  image,
  rating = 5,
  reviewCount = 0,
  badge,
  inStock = true,
  maxStock = 50,
  moq = 1,
  hasVariants = false,
  minVariantPrice,
  colorVariants = [],
  brand,
  isPreorder = false,
  preorderEta,
}: ProductCardProps) {
  const { addToCart }   = useCart();
  const { getSetting }  = useCMS();
  const currencySymbol  = getSetting('currency_symbol') || '$';

  const [activeColor, setActiveColor] = useState<string | null>(null);
  const [added,       setAdded]       = useState(false);
  const [wishlisted,  setWishlisted]  = useState(false);

  const displayPrice = hasVariants && minVariantPrice ? minVariantPrice : price;
  const discount     = originalPrice ? Math.round((1 - displayPrice / originalPrice) * 100) : 0;
  const MAX_SWATCHES = 5;

  const formatPrice = (val: number) => formatCurrency(val, currencySymbol);

  useEffect(() => {
    const wl = JSON.parse(localStorage.getItem('wishlist') || '[]') as string[];
    setWishlisted(wl.includes(id));
  }, [id]);

  const toggleWishlist = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const wl  = JSON.parse(localStorage.getItem('wishlist') || '[]') as string[];
    const next = wl.includes(id) ? wl.filter((x) => x !== id) : [...wl, id];
    localStorage.setItem('wishlist', JSON.stringify(next));
    setWishlisted(!wishlisted);
    window.dispatchEvent(new Event('wishlistUpdated'));
  };

  const handleAddToCart = (e: React.MouseEvent) => {
    e.preventDefault();
    addToCart({ id, name, price, image, quantity: moq, slug, maxStock, moq });
    setAdded(true);
    setTimeout(() => setAdded(false), 1800);
  };

  return (
    <div className="group relative bg-white rounded-2xl border border-gray-100 hover:border-gray-200 hover:shadow-[0_8px_30px_rgba(0,0,0,0.08)] transition-all duration-300 overflow-hidden flex flex-col h-full">

      {/* ── Image ─────────────────────────────────── */}
      <Link href={`/product/${slug}`} className="relative block aspect-[3/4] overflow-hidden bg-gray-50 shrink-0">
        <LazyImage
          src={image}
          alt={name}
          className="w-full h-full object-cover object-top group-hover:scale-[1.04] transition-transform duration-700 ease-out"
        />

        {/* Wishlist button */}
        <button
          type="button"
          onClick={toggleWishlist}
          className="absolute top-3 right-3 w-8 h-8 rounded-full bg-white/90 backdrop-blur-sm shadow-sm flex items-center justify-center opacity-0 group-hover:opacity-100 translate-y-1 group-hover:translate-y-0 transition-all duration-200 hover:bg-white hover:scale-110 z-10"
          aria-label={wishlisted ? 'Remove from wishlist' : 'Add to wishlist'}
        >
          <i className={`${wishlisted ? 'ri-heart-fill text-red-500' : 'ri-heart-line text-gray-600'} text-sm`} />
        </button>

        {/* Badges: Preorder (amber) beats Available (emerald); discount/custom badge stacks below */}
        <div className="absolute top-3 left-3 flex flex-col items-start gap-1.5 z-10">
          {isPreorder ? (
            <>
              <span className="inline-flex items-center gap-1 px-2.5 py-0.5 bg-amber-500 text-white text-[10px] font-bold tracking-widest uppercase rounded-full shadow-sm">
                <i className="ri-time-line" /> Preorder
              </span>
              {preorderEta && (
                <span className="px-2 py-0.5 bg-white/95 backdrop-blur text-amber-800 text-[10px] font-semibold rounded-full shadow-sm max-w-[160px] truncate">
                  {preorderEta}
                </span>
              )}
            </>
          ) : inStock ? (
            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 bg-emerald-600 text-white text-[10px] font-bold tracking-widest uppercase rounded-full shadow-sm">
              <i className="ri-check-line" /> Available
            </span>
          ) : null}
          {discount > 0 ? (
            <span className="px-2.5 py-0.5 bg-red-500 text-white text-[10px] font-bold tracking-wide rounded-full shadow-sm">
              -{discount}%
            </span>
          ) : badge ? (
            <span className="px-2.5 py-0.5 bg-gray-900 text-white text-[10px] font-bold tracking-widest uppercase rounded-full shadow-sm">
              {badge}
            </span>
          ) : null}
        </div>

        {/* Out of stock overlay (pre-order items are sold before stock arrives) */}
        {!inStock && !isPreorder && (
          <div className="absolute inset-0 bg-white/55 backdrop-blur-[2px] flex items-center justify-center">
            <span className="px-4 py-1.5 bg-white border border-gray-200 text-gray-600 text-xs font-semibold rounded-full shadow-sm tracking-wide">
              Out of Stock
            </span>
          </div>
        )}
      </Link>

      {/* ── Info ──────────────────────────────────── */}
      <div className="flex flex-col flex-1 p-3 sm:p-4 gap-2">

        {/* Color swatches */}
        {colorVariants.length > 0 && (
          <div className="flex items-center gap-1.5">
            {colorVariants.slice(0, MAX_SWATCHES).map((color) => (
              <button
                key={color.name}
                type="button"
                title={color.name}
                onClick={(e) => { e.preventDefault(); setActiveColor(activeColor === color.name ? null : color.name); }}
                className={`w-[14px] h-[14px] rounded-full transition-all duration-200 shrink-0 ${
                  activeColor === color.name ? 'ring-2 ring-offset-1 ring-gray-800 scale-110' : 'hover:scale-110'
                } ${color.hex === '#FFFFFF' ? 'ring-1 ring-gray-200' : ''}`}
                style={{ backgroundColor: color.hex }}
              />
            ))}
            {colorVariants.length > MAX_SWATCHES && (
              <span className="text-[11px] text-gray-400 font-medium">+{colorVariants.length - MAX_SWATCHES}</span>
            )}
          </div>
        )}

        {/* Brand */}
        {brand && (
          <p className="text-[10px] font-bold tracking-[0.18em] uppercase text-gray-400 leading-none">
            {brand}
          </p>
        )}

        {/* Name */}
        <Link href={`/product/${slug}`}>
          <h3 className="text-sm font-semibold text-gray-900 leading-snug line-clamp-2 hover:text-gray-600 transition-colors">
            {name}
          </h3>
        </Link>

        {/* Rating */}
        {reviewCount > 0 && (
          <div className="flex items-center gap-1.5">
            <div className="flex">
              {[1, 2, 3, 4, 5].map((star) => (
                <i
                  key={star}
                  className={`${star <= Math.round(rating) ? 'ri-star-fill' : 'ri-star-line'} text-[11px] text-amber-400`}
                />
              ))}
            </div>
            <span className="text-[11px] text-gray-400">({reviewCount})</span>
          </div>
        )}

        {/* Price + CTA */}
        <div className="mt-auto pt-1 space-y-2.5">
          <div className="flex items-baseline gap-1.5">
            <span className="text-base font-bold text-gray-900">
              {hasVariants && minVariantPrice != null
                ? `From ${formatPrice(minVariantPrice)}`
                : formatPrice(price)}
            </span>
            {originalPrice && originalPrice > price && (
              <span className="text-xs text-gray-400 line-through">{formatPrice(originalPrice)}</span>
            )}
          </div>

          {hasVariants ? (
            <Link
              href={`/product/${slug}`}
              className="flex items-center justify-center gap-1.5 w-full py-2.5 rounded-xl bg-primary text-white text-[13px] font-semibold hover:bg-primary-dark active:scale-[0.98] transition-all duration-150"
            >
              Select Options <i className="ri-arrow-right-s-line text-sm" />
            </Link>
          ) : (
            <button
              type="button"
              onClick={handleAddToCart}
              disabled={!inStock || added}
              className={`flex items-center justify-center gap-1.5 w-full py-2.5 rounded-xl text-[13px] font-semibold transition-all duration-200 ${
                added
                  ? 'bg-primary-dark text-white'
                  : inStock
                  ? 'bg-primary text-white hover:bg-primary-dark active:scale-[0.98]'
                  : 'bg-gray-100 text-gray-400 cursor-not-allowed'
              }`}
            >
              {added ? (
                <><i className="ri-check-line" /> Added</>
              ) : inStock ? (
                <><i className="ri-shopping-bag-line" /> Add to Cart</>
              ) : (
                'Out of Stock'
              )}
            </button>
          )}
        </div>
      </div>

    </div>
  );
}
