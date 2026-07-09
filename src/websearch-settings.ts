import { secretGet, setOrDeleteSecret } from "./secrets.ts";

const EXA_API_KEY_SECRET = "websearch:exaApiKey";

export async function loadExaApiKey(): Promise<string> {
  return (await secretGet(EXA_API_KEY_SECRET)) ?? "";
}

export async function saveExaApiKey(value: string): Promise<void> {
  await setOrDeleteSecret(EXA_API_KEY_SECRET, value);
}
