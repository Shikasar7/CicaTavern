#!/usr/bin/env bash
# The macOS build's steps, shared by .github/workflows/mac-release.yml (the
# release) and mac-test.yml (the same build, opened on GitHub's Macs with
# screenshots). Runs on a Mac with the Xcode command line tools.
#
#   bash scripts/mac-build.sh node <dir> <arch>...
#       Official Node.js $NODE_VERSION for darwin-<arch>, checked against the
#       SHASUMS256.txt nodejs.org publishes, unpacked into <dir>.
#   bash scripts/mac-build.sh app <arch> <node-dir> <work> <dist>
#       <work>/CicaTavern.app for <arch> (arm64 | x64): the app folder from
#       scripts/stage-release.mjs --platform mac, the launcher compiled from
#       launcher/mac/main.swift, Info.plist with the version, an icns from
#       docs/brand/icon-mac-1024.png. Signed ad hoc (runtime/node keeps the
#       Node.js Foundation's own signature) and packed by ditto, which keeps
#       the executable bits, into <dist>/CicaTavern-<version>-mac-<arch>.zip.
#   bash scripts/mac-build.sh dmg <app> <dist> <arch>
#       <dist>/CicaTavern-<version>-mac-<arch>.dmg, what people download: the
#       app beside a link to /Applications over docs/brand/dmg-background, so it
#       is installed by dragging one onto the other (dmgbuild with
#       scripts/dmg-settings.py, through scripts/dmg-build.py). DMG_PYTHON is a
#       Python with scripts/dmg-requirements.txt installed (else python3). The
#       image is mounted again: the app inside verifies, the link is there.
#   bash scripts/mac-build.sh smoke <zip> <port> <data>
#       The zip unpacked again: its signature checks out, and its own Node
#       starts the server with bin/start.mjs, then with bin/launch.mjs
#       --no-window (what the app runs); /api/status must give the version,
#       edition release and the Mac updater; POST /api/shutdown stops it each
#       time. Then, as after an in-app update: with a version installed in
#       Application Support and its mark there, the app's launch.mjs starts
#       that one (HOME is a scratch folder).
#
# Environment: NODE_VERSION (v24.22.0), MACOS_MIN (13.5: Node 24's own
# minimum, as in launcher/mac/Info.plist), VERSION (package.json's).
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
MACOS_MIN=${MACOS_MIN:-13.5}
VERSION=${VERSION:-$(node -p "require('$root/package.json').version")}
# CFBundleVersion takes numbers only: 1.8.0-beta.1 → 1.8.0.
BUNDLE_VERSION=${VERSION%%-*}

cpu_of() { [ "$1" = arm64 ] && echo arm64 || echo x86_64; }

node_download() {
  local dir=$1
  shift
  : "${NODE_VERSION:?NODE_VERSION is not set}"
  mkdir -p "$dir"
  local sums="$dir/SHASUMS256-${NODE_VERSION}.txt"
  curl -fsSL -o "$sums" "https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt"
  for arch in "$@"; do
    local tarball="node-${NODE_VERSION}-darwin-${arch}.tar.gz"
    (cd "$dir" && curl -fsSLO "https://nodejs.org/dist/${NODE_VERSION}/${tarball}" && grep "  ${tarball}\$" "$sums" | shasum -a 256 -c -)
    tar -xzf "$dir/$tarball" -C "$dir"
    rm "$dir/$tarball"
  done
  rm "$sums"
}

build_app() {
  local arch=$1 node_dir=$2 work=$3 dist=$4
  local cpu app node_bin icon
  cpu=$(cpu_of "$arch")
  app="$work/CicaTavern.app"
  node_bin="$node_dir/node-${NODE_VERSION:?NODE_VERSION is not set}-darwin-${arch}/bin/node"
  rm -rf "$app"
  mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources" "$dist"

  node "$root/scripts/stage-release.mjs" --platform mac --arch "$arch" --node "$node_bin" --out "$app/Contents/Resources/app"
  swiftc -O -swift-version 5 -target "${cpu}-apple-macos${MACOS_MIN}" -framework Cocoa -framework WebKit \
    -o "$app/Contents/MacOS/CicaTavern" "$root/launcher/mac/main.swift"
  [ "$(lipo -archs "$app/Contents/MacOS/CicaTavern")" = "$cpu" ]
  [ "$(lipo -archs "$app/Contents/Resources/app/runtime/node")" = "$cpu" ]

  cp "$root/launcher/mac/Info.plist" "$app/Contents/Info.plist"
  plutil -replace CFBundleShortVersionString -string "$BUNDLE_VERSION" "$app/Contents/Info.plist"
  plutil -replace CFBundleVersion -string "$BUNDLE_VERSION" "$app/Contents/Info.plist"
  plutil -lint "$app/Contents/Info.plist"
  printf 'APPL????' > "$app/Contents/PkgInfo"

  icon="$work/CicaTavern.iconset"
  rm -rf "$icon"
  mkdir -p "$icon"
  for size in 16 32 128 256 512; do
    sips -z "$size" "$size" "$root/docs/brand/icon-mac-1024.png" --out "$icon/icon_${size}x${size}.png" > /dev/null
    sips -z "$((size * 2))" "$((size * 2))" "$root/docs/brand/icon-mac-1024.png" --out "$icon/icon_${size}x${size}@2x.png" > /dev/null
  done
  iconutil -c icns "$icon" -o "$app/Contents/Resources/CicaTavern.icns"
  rm -rf "$icon"

  # Extended attributes (quarantine, Finder info) make codesign refuse a bundle.
  xattr -cr "$app"
  local before
  before=$(shasum -a 256 "$app/Contents/Resources/app/runtime/node")
  codesign --force --sign - --timestamp=none "$app"
  codesign --verify --strict --verbose=2 "$app"
  # Node keeps its own signature: the bundle only seals it.
  [ "$(shasum -a 256 "$app/Contents/Resources/app/runtime/node")" = "$before" ]
  codesign --verify --strict "$app/Contents/Resources/app/runtime/node"
  codesign -dv --verbose=2 "$app/Contents/Resources/app/runtime/node" 2>&1 | grep -E '^(Authority|TeamIdentifier)=' || true

  local zip="$dist/CicaTavern-${VERSION}-mac-${arch}.zip"
  rm -f "$zip"
  ditto -c -k --keepParent "$app" "$zip"
  ls -l "$zip"
}

