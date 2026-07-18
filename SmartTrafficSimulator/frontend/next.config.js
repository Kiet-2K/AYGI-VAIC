/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  distDir: 'out',
  images: {
    unoptimized: true,
  },
  trailingSlash: true,
  // Disable server-side features for static export
  experimental: {
    // Ensure all pages are static
  },
};

module.exports = nextConfig;
