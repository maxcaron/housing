#!/bin/bash
# Daily pipeline, run by launchd (~/Library/LaunchAgents/com.maximecaron.housing.plist):
# crawl -> regenerate dashboard -> publish docs/index.html to GitHub Pages.
#
# The dashboard is regenerated and pushed EVEN IF the crawl fails — the page's
# stale-data banner is the alerting mechanism, so a broken crawl must reach the
# hosted page rather than silently freezing it at the last good state.
set -u
cd "$(dirname "$0")/.."

# launchd provides a bare PATH; node lives in nvm
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
if ! command -v node >/dev/null; then
  echo "FATAL: node not found" >&2
  exit 1
fi

echo "=== $(date -u +%FT%TZ) daily run start"
node src/crawl.js
crawl_status=$?

node src/report-html.js || exit 1
cp data/report.html docs/index.html

git add docs
if ! git diff --cached --quiet; then
  git commit -q -m "daily data update $(date +%F)" && git push -q
  echo "published"
else
  echo "no changes to publish"
fi

echo "=== done (crawl exit ${crawl_status})"
exit "${crawl_status}"