build_dmg() {
  local app=$1 dist=$2 arch=$3
  local dmg="$dist/CicaTavern-${VERSION}-mac-${arch}.dmg" work mount
  work=$(mktemp -d)
  # One TIFF with both sizes, so the window is sharp on a Retina screen.
  tiffutil -cathidpicheck "$root/docs/brand/dmg-background.png" "$root/docs/brand/dmg-background@2x.png" -out "$work/background.tiff"
  rm -f "$dmg"
  "${DMG_PYTHON:-python3}" "$root/scripts/dmg-build.py" -s "$root/scripts/dmg-settings.py" \
    -D "app=$app" -D "background=$work/background.tiff" "CicaTavern $VERSION" "$dmg"
  mount=$(hdiutil attach -readonly -nobrowse -noverify "$dmg" | tail -1 | cut -f3-)
  codesign --verify --strict "$mount/CicaTavern.app"
  [ "$(readlink "$mount/Applications")" = /Applications ]
  [ -f "$mount/.DS_Store" ] && [ -f "$mount/.background.tiff" ]
  hdiutil detach "$mount" -quiet
  rm -rf "$work"
  ls -l "$dmg"
}

smoke() {
  local zip=$1 port=$2 data=$3
  local check status
  check=$(mktemp -d)
  ditto -x -k "$zip" "$check"
  local app="$check/CicaTavern.app"
  local folder="$app/Contents/Resources/app"
  codesign --verify --deep --strict "$app"
  [ -x "$folder/runtime/node" ]
  [ -x "$app/Contents/MacOS/CicaTavern" ]

  wait_status() {
    for _ in $(seq 1 90); do
      if status=$(curl -fsS "http://127.0.0.1:$port/api/status" 2> /dev/null); then
        node -e '
          const s = JSON.parse(process.argv[1])
          if (s.version !== process.argv[2] || s.edition !== "release" || s.features?.updates !== "mac") {
            console.error("unexpected /api/status:", JSON.stringify({ version: s.version, edition: s.edition, updates: s.features?.updates }))
            process.exit(1)
          }
          console.log(`  ${s.edition} ${s.version}, updates: ${s.features.updates}, data: ${s.dataRoot}`)
        ' "$status" "$VERSION"
        return 0
      fi
      sleep 1
    done
    echo "no answer on port $port"
    return 1
  }
  shutdown_server() {
    curl -fsS -X POST -H 'x-agent-tavern: 1' -H 'content-type: application/json' -d '{}' "http://127.0.0.1:$port/api/shutdown"
    echo
    for _ in $(seq 1 30); do
      curl -fsS "http://127.0.0.1:$port/api/health" > /dev/null 2>&1 || return 0
      sleep 1
    done
    echo "the server did not stop"
    return 1
  }

  echo "$(basename "$zip"): bin/start.mjs"
  (cd "$folder" && exec runtime/node bin/start.mjs --port "$port" --data "$data") > "$data.start.log" 2>&1 &
  if ! wait_status; then cat "$data.start.log"; return 1; fi
  shutdown_server
  wait || true

  echo "$(basename "$zip"): bin/launch.mjs --no-window (what CicaTavern.app runs)"
  if ! (cd "$folder" && runtime/node bin/launch.mjs --no-window --port "$port" --data "$data"); then
    cat "$data/logs/server.log" || true
    return 1
  fi
  wait_status
  shutdown_server

  # An in-app update puts the new version in Application Support and marks it there (never in the app).
  echo "$(basename "$zip"): a version installed in Application Support is the one the app starts"
  local home="$check/home"
  local support="$home/Library/Application Support/CicaTavern"
  local installed="$support/CicaTavern-${VERSION}-mac"
  mkdir -p "$support/update"
  ditto "$folder" "$installed"
  INSTALLED="$installed" VERSION="$VERSION" node -e 'console.log(JSON.stringify({ path: process.env.INSTALLED, version: process.env.VERSION }))' > "$support/update/superseded.json"
  if ! (cd "$folder" && HOME="$home" runtime/node bin/launch.mjs --no-window --port "$port" --data "$data"); then
    cat "$data/logs/server.log" || true
    return 1
  fi
  wait_status
  if ! pgrep -f "$installed/bin/start.mjs" > /dev/null; then
    echo "the server did not start from $installed"
    shutdown_server
    return 1
  fi
  echo "  started from $installed"
  shutdown_server
  rm -rf "$check"
}

command=${1:-}
shift || true
case "$command" in
  node) node_download "$@" ;;
  app) build_app "$@" ;;
  dmg) build_dmg "$@" ;;
  smoke) smoke "$@" ;;
  *)
    echo "usage: bash scripts/mac-build.sh node <dir> <arch>... | app <arch> <node-dir> <work> <dist> | dmg <app> <dist> <arch> | smoke <zip> <port> <data>" >&2
    exit 2
    ;;
esac
