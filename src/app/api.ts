import {isJsonObject, isJsonString, type JsonInput} from '../shared/json';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, init);
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const body: JsonInput = await response.json();
      if (
        isJsonObject(body) &&
        isJsonObject(body.error) &&
        isJsonString(body.error.message)
      ) {
        message = body.error.message;
      }
    } catch {
      // Proxies and network failures do not always return JSON.
    }
    if (response.status === 401)
      message = 'Your session expired. Sign in again to continue.';
    throw new ApiError(message, response.status);
  }
  if (response.status === 204) {
    // SAFETY: callers of 204 endpoints do not consume a response value.
    return undefined as T;
  }
  // SAFETY: API responses are produced by the same-version Worker contract.
  return response.json() as Promise<T>;
}

interface JsonBody {
  [key: string]:
    | FormDataEntryValue
    | boolean
    | number
    | null
    | Array<{partNumber: number; etag: string}>;
}

export function json(method: string, body: JsonBody): RequestInit {
  return {
    method,
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(body),
  };
}

export function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : 'Request failed. Please try again.';
}
