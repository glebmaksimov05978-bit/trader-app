// src/components/shared/BrandIcon.js
//
// Trend-line + bar mark, designed by Kimi from the brief the trader sent it
// (2026-08-18) — replaces the plain "T" letter in the sidebar header and the old
// hexagon mark on the login page's brand panel. Rendered in white here because both
// of those spots put the icon INSIDE an already-colored indigo/purple gradient square
// (`.logo-icon`, `.brand-logo-icon`) — Kimi's original two-tone version (indigo line +
// green bar, see BrandIconColor below) would go invisible against that same indigo
// background. Same "outline full white, fill 30% white" convention the old login-page
// hexagon already used, so swapping the mark in doesn't change the container's look.
export default function BrandIcon({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" fill="none">
      <path d="M 64 400 L 256 256 L 448 112" stroke="white" strokeWidth="56" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="188" y="132" width="136" height="248" rx="28" fill="white" fillOpacity="0.3" />
    </svg>
  );
}

// The original two-tone colors (indigo trend line + green bar) — for spots with NO
// colored square behind the icon (e.g. a future PWA home-screen icon on a plain dark
// background), where the color contrast Kimi designed for actually shows.
export function BrandIconColor({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" fill="none">
      <path d="M 64 400 L 256 256 L 448 112" stroke="#4f46e5" strokeWidth="56" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="188" y="132" width="136" height="248" rx="28" fill="#10b981" />
    </svg>
  );
}
