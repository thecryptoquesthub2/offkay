const { handler } = require("../server");

module.exports = (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const path = url.searchParams.get("path");

  if (path) {
    url.searchParams.delete("path");
    const query = url.searchParams.toString();
    req.url = `/api/${decodeURIComponent(path)}${query ? `?${query}` : ""}`;
  }

  return handler(req, res);
};
