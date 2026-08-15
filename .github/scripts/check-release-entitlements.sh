#!/bin/bash

set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 DERIVED_DATA_PATH" >&2
  exit 2
fi

derived_data=$1
products="$derived_data/Build/Products/Release"
app="$products/ClaudeSwifties.app"
extension="$app/Contents/PlugIns/UsageWidget.appex"

if [[ ! -d "$extension" ]]; then
  extension="$products/UsageWidget.appex"
fi

for bundle in "$app" "$extension"; do
  if [[ ! -d "$bundle" ]]; then
    echo "missing signed release bundle: $bundle" >&2
    exit 1
  fi
done

scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT

codesign -d --entitlements - --xml "$app" >"$scratch/app.plist"
codesign -d --entitlements - --xml "$extension" >"$scratch/widget.plist"

expected_app=$(
  /usr/libexec/PlistBuddy -c 'Print :UsageKeychainAccessGroup' "$app/Contents/Info.plist"
)
expected_widget=$(
  /usr/libexec/PlistBuddy -c 'Print :UsageKeychainAccessGroup' "$extension/Contents/Info.plist"
)

python3 - \
  "$scratch/app.plist" \
  "$scratch/widget.plist" \
  "$expected_app" \
  "$expected_widget" <<'PY'
import plistlib
import sys

APP_GROUP = "group.is.sokrates.claudeswifties"


def load(path: str) -> dict[str, object]:
    with open(path, "rb") as stream:
        value = plistlib.load(stream)
    if not isinstance(value, dict):
        raise SystemExit(f"{path}: signed entitlements are not a dictionary")
    return value


app = load(sys.argv[1])
widget = load(sys.argv[2])
expected_app = sys.argv[3]
expected_widget = sys.argv[4]

if not expected_app or expected_app != expected_widget or "$(" in expected_app:
    raise SystemExit("release Info.plists do not contain one expanded Keychain access group")

for name, entitlements in (("app", app), ("widget", widget)):
    app_groups = entitlements.get("com.apple.security.application-groups")
    if not isinstance(app_groups, list) or APP_GROUP not in app_groups:
        raise SystemExit(f"{name}: missing shared App Group entitlement")

    keychain_groups = entitlements.get("keychain-access-groups")
    if not isinstance(keychain_groups, list) or not keychain_groups:
        raise SystemExit(f"{name}: missing shared Keychain access group entitlement")

app_keychain = set(app["keychain-access-groups"])
widget_keychain = set(widget["keychain-access-groups"])
if expected_app not in app_keychain or expected_app not in widget_keychain:
    raise SystemExit("signed app and widget do not embed their expanded Keychain access group")

print("signed release entitlements contain the shared App Group and Keychain group")
PY
