#!/usr/bin/env bash
# Compress color and material textures in GLB models to KTX2.
#
# Standalone. This is not part of `npm run bake:scene`.
#
#   npm run bake:ktx2
#   npm run bake:ktx2 -- web/assets/models
#   npm run bake:ktx2 -- --dry-run
#   npm run bake:ktx2 -- --only 'room-*.glb'
#   bash scripts/bake-ktx2.sh --dry-run --only 'brutalist-*.glb' web/assets/models
#
# Room GLBs in the models directory are included. `--only GLOB` limits the
# run to basenames (pathname match). `--dry-run` prints the plan and does
# not write. There is no resize pass: dimensions stay as authored, aside
# from the encoder's own pad when a side is not a multiple of 4.
#
# Pass 1 is ETC1S for color and emissive. Pass 2 is UASTC for normal,
# occlusion, roughness, and metalness. A missing slot is a no-op. The
# script stops only when the CLI reports a hard failure.
#
# Requires `ktx` from KTX-Software >= 4.4 on PATH
# (https://github.com/KhronosGroup/KTX-Software). `@gltf-transform/cli`
# is the devDependency that drives it.

set -euo pipefail

DRY=0
ONLY=""
MODELS=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY=1
      shift
      ;;
    --only)
      if [[ $# -lt 2 ]]; then
        echo "bake-ktx2: --only needs a basename glob" >&2
        exit 2
      fi
      ONLY="$2"
      shift 2
      ;;
    --only=*)
      ONLY="${1#--only=}"
      shift
      ;;
    -*)
      echo "bake-ktx2: unknown flag $1" >&2
      exit 2
      ;;
    *)
      if [[ -n "$MODELS" ]]; then
        echo "bake-ktx2: unexpected argument $1" >&2
        exit 2
      fi
      MODELS="$1"
      shift
      ;;
  esac
done
MODELS="${MODELS:-web/assets/models}"

if [[ ! -d "$MODELS" ]]; then
  echo "bake-ktx2: not a directory: $MODELS" >&2
  exit 1
fi

if [[ "$DRY" -eq 0 ]]; then
  if ! command -v ktx >/dev/null 2>&1 && [[ -x "${HOME}/.local/bin/ktx" ]]; then
    export PATH="${HOME}/.local/bin:${PATH}"
  fi
  if ! command -v ktx >/dev/null 2>&1; then
    echo "bake-ktx2: ktx (KTX-Software >= 4.4) is not on PATH." >&2
    echo "Install it from https://github.com/KhronosGroup/KTX-Software/releases" >&2
    exit 1
  fi
fi

# One directory deep. Models live in the folder itself; a single nested
# directory of GLBs is included, and nothing below that.
mapfile -d '' files < <(find "$MODELS" -mindepth 1 -maxdepth 2 -type f -name '*.glb' -print0 | sort -z)

if [[ ${#files[@]} -eq 0 ]]; then
  echo "bake-ktx2: no GLBs under $MODELS"
  exit 0
fi

run_cli() {
  local log
  log="$(mktemp)"
  if ! npx --yes @gltf-transform/cli "$@" >"$log" 2>&1; then
    cat "$log" >&2
    rm -f "$log"
    return 1
  fi
  if grep -E -q 'Failed →|Command "ktx" not found|Unable to find "ktx"' "$log"; then
    cat "$log" >&2
    rm -f "$log"
    return 1
  fi
  rm -f "$log"
}

bake_one() {
  local in="$1"
  local base dir tmp out before after
  base="$(basename "$in")"
  if [[ -n "$ONLY" && "$base" != $ONLY ]]; then
    return 0
  fi
  if grep -a -q 'KHR_texture_basisu' "$in"; then
    echo "skip $in (already KTX2)"
    return 0
  fi
  before="$(stat -c%s "$in")"
  if [[ "$DRY" -eq 1 ]]; then
    echo "dry-run $in  $before bytes"
    return 0
  fi
  dir="$(dirname "$in")"
  # The suffix must be .glb. Without it the CLI writes JSON plus an external .bin.
  tmp="$(mktemp "$dir/.bake-ktx2.XXXXXX.glb")"
  out="$(mktemp "$dir/.bake-ktx2.XXXXXX.glb")"
  if ! run_cli etc1s "$in" "$tmp" --slots "{color,emissive}"; then
    rm -f "$tmp" "$out"
    echo "bake-ktx2: etc1s failed for $in" >&2
    return 1
  fi
  if ! run_cli uastc "$tmp" "$out" --slots "{normal,occlusion,roughness,metalness}"; then
    rm -f "$tmp" "$out"
    echo "bake-ktx2: uastc failed for $in" >&2
    return 1
  fi
  rm -f "$tmp"
  # A model with no png/jpeg maps is rewritten by the CLI and gains nothing.
  # Leave the authored GLB in place.
  if ! grep -a -q 'KHR_texture_basisu' "$out"; then
    rm -f "$out"
    echo "skip $in (no compressible textures)"
    return 0
  fi
  mv -f "$out" "$in"
  after="$(stat -c%s "$in")"
  echo "$in  $before -> $after"
}

status=0
for in in "${files[@]}"; do
  if ! bake_one "$in"; then
    status=1
    break
  fi
done
exit "$status"
