- Do not use code comments, name variables correctly instead

## GitHub Actions owns the data

`.github/workflows/daily.yml` crawls at 10:37 UTC and commits `data/housing.db`
and `docs/index.html` to `main`. `main` therefore has a second author that
pushes every day.

- Pull before editing anything. A checkout more than a day old will have its
  first push rejected.
- Do not run `node src/crawl.js` or `bin/daily.sh` casually to check something.
  Both mutate the tracked SQLite file, git cannot merge a binary, and resolving
  that conflict by picking a side silently discards a day of history. To test
  the scrapers, run the `probe` workflow — it writes nothing and reports the
  runner's egress IP. A local crawl is only correct as: pull, run, push
  immediately.
- `crawl.js` exit 2 means it refused to crawl against an empty baseline. That is
  the guard working. Never reach for `--bootstrap` to get past it unless the
  database is genuinely new — bootstrapping over a failed restore is exactly the
  history loss the guard exists to prevent.
- The launchd agent is unloaded deliberately. Do not reload it while Actions
  owns the schedule, or the two will both crawl and fight over the same commit.
