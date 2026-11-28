# Browser GPU compute for small neural nets — standards, drivers, and measured limits

| | |
|---|---|
| **Question** | Can a browser tab use the GPU for relatively simple neural-net processing? Does three.js/WebGPU talk to drivers directly, or is there a web standard for CUDA-like compute? |
| **Decision it informs** | Whether a small NN policy could run in the browser (and whether it is worth it), and what the fallback is for the Node bot lane. |
| **Timebox** | 60 min (spent ~55). |
| **Window** | 2026-11-28 12:08 → 13:05 America/New_York. |
| **Method** | standard docs (MDN, W3C), caniuse support data, plus a local probe: headless Chrome 157 + a real WebGPU compute kernel, and a Node MLP benchmark. |

## Answer

**Yes — via WebGPU compute shaders, not CUDA.** A page gets a sandboxed GPU device from the browser; the browser's
WebGPU implementation drives the platform's native graphics API (Metal on macOS, Direct3D 12 on Windows, Vulkan on
Linux/Android) through the OS driver. CUDA is an NVIDIA native SDK and is **not** reachable from a web page — there is no
web standard that exposes raw drivers or CUDA, only abstractions over them: **WebGPU** (general compute, the practical
choice), **WebNN** (a dedicated NN inference API, still off by default everywhere), and legacy **WebGL2** GPGPU tricks.
Measured locally: a real WebGPU compute kernel ran correctly in headless Chrome 157 (on SwiftShader, the software
rasterizer), while **Node 24 has no `navigator.gpu`** — so the bot lane cannot use this path today. For the sizes in
question, a tiny MLP on the CPU is **3.8–22.8 µs** per inference, so per-bot 20 Hz policies do **not** need the GPU;
the GPU pays off for batched evaluation and larger tensors.

## 1. The stack (what "drivers in the browser" means)

MDN's WebGPU page: the browser's WebGPU implementation **communicates with the GPU via a native GPU API driver**, and
the API is designed with a "logical device" abstraction for isolation and secure-context exposure. In practice:

```
page JS  →  WebGPU (JS API)  →  browser implementation (Dawn/ANGLE or WebKit's)
         →  native API: Metal / D3D12 / Vulkan  →  OS driver  →  GPU
```

There is no path from a page to a driver's ioctl/COM interface or to CUDA; shaders and buffers are validated and
time-sliced by the browser. WebGPU also offers a **compatibility mode** over OpenGL ES 3.1 / D3D11 for older hardware.
<https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API>

## 2. The standards

| Standard | What it gives | Status (2026-11-28) |
|---|---|---|
| **WebGPU** (W3C GPU for the Web WG) | general GPU compute: compute pipelines, storage buffers, workgroups; also rendering | shipped: Chrome 113+, Edge, Opera, Safari 26+ partial, Firefox off by default (caniuse 86.83 % global, October 2026 usage) |
| **WebNN** (W3C Web Machine Learning WG) | dedicated NN inference API (`navigator.ml`): `MLGraphBuilder` ops (gemm, conv2d, gru, lstm…), backend chosen by the browser (CPU/GPU/NPU), "consistent interface across platforms" | **Candidate Recommendation Draft, 20 Nov 2026**; caniuse **0 %** — `navigator.ml` disabled by default in Chrome 112–161, unsupported in Firefox/Safari |
| **WebGL2** (Khronos) | GPGPU via fragment shaders / transform feedback; no compute shaders | universally supported; legacy path |
| **WebAssembly SIMD + threads** | CPU fallback, no GPU | supported in all majors |
| **WebCL** | the old "OpenCL in the browser" | never shipped in mainstream browsers; dead |

Sources: <https://www.w3.org/TR/webnn/>, <https://caniuse.com/webgpu>, <https://caniuse.com/mdn-api_navigator_ml>,
<https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API>.

**So the CUDA analogue on the web is WebGPU compute.** WebNN is the higher-level NN standard, but on this date it
cannot be assumed in a shipped page.

## 3. Local measurements (this machine, 2026-11-28)

