import { readFile } from 'node:fs/promises'
export async function localEnv() {
  const env: Record<string, string> = {}
  try {
    for (const line of (
      await readFile(new URL('../.dev.vars', import.meta.url), 'utf8')
    ).split('\n')) {
      const match = line.match(/^([A-Z_]+)=(.*)$/)
      if (match) env[match[1]] = match[2].replace(/^(["'])(.*)\1$/, '$2')
    }
  } catch {
    /* The caller may supply environment variables instead. */
  }
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    ...env,
  }
}
