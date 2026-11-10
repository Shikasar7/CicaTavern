#!/usr/bin/env bash
# Opens CicaTavern.app the way a person does and records what it shows. Run on
# a Mac with a desktop session (GitHub's macOS runners, by .github/workflows/mac-test.yml);
# it uses the real port (8790) and data folder (~/.cicatavern), so not on your own Mac.
#
#   bash scripts/mac-gui-test.sh <CicaTavern-<version>-mac-<arch>.zip> <out>
#
# The zip is unpacked into ~/Applications and opened with `open`. Checks:
#   - a CicaTavern window comes up and the page in it reaches the server
#     (a WebKit connection to 127.0.0.1:8790);
#   - /api/status answers with this version, edition release, the check-only
#     Mac updater, from the app's own runtime/node;
#   - closing the app leaves the server to quit by itself (its idle exit).
# Screenshots in <out>: the first start (隐私与网络 notice), the empty main
# window once the notice is confirmed, then the example card imported and
# opened, in English and in Chinese; a recording of the first start; the logs.
# The zip is not quarantined here, so Gatekeeper's first-open prompt is not
# part of this test (spctl's verdict is logged).
set -euo pipefail

zip=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
out=$2
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
VERSION=${VERSION:-$(node -p "require('$root/package.json').version")}
port=8790
base="http://127.0.0.1:$port"
mkdir -p "$out"
out=$(cd "$out" && pwd)
tmp=$(mktemp -d)
log="$out/steps.log"
say() { echo "$*" | tee -a "$log"; }

{
  sw_vers
  echo "machine: $(uname -m), $(sysctl -n machdep.cpu.brand_string 2> /dev/null || true)"
  echo "screen: $(system_profiler SPDisplaysDataType 2> /dev/null | grep -E 'Resolution' | head -1 | sed 's/^ *//')"
} > "$out/system.txt"
cat "$out/system.txt" | tee -a "$log"

# Window list (CoreGraphics): "id x y width height title" for each normal window of an app.
# The title is empty without Screen Recording permission.
cat > "$tmp/windows.swift" << 'EOF'
import CoreGraphics
import Foundation

let owner = CommandLine.arguments.dropFirst().first ?? "CicaTavern"
let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
for window in windows where window[kCGWindowOwnerName as String] as? String == owner && window[kCGWindowLayer as String] as? Int == 0 {
    let id = window[kCGWindowNumber as String] as? Int ?? 0
    let bounds = window[kCGWindowBounds as String] as? [String: Any] ?? [:]
    let size = { (key: String) -> Int in Int((bounds[key] as? NSNumber)?.doubleValue ?? 0) }
    print("\(id) \(size("X")) \(size("Y")) \(size("Width")) \(size("Height")) \(window[kCGWindowName as String] as? String ?? "")")
}
EOF
swiftc -O -o "$tmp/windows" "$tmp/windows.swift"

apps="$HOME/Applications"
app="$apps/CicaTavern.app"
mkdir -p "$apps"
rm -rf "$app"
ditto -x -k "$zip" "$apps"
codesign --verify --deep --strict "$app"
say "Gatekeeper's verdict on this app (accepted when it is notarized; an ad hoc signed one is rejected):"
spctl --assess --type execute -vv "$app" 2>&1 | tee -a "$log" || true

api() {
  local method=$1 path=$2 body=${3:-}
  if [ -n "$body" ]; then
    curl -fsS -X "$method" -H 'x-agent-tavern: 1' -H 'content-type: application/json' --data-binary "$body" "$base$path"
  else
    curl -fsS "$base$path"
  fi
}

running() { pgrep -x CicaTavern > /dev/null; }

open_app() {
  local name=$1
  say "open: $name"
  open --stdout "$out/app-$name.log" --stderr "$out/app-$name.log" "$app" 2>> "$log" || open "$app"
}

# The window, then the server, then the page's own connection to it.
wait_ready() {
  local window=""
  for _ in $(seq 1 120); do
    window=$("$tmp/windows" CicaTavern | head -1)
    [ -n "$window" ] && break
    sleep 1
  done
  if [ -z "$window" ]; then
    say "no CicaTavern window after 2 minutes"
    return 1
  fi
  say "window: $window"
  for _ in $(seq 1 120); do
    api GET /api/status > "$tmp/status.json" 2> /dev/null && break
    sleep 1
  done
  [ -s "$tmp/status.json" ] || { say "no answer on $base"; return 1; }
  for _ in $(seq 1 60); do
    if lsof -nP -iTCP:"$port" -sTCP:ESTABLISHED 2> /dev/null | grep -v '^node ' | grep -q -- "->127.0.0.1:$port"; then
      break
    fi
    sleep 1
  done
  lsof -nP -iTCP:"$port" 2> /dev/null >> "$log" || true
  if ! lsof -nP -iTCP:"$port" -sTCP:ESTABLISHED 2> /dev/null | grep -v '^node ' | grep -q -- "->127.0.0.1:$port"; then
    say "the window's page never connected to the server"
    return 1
  fi
  # Fonts, pictures, the first paint.
  sleep 6
  echo "$window" > "$tmp/window"
}

