// What a local Ollama has installed, and what each model would cost in VRAM.
//
// The options flow in Home Assistant lets you pick a provider and a model. For
// the hosted providers the model list is a fixed suggestion — every model is
// always "available". Ollama is the opposite: only what has been pulled onto
// this machine can run, and a model that does not fit in VRAM does not fail,
// it silently spills into system RAM and gets several times slower. So the
// picker needs the real inventory plus a size the user can compare against
// their card.

const DEFAULT_BASE_URL = "http://localhost:11434/v1";

/** Weights are only part of what a running model occupies. On top of the file
 *  itself Ollama allocates a KV cache and compute buffers, and Home Mind's
 *  prompt is unusually long (device cheat sheet + home topology + recalled
 *  facts), which is exactly what the KV cache scales with. 1.2 GB on top of
 *  the weights matches what a 4-14B model actually reserves at a few thousand
 *  tokens of context; it is a planning figure, not a guarantee. */
const RUNTIME_OVERHEAD_GB = 1.2;

/** Not all of the card is available to a model: the driver, whatever is on the
 *  display, and Ollama's own headroom take a slice first. Measured here on a
 *  4 GB T600 — a 2.3 GB model reported as needing 3.5 GB was still pushed 15%
 *  onto the CPU, so a naive "requirement <= card size" call says it fits when
 *  it does not. Better to warn on something that would just fit than to
 *  promise a fit that turns into silent CPU offload. */
const GPU_RESERVE_GB = 0.6;

const GB = 1024 ** 3;

export interface OllamaModelInfo {
  /** Name to pass as LLM_MODEL, e.g. "qwen3:14b". */
  name: string;
  /** On-disk size of the weights, bytes. */
  sizeBytes: number;
  /** e.g. "14.8B" — as reported by Ollama, absent on older versions. */
  parameterSize?: string;
  /** e.g. "Q4_K_M". */
  quantization?: string;
  /** Weights + runtime overhead, GB, rounded to one decimal. */
  requiredVramGb: number;
  /** Whether the model can call functions at all. Home Mind drives the house
   *  through six HA tools, so a model without this is unusable here no matter
   *  how well it writes — and Ollama hosts plenty of them. null = the server
   *  is too old to report capabilities, so we cannot tell. */
  supportsTools: boolean | null;
  /** Whether it fits the card, when the card's size is known (OLLAMA_VRAM_GB).
   *  null = we were not told how much VRAM there is, so we do not guess. */
  fitsVram: boolean | null;
}

export interface OllamaStatus {
  baseUrl: string;
  reachable: boolean;
  /** Why it could not be read — shown in the options form so an unreachable
   *  Ollama looks like a configuration problem rather than an empty list. */
  error?: string;
  /** Card size in GB, from OLLAMA_VRAM_GB. null = not configured. */
  vramTotalGb: number | null;
  /** What of it a model can actually have, once the driver's share is taken
   *  off. This — not the card's nominal size — is what `fitsVram` compares
   *  against. null when the card size is unknown. */
  usableVramGb: number | null;
  models: OllamaModelInfo[];
  /** Models currently resident, and how much of each sits on the GPU. A model
   *  that is only partly offloaded is the failure mode this whole block exists
   *  to make visible: it works, it is just slow. */
  loaded: Array<{ name: string; onGpuPercent: number }>;
}

/** Ollama's native API lives at the root; the OpenAI-compatible one that the
 *  chat engine talks to is under /v1. Config carries the /v1 form, so strip it
 *  rather than making the user configure the same host twice. */
export function ollamaRootUrl(baseUrl: string | undefined): string {
  const url = (baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  return url.endsWith("/v1") ? url.slice(0, -3) : url;
}

export function estimateRequiredVramGb(sizeBytes: number): number {
  return Math.round((sizeBytes / GB + RUNTIME_OVERHEAD_GB) * 10) / 10;
}

async function getJson(url: string, timeoutMs: number): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return res.json();
}

/** Best-effort inventory. Never throws: the options form must stay usable when
 *  Ollama is not installed, which is the default for most deployments. */
export async function fetchOllamaStatus(
  baseUrl: string | undefined,
  vramTotalGb: number | null = null,
  timeoutMs = 3000
): Promise<OllamaStatus> {
  const root = ollamaRootUrl(baseUrl);
  const usableVramGb =
    vramTotalGb === null
      ? null
      : Math.round(Math.max(vramTotalGb - GPU_RESERVE_GB, 0) * 10) / 10;
  const status: OllamaStatus = {
    baseUrl: root,
    reachable: false,
    vramTotalGb,
    usableVramGb,
    models: [],
    loaded: [],
  };

  try {
    const tags = (await getJson(`${root}/api/tags`, timeoutMs)) as {
      models?: Array<{
        name?: string;
        size?: number;
        capabilities?: string[];
        details?: { parameter_size?: string; quantization_level?: string };
      }>;
    };
    status.reachable = true;
    status.models = (tags.models ?? [])
      .filter((m): m is { name: string; size?: number } & typeof m => !!m.name)
      .map((m) => {
        const sizeBytes = m.size ?? 0;
        const requiredVramGb = estimateRequiredVramGb(sizeBytes);
        return {
          name: m.name,
          sizeBytes,
          ...(m.details?.parameter_size ? { parameterSize: m.details.parameter_size } : {}),
          ...(m.details?.quantization_level ? { quantization: m.details.quantization_level } : {}),
          requiredVramGb,
          fitsVram: usableVramGb === null ? null : requiredVramGb <= usableVramGb,
          supportsTools: m.capabilities ? m.capabilities.includes("tools") : null,
        };
      })
      .sort((a, b) => a.sizeBytes - b.sizeBytes);
  } catch (err) {
    status.error = err instanceof Error ? err.message : String(err);
    return status;
  }

  // Secondary and strictly optional: a running model tells us what actually
  // fit, which beats any estimate. Losing it must not lose the inventory.
  try {
    const ps = (await getJson(`${root}/api/ps`, timeoutMs)) as {
      models?: Array<{ name?: string; size?: number; size_vram?: number }>;
    };
    status.loaded = (ps.models ?? [])
      .filter((m) => m.name && m.size)
      .map((m) => ({
        name: m.name!,
        onGpuPercent: Math.round(((m.size_vram ?? 0) / m.size!) * 100),
      }));
  } catch {
    // Older Ollama without /api/ps, or it went away between the two calls.
  }

  return status;
}
