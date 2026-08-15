#!/bin/bash

set -euo pipefail

project=ClaudeSwifties.xcodeproj
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT

check_mapping() {
  local target=$1
  local sdk=$2
  local expected_entitlements=$3
  local expected_info=$4
  local output="$scratch/${target}-${sdk}.json"

  xcodebuild \
    -project "$project" \
    -target "$target" \
    -configuration Release \
    -sdk "$sdk" \
    -showBuildSettings \
    -json >"$output"

  python3 - "$output" "$target" "$expected_entitlements" "$expected_info" <<'PY'
import json
import sys

path, target, expected_entitlements, expected_info = sys.argv[1:]
with open(path, encoding="utf-8") as stream:
    entries = json.load(stream)

if len(entries) != 1 or entries[0].get("target") != target:
    raise SystemExit(f"unexpected build-settings result for {target}")

settings = entries[0].get("buildSettings", {})
actual_entitlements = settings.get("CODE_SIGN_ENTITLEMENTS")
actual_info = settings.get("INFOPLIST_FILE")
if actual_entitlements != expected_entitlements:
    raise SystemExit(
        f"{target}: Release CODE_SIGN_ENTITLEMENTS is {actual_entitlements!r}, "
        f"expected {expected_entitlements!r}"
    )
if actual_info != expected_info:
    raise SystemExit(
        f"{target}: Release INFOPLIST_FILE is {actual_info!r}, expected {expected_info!r}"
    )
PY
}

for sdk in iphoneos iphonesimulator; do
  check_mapping \
    ClaudeSwifties "$sdk" \
    App/ClaudeSwifties-iOS.entitlements \
    ClaudeSwifties.xcodeproj/Info/ClaudeSwifties-iOS.plist
  check_mapping \
    UsageWidget "$sdk" \
    Widget/UsageWidget-iOS.entitlements \
    ClaudeSwifties.xcodeproj/Info/UsageWidget.plist
done

check_mapping \
  ClaudeSwifties macosx \
  App/ClaudeSwifties-macOS.entitlements \
  ClaudeSwifties.xcodeproj/Info/ClaudeSwifties-macOS.plist
check_mapping \
  UsageWidget macosx \
  Widget/UsageWidget-macOS.entitlements \
  ClaudeSwifties.xcodeproj/Info/UsageWidget.plist

python3 - <<'PY'
import plistlib

APP_GROUP = "group.is.sokrates.claudeswifties"
KEYCHAIN_GROUP = "$(AppIdentifierPrefix)is.sokrates.ClaudeSwifties.shared"
CASES = (
    ("App/ClaudeSwifties-iOS.entitlements", "ClaudeSwifties.xcodeproj/Info/ClaudeSwifties-iOS.plist"),
    ("App/ClaudeSwifties-macOS.entitlements", "ClaudeSwifties.xcodeproj/Info/ClaudeSwifties-macOS.plist"),
    ("Widget/UsageWidget-iOS.entitlements", "ClaudeSwifties.xcodeproj/Info/UsageWidget.plist"),
    ("Widget/UsageWidget-macOS.entitlements", "ClaudeSwifties.xcodeproj/Info/UsageWidget.plist"),
)


def load(path: str) -> dict[str, object]:
    with open(path, "rb") as stream:
        value = plistlib.load(stream)
    if not isinstance(value, dict):
        raise SystemExit(f"{path}: expected a plist dictionary")
    return value


for entitlements_path, info_path in CASES:
    entitlements = load(entitlements_path)
    info = load(info_path)
    if entitlements.get("com.apple.security.application-groups") != [APP_GROUP]:
        raise SystemExit(f"{entitlements_path}: wrong App Group declaration")
    if entitlements.get("keychain-access-groups") != [KEYCHAIN_GROUP]:
        raise SystemExit(f"{entitlements_path}: wrong Keychain access-group declaration")
    if info.get("UsageKeychainAccessGroup") != KEYCHAIN_GROUP:
        raise SystemExit(f"{info_path}: runtime Keychain group does not match entitlements")

print("Release build settings map every Apple target and SDK to shared entitlements")
PY
