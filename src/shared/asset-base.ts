/**
 * Leading URL prefix for client assets. The multiplayer bundle defines this as
 * `"/"`. The solo bundle defines it as `"./"`. Node loads of this module leave
 * it unset, and those callers keep the absolute multiplayer paths.
 */
declare const __ASSET_BASE__: string;

export function assetBase(): string {
  return typeof __ASSET_BASE__ === "string" ? __ASSET_BASE__ : "/";
}
