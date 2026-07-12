#!/usr/bin/env node
// Generate PNG icons from the base SVG for Chrome extension
// Requires: npm i -D sharp

const fs = require('fs');
const path = require('path');

async function run() {
  const sharp = require('sharp');
  const sizes = [16, 32, 48, 128];
  const baseSvgPath = path.resolve(__dirname, '..', 'src', 'assets', 'icons', 'icon.svg');
  const outDir = path.resolve(__dirname, '..', 'src', 'assets', 'icons');

  if (!fs.existsSync(baseSvgPath)) {
    console.error('Base SVG not found:', baseSvgPath);
    process.exit(1);
  }
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const svgBuffer = fs.readFileSync(baseSvgPath);
  for (const size of sizes) {
    const outPath = path.join(outDir, `icon${size}.png`);
    await sharp(svgBuffer, { density: 384 }) // higher density for sharper small sizes
      .resize(size, size)
      .png()
      .toFile(outPath);
    console.log('Generated', path.relative(process.cwd(), outPath));

    // grayscale variant for paused state
    const grayPath = path.join(outDir, `icon${size}_gray.png`);
    await sharp(svgBuffer, { density: 384 })
      .resize(size, size)
      .grayscale()
      .modulate({ brightness: 1, saturation: 0 })
      .png()
      .toFile(grayPath);
    console.log('Generated', path.relative(process.cwd(), grayPath));
  }
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