| Probe | Result |
|---|---|
| Node 24 `navigator.gpu` | **undefined** — the bot lane is Node; no WebGPU |
| Chrome 157 headless, `file://` (secure context), `--enable-unsafe-webgpu --enable-unsafe-swiftshader` | `navigator.gpu` **true**, `navigator.ml` **false**, `webgl2` true |
| adapter/device | adapter `google` / `swiftshader`, `maxStorageBufferBindingSize` **1 GiB** |
| a real compute kernel (`out[i] = in[i]*2+1`, 64 lanes, dispatch 16×4) | **correct**: `first=1`, `last=127`, `ok=true` |
| three.js r186 | `build/three.webgpu.js` present; TSL exports `compute`, `storage`, `instancedArray` — three can author compute kernels, not just render |
| CPU MLP forward, 200 k iterations (Node, Float32Array) | 16→16→4: **3.81 µs**/eval (262 k/s); 64→64→32→4: **22.79 µs**/eval (44 k/s) |

Caveats: the headless adapter is **SwiftShader (CPU)** — it proves the API and the pipeline, not GPU throughput; the
probe scripts are `plan/tmp/cdp-gpu.mjs` and `plan/tmp/gpu-sync.html`.

## 4. Is the GPU even the right tool at this scale?

At 20 Hz with 16 bots: 320 inferences/s. A 16→16→4 net costs **3.8 µs** → **1.2 ms/s** of CPU — 0.1 % of one core. A
64-wide two-hidden-layer net costs **7.3 ms/s** — still small. GPU dispatch overhead (submit + fence + readback) is
tens of µs even on a real GPU, and far more on SwiftShader, so a per-bot GPU inference would likely be **slower** than
the CPU. The GPU earns its place when one dispatch covers many inferences:

| Workload | Where |
|---|---|
| per-bot policy net (≤ 10 k MACs), 20 Hz | **CPU / JS / WASM** — measured µs |
| GA evaluating a population (64–512 genomes) | **GPU compute** (batch the matmul) or CPU with batching |
| vision / convnets / large tensors | **WebGPU**, WebNN where enabled |
| browser-hosted commander with a larger net | **WebGPU** (three TSL `compute` or raw WebGPU) |

## 5. Constraints a browser NN must live with

- **Secure context** (`https` or `localhost`/`file`); `navigator.gpu` is absent otherwise.
- **No CUDA / no direct driver access**; the browser validates shaders and may time-slice/kill long work (device loss,
  watchdog).
- **Buffer limits**: `maxStorageBufferBindingSize` (1 GiB in the local build; lower on mobile), per-stage limits.
- **Readback latency**: `mapAsync` is asynchronous; a per-tick CPU↔GPU round trip is a stall, not a fast path.
- **Shader compile cost** at first use; pipelines should be cached/reused.
- **Fallback required**: Firefox (WebGPU off by default), Safari (partial), WebNN (off) → keep a CPU/WASM path.
- **Privacy/abuse**: browsers may block or throttle GPU work; WGSL has no dynamic code loading.

## 6. What this means for this repo

- **Bots are Node processes** (`packages/bot-client`), and Node 24 has no `navigator.gpu`. A GPU NN cannot run in the
  bot lane without a native addon or a Deno/Chromium sidecar. The JSON-brain/CPU path stands.
- **The browser client** is the only GPU surface today; it still uses `WebGLRenderer` on three r186. Running a GPU NN
  there would mean either a WebGPU renderer migration (already researched for meshlets) or a small standalone WebGPU
  compute pass alongside the WebGL renderer (two contexts — possible, but a real design change).
- **The GA** should batch on the CPU first (the measured per-eval cost makes a 64-genome population ~1.5 ms/s); reach
  for GPU compute only if the population or the net grows, and then the harness needs a WebGPU-capable runtime.

## 7. Open questions

1. **Target browsers** — if Firefox matters, WebGPU is not available by default and a WebGL2/WASM fallback is mandatory.
2. **GA harness runtime** — Node has no WebGPU; Deno does; a browser harness would need the page context.
3. **WebNN enablement** — if Chrome ships it on by default (the CRD is recent), a straightforward NN path may appear;
   until then it is a flag.
4. **Three.js compute in this repo** — a standalone compute pass next to WebGLRenderer is untested here; if the client
   ever migrates to `WebGPURenderer`, TSL `compute` becomes the natural GPU NN path.

## 8. Confidence

`verified locally` — Node's missing `navigator.gpu`, the Chrome probe (API presence, adapter info, the compute kernel
result), three r186 exports, the MLP timings. `documented externally` — WebGPU's driver-mediated stack (MDN), caniuse
support numbers, WebNN's CRD status and 0 % support. `inferred` — GPU dispatch-overhead guidance (standard
measurement practice, not measured here on real hardware), and the browser-NN recommendations.
