#!/usr/bin/env node
/**
 * Generate favicon PNG files and OG image from SVG source
 * Run with: node scripts/generate-icons.js
 */

import sharp from 'sharp';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, '..', 'public');

// Brand colors
const COLORS = {
  bg: '#0a0a0f',
  accent: '#00ff88',
  text: '#ffffff',
};

// Icon sizes to generate
const FAVICON_SIZES = [
  { name: 'favicon-16x16.png', size: 16 },
  { name: 'favicon-32x32.png', size: 32 },
  { name: 'favicon-192x192.png', size: 192 },
  { name: 'favicon-512x512.png', size: 512 },
  { name: 'apple-touch-icon.png', size: 180 },
];

// OG Image dimensions
const OG_IMAGE = {
  width: 1200,
  height: 630,
};

/**
 * Create SVG source for favicon at given size
 */
function createFaviconSvg(size) {
  const cornerRadius = Math.round(size * 0.1875); // 6/32 ratio
  const fontSize = Math.round(size * 0.5); // 16/32 ratio
  const textY = Math.round(size * 0.6875); // 22/32 ratio

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
  <rect width="${size}" height="${size}" rx="${cornerRadius}" fill="${COLORS.bg}"/>
  <text x="${size / 2}" y="${textY}" font-family="Inter, system-ui, sans-serif" font-size="${fontSize}" font-weight="bold" fill="${COLORS.accent}" text-anchor="middle">n</text>
</svg>`;
}

/**
 * Create OG image SVG
 */
function createOgImageSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${OG_IMAGE.width} ${OG_IMAGE.height}" width="${OG_IMAGE.width}" height="${OG_IMAGE.height}">
  <defs>
    <linearGradient id="bgGradient" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#0a0a0f"/>
      <stop offset="50%" style="stop-color:#12121a"/>
      <stop offset="100%" style="stop-color:#0a0a0f"/>
    </linearGradient>
    <linearGradient id="accentGradient" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" style="stop-color:#00ff88"/>
      <stop offset="100%" style="stop-color:#00d4ff"/>
    </linearGradient>
    <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="3" result="blur"/>
      <feComposite in="SourceGraphic" in2="blur" operator="over"/>
    </filter>
  </defs>

  <!-- Background -->
  <rect width="100%" height="100%" fill="url(#bgGradient)"/>

  <!-- Grid pattern -->
  <g opacity="0.1" stroke="${COLORS.accent}" stroke-width="0.5">
    ${Array.from({ length: 25 }, (_, i) => `<line x1="${i * 50}" y1="0" x2="${i * 50}" y2="${OG_IMAGE.height}"/>`).join('\n    ')}
    ${Array.from({ length: 13 }, (_, i) => `<line x1="0" y1="${i * 50}" x2="${OG_IMAGE.width}" y2="${i * 50}"/>`).join('\n    ')}
  </g>

  <!-- Logo icon -->
  <g transform="translate(100, 215)">
    <rect width="200" height="200" rx="40" fill="${COLORS.bg}" stroke="${COLORS.accent}" stroke-width="3"/>
    <text x="100" y="140" font-family="Inter, system-ui, sans-serif" font-size="120" font-weight="bold" fill="${COLORS.accent}" text-anchor="middle" filter="url(#glow)">n</text>
  </g>

  <!-- Title -->
  <text x="350" y="280" font-family="Inter, system-ui, sans-serif" font-size="72" font-weight="bold" fill="${COLORS.text}">noex</text>

  <!-- Subtitle -->
  <text x="350" y="350" font-family="Inter, system-ui, sans-serif" font-size="36" fill="${COLORS.text}" opacity="0.9">Erlang/OTP Patterns for Node.js</text>

  <!-- Tagline -->
  <text x="350" y="410" font-family="Inter, system-ui, sans-serif" font-size="24" fill="${COLORS.text}" opacity="0.6">Build fault-tolerant, scalable systems with TypeScript</text>

  <!-- Bottom accent line -->
  <rect x="0" y="${OG_IMAGE.height - 6}" width="${OG_IMAGE.width}" height="6" fill="url(#accentGradient)"/>
</svg>`;
}

/**
 * Generate PNG from SVG string
 */
async function svgToPng(svgString, outputPath, width, height) {
  await sharp(Buffer.from(svgString))
    .resize(width, height)
    .png()
    .toFile(outputPath);
}

/**
 * Main function
 */
async function main() {
  console.log('Generating favicon PNG files and OG image...\n');

  // Generate favicons
  for (const { name, size } of FAVICON_SIZES) {
    const svgContent = createFaviconSvg(size);
    const outputPath = join(publicDir, name);
    await svgToPng(svgContent, outputPath, size, size);
    console.log(`  Created: ${name} (${size}x${size})`);
  }

  // Generate OG image
  const ogSvg = createOgImageSvg();
  const ogPath = join(publicDir, 'og-image.png');
  await svgToPng(ogSvg, ogPath, OG_IMAGE.width, OG_IMAGE.height);
  console.log(`  Created: og-image.png (${OG_IMAGE.width}x${OG_IMAGE.height})`);

  console.log('\nAll icons generated successfully!');
}

main().catch(console.error);
