# Gumroad on Next.js

The TypeScript/Prisma/Next.js port of the Rails app, running beside it on the same database.
Plan and workstreams: [docs/nextjs-rewrite](../docs/nextjs-rewrite/README.md).

```bash
npm install
cp .env.example .env        # point DATABASE_URL at the Rails dev database
npm run dev                 # http://localhost:3100
npm test                    # parity tests
npm run typecheck
```

`prisma/schema.prisma` is generated from `../db/schema.rb`; never edit it by hand. After a Rails
migration, run `npm run prisma:generate-schema`.
