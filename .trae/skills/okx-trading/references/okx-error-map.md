# OKX Error Mapping

Use this map for consistent provider errors and retry behavior.

## Auth and signature

- `50113`: invalid API key/secret/passphrase -> `UNAUTHORIZED`
- `50114`: invalid signature -> `UNAUTHORIZED`
- `50115`: invalid timestamp -> `UNAUTHORIZED`

## Request validation and mode

- `51000`: parameter error -> `INVALID_INPUT`
- `51001`: instrument not found/unavailable -> `INVALID_INPUT`
- `51010`: account mode mismatch -> `INVALID_INPUT`
- `51015`: quantity too small -> `INVALID_INPUT`

## Order and balance

- `51008`: insufficient balance -> `INSUFFICIENT_BUYING_POWER`
- `51009`: order does not exist -> `NOT_FOUND`
- `51131`: price out of range -> `INVALID_INPUT`

## Rate limiting and transient

- `50011`: too many requests -> `RATE_LIMITED` (retryable)
- `50040`: frequent operations -> `RATE_LIMITED` (retryable)
- HTTP `429`, `500`, `502`, `503`, `504` -> retryable

## Retry policy

- Retry only retryable errors.
- Use exponential backoff + jitter.
- Respect `Retry-After` header when available.
- Do not retry auth or invalid-input failures.
