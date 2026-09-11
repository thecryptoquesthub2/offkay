// Vercel serverless entry. vercel.json rewrites /api/* to /api/index?path=...,
// so reconstruct the real path and hand the request to the app's handler.
// Health and all other API routes live in server.js - this file only rewrites URLs.
module.exports = (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const path = url.searchParams.get("path");

  if (path) {
    url.searchParams.delete("path");
    const query = url.searchParams.toString();
    req.url = `/api/${decodeURIComponent(path)}${query ? `?${query}` : ""}`;
  }

  return require("../server").handler(req, res);
};
