import { Metadata } from 'next';
import { createServerSupabase } from '@/lib/supabase-server';
import ProductDetailClient from './ProductDetailClient';

const SITE_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://kinagventures.com';
const SITE_NAME = 'KINAG VENTURES';

async function getProduct(slug: string) {
  try {
    const supabase = createServerSupabase('anon');
    const { data } = await supabase
      .from('products')
      .select(
        // Photos live in product_images (products has no `images` column; asking
        // for one failed the whole query, so every page said "Product Not Found").
        'name, description, short_description, seo_title, seo_description, images:product_images(url, position), price, compare_at_price, sku, brand, quantity, track_quantity, continue_selling, rating_avg, review_count, category_id, metadata'
      )
      .eq('slug', slug)
      .eq('status', 'active')
      .single();
    return data;
  } catch {
    return null;
  }
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const product = await getProduct(slug);

  if (!product) {
    return {
      title: 'Product Not Found | KINAG VENTURES',
      robots: { index: false, follow: false },
    };
  }

  const productUrl = `${SITE_URL}/product/${slug}`;
  const ogImage = product.images?.[0]?.url || '/logo-kinag.png';
  const metaTitleText = product.seo_title?.trim() || product.name;
  const title = `${metaTitleText} | ${SITE_NAME}`;
  const description =
    product.seo_description?.trim() ||
    product.short_description?.trim() ||
    (product.description
      ? `${product.description.slice(0, 155)}...`
      : `Shop ${product.name}. Quality imports, fast delivery across Ghana.`);

  return {
    title: metaTitleText,
    description,
    openGraph: {
      title,
      description,
      url: productUrl,
      type: 'website',
      siteName: SITE_NAME,
      locale: 'en',
      images: [{ url: ogImage, width: 1200, height: 630, alt: `${product.name} — ${SITE_NAME}` }],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: [ogImage],
    },
    alternates: { canonical: productUrl },
    keywords: [
      product.name,
      `buy ${product.name}`,
      'quality products',
      SITE_NAME,
    ].join(', '),
  };
}

export default async function ProductDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const product = await getProduct(slug);

  const productJsonLd = product
    ? (() => {
        const productUrl = `${SITE_URL}/product/${slug}`;
        const images = Array.isArray(product.images)
          ? product.images
              .map((img: any) => img?.url)
              .filter(Boolean)
              .map((u: string) => (u.startsWith('http') ? u : `${SITE_URL}${u}`))
          : [];
        const inStock =
          !product.track_quantity ||
          (product.quantity ?? 0) > 0 ||
          product.continue_selling === true;

        const schema: Record<string, any> = {
          '@context': 'https://schema.org',
          '@type': 'Product',
          name: product.name,
          description:
            product.seo_description?.trim() ||
            product.short_description?.trim() ||
            product.description ||
            product.name,
          image: images.length ? images : [`${SITE_URL}/logo-kinag.png`],
          url: productUrl,
          ...(product.sku && { sku: product.sku }),
          ...(product.brand && { brand: { '@type': 'Brand', name: product.brand } }),
          offers: {
            '@type': 'Offer',
            url: productUrl,
            priceCurrency: 'GHS',
            price: Number(product.price ?? 0).toFixed(2),
            itemCondition: 'https://schema.org/NewCondition',
            availability: inStock
              ? 'https://schema.org/InStock'
              : 'https://schema.org/OutOfStock',
            seller: { '@type': 'Organization', name: SITE_NAME },
          },
        };

        if ((product.review_count ?? 0) > 0 && (product.rating_avg ?? 0) > 0) {
          schema.aggregateRating = {
            '@type': 'AggregateRating',
            ratingValue: Number(product.rating_avg).toFixed(1),
            reviewCount: product.review_count,
          };
        }

        return schema;
      })()
    : null;

  return (
    <>
      {productJsonLd && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(productJsonLd) }}
        />
      )}
      <ProductDetailClient slug={slug} />
    </>
  );
}
