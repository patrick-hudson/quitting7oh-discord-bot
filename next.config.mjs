/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverActions: { allowedOrigins: ["localhost:3000"] },
  },
  // discord.js is server-only; don't try to bundle it for edge/client
  serverExternalPackages: ["discord.js", "@prisma/client"],
};

export default nextConfig;
