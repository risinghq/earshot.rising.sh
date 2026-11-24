const timeoutMs = 8000;

export class FeedError extends Error {
  constructor(
    message: string,
    readonly url: string,
  ) {
    super(message);
  }
}

// The timer is cleared once the body is read. AbortSignal.timeout's timer
// would stay pending for the full 8 s, and a pending timer keeps a Durable
// Object from hibernating or being evicted.
export async function fetchJson(url: string): Promise<unknown> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetch(url, {
        signal: abort.signal,
        headers: { "user-agent": "music-stats-web" },
      });
    } catch (error) {
      throw new FeedError(String(error), url);
    }
    if (!response.ok)
      throw new FeedError(`feed answered ${response.status}`, url);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}
