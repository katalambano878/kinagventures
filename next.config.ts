import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Coolify Dockerfile build: only Next's standalone server goes in the image.
  output: 'standalone',
  images: {
    minimumCacheTTL: 2592000, // Cache optimized images for 30 days
    // Uploaded photos are stored host-relative (/storage/v1/object/public/...)
    // and served by this app; '/**' keeps the files in public/.
    localPatterns: [
      { pathname: '/storage/v1/**' },
      { pathname: '/**' },
    ],
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '*.supabase.co',
        pathname: '/storage/v1/object/public/**',
      },
      // Absolute URLs to this app's own storage.
      {
        protocol: 'https',
        hostname: 'www.kinagventures.com',
        pathname: '/storage/v1/**',
      },
      {
        protocol: 'https',
        hostname: 'kinagventures.com',
        pathname: '/storage/v1/**',
      },
      {
        protocol: 'https',
        hostname: 'images.unsplash.com',
      },
      {
        protocol: 'https',
        hostname: 'via.placeholder.com',
      },
      {
        protocol: 'https',
        hostname: 'placehold.co',
        pathname: '/**',
      },
    ],
  },
  typescript: {
    // TypeScript checks enabled - type errors will fail build
    ignoreBuildErrors: false,
  },
  // Security + Caching headers
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-DNS-Prefetch-Control', value: 'on' },
          { key: 'X-XSS-Protection', value: '1; mode=block' },
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' }
        ]
      },
      // Cache storefront API routes aggressively (5 min CDN, revalidate in background)
      {
        source: '/api/storefront/:path*',
        headers: [
          { key: 'Cache-Control', value: 'public, s-maxage=900, stale-while-revalidate=1800' }
        ]
      },
      // Cache static assets (JS, CSS, fonts) for 1 year (they have content hashes)
      {
        source: '/_next/static/:path*',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }
        ]
      },
      // Cache optimized images for 30 days
      {
        source: '/_next/image',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=2592000, stale-while-revalidate=86400' }
        ]
      }
    ];
  }
};

export default nextConfig;
