/** @type {import('next').NextConfig} */
const proxyTarget = process.env.API_PROXY_TARGET;

const nextConfig = {
  output: "standalone",
  reactStrictMode: true,
  poweredByHeader: false,
  // Optional same-origin proxy: set NEXT_PUBLIC_API_URL=/api and API_PROXY_TARGET=http://backend:8000
  // when the API does not send CORS headers for the frontend origin.
  async rewrites() {
    return proxyTarget ? [{ source: "/api/:path*", destination: `${proxyTarget}/:path*` }] : [];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
};

export default nextConfig;
