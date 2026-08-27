- Do not use code comments, name variables correctly instead

## GitHub Actions owns the data

`.github/workflows/daily.yml` crawls four times a day (08:37, 14:37, 18:37 and
00:37 UTC — 04:37/10:37/14:37/20:37 EDT) and commits `data/housing.db` and
`docs/index.html` to `main`. `main` therefore has a second author that pushes
several times a day.

- Pull before editing anything, and again before pushing. A checkout a few hours
  old will have its first push rejected.
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
