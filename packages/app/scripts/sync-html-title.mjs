import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

const { title } = JSON.parse(
  fs.readFileSync(path.join(projectRoot, "site.config.json"), "utf8")
);

const htmlFiles = [
  path.join(projectRoot, "index.html"),
  path.join(projectRoot, "public", "index.html"),
  path.join(projectRoot, "site", "index.html"),
];

for (const htmlFile of htmlFiles) {
  const current = fs.readFileSync(htmlFile, "utf8");
  const updated = current.replace(/<title>.*?<\/title>/s, `<title>${title}</title>`);

  if (updated !== current) {
    fs.writeFileSync(htmlFile, updated, "utf8");
  }
}