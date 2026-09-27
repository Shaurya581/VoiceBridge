# VoiceBridge

VoiceBridge is a voice-driven enterprise incident reporting and workflow application. This repository is the development foundation; voice capture and workflow features will be added in later phases.

## Stack

- Web: React, TypeScript, Vite, Tailwind CSS, Lucide
- API: Node.js, TypeScript, Express
- Data: PostgreSQL and Prisma ORM
- Local orchestration: Docker Compose

## Local development

Install Node.js 24 and pnpm 11, then install dependencies:

```sh
pnpm install
cp .env.example .env
```

With Docker available, start PostgreSQL, the API, and the web client:

```sh
docker compose up --build
```

The web client is at `http://localhost:5173` and the API health endpoint is at `http://localhost:4000/api/health`.

To run the applications directly, start PostgreSQL separately, then run `pnpm dev`. Configure `DATABASE_URL` in `.env` for the API database check.

## Verification

```sh
pnpm build
pnpm typecheck
pnpm test
```

The API health route reports service and database status. Database schema, migrations, seed data, and workflow APIs are planned for subsequent phases.