shoot() {
  local name=$1 id
  id=$(cut -d' ' -f1 < "$tmp/window")
  screencapture -x "$out/$name-screen.png"
  screencapture -x -o -l"$id" "$out/$name.png" || cp "$out/$name-screen.png" "$out/$name.png"
  say "screenshot: $name.png ($(sips -g pixelWidth -g pixelHeight "$out/$name.png" | awk '/pixel/ {print $2}' | paste -sd x -))"
}

# Quit as ⌘Q does (the app leaves the page first, then quits). The Apple Event may
# need an Automation permission this Mac has not given, so it gets 10 seconds;
# then SIGTERM.
close_app() {
  running || return 0
  osascript -e 'tell application id "app.cicatavern.mac" to quit' > /dev/null 2>&1 &
  local asker=$!
  for _ in $(seq 1 10); do
    running || break
    sleep 1
  done
  kill "$asker" 2> /dev/null || true
  if running; then
    say "quit: no answer to the Apple Event, so SIGTERM"
    pkill -TERM -x CicaTavern || true
  else
    say "quit: by Apple Event, as ⌘Q"
  fi
  for _ in $(seq 1 30); do
    running || return 0
    sleep 1
  done
  say "CicaTavern did not quit"
  return 1
}

check_status() {
  node -e '
    const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))
    const problems = []
    if (s.version !== process.argv[2]) problems.push(`version ${s.version}`)
    if (s.edition !== "release") problems.push(`edition ${s.edition}`)
    if (s.features?.updates !== "mac") problems.push(`updates ${s.features?.updates}`)
    if (problems.length) { console.error("unexpected /api/status:", problems.join(", ")); process.exit(1) }
    console.log(`/api/status: ${s.edition} ${s.version}, updates: ${s.features.updates}, data: ${s.dataRoot}`)
  ' "$tmp/status.json" "$VERSION" | tee -a "$log"
  local pid command
  pid=$(lsof -nP -t -iTCP:"$port" -sTCP:LISTEN | head -1)
  echo "$pid" > "$tmp/server.pid"
  command=$(ps -o command= -p "$pid")
  say "server process: $command"
  case "$command" in
    *"$app/Contents/Resources/app/runtime/node"*) ;;
    *) say "the server is not the app's own runtime/node"; return 1 ;;
  esac
  say "runtime/node: $(file -b "$app/Contents/Resources/app/runtime/node")"
}

# 1. First start: the window, the bundled server, the 隐私与网络 notice.
running && close_app
(screencapture -x -v -V 15 "$out/first-start.mov" > /dev/null 2>&1 || true) &
recorder=$!
open_app first-start
wait_ready
check_status
shoot 1-first-start

# 2. The notice confirmed (as its 「好，开始吧」 does) and no card yet: the empty
#    main window, which also marks this version's 更新了什么 as seen, as for a new player.
api PUT /api/settings '{"privacyNotice":1}' > /dev/null
close_app
open_app empty
wait_ready
shoot 2-empty

# 3. The example card imported: the app opens on it. 更新了什么 showing here would
#    mean the page's storage did not survive the restart.
node -e '
  const fs = require("fs")
  const file = process.argv[1]
  process.stdout.write(JSON.stringify({ filename: require("path").basename(file), data: fs.readFileSync(file).toString("base64") }))
' "$app/Contents/Resources/app/examples/示例-小雨.json" > "$tmp/card.json"
api POST /api/cards/import "@$tmp/card.json" | head -c 300 | tee -a "$log"
echo | tee -a "$log"
close_app
open_app card
wait_ready
shoot 3-card

# 4. The same in Chinese (设置 → 更多 → 界面语言).
api PUT /api/settings '{"uiLanguage":"zh"}' > /dev/null
close_app
open_app chinese
wait_ready
shoot 4-card-chinese

# 5. Closed: the page has gone, so the server quits by itself about a minute
#    later. Watched by its process, not by asking it: a request restarts the countdown.
close_app
cp "$HOME/.cicatavern/logs/server.log" "$out/server.log" 2> /dev/null || true
server=$(cat "$tmp/server.pid")
say "app closed; waiting for the server (pid $server) to quit by itself"
stopped=""
for _ in $(seq 1 60); do
  if ! kill -0 "$server" 2> /dev/null; then
    stopped=1
    break
  fi
  sleep 2
done
pkill -x screencapture 2> /dev/null || true
wait "$recorder" 2> /dev/null || true
if [ -z "$stopped" ]; then
  say "the server was still running 2 minutes after the app closed"
  exit 1
fi
say "the server quit by itself after the app closed"
cp "$HOME/.cicatavern/logs/server.log" "$out/server.log" 2> /dev/null || true
say "all checks passed"
