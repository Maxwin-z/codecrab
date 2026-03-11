lsof -t -i:4200 | xargs kill
pnpm run dev:server
