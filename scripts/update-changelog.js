const fs = require("node:fs");

const file = "CHANGELOG.md";
const version = process.env.npm_new_version;

if (!version) {
  throw new Error("Missing npm_new_version. Run via npm version.");
}

const date = new Date().toISOString().slice(0, 10);
const changelog = fs.readFileSync(file, "utf8");

const heading = /^## \[Unreleased\][^\S\r\n]*$/m;

if (!heading.test(changelog)) {
  throw new Error("Missing ## [Unreleased] heading in CHANGELOG.md");
}

const updated = changelog.replace(
  heading,
  `## [Unreleased]\n\n## [${version}] - ${date}`,
);

fs.writeFileSync(file, updated);
console.log(`Updated CHANGELOG.md for v${version}`);
