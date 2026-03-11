lsof -t -i:5730 | xargs kill
pnpm run dev:app
