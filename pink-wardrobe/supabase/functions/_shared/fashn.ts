/**
 * FASHN.ai virtual try-on client.
 *
 * The ONLY paid call in the application, and the only module that talks to
 * FASHN. It runs exclusively in an Edge Function — the API key never reaches
 * the browser or the APK.
 *
 * >>> VERIFY BEFORE FIRST PAID RUN <<<
 * The request field names below follow FASHN's documented universal /v1/run
 * contract, but docs.fashn.ai was unreachable from the build environment.
 * Confirm them against the live API reference before spending credits. They
 * are confined to this file so a correction is a single-file change.
 */

const API_BASE = 'https://api.fashn.ai/v1';

// Each garment is generated exactly once and reused forever, so quality
// compounds while cost does not — which makes the higher-fidelity endpoint the
// right default rather than the cheaper interactive one.
const DEFAULT_MODEL = 'tryon-max';

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 180_000;

const CATEGORY_MAP: Record<string, string> = {
  tops: 'tops',
  bottoms: 'bottoms',
  dresses: 'one-pieces',
  outerwear: 'tops',
  swimwear: 'one-pieces',
  gym_wear: 'tops',
  shoes: 'auto',
  accessories: 'auto',
  undergarments: 'auto',
};

export class FashnError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable = true) {
    super(message);
    this.retryable = retryable;
  }
}

function headers(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
}

function toDataUri(bytes: Uint8Array, contentType: string): string {
  // Images are inlined rather than passed by URL so nothing in the bucket ever
  // needs to be publicly fetchable.
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return `data:${contentType};base64,${btoa(binary)}`;
}

async function submit(
  apiKey: string,
  avatar: Uint8Array,
  garment: Uint8Array,
  category: string,
  avatarType: string,
  garmentType: string,
): Promise<string> {
  const payload = {
    model_name: DEFAULT_MODEL,
    inputs: {
      model_image: toDataUri(avatar, avatarType),
      garment_image: toDataUri(garment, garmentType),
      category: CATEGORY_MAP[category] ?? 'auto',
      // Deterministic, so regenerating after a fix yields a comparable image
      // rather than a differently-posed one.
      seed: 42,
      num_samples: 1,
    },
  };

  const response = await fetch(`${API_BASE}/run`, {
    method: 'POST',
    headers: headers(apiKey),
    body: JSON.stringify(payload),
  }).catch((error) => {
    throw new FashnError(`Could not reach FASHN: ${error.message}`);
  });

  if (response.status === 401) {
    throw new FashnError('FASHN rejected the API key.', false);
  }
  if (response.status === 402) {
    throw new FashnError('Out of FASHN credits.', false);
  }
  if (response.status === 429) {
    throw new FashnError('FASHN rate limit reached; try again shortly.');
  }
  if (!response.ok) {
    const text = await response.text();
    throw new FashnError(`FASHN returned ${response.status}: ${text.slice(0, 300)}`);
  }

  const body = await response.json();
  if (!body.id) {
    throw new FashnError('FASHN response contained no prediction id.');
  }

  return body.id as string;
}

async function waitForOutputUrl(apiKey: string, predictionId: string): Promise<string> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const response = await fetch(`${API_BASE}/status/${predictionId}`, {
      headers: headers(apiKey),
    }).catch((error) => {
      throw new FashnError(`Could not poll FASHN: ${error.message}`);
    });

    if (!response.ok) {
      const text = await response.text();
      throw new FashnError(
        `FASHN status check returned ${response.status}: ${text.slice(0, 300)}`,
      );
    }

    const body = await response.json();

    if (body.status === 'completed') {
      const outputs: string[] = body.output ?? [];
      if (outputs.length === 0) {
        throw new FashnError('FASHN reported completion with no output image.');
      }
      return outputs[0];
    }

    if (body.status === 'failed') {
      // Failed generations are not billed, so retrying is safe.
      throw new FashnError(`FASHN generation failed: ${body.error ?? 'unknown'}`);
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  throw new FashnError('FASHN generation timed out after 3 minutes.');
}

/**
 * Download the generated image.
 *
 * CRITICAL: must run immediately after generation. FASHN output URLs expire
 * (documented at 3 days, but treat them as ephemeral). Miss this and the layer
 * is lost and the credit is spent for nothing, which breaks the entire
 * generate-once cost model.
 */
async function downloadOutput(url: string): Promise<{ bytes: Uint8Array; contentType: string }> {
  const response = await fetch(url).catch((error) => {
    throw new FashnError(`Could not download FASHN output: ${error.message}`);
  });

  if (!response.ok) {
    throw new FashnError(`FASHN output download returned ${response.status}`);
  }

  return {
    bytes: new Uint8Array(await response.arrayBuffer()),
    contentType: response.headers.get('Content-Type') ?? 'image/png',
  };
}

export interface TryOnResult {
  predictionId: string;
  bytes: Uint8Array;
  contentType: string;
}

/** Submit, poll and download in one call. */
export async function generate(opts: {
  apiKey: string;
  avatar: Uint8Array;
  garment: Uint8Array;
  category: string;
  avatarType?: string;
  garmentType?: string;
}): Promise<TryOnResult> {
  const predictionId = await submit(
    opts.apiKey,
    opts.avatar,
    opts.garment,
    opts.category,
    opts.avatarType ?? 'image/jpeg',
    opts.garmentType ?? 'image/jpeg',
  );

  const outputUrl = await waitForOutputUrl(opts.apiKey, predictionId);
  const { bytes, contentType } = await downloadOutput(outputUrl);

  return { predictionId, bytes, contentType };
}
