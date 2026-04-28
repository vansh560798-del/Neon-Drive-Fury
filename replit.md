# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Artifacts

- **lucidex-racing** — Cyberpunk 3D racing game built with React + Vite + Three.js (react-three-fiber). Frontend-only, single-file game in `artifacts/lucidex-racing/src/Game.tsx`. Includes nitro/2x-multiplier/shield pickups, near-miss combo system with score multiplier, matching HUD pills + audio cues, a 15-car selectable garage with per-car visual styling and speed/accel/grip stat differentiation, and 10 selectable routes (themed worlds) that re-skin sky/fog/road/buildings/arches/lights. Both car and route selections persist in localStorage.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
