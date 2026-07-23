# DIAL macOS wrapper

This is a programmatic AppKit/WKWebView shell for
`https://lheinen002-prog.github.io/dial/`. It does not contain or replace the
web app.

## Security behavior

- The embedded view may navigate only to HTTPS pages beneath
  `lheinen002-prog.github.io/dial/`.
- A user-clicked external HTTP(S) link opens in the default browser; redirects,
  popups, custom schemes, and other in-app destinations are cancelled.
- Blob downloads initiated by the trusted DIAL page are saved to Downloads.
- The Keychain message handler rejects non-main-frame and non-DIAL origins.
- The token is stored as a generic-password item with service
  `com.lmh.lucashq`, account `dial-sync-token`, and
  `AfterFirstUnlockThisDeviceOnly` accessibility.

The page receives this promise API at document start:

```js
await window.dialKeychain.getToken();       // string or null
await window.dialKeychain.setToken(token);  // true
await window.dialKeychain.deleteToken();    // true
window.dialKeychain.available;              // true
```

## Compile check

From this directory:

```sh
swiftc \
  -framework AppKit \
  -framework WebKit \
  -framework Security \
  main.swift \
  -o /tmp/DIAL-wrapper-check
```

## Build an app bundle

Use a fresh output directory; do not point these commands at the existing
Desktop `DIAL.app`.

```sh
APP_ROOT="$PWD/build/DIAL.app"
mkdir -p "$APP_ROOT/Contents/MacOS"
mkdir -p "$APP_ROOT/Contents/Resources"
cp Info.plist "$APP_ROOT/Contents/Info.plist"
# Reuse the existing DIAL artwork:
cp "/path/to/AppIcon.icns" "$APP_ROOT/Contents/Resources/AppIcon.icns"
swiftc -O \
  -framework AppKit \
  -framework WebKit \
  -framework Security \
  main.swift \
  -o "$APP_ROOT/Contents/MacOS/DIAL"
codesign --force --sign - "$APP_ROOT"
open "$APP_ROOT"
```

For a durable install, sign every release with the same Apple signing identity.
That keeps the `com.lmh.lucashq` application identity and its Keychain access
stable. No App Transport Security exception is required because DIAL loads over
HTTPS.
