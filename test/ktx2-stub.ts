import type { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { Texture } from "three";

/**
 * Node has no Basis transcoder. A KTX2 GLB requires KHR_texture_basisu, and
 * GLTFLoader rejects that file until a loader is set. The stand-in keeps
 * material.map set for placement checks.
 */
export function allowKtx2(loader: GLTFLoader): void {
  const stub = {
    load(_url: string, onLoad: (texture: Texture) => void): void {
      const texture = new Texture();
      texture.image = { width: 1, height: 1 };
      texture.needsUpdate = true;
      onLoad(texture);
    },
  };
  loader.setKTX2Loader(stub as never);
}
