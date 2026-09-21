/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // An SOV exhibit is a few hundred KB, but a subcontract with the SOV
    // buried in it runs larger. The default 1 MB rejects those with a stack
    // trace rather than a message anyone can act on.
    serverActions: { bodySizeLimit: "6mb" },
    // pdf.js resolves its worker, standard fonts and cmaps relative to its
    // own package directory at runtime. Bundling rewrites those paths and the
    // lookups fail, so it stays an external require on the server.
    serverComponentsExternalPackages: ["pdfjs-dist"],
    // The worker is imported by its package path so the tracer can follow it,
    // but naming it here as well costs nothing and means a tracer change can
    // never quietly strand it. Without the file the PDF reader fails only in
    // production, with a module-not-found, while working on every machine
    // that has the full node_modules.
    outputFileTracingIncludes: {
      "/projects/**": ["./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"],
    },
  },
};

export default nextConfig;
