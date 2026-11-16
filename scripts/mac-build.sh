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
#       docs/brand/icon-mac-1024.png. Signed (see Signing; runtime/node keeps
#       the Node.js Foundation's own signature) and packed by ditto, which keeps
#       the executable bits, into <dist>/CicaTavern-<version>-mac-<arch>.zip.
#   bash scripts/mac-build.sh dmg <app> <dist> <arch>
#       <dist>/CicaTavern-<version>-mac-<arch>.dmg, what people download: the
#       app beside a link to /Applications over docs/brand/dmg-background (for
#       an app that is not notarized, dmg-background-not-notarized, which says
#       how to open it the first time), so it is installed by dragging one onto
#       the other (dmgbuild with scripts/dmg-settings.py, through
#       scripts/dmg-build.py). DMG_PYTHON is a Python with
#       scripts/dmg-requirements.txt installed (else python3). The image is
#       mounted again: the app inside verifies, the link is there.
#   bash scripts/mac-build.sh smoke <zip> <port> <data>
#       The zip unpacked again: its signature checks out, and its own Node
#       starts the server with bin/start.mjs, then with bin/launch.mjs
#       --no-window (what the app runs); /api/status must give the version,
#       edition release and the Mac updater; POST /api/shutdown stops it each
#       time. Then, as after an in-app update: with a version installed in
#       Application Support and its mark there, the app's launch.mjs starts
#       that one (HOME is a scratch folder).
#   bash scripts/mac-build.sh keychain <p12> <keychain>
#       A new keychain at <keychain> holding the Developer ID certificate and
#       key in <p12> (its password in MAC_CERT_PASSWORD), unlocked and put in
#       the user's search list, where codesign looks for Apple's Developer ID
#       G2 intermediate (the .p12 carries it). Prints the identity's name, for
#       MAC_SIGN_IDENTITY.
#   bash scripts/mac-build.sh keychain-remove <keychain>
#       Deletes it (which also takes it out of the search list).
#
# Signing. With MAC_SIGN_IDENTITY ("Developer ID Application: …", looked up in
# MAC_KEYCHAIN when that is set), app signs CicaTavern.app with it, with the
# hardened runtime and launcher/mac/CicaTavern.entitlements (the microphone, for
# voice input), and dmg signs the disk image. With NOTARY_KEY (an App Store
# Connect API key's .p8), NOTARY_KEY_ID and NOTARY_ISSUER_ID too, Apple's notary
# service checks each and its ticket is stapled on: the app's before it is zipped
# (so the zip and the disk image carry it), then the disk image's own. Node's
# own Developer ID signature is accepted as it is. Without MAC_SIGN_IDENTITY
# everything is signed ad hoc, as before the Developer ID.
#
# Environment: NODE_VERSION (v24.22.0), MACOS_MIN (13.5: Node 24's own
# minimum, as in launcher/mac/Info.plist), VERSION (package.json's), and the
# signing ones above.
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
MACOS_MIN=${MACOS_MIN:-13.5}
VERSION=${VERSION:-$(node -p "require('$root/package.json').version")}
# CFBundleVersion takes numbers only: 1.8.0-beta.1 → 1.8.0.
BUNDLE_VERSION=${VERSION%%-*}

cpu_of() { [ "$1" = arm64 ] && echo arm64 || echo x86_64; }

signing() { [ -n "${MAC_SIGN_IDENTITY:-}" ]; }

# All three notary settings, with the Developer ID; some of them only is a mistake.
notarizing() {
  local set=0 name
  for name in NOTARY_KEY NOTARY_KEY_ID NOTARY_ISSUER_ID; do
    [ -z "${!name:-}" ] || set=$((set + 1))
  done
  [ "$set" != 0 ] || return 1
  if [ "$set" != 3 ] || ! signing; then
    echo "notarizing needs NOTARY_KEY, NOTARY_KEY_ID and NOTARY_ISSUER_ID together, and MAC_SIGN_IDENTITY" >&2
    exit 1
  fi
  [ -f "$NOTARY_KEY" ] || { echo "NOTARY_KEY: no such file: $NOTARY_KEY" >&2; exit 1; }
}

developer_id_sign() {
  codesign --force --timestamp ${MAC_KEYCHAIN:+--keychain "$MAC_KEYCHAIN"} --sign "$MAC_SIGN_IDENTITY" "$@"
}

# Sends <file> to Apple's notary service and waits for its answer (30 minutes
# at most); anything but Accepted prints Apple's log and stops the build.
notarize() {
  local file=$1 answer id status
  local key=(--key "$NOTARY_KEY" --key-id "$NOTARY_KEY_ID" --issuer "$NOTARY_ISSUER_ID")
  answer=$(mktemp)
  echo "notarizing $(basename "$file")"
  xcrun notarytool submit "$file" "${key[@]}" --wait --timeout 30m --output-format json > "$answer" || true
  id=$(plutil -extract id raw "$answer" 2> /dev/null || true)
  status=$(plutil -extract status raw "$answer" 2> /dev/null || true)
  echo "  submission ${id:-(none)}: ${status:-no answer}"
  if [ "$status" != Accepted ]; then
    cat "$answer"
    [ -z "$id" ] || xcrun notarytool log "$id" "${key[@]}" || true
    rm -f "$answer"
    exit 1
  fi
  rm -f "$answer"
}

