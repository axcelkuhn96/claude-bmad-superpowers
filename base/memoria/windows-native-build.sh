#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
: "${NODE_INCLUDE:?Set NODE_INCLUDE to the Node 18 include/node directory}"
: "${MINGW_PREFIX:?Set MINGW_PREFIX to the cross-compiler installation prefix}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
"$MINGW_PREFIX/bin/x86_64-w64-mingw32-dlltool" -d windows-native.def -l "$work/node-napi.a" -m i386:x86-64
"$MINGW_PREFIX/bin/x86_64-w64-mingw32-gcc-posix" -Os -s -shared -Wl,--no-insert-timestamp \
  -I"$NODE_INCLUDE" -B"$MINGW_PREFIX/bin/" \
  -B"$MINGW_PREFIX/x86_64-w64-mingw32/bin/" \
  -L"$MINGW_PREFIX/x86_64-w64-mingw32/lib" \
  -L"$MINGW_PREFIX/lib/gcc/x86_64-w64-mingw32/13-posix" \
  -o bin/windows-native-x64.node windows-native.c "$work/node-napi.a" -lshell32 -ladvapi32
sha256sum bin/windows-native-x64.node
