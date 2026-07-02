import type { ProjectType } from '../shared/types'

export interface SeedProject {
  name: string
  /** path relative to the user home dir (C:\Users\chris); use '/' separators */
  dir: string
  type: ProjectType
  stack: string
}

// Curated from the TOOL-STACK.md project map. Only seeded if the folder exists.
export const SEED_PROJECTS: SeedProject[] = [
  { name: 'Squishy Smash', dir: 'Roblox-squishy', type: 'roblox', stack: 'Rojo · Luau · Open Cloud · Meshy' },
  { name: 'Gnarly Nutmeg', dir: 'Roblox-gnarly-nutmeg', type: 'roblox', stack: 'Rojo · Luau' },
  { name: 'Basketball 3PT', dir: 'Roblox-basketball-3pt', type: 'roblox', stack: 'Rojo · Luau (scaffold)' },
  { name: 'Hytopia Games', dir: 'Hytopia-games', type: 'hytopia', stack: 'HYTOPIA SDK · TS · Bun' },
  { name: 'Merkari (HYTOPIA)', dir: 'Merkari-HYTOPIA', type: 'hytopia', stack: 'HYTOPIA SDK · HYCHAIN' },
  { name: 'Free Fall', dir: 'Free-fall', type: 'hytopia', stack: 'HYTOPIA SDK · Bun' },
  { name: 'Unreal — Gnarly', dir: 'Unreal-Gnarly', type: 'unreal', stack: 'UE 5.8 · Blueprint · MCP' },
  { name: 'Unreal — Squishy', dir: 'Unreal-squishy', type: 'unreal', stack: 'UE 5.8 · Blueprint' },
  {
    name: 'Scrapstorm Arena',
    dir: 'scrapstorm-arena',
    type: 'web-app',
    stack: 'R3F · Three.js · Rapier · Vite'
  },
  { name: 'three-j (Sports Academy)', dir: 'three-j', type: 'web-app', stack: 'R3F · Capacitor · Colyseus' },
  { name: 'Pregame', dir: 'Pregame', type: 'mobile-app', stack: 'Flutter · Firebase · Stripe' },
  {
    name: 'Pregame — World Cup',
    dir: 'Pregame-World-Cup',
    type: 'mobile-app',
    stack: 'Flutter · Firebase · Twilio'
  },
  {
    name: 'Kentucky Wildcats',
    dir: 'Kentucky-Wildcats',
    type: 'mobile-app',
    stack: 'Flutter + React · Firebase'
  },
  {
    name: 'Athlete Domains iOS',
    dir: 'athlete-domains-ios',
    type: 'mobile-app',
    stack: 'Capacitor · Three.js · Firebase'
  },
  {
    name: 'Rage Smash (Fast-games)',
    dir: 'Fast-games',
    type: 'mobile-app',
    stack: 'Three.js · Capacitor · StoreKit'
  },
  { name: 'App-store (4 games)', dir: 'App-store', type: 'mobile-app', stack: 'Three.js · Vite · Capacitor' },
  {
    name: 'Overtime-Care',
    dir: 'Overtime-Care',
    type: 'web-app',
    stack: 'Next.js · Prisma · AWS · Terraform'
  },
  {
    name: 'New-apps (SaaS)',
    dir: 'New-apps',
    type: 'web-app',
    stack: 'Next.js 16 · shadcn · Stripe · Supabase'
  },
  {
    name: 'The Classified Files',
    dir: 'The-Classified-Files',
    type: 'web-app',
    stack: 'Vite PWA · Express · Stripe'
  },
  {
    name: 'Board Battle (MA-Training)',
    dir: 'MA-Training',
    type: 'web-app',
    stack: 'Vite · React · Tailwind'
  },
  { name: 'Sports Trader', dir: 'sports-trader', type: 'web-app', stack: 'FastAPI · odds APIs · ML' },
  {
    name: 'FounderOS (v1, retired)',
    dir: 'Personal-IDE/founderos',
    type: 'web-app',
    stack: 'Next.js + Electron — harvest source'
  },
  { name: 'CryptoBot', dir: 'CryptoBot', type: 'crypto-web3', stack: 'CCXT · multi-LLM · PM2' },
  {
    name: 'Crypto Coin Launcher',
    dir: 'Crypto-coin-launcher',
    type: 'crypto-web3',
    stack: 'Solana · Base · Next.js'
  },
  {
    name: '$GIVE Experiment',
    dir: 'give-experiment',
    type: 'crypto-web3',
    stack: 'Solidity · Hardhat · Foundry'
  },
  { name: 'Crypto Book', dir: 'crypto-book', type: 'crypto-web3', stack: 'KDP · Base NFT · Python' },
  {
    name: 'AI Creators',
    dir: 'AI-creators',
    type: 'ai-content',
    stack: 'FLUX · Recraft · ElevenLabs · FFmpeg'
  },
  { name: 'Income Kit', dir: 'income-kit', type: 'ai-content', stack: 'video-factory · agent pack' },
  { name: 'The Red Brick Road', dir: 'The-Red-Brick-Road', type: 'other', stack: 'Python · KDP · NFT' },
  {
    name: 'Athlete Domains (site)',
    dir: 'athlete-domains-site',
    type: 'static-site',
    stack: 'HTML/CSS/JS · Netlify'
  },
  { name: 'Chris Website', dir: 'Chris-website', type: 'static-site', stack: 'Next.js static · MDX' },
  { name: 'KK Designs', dir: 'KKdesigns', type: 'static-site', stack: 'HTML · Tailwind CDN' },
  { name: 'Builder Hub (this app)', dir: 'builder-hub', type: 'web-app', stack: 'Electron · Vite · React' }
]