signing_keychain() {
  local p12=$1 keychain=$2 password identity line others=()
  : "${MAC_CERT_PASSWORD:?MAC_CERT_PASSWORD is not set}"
  password=$(openssl rand -hex 24)
  security create-keychain -p "$password" "$keychain"
  security set-keychain-settings -lut 21600 "$keychain"
  security unlock-keychain -p "$password" "$keychain"
  security import "$p12" -k "$keychain" -P "$MAC_CERT_PASSWORD" -T /usr/bin/codesign > /dev/null
  security set-key-partition-list -S apple-tool:,apple: -s -k "$password" "$keychain" > /dev/null
  while IFS= read -r line; do
    line=${line#*\"}
    others+=("${line%\"*}")
  done < <(security list-keychains -d user)
  security list-keychains -d user -s "$keychain" ${others[@]+"${others[@]}"}
  identity=$(security find-identity -v -p codesigning "$keychain" | sed -n 's/.*"\(Developer ID Application: .*\)"$/\1/p')
  if [ -z "$identity" ] || [ "$(printf '%s\n' "$identity" | wc -l | tr -d ' ')" != 1 ]; then
    echo "expected one valid Developer ID Application identity from $p12:" >&2
    security find-identity -p codesigning "$keychain" >&2
    exit 1
  fi
  echo "$identity"
}

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
  if signing; then
    developer_id_sign --options runtime --entitlements "$root/launcher/mac/CicaTavern.entitlements" "$app"
  else
    codesign --force --sign - --timestamp=none "$app"
  fi
  codesign --verify --strict --verbose=2 "$app"
  codesign -dv --verbose=2 "$app" 2>&1 | grep -E '^(Authority|TeamIdentifier|Timestamp)=' || true
  # Node keeps its own signature: the bundle only seals it.
  [ "$(shasum -a 256 "$app/Contents/Resources/app/runtime/node")" = "$before" ]
  codesign --verify --strict "$app/Contents/Resources/app/runtime/node"
  codesign -dv --verbose=2 "$app/Contents/Resources/app/runtime/node" 2>&1 | grep -E '^(Authority|TeamIdentifier)=' || true

  local zip="$dist/CicaTavern-${VERSION}-mac-${arch}.zip"
  rm -f "$zip"
  if notarizing; then
    # The notary service takes a zip; the ticket then goes into the app, and the zip is made again with it.
    ditto -c -k --keepParent "$app" "$zip"
    notarize "$zip"
    rm "$zip"
    xcrun stapler staple "$app"
    xcrun stapler validate "$app"
    spctl --assess --type execute -vv "$app"
  fi
  ditto -c -k --keepParent "$app" "$zip"
  ls -l "$zip"
}

build_dmg() {
  local app=$1 dist=$2 arch=$3
  local dmg="$dist/CicaTavern-${VERSION}-mac-${arch}.dmg" work mount background=dmg-background notarized=yes
  # The app's own ticket, stapled by app: without it the first open needs 仍要打开, and the window says so.
  xcrun stapler validate "$app" > /dev/null 2>&1 || { notarized=no; background=dmg-background-not-notarized; }
  work=$(mktemp -d)
  # One TIFF with both sizes, so the window is sharp on a Retina screen.
  tiffutil -cathidpicheck "$root/docs/brand/$background.png" "$root/docs/brand/$background@2x.png" -out "$work/background.tiff"
  rm -f "$dmg"
  "${DMG_PYTHON:-python3}" "$root/scripts/dmg-build.py" -s "$root/scripts/dmg-settings.py" \
    -D "app=$app" -D "background=$work/background.tiff" "CicaTavern $VERSION" "$dmg"
  mount=$(hdiutil attach -readonly -nobrowse -noverify "$dmg" | tail -1 | cut -f3-)
  codesign --verify --strict "$mount/CicaTavern.app"
  [ "$notarized" = no ] || xcrun stapler validate "$mount/CicaTavern.app"
  [ "$(readlink "$mount/Applications")" = /Applications ]
  [ -f "$mount/.DS_Store" ] && [ -f "$mount/.background.tiff" ]
  hdiutil detach "$mount" -quiet
  rm -rf "$work"
  if signing; then
    developer_id_sign "$dmg"
    codesign --verify --strict "$dmg"
    if notarizing; then
      notarize "$dmg"
      xcrun stapler staple "$dmg"
      xcrun stapler validate "$dmg"
      spctl --assess --type open --context context:primary-signature -vv "$dmg"
    fi
  fi
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
  keychain) signing_keychain "$@" ;;
  keychain-remove) security delete-keychain "$1" ;;
  *)
    echo "usage: bash scripts/mac-build.sh node <dir> <arch>... | app <arch> <node-dir> <work> <dist> | dmg <app> <dist> <arch> | smoke <zip> <port> <data> | keychain <p12> <keychain> | keychain-remove <keychain>" >&2
    exit 2
    ;;
esac
