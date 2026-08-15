#!/bin/bash

set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 DERIVED_DATA_PATH" >&2
  exit 2
fi

derived_data=$1
products="$derived_data/Build/Products/Release"
app="$products/ClaudeSwifties.app"
widget="$app/Contents/PlugIns/UsageWidget.appex"
app_info="$app/Contents/Info.plist"
widget_info="$widget/Contents/Info.plist"

for path in "$app" "$widget" "$app_info" "$widget_info"; do
  if [[ ! -e "$path" ]]; then
    echo "missing release artifact: $path" >&2
    exit 1
  fi
done

app_keychain=$(/usr/libexec/PlistBuddy -c 'Print :UsageKeychainAccessGroup' "$app_info")
widget_keychain=$(/usr/libexec/PlistBuddy -c 'Print :UsageKeychainAccessGroup' "$widget_info")
unexpanded_setting_marker="\$("
if [[ -z "$app_keychain" || "$app_keychain" != "$widget_keychain" || "$app_keychain" == *"$unexpanded_setting_marker"* ]]; then
  echo "release products do not contain one expanded shared Keychain access group" >&2
  exit 1
fi

scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
cp App/ClaudeSwifties-macOS.entitlements "$scratch/app.plist"
cp Widget/UsageWidget-macOS.entitlements "$scratch/widget.plist"
/usr/libexec/PlistBuddy -c "Set :keychain-access-groups:0 $app_keychain" "$scratch/app.plist"
/usr/libexec/PlistBuddy -c "Set :keychain-access-groups:0 $widget_keychain" "$scratch/widget.plist"

# Sign the nested code first, then the host. This is an ad-hoc CI artifact: it
# proves the release products embed their target-expanded declarations, while
# a provisioning-profile signature remains an explicit live-device gate.
codesign --force --sign - --entitlements "$scratch/widget.plist" "$widget"
codesign --force --sign - --entitlements "$scratch/app.plist" "$app"
codesign --verify --deep --strict --verbose=2 "$app"
