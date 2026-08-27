import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = path.join(root, "dist");
const outputFile = path.join(outputDirectory, "openbio-comfy-mcp.mjs");

const result = await build({
  absWorkingDir: root,
  bundle: true,
  entryPoints: ["mcp_host/cli.mjs"],
  format: "esm",
  legalComments: "eof",
  metafile: true,
  outfile: outputFile,
  platform: "node",
  target: "node20",
});

const packageRoots = new Set();
for (const input of Object.keys(result.metafile.inputs)) {
  const absoluteInput = path.resolve(root, input);
  const marker = `${path.sep}node_modules${path.sep}`;
  const markerIndex = absoluteInput.lastIndexOf(marker);
  if (markerIndex === -1) continue;

  const packageParts = absoluteInput.slice(markerIndex + marker.length).split(path.sep);
  const packageLength = packageParts[0].startsWith("@") ? 2 : 1;
  packageRoots.add(
    path.join(
      absoluteInput.slice(0, markerIndex + marker.length),
      ...packageParts.slice(0, packageLength),
    ),
  );
}

const notices = [
  "# Third-party notices",
  "",
  "The bundled MCP server contains the following third-party packages. Their license texts are reproduced below.",
  "",
];

const packages = [];
for (const packageRoot of packageRoots) {
  const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  const files = await readdir(packageRoot);
  const licenseFile = files.find((file) => /^(licen[cs]e|copying)(\..*)?$/i.test(file));
  const licenseText = licenseFile
    ? (await readFile(path.join(packageRoot, licenseFile), "utf8")).trim()
    : "No standalone license file was included in the installed package.";

  packages.push({
    license: manifest.license ?? "Unspecified",
    licenseText,
    name: manifest.name,
    version: manifest.version,
  });
}

packages.sort((left, right) => left.name.localeCompare(right.name));
for (const dependency of packages) {
  notices.push(
    `## ${dependency.name} ${dependency.version}`,
    "",
    `License: ${dependency.license}`,
    "",
    "```text",
    dependency.licenseText,
    "```",
    "",
  );
}

await writeFile(
  path.join(outputDirectory, "THIRD_PARTY_NOTICES.md"),
  `${notices.join("\n")}\n`,
  "utf8",
);
